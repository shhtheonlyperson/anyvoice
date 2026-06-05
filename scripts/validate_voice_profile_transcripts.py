from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from score_voice_regression import (
    TEXT_SCORING_POLICY,
    add_transcript_key,
    error_rate,
    load_json,
    normalize_for_cer,
    tokenize_for_wer,
    transcript_from_value,
    write_json,
)
from transcribe_voice_regression import resolve_backend, transcriber_for_backend


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
DEFAULT_OUT_ROOT = REPO_ROOT / "generated" / "voice-profile-transcript-validation"


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def canonical_profile_sha256(profile: dict[str, Any]) -> str:
    payload = dict(profile)
    payload.pop("createdAt", None)
    payload.pop("loraPath", None)
    payload.pop("loraAdapter", None)
    payload.pop("preferredBackend", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def profile_clips(profile: dict[str, Any]) -> list[dict[str, Any]]:
    clips = profile.get("clips")
    if not isinstance(clips, list):
        return []
    max_clips = 10
    requirements = profile.get("requirements")
    if isinstance(requirements, dict) and isinstance(requirements.get("maxClips"), int):
        max_clips = int(requirements["maxClips"])
    return [clip for clip in clips if isinstance(clip, dict)][:max_clips]


def resolve_audio_path(profile_path: Path, raw_path: str) -> Path:
    audio_path = Path(raw_path).expanduser()
    if not audio_path.is_absolute():
        audio_path = profile_path.parent / audio_path
    return audio_path.resolve()


def load_asr_index(path: Path | None) -> dict[str, str]:
    if not path:
        return {}
    data = load_json(path)
    if isinstance(data, dict) and "transcripts" in data:
        data = data["transcripts"]
    index: dict[str, str] = {}
    if isinstance(data, dict):
        for key, value in data.items():
            transcript = transcript_from_value(value)
            if transcript is not None:
                add_transcript_key(index, str(key), transcript)
        return index
    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            transcript = transcript_from_value(row)
            if transcript is None:
                continue
            for key_name in ("sourceRunId", "id", "runId", "audioPath", "referenceAudio", "outputWav", "file"):
                value = row.get(key_name)
                if isinstance(value, str):
                    add_transcript_key(index, value, transcript)
            clip_index = row.get("index")
            if isinstance(clip_index, int):
                add_transcript_key(index, str(clip_index), transcript)
    return index


def asr_for_clip(clip: dict[str, Any], audio_path: Path, asr_index: dict[str, str]) -> str | None:
    keys = [
        str(clip.get("sourceRunId") or ""),
        str(clip.get("id") or ""),
        str(clip.get("runId") or ""),
        str(clip.get("audioPath") or ""),
        str(audio_path),
        audio_path.name,
    ]
    for key in keys:
        if key and key in asr_index:
            return asr_index[key]
    return None


def score_clip(
    *,
    clip: dict[str, Any],
    index: int,
    profile_path: Path,
    asr_index: dict[str, str],
    transcribe: Any,
    dry_run: bool,
    max_cer: float,
    max_wer: float,
) -> dict[str, Any]:
    source_run_id = str(clip.get("sourceRunId") or f"clip-{index}").strip()
    raw_audio_path = str(clip.get("audioPath") or "").strip()
    expected = str(clip.get("transcriptRaw") or "").strip()
    row: dict[str, Any] = {
        "index": index,
        "sourceRunId": source_run_id,
        "audioPath": raw_audio_path,
        "expectedTranscript": expected,
        "asrTranscript": None,
        "cer": None,
        "wer": None,
        "verdict": "planned" if dry_run else "missing_asr",
        "error": None,
    }
    if not raw_audio_path:
        row["verdict"] = "missing_audio"
        row["error"] = "missing audioPath"
        return row
    if not expected:
        row["verdict"] = "missing_expected_transcript"
        row["error"] = "missing transcriptRaw"
        return row

    audio_path = resolve_audio_path(profile_path, raw_audio_path)
    row["audioPath"] = str(audio_path)
    if dry_run:
        return row
    if not audio_path.exists():
        row["verdict"] = "missing_audio"
        row["error"] = f"missing audio: {audio_path}"
        return row

    asr_text = asr_for_clip(clip, audio_path, asr_index)
    if asr_text is None and transcribe is not None:
        try:
            result = transcribe(audio_path)
            asr_text = transcript_from_value(result)
        except Exception as exc:  # noqa: BLE001
            row["verdict"] = "asr_error"
            row["error"] = str(exc)
            return row
    if asr_text is None:
        return row

    cer = error_rate(normalize_for_cer(expected), normalize_for_cer(asr_text))
    wer = error_rate(tokenize_for_wer(expected), tokenize_for_wer(asr_text))
    row.update(
        {
            "asrTranscript": asr_text,
            "cer": cer,
            "wer": wer,
            "verdict": "pass" if cer["rate"] <= max_cer and wer["rate"] <= max_wer else "fail",
        }
    )
    return row


def average(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 6) if values else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate AnyVoice profile transcripts against ASR before using a digital voice profile.")
    parser.add_argument("--profile-json", default=str(DEFAULT_PROFILE_JSON))
    parser.add_argument("--asr-json", help="Optional external ASR JSON keyed by sourceRunId or audio path.")
    parser.add_argument("--out", help="Output JSON path. Defaults to generated/voice-profile-transcript-validation/<profile-id>-<timestamp>.json.")
    parser.add_argument("--backend", choices=("auto", "faster-whisper", "whisper-cli"), default="auto")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-filter", action="store_true")
    parser.add_argument("--fp16", choices=("true", "false"))
    parser.add_argument("--max-cer", type=float, default=0.18)
    parser.add_argument("--max-wer", type=float, default=0.28)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero unless every selected clip passes.")
    args = parser.parse_args()

    args.language = args.language or None
    args.fp16 = None if args.fp16 is None else args.fp16 == "true"

    profile_path = Path(args.profile_json).expanduser().resolve()
    profile = load_json(profile_path)
    if not isinstance(profile, dict):
        raise SystemExit(f"profile is not a JSON object: {profile_path}")
    clips = profile_clips(profile)
    if args.limit is not None:
        clips = clips[: max(0, args.limit)]
    if not clips:
        raise SystemExit("profile has no selected clips to validate")

    asr_index = load_asr_index(Path(args.asr_json).expanduser().resolve() if args.asr_json else None)
    backend = "external-asr" if args.asr_json else ("dry-run" if args.dry_run else resolve_backend(args.backend))
    transcribe = None
    if not args.dry_run and not args.asr_json:
        transcribe = transcriber_for_backend(backend, args)

    rows = [
        score_clip(
            clip=clip,
            index=index,
            profile_path=profile_path,
            asr_index=asr_index,
            transcribe=transcribe,
            dry_run=args.dry_run,
            max_cer=args.max_cer,
            max_wer=args.max_wer,
        )
        for index, clip in enumerate(clips, start=1)
    ]
    pass_count = sum(1 for row in rows if row["verdict"] == "pass")
    failed_rows = [row for row in rows if row["verdict"] != "pass" and row["verdict"] != "planned"]
    cer_values = [float(row["cer"]["rate"]) for row in rows if isinstance(row.get("cer"), dict)]
    wer_values = [float(row["wer"]["rate"]) for row in rows if isinstance(row.get("wer"), dict)]
    status = "planned" if args.dry_run else ("pass" if pass_count == len(rows) else "blocked")
    payload = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "profile": str(profile_path),
        "profileSha256": canonical_profile_sha256(profile),
        "voiceProfileId": profile.get("voiceProfileId"),
        "backend": backend,
        "model": args.model,
        "language": args.language,
        "thresholds": {"maxCer": args.max_cer, "maxWer": args.max_wer},
        "textScoringPolicy": TEXT_SCORING_POLICY,
        "status": status,
        "summary": {
            "total": len(rows),
            "passed": pass_count,
            "failed": len(failed_rows),
            "avgCer": average(cer_values),
            "maxCer": max(cer_values) if cer_values else None,
            "avgWer": average(wer_values),
            "maxWer": max(wer_values) if wer_values else None,
        },
        "clips": rows,
    }
    out_path = (
        Path(args.out).expanduser().resolve()
        if args.out
        else DEFAULT_OUT_ROOT / f"{profile.get('voiceProfileId') or 'local-default'}-{utc_stamp()}.json"
    )
    write_json(out_path, payload)
    print(json.dumps({"validationJson": str(out_path), **payload["summary"], "status": status, "backend": backend}, ensure_ascii=False))
    if args.strict and status != "pass":
        sys.exit(2)


if __name__ == "__main__":
    main()
