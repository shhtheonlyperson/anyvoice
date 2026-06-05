from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from shutil import which
from typing import Any

from voice_clone_regression import call_hot_worker, file_sha256, hot_worker_clone_url


REPO_ROOT = Path(__file__).resolve().parent.parent
SYNTH_SCRIPT = REPO_ROOT / "scripts" / "synthesize_voxcpm_anyvoice.py"
SUPPORTED_LOCAL_BACKENDS = {"voxcpm2-hifi", "indextts2", "f5-tts", "fishaudio-s2-pro"}
DEFAULT_MLX_AUDIO_TTS_GENERATE = "mlx_audio.tts.generate"
DEFAULT_INDEXTTS2_MLX_MODEL = "vanch007/mlx-indextts2-standard-fp16"
DEFAULT_INDEXTTS2_RUNTIME_DIR = Path.home() / ".cache" / "anyvoice-renderers" / "mlx-indextts"
DEFAULT_F5_TTS_COMMAND = "uvx --from f5-tts f5-tts_infer-cli"
DEFAULT_F5_TTS_MODEL = "F5TTS_v1_Base"
DEFAULT_F5_TTS_HF_MODEL = "SWivid/F5-TTS"


def local_env_value(key: str) -> str:
    if key in os.environ:
        return os.environ.get(key, "").strip()
    env_path = REPO_ROOT / ".env.local"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == key:
            return value.strip().strip('"').strip("'")
    return ""


def default_stability_seed() -> int | None:
    value = os.environ.get("ANYVOICE_STABILITY_SEED", "1337").strip().lower()
    if value in {"", "off", "none", "random"}:
        return None
    try:
        seed = int(value)
    except ValueError:
        return 1337
    return seed if 0 <= seed <= 2_147_483_647 else 1337


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def resolve_input(path: str, label: str) -> Path:
    resolved = Path(path).expanduser()
    if not resolved.is_absolute():
        resolved = (Path.cwd() / resolved).resolve()
    if not resolved.exists():
        raise SystemExit(f"{label} is missing: {resolved}")
    return resolved


def metadata_path_for_output(output_wav: Path) -> Path:
    return output_wav.with_suffix(".metadata.json")


def output_evidence(output_wav: Path) -> dict[str, Any]:
    exists = output_wav.exists()
    return {
        "outputWav": str(output_wav),
        "outputExists": exists,
        "missingOutput": not exists,
        "outputBytes": output_wav.stat().st_size if exists else None,
        "outputSha256": file_sha256(output_wav) if exists else None,
    }


def merge_metadata(path: Path, values: dict[str, Any]) -> None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload.update(values)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def env_value(key: str) -> str:
    return os.environ.get(key, "").strip()


def hf_cache_root() -> Path:
    if env_value("HUGGINGFACE_HUB_CACHE"):
        return Path(env_value("HUGGINGFACE_HUB_CACHE")).expanduser()
    if env_value("HF_HOME"):
        return Path(env_value("HF_HOME")).expanduser() / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def hf_model_cache_status(model_id: str) -> dict[str, Any]:
    if "/" not in model_id:
        return {"modelId": model_id, "cacheRequired": False, "status": "not_huggingface_repo_id"}
    cache_dir = hf_cache_root() / f"models--{model_id.replace('/', '--')}"
    refs_dir = cache_dir / "refs"
    snapshots_dir = cache_dir / "snapshots"
    snapshot_files = []
    if snapshots_dir.is_dir():
        snapshot_files = [path for path in snapshots_dir.rglob("*") if path.is_file()]
    latest_snapshot = ""
    try:
        latest_snapshot = (cache_dir / "refs" / "main").read_text(encoding="utf-8").strip()
    except OSError:
        latest_snapshot = ""
    snapshot_dir = snapshots_dir / latest_snapshot if latest_snapshot else None
    codec_files: list[str] = []
    if snapshot_dir and snapshot_dir.is_dir():
        codec_files = sorted(path.name for path in snapshot_dir.glob("codec.*"))
    codec_status = "not_checked"
    if model_id == "fishaudio/s2-pro":
        expected_codec_files = {"codec.safetensors", "model.safetensors", "pytorch_model.safetensors"}
        present = set(codec_files)
        codec_status = "ready" if present.intersection(expected_codec_files) else ("unsupported_codec_pth" if "codec.pth" in present else "missing")
    indextts2_status = "not_checked"
    if "indextts2" in model_id.lower() or "indextts" in model_id.lower():
        expected = {
            "gpt.safetensors",
            "s2mel.safetensors",
            "bigvgan.safetensors",
            "vq2emb.safetensors",
            "tokenizer.model",
            "config.yaml",
        }
        present = {path.name for path in snapshot_dir.iterdir()} if snapshot_dir and snapshot_dir.is_dir() else set()
        missing = sorted(expected - present)
        indextts2_status = "ready" if not missing else "missing_files:" + ",".join(missing)
    return {
        "modelId": model_id,
        "cacheDir": str(cache_dir),
        "cacheDirExists": cache_dir.exists(),
        "refsExists": refs_dir.exists(),
        "snapshotsExists": snapshots_dir.exists(),
        "snapshotFiles": len(snapshot_files),
        "latestSnapshot": latest_snapshot or None,
        "codecFiles": codec_files,
        "codecStatus": codec_status,
        "indextts2Status": indextts2_status,
        "status": "ready" if snapshot_files else ("refs_only" if refs_dir.exists() else "missing"),
    }


def resolve_hf_snapshot(model_id: str) -> Path | None:
    status = hf_model_cache_status(model_id)
    latest = status.get("latestSnapshot")
    cache_dir = status.get("cacheDir")
    if isinstance(latest, str) and latest and isinstance(cache_dir, str):
        path = Path(cache_dir) / "snapshots" / latest
        return path if path.is_dir() else None
    return None


def local_backend_preflight(backend: str, args: argparse.Namespace) -> dict[str, Any]:
    if backend == "voxcpm2-hifi":
        return {
            "backend": backend,
            "localAdapter": "voxcpm",
            "supportedLocalAdapter": True,
            "status": "ready",
        }
    if backend == "fishaudio-s2-pro":
        cli_status: dict[str, Any]
        try:
            cli = resolve_mlx_audio_cli(args.mlx_audio_tts_generate)
            cli_status = {"available": True, "path": cli}
        except SystemExit as exc:
            cli_status = {"available": False, "error": str(exc)}
        model_cache = hf_model_cache_status(args.mlx_model)
        if not cli_status["available"]:
            status = "needs_cli"
        elif model_cache.get("codecStatus") == "unsupported_codec_pth":
            status = "incompatible_model_cache"
        elif model_cache.get("codecStatus") == "missing":
            status = "needs_model_cache"
        elif model_cache.get("status") != "ready":
            status = "needs_model_cache"
        else:
            status = "ready"
        return {
            "backend": backend,
            "localAdapter": "mlx_audio",
            "supportedLocalAdapter": True,
            "status": status,
            "cli": cli_status,
            "modelCache": model_cache,
            "modelId": args.mlx_model,
        }
    if backend == "indextts2":
        runtime_dir = Path(args.indextts_runtime_dir).expanduser()
        uv_available = bool(which(args.uv))
        cli_ready = (runtime_dir / "pyproject.toml").is_file()
        model_cache = hf_model_cache_status(args.indextts_model)
        if not uv_available:
            status = "needs_uv"
        elif not cli_ready:
            status = "needs_mlx_indextts_runtime"
        elif model_cache.get("status") != "ready":
            status = "needs_model_cache"
        elif model_cache.get("indextts2Status") != "ready":
            status = "incompatible_model_cache"
        else:
            status = "ready"
        return {
            "backend": backend,
            "localAdapter": "mlx_indextts",
            "supportedLocalAdapter": True,
            "status": status,
            "runtimeDir": str(runtime_dir),
            "uv": args.uv,
            "uvAvailable": uv_available,
            "runtimeReady": cli_ready,
            "modelCache": model_cache,
            "modelId": args.indextts_model,
        }
    if backend == "f5-tts":
        cli_status: dict[str, Any]
        try:
            command = resolve_f5_tts_command(args.f5_tts_command)
            executable = command[0] if command else ""
            cli_status = {
                "available": True,
                "command": command,
                "executable": executable,
                "path": str(Path(executable).expanduser()) if Path(executable).expanduser().exists() else which(executable),
            }
        except SystemExit as exc:
            cli_status = {"available": False, "error": str(exc)}
        model_cache = hf_model_cache_status(args.f5_tts_hf_model)
        status = "ready" if cli_status.get("available") else "needs_cli"
        return {
            "backend": backend,
            "localAdapter": "f5_tts_cli",
            "supportedLocalAdapter": True,
            "status": status,
            "cli": cli_status,
            "modelCache": model_cache,
            "model": args.f5_tts_model,
            "modelId": args.f5_tts_hf_model,
            "device": args.f5_tts_device,
        }
    return {
        "backend": backend,
        "supportedLocalAdapter": False,
        "status": "needs_external_renderer_command",
        "reason": "no built-in local adapter for this backend",
    }


def backend_render_command_env(backend: str) -> str:
    suffix = "".join(ch if ch.isalnum() else "_" for ch in backend.strip().upper()).strip("_")
    while "__" in suffix:
        suffix = suffix.replace("__", "_")
    return f"ANYVOICE_BACKEND_RENDER_COMMAND_{suffix or 'BACKEND'}"


def render_exists(render: dict[str, Any]) -> bool:
    output = render.get("outputWav")
    return isinstance(output, str) and output.strip() and Path(output).expanduser().is_file()


def preflight_manifest(path: Path, args: argparse.Namespace) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    renders = payload.get("renders") if isinstance(payload, dict) and isinstance(payload.get("renders"), list) else []
    by_backend: dict[str, list[dict[str, Any]]] = {}
    for render in renders:
        if not isinstance(render, dict):
            continue
        backend = str(render.get("backend") or "").strip().lower()
        if not backend:
            continue
        by_backend.setdefault(backend, []).append(render)

    backends = []
    for backend in sorted(by_backend):
        backend_renders = by_backend[backend]
        missing = [render for render in backend_renders if not render_exists(render)]
        envs = sorted(
            {
                str(render.get("commandTemplateEnv") or backend_render_command_env(backend)).strip()
                for render in backend_renders
                if str(render.get("commandTemplateEnv") or backend_render_command_env(backend)).strip()
            }
        )
        missing_envs = sorted(
            {
                str(render.get("commandTemplateEnv") or backend_render_command_env(backend)).strip()
                for render in missing
                if str(render.get("commandTemplateEnv") or backend_render_command_env(backend)).strip()
            }
        )
        fallback_envs = sorted(
            {
                str(render.get("commandTemplateFallbackEnv") or "ANYVOICE_BACKEND_RENDER_COMMAND").strip()
                for render in backend_renders
                if str(render.get("commandTemplateFallbackEnv") or "ANYVOICE_BACKEND_RENDER_COMMAND").strip()
            }
        )
        fallback_env = fallback_envs[0] if len(fallback_envs) == 1 else "ANYVOICE_BACKEND_RENDER_COMMAND"
        configured_envs = [env for env in missing_envs if env_value(env)]
        fallback_configured = bool(env_value(fallback_env))
        command_configured = bool(missing) and (fallback_configured or (bool(missing_envs) and len(configured_envs) == len(missing_envs)))
        local = local_backend_preflight(backend, args)
        if not missing:
            status = "ready"
        elif command_configured:
            status = "ready_to_render"
        elif local.get("status") == "ready":
            status = "local_adapter_ready_needs_env"
        else:
            status = str(local.get("status") or "needs_renderer_command")
        backends.append(
            {
                "backend": backend,
                "totalRenders": len(backend_renders),
                "renderedRenders": len(backend_renders) - len(missing),
                "missingRenders": len(missing),
                "commandTemplateEnvs": envs,
                "missingCommandTemplateEnvs": missing_envs,
                "fallbackEnv": fallback_env,
                "configuredCommandTemplateEnvs": configured_envs,
                "fallbackConfigured": fallback_configured,
                "commandConfigured": command_configured,
                "local": local,
                "status": status,
            }
        )
    blocking = [row for row in backends if row.get("missingRenders") and row.get("status") not in {"ready_to_render", "local_adapter_ready_needs_env"}]
    return {
        "version": 1,
        "status": "ready" if not blocking else "needs_renderer_setup",
        "manifest": str(path.resolve()),
        "backends": backends,
        "blockingBackends": [row.get("backend") for row in blocking],
    }


def preflight(args: argparse.Namespace) -> None:
    if args.manifest:
        manifest = resolve_input(args.manifest, "manifest")
        print(json.dumps(preflight_manifest(manifest, args), ensure_ascii=False, sort_keys=True))
        return
    backend = args.backend.strip().lower()
    print(json.dumps({"version": 1, **local_backend_preflight(backend, args)}, ensure_ascii=False, sort_keys=True))


def render_voxcpm(
    *,
    args: argparse.Namespace,
    target_text_file: Path,
    reference_audio: Path,
    prompt_text_file: Path,
    text_prep_file: Path | None,
    output_wav: Path,
    metadata_output: Path,
) -> dict[str, Any]:
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    metadata_output.parent.mkdir(parents=True, exist_ok=True)
    hot_worker_url = str(args.hot_worker_url or "").strip()
    seed = args.seed
    if hot_worker_url:
        metadata = call_hot_worker(
            hot_worker_url,
            {
                "textFile": str(target_text_file),
                "referenceAudio": str(reference_audio),
                "promptTextFile": str(prompt_text_file),
                "textPrepFile": str(text_prep_file) if text_prep_file else None,
                "modelId": args.model_id,
                "quality": args.quality,
                "cloneMode": "hifi",
                "stabilitySeed": seed,
                "metadataOutput": str(metadata_output),
                "output": str(output_wav),
            },
        )
        return {
            "renderer": "hot_worker",
            "hotWorkerUrl": hot_worker_clone_url(hot_worker_url),
            "hotWorkerMetadata": metadata,
        }

    command = [
        args.python,
        str(SYNTH_SCRIPT),
        "--text-file",
        str(target_text_file),
        "--reference-audio",
        str(reference_audio),
        "--prompt-text-file",
        str(prompt_text_file),
        "--model-id",
        args.model_id,
        "--quality",
        args.quality,
        "--clone-mode",
        "hifi",
        "--metadata-output",
        str(metadata_output),
        "--output",
        str(output_wav),
    ]
    if text_prep_file:
        command.extend(["--text-prep-file", str(text_prep_file)])
    if seed is not None:
        command.extend(["--seed", str(seed)])
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or proc.stdout.strip() or f"VoxCPM render failed with code {proc.returncode}")
    return {
        "renderer": "python",
        "command": " ".join(command),
        "returnCode": proc.returncode,
        "stderr": proc.stderr[-4000:],
    }


def resolve_mlx_audio_cli(value: str) -> str:
    candidate = value.strip() or DEFAULT_MLX_AUDIO_TTS_GENERATE
    if Path(candidate).expanduser().exists():
        return str(Path(candidate).expanduser())
    resolved = which(candidate)
    if resolved:
        return resolved
    typeless_cli = Path.home() / ".local" / "share" / "typelessmlx" / "venv" / "bin" / "mlx_audio.tts.generate"
    if typeless_cli.exists():
        return str(typeless_cli)
    raise SystemExit(
        "mlx-audio TTS CLI is not available; set ANYVOICE_MLX_AUDIO_TTS_GENERATE "
        "or install TypelessMLX/mlx-audio before rendering fishaudio-s2-pro"
    )


def resolve_f5_tts_command(value: str) -> list[str]:
    raw = value.strip() or DEFAULT_F5_TTS_COMMAND
    command = shlex.split(raw)
    if not command:
        raise SystemExit("F5-TTS command is empty; set ANYVOICE_F5_TTS_COMMAND")
    executable = Path(command[0]).expanduser()
    if executable.exists():
        command[0] = str(executable)
        return command
    resolved = which(command[0])
    if resolved:
        command[0] = resolved
        return command
    raise SystemExit(
        "F5-TTS CLI is not available; set ANYVOICE_F5_TTS_COMMAND "
        "or install/run it with uvx using `uvx --from f5-tts f5-tts_infer-cli`"
    )


def render_f5_tts(
    *,
    args: argparse.Namespace,
    target_text_file: Path,
    reference_audio: Path,
    prompt_text_file: Path,
    output_wav: Path,
    metadata_output: Path,
) -> dict[str, Any]:
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    metadata_output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        *resolve_f5_tts_command(args.f5_tts_command),
        "--model",
        args.f5_tts_model,
        "--ref_audio",
        str(reference_audio),
        "--ref_text",
        read_text(prompt_text_file),
        "--gen_text",
        read_text(target_text_file),
        "--output_dir",
        str(output_wav.parent),
        "--output_file",
        output_wav.name,
        "--nfe_step",
        str(args.f5_tts_nfe_step),
        "--cfg_strength",
        str(args.f5_tts_cfg_strength),
        "--speed",
        str(args.f5_tts_speed),
        "--device",
        args.f5_tts_device,
        "--no_legacy_text",
    ]
    if args.f5_tts_remove_silence:
        command.append("--remove_silence")
    proc = subprocess.run(command, capture_output=True, text=True)
    metadata = {
        "version": 1,
        "renderer": "f5_tts_cli",
        "backend": "f5-tts",
        "model": args.f5_tts_model,
        "modelId": args.f5_tts_hf_model,
        "command": command,
        "returnCode": proc.returncode,
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
        "outputWav": str(output_wav),
        "outputExists": output_wav.exists(),
    }
    metadata_output.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or proc.stdout.strip() or f"F5-TTS render failed with code {proc.returncode}")
    if not output_wav.exists():
        raise SystemExit(f"F5-TTS render finished but did not create output WAV: {output_wav}")
    return {
        "renderer": "f5_tts_cli",
        "command": " ".join(command),
        "returnCode": proc.returncode,
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
        "externalModelId": args.f5_tts_hf_model,
        "f5Model": args.f5_tts_model,
        "device": args.f5_tts_device,
    }


def render_fishaudio_s2_pro(
    *,
    args: argparse.Namespace,
    target_text_file: Path,
    reference_audio: Path,
    prompt_text_file: Path,
    output_wav: Path,
    metadata_output: Path,
) -> dict[str, Any]:
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    metadata_output.parent.mkdir(parents=True, exist_ok=True)
    cli = resolve_mlx_audio_cli(args.mlx_audio_tts_generate)
    audio_format = output_wav.suffix.lstrip(".") or "wav"
    file_prefix = output_wav.with_suffix("").name
    command = [
        cli,
        "--model",
        args.mlx_model,
        "--text",
        read_text(target_text_file),
        "--ref_audio",
        str(reference_audio),
        "--ref_text",
        read_text(prompt_text_file),
        "--output_path",
        str(output_wav.parent),
        "--file_prefix",
        file_prefix,
        "--audio_format",
        audio_format,
        "--join_audio",
        "--lang_code",
        args.lang_code,
    ]
    if args.mlx_stt_model:
        command.extend(["--stt_model", args.mlx_stt_model])
    proc = subprocess.run(command, capture_output=True, text=True)
    alternate_output = output_wav.parent / f"{file_prefix}_000.{audio_format}"
    if not output_wav.exists() and alternate_output.exists():
        alternate_output.replace(output_wav)
    metadata = {
        "version": 1,
        "renderer": "mlx_audio",
        "backend": "fishaudio-s2-pro",
        "model": args.mlx_model,
        "command": command,
        "returnCode": proc.returncode,
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
        "outputWav": str(output_wav),
        "outputExists": output_wav.exists(),
    }
    metadata_output.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if proc.returncode != 0 or "Error loading model:" in proc.stdout:
        raise SystemExit(proc.stderr.strip() or proc.stdout.strip() or f"mlx-audio render failed with code {proc.returncode}")
    if not output_wav.exists():
        raise SystemExit(
            "mlx-audio render finished but did not create the planned output WAV: "
            f"{output_wav}. Check model availability for {args.mlx_model!r}."
        )
    return {
        "renderer": "mlx_audio",
        "command": " ".join(command),
        "returnCode": proc.returncode,
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
        "externalModelId": args.mlx_model,
        "languageCode": args.lang_code,
    }


def render_indextts2(
    *,
    args: argparse.Namespace,
    target_text_file: Path,
    reference_audio: Path,
    output_wav: Path,
    metadata_output: Path,
) -> dict[str, Any]:
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    metadata_output.parent.mkdir(parents=True, exist_ok=True)
    preflight_status = local_backend_preflight("indextts2", args)
    if preflight_status.get("status") != "ready":
        raise SystemExit(f"IndexTTS2 MLX renderer is not ready: {json.dumps(preflight_status, ensure_ascii=False, sort_keys=True)}")
    model_path = resolve_hf_snapshot(args.indextts_model)
    if model_path is None:
        raise SystemExit(f"IndexTTS2 MLX model snapshot is missing for {args.indextts_model}")
    runtime_dir = Path(args.indextts_runtime_dir).expanduser().resolve()
    speaker_cache_dir = Path(args.indextts_speaker_cache_dir).expanduser() if args.indextts_speaker_cache_dir else output_wav.parent / ".speaker-cache"
    if not speaker_cache_dir.is_absolute():
        speaker_cache_dir = (Path.cwd() / speaker_cache_dir).resolve()
    speaker_cache_dir.mkdir(parents=True, exist_ok=True)
    reference_hash = file_sha256(reference_audio) or "unknown"
    speaker_cache = speaker_cache_dir / f"{reference_audio.stem}-{reference_hash[:12]}.npz"
    speaker_command = [
        args.uv,
        "run",
        "mlx-indextts",
        "speaker",
        "-m",
        str(model_path),
        "-r",
        str(reference_audio),
        "-o",
        str(speaker_cache),
        "--memory-limit",
        str(args.indextts_memory_limit),
    ]
    speaker_proc: subprocess.CompletedProcess[str] | None = None
    if not speaker_cache.is_file():
        speaker_proc = subprocess.run(speaker_command, cwd=runtime_dir, capture_output=True, text=True)
        if speaker_proc.returncode != 0:
            raise SystemExit(speaker_proc.stderr.strip() or speaker_proc.stdout.strip() or f"IndexTTS2 speaker conditioning failed with code {speaker_proc.returncode}")
    generate_command = [
        args.uv,
        "run",
        "mlx-indextts",
        "generate",
        "-m",
        str(model_path),
        "-r",
        str(speaker_cache),
        "-t",
        read_text(target_text_file),
        "-o",
        str(output_wav),
        "--memory-limit",
        str(args.indextts_memory_limit),
        "--diffusion-steps",
        str(args.indextts_diffusion_steps),
    ]
    generate_proc = subprocess.run(generate_command, cwd=runtime_dir, capture_output=True, text=True)
    metadata = {
        "version": 1,
        "renderer": "mlx_indextts",
        "backend": "indextts2",
        "model": args.indextts_model,
        "modelPath": str(model_path),
        "runtimeDir": str(runtime_dir),
        "speakerCache": str(speaker_cache),
        "speakerCacheReused": speaker_proc is None,
        "speakerCommand": speaker_command,
        "speakerReturnCode": speaker_proc.returncode if speaker_proc is not None else 0,
        "speakerStdout": speaker_proc.stdout[-4000:] if speaker_proc is not None else "",
        "speakerStderr": speaker_proc.stderr[-4000:] if speaker_proc is not None else "",
        "generateCommand": generate_command,
        "generateReturnCode": generate_proc.returncode,
        "generateStdout": generate_proc.stdout[-4000:],
        "generateStderr": generate_proc.stderr[-4000:],
        "outputWav": str(output_wav),
        "outputExists": output_wav.exists(),
    }
    metadata_output.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if generate_proc.returncode != 0:
        raise SystemExit(generate_proc.stderr.strip() or generate_proc.stdout.strip() or f"IndexTTS2 generate failed with code {generate_proc.returncode}")
    if not output_wav.exists():
        raise SystemExit(f"IndexTTS2 generate finished but did not create output WAV: {output_wav}")
    return {
        "renderer": "mlx_indextts",
        "speakerCommand": " ".join(speaker_command),
        "speakerCache": str(speaker_cache),
        "speakerCacheReused": speaker_proc is None,
        "command": " ".join(generate_command),
        "returnCode": generate_proc.returncode,
        "stdout": generate_proc.stdout[-4000:],
        "stderr": generate_proc.stderr[-4000:],
        "externalModelId": args.indextts_model,
        "runtimeDir": str(runtime_dir),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Render one AnyVoice backend-shootout job.")
    parser.add_argument("--backend", default="")
    parser.add_argument("--manifest", help="Backend shootout manifest to inspect in --preflight mode.")
    parser.add_argument("--preflight", action="store_true", help="Check local adapter, renderer env, and model-cache readiness without rendering.")
    parser.add_argument("--text-file")
    parser.add_argument("--reference", "--reference-audio", dest="reference_audio")
    parser.add_argument("--prompt", "--prompt-text-file", dest="prompt_text_file")
    parser.add_argument("--out", "--output-wav", dest="output_wav")
    parser.add_argument("--text-prep-file")
    parser.add_argument("--case-id", default="")
    parser.add_argument("--repeat", type=int)
    parser.add_argument("--seed", type=int, default=default_stability_seed())
    parser.add_argument("--python", default=local_env_value("ANYVOICE_VOXCPM_PYTHON") or sys.executable)
    parser.add_argument("--hot-worker-url", default=local_env_value("ANYVOICE_HOT_WORKER_URL"))
    parser.add_argument("--model-id", default=local_env_value("ANYVOICE_MODEL_ID") or "openbmb/VoxCPM2")
    parser.add_argument("--mlx-audio-tts-generate", default=local_env_value("ANYVOICE_MLX_AUDIO_TTS_GENERATE") or DEFAULT_MLX_AUDIO_TTS_GENERATE)
    parser.add_argument("--mlx-model", default=local_env_value("ANYVOICE_FISHAUDIO_S2_PRO_MODEL") or "fishaudio/s2-pro")
    parser.add_argument("--mlx-stt-model", default=local_env_value("ANYVOICE_MLX_AUDIO_STT_MODEL"))
    parser.add_argument("--lang-code", default=local_env_value("ANYVOICE_MLX_AUDIO_LANG_CODE") or "zh")
    parser.add_argument("--uv", default=local_env_value("ANYVOICE_UV_BIN") or "uv")
    parser.add_argument("--indextts-runtime-dir", default=local_env_value("ANYVOICE_INDEXTTS2_RUNTIME_DIR") or str(DEFAULT_INDEXTTS2_RUNTIME_DIR))
    parser.add_argument("--indextts-model", default=local_env_value("ANYVOICE_INDEXTTS2_MLX_MODEL") or DEFAULT_INDEXTTS2_MLX_MODEL)
    parser.add_argument("--indextts-memory-limit", type=int, default=int(local_env_value("ANYVOICE_INDEXTTS2_MEMORY_LIMIT") or "24"))
    parser.add_argument("--indextts-diffusion-steps", type=int, default=int(local_env_value("ANYVOICE_INDEXTTS2_DIFFUSION_STEPS") or "16"))
    parser.add_argument("--indextts-speaker-cache-dir", default=local_env_value("ANYVOICE_INDEXTTS2_SPEAKER_CACHE_DIR"))
    parser.add_argument("--f5-tts-command", default=local_env_value("ANYVOICE_F5_TTS_COMMAND") or DEFAULT_F5_TTS_COMMAND)
    parser.add_argument("--f5-tts-model", default=local_env_value("ANYVOICE_F5_TTS_MODEL") or DEFAULT_F5_TTS_MODEL)
    parser.add_argument("--f5-tts-hf-model", default=local_env_value("ANYVOICE_F5_TTS_HF_MODEL") or DEFAULT_F5_TTS_HF_MODEL)
    parser.add_argument("--f5-tts-device", default=local_env_value("ANYVOICE_F5_TTS_DEVICE") or "mps")
    parser.add_argument("--f5-tts-nfe-step", type=int, default=int(local_env_value("ANYVOICE_F5_TTS_NFE_STEP") or "16"))
    parser.add_argument("--f5-tts-cfg-strength", type=float, default=float(local_env_value("ANYVOICE_F5_TTS_CFG_STRENGTH") or "2.0"))
    parser.add_argument("--f5-tts-speed", type=float, default=float(local_env_value("ANYVOICE_F5_TTS_SPEED") or "1.0"))
    parser.add_argument("--f5-tts-remove-silence", action="store_true", default=local_env_value("ANYVOICE_F5_TTS_REMOVE_SILENCE").lower() in {"1", "true", "yes", "on"})
    parser.add_argument("--quality", choices=("speed", "balanced", "quality"), default="balanced")
    parser.add_argument("--metadata-output")
    parser.add_argument(
        "--skip-unsupported",
        action="store_true",
        help="Exit 0 without rendering unsupported external backends so mixed shootout plans can fill local VoxCPM baseline renders first.",
    )
    args = parser.parse_args()

    backend = args.backend.strip().lower()
    if args.preflight:
        if not backend and not args.manifest:
            raise SystemExit("--preflight requires --backend or --manifest")
        preflight(args)
        return
    missing_args = [
        name
        for name, value in [
            ("--backend", backend),
            ("--text-file", args.text_file),
            ("--reference", args.reference_audio),
            ("--prompt", args.prompt_text_file),
            ("--out", args.output_wav),
        ]
        if not value
    ]
    if missing_args:
        raise SystemExit(f"missing required render arguments: {', '.join(missing_args)}")
    if backend not in SUPPORTED_LOCAL_BACKENDS:
        if args.skip_unsupported:
            print(
                json.dumps(
                    {
                        "version": 1,
                        "status": "skipped",
                        "backend": backend,
                        "caseId": args.case_id or None,
                        "repeat": args.repeat,
                        "reason": "unsupported_backend_requires_external_renderer",
                        "outputWav": str(Path(args.output_wav).expanduser()) if args.output_wav else None,
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
            return
        raise SystemExit(
            f"backend {args.backend!r} is not implemented by this local renderer; "
            "use a backend-specific command for IndexTTS2/F5-TTS or route only supported local jobs here"
        )

    target_text_file = resolve_input(args.text_file, "target text file")
    reference_audio = resolve_input(args.reference_audio, "reference audio")
    prompt_text_file = resolve_input(args.prompt_text_file, "prompt text file")
    text_prep_file = resolve_input(args.text_prep_file, "text prep file") if args.text_prep_file else None
    output_wav = Path(args.output_wav).expanduser()
    if not output_wav.is_absolute():
        output_wav = (Path.cwd() / output_wav).resolve()
    metadata_output = (
        Path(args.metadata_output).expanduser().resolve()
        if args.metadata_output
        else metadata_path_for_output(output_wav)
    )

    started_at = datetime.now(timezone.utc)
    if backend == "voxcpm2-hifi":
        render_meta = render_voxcpm(
            args=args,
            target_text_file=target_text_file,
            reference_audio=reference_audio,
            prompt_text_file=prompt_text_file,
            text_prep_file=text_prep_file,
            output_wav=output_wav,
            metadata_output=metadata_output,
        )
    elif backend == "indextts2":
        render_meta = render_indextts2(
            args=args,
            target_text_file=target_text_file,
            reference_audio=reference_audio,
            output_wav=output_wav,
            metadata_output=metadata_output,
        )
    elif backend == "f5-tts":
        render_meta = render_f5_tts(
            args=args,
            target_text_file=target_text_file,
            reference_audio=reference_audio,
            prompt_text_file=prompt_text_file,
            output_wav=output_wav,
            metadata_output=metadata_output,
        )
    else:
        render_meta = render_fishaudio_s2_pro(
            args=args,
            target_text_file=target_text_file,
            reference_audio=reference_audio,
            prompt_text_file=prompt_text_file,
            output_wav=output_wav,
            metadata_output=metadata_output,
        )
    finished_at = datetime.now(timezone.utc)
    render_seconds = round((finished_at - started_at).total_seconds(), 3)
    merge_metadata(metadata_output, {"renderSeconds": render_seconds})
    payload = {
        "version": 1,
        "status": "ready" if output_wav.exists() else "missing_output",
        "backend": backend,
        "caseId": args.case_id or None,
        "repeat": args.repeat,
        "startedAt": started_at.isoformat(),
        "finishedAt": finished_at.isoformat(),
        "targetTextFile": str(target_text_file),
        "targetText": read_text(target_text_file),
        "referenceAudio": str(reference_audio),
        "promptTextFile": str(prompt_text_file),
        "textPrepFile": str(text_prep_file) if text_prep_file else None,
        "metadataOutput": str(metadata_output),
        "modelId": args.model_id,
        "quality": args.quality,
        "cloneMode": "hifi" if backend == "voxcpm2-hifi" else backend,
        "stabilitySeed": args.seed,
        "renderSeconds": render_seconds,
        **render_meta,
        **output_evidence(output_wav),
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    if payload["status"] != "ready":
        raise SystemExit(65)


if __name__ == "__main__":
    main()
