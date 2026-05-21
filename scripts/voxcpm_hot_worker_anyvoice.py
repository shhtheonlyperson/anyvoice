from __future__ import annotations

import argparse
import json
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import soundfile as sf
from voxcpm import VoxCPM

from synthesize_voxcpm_anyvoice import (
    QUALITY_PRESETS,
    analyze_reference_quality,
    apply_stability_seed,
    convert_reference_audio,
    default_clone_mode,
    default_stability_seed,
    default_lora_path,
    build_lora_config,
    ensure_parent,
    lora_config_metadata,
    normalize_lora_path,
    read_json_file,
    read_text_arg,
    should_enable_optimize,
)


JsonObject = dict[str, Any]


def effective_params_for_quality(quality: str, reference_quality: JsonObject) -> JsonObject:
    preset = QUALITY_PRESETS.get(quality, QUALITY_PRESETS["balanced"])
    denoise_mode = preset["denoise"]
    if denoise_mode == "on":
        denoise = True
    elif denoise_mode == "off":
        denoise = False
    else:
        snr = reference_quality.get("snrDb")
        denoise = bool(snr is not None and snr < 18.0)

    return {
        "timesteps": int(preset["timesteps"]),
        "cfgValue": float(preset["cfg"]),
        "denoise": denoise,
        "qualityPreset": quality if quality in QUALITY_PRESETS else "balanced",
    }


def seed_for_request(request: JsonObject) -> int | None:
    value = request.get("stabilitySeed", request.get("seed", default_stability_seed()))
    if value is None:
        return None
    if isinstance(value, str) and value.strip().lower() in {"", "off", "none", "random"}:
        return None
    try:
        seed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("stabilitySeed must be an integer, null, or 'off'") from exc
    if not 0 <= seed <= 2_147_483_647:
        raise ValueError("stabilitySeed must be between 0 and 2147483647")
    return seed


def clone_mode_for_request(request: JsonObject) -> str:
    value = str(request.get("cloneMode") or default_clone_mode()).strip().lower()
    return value if value in {"hifi", "prompt"} else "hifi"


class HotVoxCPMWorker:
    def __init__(
        self,
        *,
        model_id: str,
        cache_dir: str | None,
        local_files_only: bool,
        load_denoiser: bool,
        no_optimize: bool,
        lora_path: str | None,
        lora_r: int,
        lora_alpha: int,
        lora_dropout: float,
        lora_disable_lm: bool,
        lora_disable_dit: bool,
        lora_enable_proj: bool,
    ) -> None:
        self.cache_dir = cache_dir
        self.local_files_only = local_files_only
        self.load_denoiser = load_denoiser
        self.no_optimize = no_optimize
        self.default_lora_path = lora_path
        self.lora_r = lora_r
        self.lora_alpha = lora_alpha
        self.lora_dropout = lora_dropout
        self.lora_disable_lm = lora_disable_lm
        self.lora_disable_dit = lora_disable_dit
        self.lora_enable_proj = lora_enable_proj
        self.lock = threading.Lock()
        self.model_key: tuple[Any, ...] | None = None
        self.model: VoxCPM | None = None
        self.model_stats: JsonObject = {}
        self.ensure_model(model_id=model_id, lora_path=lora_path)

    def expected_model_key(self, *, model_id: str, lora_path: str | None) -> tuple[Any, ...]:
        optimize_requested = not self.no_optimize
        optimize_enabled, _optimize_reason = should_enable_optimize(optimize_requested)
        resolved_lora_path = normalize_lora_path(lora_path)
        return (
            model_id,
            self.cache_dir or "",
            self.local_files_only,
            self.load_denoiser,
            optimize_enabled,
            resolved_lora_path or "",
            self.lora_r,
            self.lora_alpha,
            self.lora_dropout,
            self.lora_disable_lm,
            self.lora_disable_dit,
            self.lora_enable_proj,
        )

    def ensure_model(self, *, model_id: str, lora_path: str | None) -> JsonObject:
        optimize_requested = not self.no_optimize
        optimize_enabled, optimize_reason = should_enable_optimize(optimize_requested)
        resolved_lora_path = normalize_lora_path(lora_path)
        lora_config = build_lora_config(
            lora_path=resolved_lora_path,
            lora_r=self.lora_r,
            lora_alpha=self.lora_alpha,
            lora_dropout=self.lora_dropout,
            lora_disable_lm=self.lora_disable_lm,
            lora_disable_dit=self.lora_disable_dit,
            lora_enable_proj=self.lora_enable_proj,
        )
        lora_meta = lora_config_metadata(lora_config)
        model_key = (
            model_id,
            self.cache_dir or "",
            self.local_files_only,
            self.load_denoiser,
            optimize_enabled,
            resolved_lora_path or "",
            self.lora_r,
            self.lora_alpha,
            self.lora_dropout,
            self.lora_disable_lm,
            self.lora_disable_dit,
            self.lora_enable_proj,
        )
        if self.model is not None and self.model_key == model_key:
            return {
                **self.model_stats,
                "modelLoadSeconds": 0.0,
                "reusedHotModel": True,
            }

        started_at = time.perf_counter()
        self.model = VoxCPM.from_pretrained(
            model_id,
            load_denoiser=self.load_denoiser,
            cache_dir=self.cache_dir,
            local_files_only=self.local_files_only,
            optimize=optimize_enabled,
            lora_config=lora_config,
            lora_weights_path=resolved_lora_path,
        )
        self.model_key = model_key
        self.model_stats = {
            "model_id": model_id,
            "optimize_requested": optimize_requested,
            "optimize_enabled": optimize_enabled,
            "optimize_reason": optimize_reason,
            "lora_enabled": bool(resolved_lora_path),
            "lora_path": resolved_lora_path,
            "lora_config": lora_meta,
            "modelLoadSeconds": round(time.perf_counter() - started_at, 3),
            "reusedHotModel": False,
        }
        return dict(self.model_stats)

    def synthesize(self, request: JsonObject, emit: Any) -> JsonObject:
        text = read_text_arg(None, str(request["textFile"]))
        prompt_text = read_text_arg(None, str(request["promptTextFile"]))
        text_preparation = read_json_file(str(request["textPrepFile"])) if request.get("textPrepFile") else None
        reference_input = Path(str(request["referenceAudio"]))
        output_path = ensure_parent(str(request["output"]))
        run_dir = output_path.parent
        model_id = str(request.get("modelId") or self.model_stats.get("model_id") or "openbmb/VoxCPM2")
        quality = str(request.get("quality") or "balanced")
        clone_mode = clone_mode_for_request(request)
        stability_seed = seed_for_request(request)
        lora_path = str(request.get("loraPath") or self.default_lora_path or "").strip() or None

        emit({"type": "progress", "phase": "reference_preprocessing", "message": "Preparing reference audio"})
        reference_wav = convert_reference_audio(reference_input, run_dir)
        reference_quality = analyze_reference_quality(reference_wav)
        emit(
            {
                "type": "progress",
                "phase": "reference_analyzed",
                "message": "Reference audio analyzed",
                "referenceQuality": reference_quality,
            }
        )

        with self.lock:
            reused = self.model is not None and self.model_key == self.expected_model_key(
                model_id=model_id,
                lora_path=lora_path,
            )
            if not reused:
                emit({"type": "progress", "phase": "model_loading", "message": "Loading VoxCPM2"})
            model_stats = self.ensure_model(model_id=model_id, lora_path=lora_path)
            emit(
                {
                    "type": "progress",
                    "phase": "model_ready",
                    "message": "VoxCPM2 ready",
                    "reusedHotModel": model_stats.get("reusedHotModel"),
                }
            )
            model = self.model
            if model is None:
                raise RuntimeError("VoxCPM model failed to load")

            effective_params = effective_params_for_quality(quality, reference_quality)
            effective_params["cloneMode"] = clone_mode
            effective_params["stabilitySeed"] = stability_seed
            effective_params["loraEnabled"] = bool(model_stats.get("lora_enabled"))
            effective_params["loraPath"] = model_stats.get("lora_path")
            if model_stats.get("lora_config") is not None:
                effective_params["loraConfig"] = model_stats.get("lora_config")
            emit(
                {
                    "type": "progress",
                    "phase": "synthesis_started",
                    "message": "Synthesizing voice",
                    "effectiveParams": effective_params,
                }
            )
            started_at = time.perf_counter()
            seed_metadata = apply_stability_seed(stability_seed)
            generate_kwargs: JsonObject = {
                "text": text,
                "prompt_wav_path": str(reference_wav),
                "prompt_text": prompt_text,
                "cfg_value": float(effective_params["cfgValue"]),
                "inference_timesteps": int(effective_params["timesteps"]),
                "min_len": 2,
                "max_len": 4096,
                "normalize": False,
                "denoise": bool(effective_params["denoise"]),
            }
            if clone_mode == "hifi":
                generate_kwargs["reference_wav_path"] = str(reference_wav)
            wav = model.generate(**generate_kwargs)
            generate_seconds = round(time.perf_counter() - started_at, 3)

        sf.write(str(output_path), wav, model.tts_model.sample_rate)
        emit({"type": "progress", "phase": "audio_ready", "message": "Audio written"})

        metadata: JsonObject = {
            "model_id": model_id,
            "mode": "ultimate",
            "reference_audio": str(reference_input),
            "converted_reference_audio": str(reference_wav),
            "clone_mode": clone_mode,
            "prompt_text_present": True,
            "char_count": len(text),
            "cfg_value": effective_params["cfgValue"],
            "inference_timesteps": effective_params["timesteps"],
            "sample_rate": model.tts_model.sample_rate,
            "output": str(output_path),
            "referenceQuality": reference_quality,
            "effectiveParams": effective_params,
            "determinism": seed_metadata,
            "lora": {
                "enabled": bool(model_stats.get("lora_enabled")),
                "path": model_stats.get("lora_path"),
                "config": model_stats.get("lora_config"),
            },
            "hotWorker": {
                "reusedHotModel": True,
                "generateSeconds": generate_seconds,
                **model_stats,
            },
        }
        if text_preparation is not None:
            metadata["textPreparation"] = text_preparation
        metadata_output = request.get("metadataOutput")
        if metadata_output:
            ensure_parent(str(metadata_output)).write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        return metadata


class RequestHandler(BaseHTTPRequestHandler):
    server: "HotWorkerServer"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, status: int, payload: JsonObject) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _emit_jsonl(self, payload: JsonObject) -> None:
        self.wfile.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.wfile.flush()

    def do_GET(self) -> None:
        if self.path.rstrip("/") not in {"", "/health", "/preload"}:
            self._send_json(404, {"ok": False, "message": "not found"})
            return
        self._send_json(
            200,
            {
                "ok": True,
                "modelLoaded": self.server.worker.model is not None,
                "model": self.server.worker.model_stats,
            },
        )

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/clone":
            self._send_json(404, {"ok": False, "message": "not found"})
            return
        length = int(self.headers.get("content-length") or "0")
        try:
            request = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"ok": False, "message": f"invalid JSON: {exc}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        try:
            metadata = self.server.worker.synthesize(request, self._emit_jsonl)
            self._emit_jsonl({"type": "metadata", "metadata": metadata})
            self._emit_jsonl({"type": "completed", "payload": {"ok": True}})
        except Exception as exc:  # noqa: BLE001
            self._emit_jsonl(
                {
                    "type": "error",
                    "message": str(exc),
                    "traceback": traceback.format_exc(),
                }
            )


class HotWorkerServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], worker: HotVoxCPMWorker) -> None:
        super().__init__(address, RequestHandler)
        self.worker = worker


def main() -> None:
    parser = argparse.ArgumentParser(description="Preloaded AnyVoice VoxCPM2 hot worker.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model-id", default="openbmb/VoxCPM2")
    parser.add_argument("--cache-dir")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--no-optimize", action="store_true")
    parser.add_argument("--load-denoiser", action="store_true", default=True)
    parser.add_argument("--no-load-denoiser", dest="load_denoiser", action="store_false")
    parser.add_argument(
        "--lora-path",
        default=default_lora_path(),
        help="Optional VoxCPM LoRA weights path. Also configurable with ANYVOICE_VOXCPM_LORA_PATH.",
    )
    parser.add_argument("--lora-r", type=int, default=32)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--lora-dropout", type=float, default=0.0)
    parser.add_argument("--lora-disable-lm", action="store_true")
    parser.add_argument("--lora-disable-dit", action="store_true")
    parser.add_argument("--lora-enable-proj", action="store_true")
    args = parser.parse_args()

    worker = HotVoxCPMWorker(
        model_id=args.model_id,
        cache_dir=args.cache_dir,
        local_files_only=args.local_files_only,
        load_denoiser=args.load_denoiser,
        no_optimize=args.no_optimize,
        lora_path=args.lora_path,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        lora_disable_lm=args.lora_disable_lm,
        lora_disable_dit=args.lora_disable_dit,
        lora_enable_proj=args.lora_enable_proj,
    )
    server = HotWorkerServer((args.host, args.port), worker)
    print(
        json.dumps(
            {
                "type": "ready",
                "url": f"http://{args.host}:{args.port}",
                "model": worker.model_stats,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
