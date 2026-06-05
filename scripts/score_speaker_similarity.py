from __future__ import annotations

import argparse
import json
import math
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np


DEFAULT_SR = 16000
BACKENDS = ("mfcc-cosine", "resemblyzer", "speechbrain-ecapa")


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON: {path}: {exc}") from exc


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def report_renders(report: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    groups = report.get("groups")
    if not isinstance(groups, list):
        raise SystemExit("report does not contain groups[]")
    report_reference = str(report.get("referenceAudio") or "").strip()
    for group in groups:
        if not isinstance(group, dict):
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            output_wav = str(render.get("outputWav") or "").strip()
            reference_audio = str(render.get("referenceAudio") or report_reference).strip()
            if not output_wav:
                continue
            rows.append(
                {
                    "cloneMode": group.get("cloneMode") or render.get("cloneMode"),
                    "caseId": case.get("id") or render.get("caseId"),
                    "repeat": render.get("repeat"),
                    "outputWav": output_wav,
                    "referenceAudio": reference_audio,
                    "profileClipId": render.get("profileClipId"),
                    "voiceProfileId": render.get("voiceProfileId"),
                    "status": render.get("status"),
                }
            )
    return rows


def profile_reference_rows(profile_path: Path | None) -> dict[str, list[dict[str, Any]]]:
    if profile_path is None:
        return {}
    profile = load_json(profile_path)
    if not isinstance(profile, dict):
        raise SystemExit(f"profile JSON is not an object: {profile_path}")
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip()
    if not voice_profile_id:
        raise SystemExit(f"profile JSON is missing voiceProfileId: {profile_path}")
    clips = profile.get("clips") if isinstance(profile.get("clips"), list) else []
    clip_by_id = {
        str(clip.get("sourceRunId") or "").strip(): clip
        for clip in clips
        if isinstance(clip, dict) and str(clip.get("sourceRunId") or "").strip()
    }
    reference_ids = [
        str(item).strip()
        for item in profile.get("referenceClipIds", [])
        if isinstance(item, str) and str(item).strip()
    ]
    selected_clips = [clip_by_id[reference_id] for reference_id in reference_ids if reference_id in clip_by_id] if reference_ids else clips
    references: list[dict[str, Any]] = []
    for reference_id in reference_ids:
        if reference_id not in clip_by_id:
            references.append(
                {
                    "sourceRunId": reference_id,
                    "audioPath": None,
                    "error": "referenceClipId not found in profile clips",
                }
            )
    for clip in selected_clips:
        if not isinstance(clip, dict):
            continue
        audio_path = clip.get("audioPath")
        source_run_id = str(clip.get("sourceRunId") or "").strip()
        if isinstance(audio_path, str) and audio_path.strip():
            references.append(
                {
                    "sourceRunId": source_run_id,
                    "audioPath": str(resolve_path(audio_path, profile_path.parent)),
                }
            )
    return {voice_profile_id: references}


def resolve_path(path: str, base: Path) -> Path:
    resolved = Path(path).expanduser()
    if not resolved.is_absolute():
        resolved = base / resolved
    return resolved.resolve()


def load_audio(path: Path, target_sr: int) -> np.ndarray:
    try:
        import soundfile as sf

        data, sr = sf.read(str(path), always_2d=False, dtype="float32")
        audio = np.asarray(data, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
    except ImportError:
        audio, sr = load_wav_with_stdlib(path)
    if audio.size == 0:
        raise RuntimeError(f"empty audio: {path}")
    audio = np.asarray(audio, dtype=np.float32)
    if sr != target_sr:
        audio = resample_linear(audio, sr, target_sr)
    peak = float(np.max(np.abs(audio)))
    if peak > 0:
        audio = audio / peak
    return trim_silence(audio)


def load_wav_with_stdlib(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sr = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    if sample_width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sample_width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sample_width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError(f"unsupported WAV sample width {sample_width} bytes: {path}")
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, sr


def resample_linear(audio: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    if source_sr <= 0 or target_sr <= 0:
        raise RuntimeError(f"invalid sample rate: {source_sr} -> {target_sr}")
    if audio.size < 2:
        return audio
    duration = audio.size / float(source_sr)
    target_size = max(1, int(round(duration * target_sr)))
    old_x = np.linspace(0.0, duration, num=audio.size, endpoint=False)
    new_x = np.linspace(0.0, duration, num=target_size, endpoint=False)
    return np.interp(new_x, old_x, audio).astype(np.float32)


def trim_silence(audio: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak <= 0:
        return audio
    threshold = max(peak * 0.02, 1e-4)
    active = np.flatnonzero(np.abs(audio) >= threshold)
    if active.size == 0:
        return audio
    start = max(0, int(active[0]) - 800)
    end = min(audio.size, int(active[-1]) + 800)
    return audio[start:end]


def hz_to_mel(hz: np.ndarray) -> np.ndarray:
    return 2595.0 * np.log10(1.0 + hz / 700.0)


def mel_to_hz(mel: np.ndarray) -> np.ndarray:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def mel_filterbank(sr: int, n_fft: int, n_mels: int) -> np.ndarray:
    mel_points = np.linspace(hz_to_mel(np.array([0.0]))[0], hz_to_mel(np.array([sr / 2.0]))[0], n_mels + 2)
    hz_points = mel_to_hz(mel_points)
    bins = np.floor((n_fft + 1) * hz_points / sr).astype(int)
    filters = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for index in range(1, n_mels + 1):
        left, center, right = bins[index - 1], bins[index], bins[index + 1]
        if center > left:
            filters[index - 1, left:center] = (np.arange(left, center) - left) / (center - left)
        if right > center:
            filters[index - 1, center:right] = (right - np.arange(center, right)) / (right - center)
    return filters


def dct_basis(n_mfcc: int, n_mels: int) -> np.ndarray:
    basis = np.zeros((n_mfcc, n_mels), dtype=np.float32)
    scale = math.sqrt(2.0 / n_mels)
    for k in range(n_mfcc):
        for n in range(n_mels):
            basis[k, n] = scale * math.cos(math.pi * k * (2 * n + 1) / (2 * n_mels))
    basis[0, :] *= 1.0 / math.sqrt(2.0)
    return basis


def mfcc_embedding(audio: np.ndarray, sr: int) -> np.ndarray:
    frame_len = int(round(sr * 0.025))
    hop = int(round(sr * 0.010))
    n_fft = 512
    n_mels = 40
    n_mfcc = 20
    if audio.size < frame_len:
        audio = np.pad(audio, (0, frame_len - audio.size))
    frame_count = 1 + max(0, (audio.size - frame_len) // hop)
    window = np.hamming(frame_len).astype(np.float32)
    filters = mel_filterbank(sr, n_fft, n_mels)
    dct = dct_basis(n_mfcc, n_mels)
    mfcc_rows: list[np.ndarray] = []
    for frame_index in range(frame_count):
        start = frame_index * hop
        frame = audio[start : start + frame_len]
        if frame.size < frame_len:
            frame = np.pad(frame, (0, frame_len - frame.size))
        spectrum = np.fft.rfft(frame * window, n=n_fft)
        power = (np.abs(spectrum) ** 2).astype(np.float32)
        log_mel = np.log(np.maximum(filters @ power, 1e-8))
        mfcc_rows.append(dct @ log_mel)
    mfcc = np.vstack(mfcc_rows)
    voiced = mfcc[:, 1:]
    embedding = np.concatenate([voiced.mean(axis=0), voiced.std(axis=0)])
    norm = float(np.linalg.norm(embedding))
    if norm <= 0:
        return embedding
    return embedding / norm


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 0:
        return 0.0
    return round(float(np.dot(a, b) / denom), 6)


def mfcc_embedder(args: argparse.Namespace) -> Callable[[Path], np.ndarray]:
    cache: dict[str, np.ndarray] = {}

    def embed(path: Path) -> np.ndarray:
        key = str(path)
        if key not in cache:
            audio = load_audio(path, args.sample_rate)
            max_samples = int(args.sample_rate * args.max_duration_sec)
            if max_samples > 0 and audio.size > max_samples:
                audio = audio[:max_samples]
            cache[key] = mfcc_embedding(audio, args.sample_rate)
        return cache[key]

    return embed


def resemblyzer_embedder(_: argparse.Namespace) -> Callable[[Path], np.ndarray]:
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
    except ImportError as exc:
        raise SystemExit("resemblyzer is not installed in this Python env") from exc
    encoder = VoiceEncoder()
    cache: dict[str, np.ndarray] = {}

    def embed(path: Path) -> np.ndarray:
        key = str(path)
        if key not in cache:
            cache[key] = np.asarray(encoder.embed_utterance(preprocess_wav(path)), dtype=np.float32)
        return cache[key]

    return embed


def module_available(name: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(name) is not None


def backend_availability() -> dict[str, dict[str, Any]]:
    speechbrain_missing = [
        name
        for name in ("speechbrain", "torch", "torchaudio")
        if not module_available(name)
    ]
    return {
        "mfcc-cosine": {
            "available": True,
            "kind": "local_proxy",
            "reason": "built in MFCC cosine scorer",
        },
        "resemblyzer": {
            "available": module_available("resemblyzer"),
            "kind": "speaker_embedding",
            "reason": "installed" if module_available("resemblyzer") else "missing Python package: resemblyzer",
        },
        "speechbrain-ecapa": {
            "available": not speechbrain_missing,
            "kind": "speaker_verification",
            "reason": "installed" if not speechbrain_missing else f"missing Python package(s): {', '.join(speechbrain_missing)}",
        },
    }


def speechbrain_embedder(args: argparse.Namespace) -> Callable[[Path], np.ndarray]:
    try:
        import torch
        import torchaudio
    except ImportError as exc:
        raise SystemExit("torch and torchaudio are required for speechbrain-ecapa") from exc
    try:
        from speechbrain.inference.speaker import EncoderClassifier
    except ImportError:
        try:
            from speechbrain.pretrained import EncoderClassifier
        except ImportError as exc:
            raise SystemExit("speechbrain is not installed in this Python env") from exc

    source = args.model or "speechbrain/spkrec-ecapa-voxceleb"
    classifier = EncoderClassifier.from_hparams(source=source)
    cache: dict[str, np.ndarray] = {}

    def embed(path: Path) -> np.ndarray:
        key = str(path)
        if key not in cache:
            signal, sr = torchaudio.load(str(path))
            if signal.shape[0] > 1:
                signal = signal.mean(dim=0, keepdim=True)
            if sr != args.sample_rate:
                signal = torchaudio.functional.resample(signal, sr, args.sample_rate)
            with torch.no_grad():
                embedding = classifier.encode_batch(signal).squeeze().detach().cpu().numpy()
            cache[key] = np.asarray(embedding, dtype=np.float32)
        return cache[key]

    return embed


def resolve_backend(requested: str) -> str:
    if requested != "auto":
        return requested
    availability = backend_availability()
    if availability["speechbrain-ecapa"]["available"]:
        return "speechbrain-ecapa"
    if availability["resemblyzer"]["available"]:
        return "resemblyzer"
    return "mfcc-cosine"


def embedder_for_backend(backend: str, args: argparse.Namespace) -> Callable[[Path], np.ndarray]:
    if backend == "mfcc-cosine":
        return mfcc_embedder(args)
    if backend == "resemblyzer":
        return resemblyzer_embedder(args)
    if backend == "speechbrain-ecapa":
        return speechbrain_embedder(args)
    raise SystemExit(f"unknown speaker similarity backend: {backend}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score AnyVoice regression renders against their reference audio for speaker similarity.")
    parser.add_argument("report", nargs="?", help="AnyVoice voice_clone_regression.py report.json")
    parser.add_argument("--out", help="Speaker similarity JSON path. Defaults to <report-dir>/speaker.json.")
    parser.add_argument("--backend", choices=("auto", *BACKENDS), default="auto")
    parser.add_argument("--model", help="Optional model name/path for model-based speaker backends.")
    parser.add_argument("--profile-json", help="Optional profile manifest; when provided, also compare each render against selected profile clips.")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SR)
    parser.add_argument("--max-duration-sec", type=float, default=30.0)
    parser.add_argument("--limit", type=int, help="Score only the first N renders.")
    parser.add_argument("--dry-run", action="store_true", help="Write planned rows without loading audio or computing similarity.")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero if any render cannot be scored.")
    parser.add_argument("--list-backends", action="store_true", help="Print backend availability and the auto-selected backend, then exit.")
    args = parser.parse_args()

    if args.list_backends:
        availability = backend_availability()
        print(
            json.dumps(
                {
                    "version": 1,
                    "selectedAutoBackend": resolve_backend("auto"),
                    "backends": availability,
                    "recommendation": (
                        "Use speechbrain-ecapa for stronger product claims when available; "
                        "mfcc-cosine is only a local proxy."
                    ),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return

    if not args.report:
        parser.error("report is required unless --list-backends is used")

    report_path = Path(args.report).expanduser().resolve()
    report = load_json(report_path)
    rows = report_renders(report if isinstance(report, dict) else {})
    profile_references = profile_reference_rows(Path(args.profile_json).expanduser().resolve() if args.profile_json else None)
    if args.limit is not None:
        rows = rows[: max(0, args.limit)]
    if not rows:
        raise SystemExit("no render WAVs found in report")

    backend = "dry-run" if args.dry_run else resolve_backend(args.backend)
    embed: Callable[[Path], np.ndarray] | None = None
    if not args.dry_run:
        embed = embedder_for_backend(backend, args)

    base = report_path.parent
    similarity_rows: list[dict[str, Any]] = []
    failures = 0
    for row in rows:
        output_path = resolve_path(str(row["outputWav"]), base)
        reference_raw = str(row.get("referenceAudio") or "").strip()
        result = {
            **row,
            "outputWav": str(output_path),
            "referenceAudio": reference_raw,
            "speakerSimilarity": None,
            "profileReferenceSimilarities": None,
            "profileSpeakerSimilarityAvg": None,
            "profileSpeakerSimilarityMin": None,
            "backend": backend,
            "error": None,
        }
        if not reference_raw:
            result["error"] = "missing referenceAudio"
            failures += 1
            similarity_rows.append(result)
            continue
        reference_path = resolve_path(reference_raw, base)
        result["referenceAudio"] = str(reference_path)
        if args.dry_run:
            references = profile_references.get(str(row.get("voiceProfileId") or ""), [])
            if references:
                result["profileReferenceSimilarities"] = [
                    {
                        "sourceRunId": reference.get("sourceRunId"),
                        "referenceAudio": reference.get("audioPath"),
                        "speakerSimilarity": None,
                    }
                    for reference in references
                ]
            similarity_rows.append(result)
            continue
        if not output_path.exists():
            result["error"] = f"missing output audio: {output_path}"
            failures += 1
            similarity_rows.append(result)
            continue
        if not reference_path.exists():
            result["error"] = f"missing reference audio: {reference_path}"
            failures += 1
            similarity_rows.append(result)
            continue
        try:
            if embed is None:
                raise RuntimeError("speaker similarity backend unavailable")
            output_embedding = embed(output_path)
            result["speakerSimilarity"] = cosine(embed(reference_path), output_embedding)
            references = profile_references.get(str(row.get("voiceProfileId") or ""), [])
            if references:
                profile_rows: list[dict[str, Any]] = []
                profile_failures = 0
                for reference in references:
                    raw_audio = reference.get("audioPath")
                    reference_row = {
                        "sourceRunId": reference.get("sourceRunId"),
                        "referenceAudio": raw_audio,
                        "speakerSimilarity": None,
                        "error": None,
                    }
                    if not isinstance(raw_audio, str) or not raw_audio.strip():
                        reference_row["error"] = "missing profile reference audio"
                        profile_failures += 1
                    else:
                        profile_audio = Path(raw_audio).expanduser().resolve()
                        if not profile_audio.exists():
                            reference_row["error"] = f"missing profile reference audio: {profile_audio}"
                            profile_failures += 1
                        else:
                            reference_row["referenceAudio"] = str(profile_audio)
                            reference_row["speakerSimilarity"] = cosine(embed(profile_audio), output_embedding)
                    profile_rows.append(reference_row)
                profile_values = [
                    float(item["speakerSimilarity"])
                    for item in profile_rows
                    if isinstance(item.get("speakerSimilarity"), (int, float))
                ]
                result["profileReferenceSimilarities"] = profile_rows
                result["profileSpeakerSimilarityAvg"] = round(sum(profile_values) / len(profile_values), 6) if profile_values else None
                result["profileSpeakerSimilarityMin"] = round(min(profile_values), 6) if profile_values else None
                if profile_failures:
                    result["error"] = f"profile reference scoring failed for {profile_failures} clip(s)"
                    failures += profile_failures
        except Exception as exc:  # noqa: BLE001
            result["error"] = str(exc)
            failures += 1
        similarity_rows.append(result)

    scored_values = [
        float(row["speakerSimilarity"])
        for row in similarity_rows
        if isinstance(row.get("speakerSimilarity"), (int, float))
    ]
    payload = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceReport": str(report_path),
        "backend": backend,
        "model": args.model,
        "dryRun": args.dry_run,
        "similarities": similarity_rows,
        "summary": {
            "total": len(similarity_rows),
            "scored": len(scored_values),
            "failed": failures,
            "avgSpeakerSimilarity": round(sum(scored_values) / len(scored_values), 6) if scored_values else None,
            "minSpeakerSimilarity": round(min(scored_values), 6) if scored_values else None,
            "profileReferenceScored": sum(
                len(
                    [
                        item
                        for item in row.get("profileReferenceSimilarities", []) or []
                        if isinstance(item, dict) and isinstance(item.get("speakerSimilarity"), (int, float))
                    ]
                )
                for row in similarity_rows
                if isinstance(row.get("profileReferenceSimilarities"), list)
            ),
        },
    }
    out_path = Path(args.out).expanduser().resolve() if args.out else report_path.parent / "speaker.json"
    write_json(out_path, payload)
    print(json.dumps({"speakerJson": str(out_path), **payload["summary"], "backend": backend}, ensure_ascii=False))
    if args.strict and failures:
        sys.exit(2)


if __name__ == "__main__":
    main()
