from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from build_voice_profile import strict_traditional_script_errors
from import_voice_profile_clips import field, load_json, load_manifest, normalized_transcript, resolve_audio_path


REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_EXTENSIONS = [".wav", ".m4a", ".mp3", ".webm", ".aac", ".caf", ".aiff", ".aif", ".flac", ".ogg", ".opus"]
SOURCE_STEM_SUFFIXES = ["", ".source", ".export", "-source", "-export"]


def utc_stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command(parts: list[str]) -> str:
    return " ".join(shlex.quote(str(part)) for part in parts)


def manifest_metadata(path: Path) -> dict[str, Any]:
    if path.suffix.lower() != ".json":
        return {}
    parsed = load_json(path)
    return parsed if isinstance(parsed, dict) else {}


def prompt_path_for_clip(manifest_dir: Path, clip_id: str) -> Path:
    return manifest_dir / "prompts" / f"{clip_id}.txt"


def clip_specs(manifest_path: Path) -> list[dict[str, Any]]:
    rows = load_manifest(manifest_path)
    specs: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        raw_audio = field(row, ("audioPath", "audio", "path", "file"))
        if not raw_audio:
            raise SystemExit(f"manifest row {index} is missing audioPath/audio/path/file")
        transcript = normalized_transcript(field(row, ("transcript", "promptTranscript", "text")))
        if not transcript:
            raise SystemExit(f"manifest row {index} is missing transcript/promptTranscript/text")
        script_errors = strict_traditional_script_errors(transcript)
        if script_errors:
            raise SystemExit(
                f"manifest row {index} transcript must use strict Traditional Chinese before audio is normalized "
                f"(errors={','.join(script_errors)})"
            )
        clip_id = field(row, ("id", "runId", "sourceRunId")) or f"profile-clip-{index:02d}"
        prompt_path = prompt_path_for_clip(manifest_path.parent, clip_id)
        prompt_transcript = ""
        if prompt_path.exists():
            prompt_transcript = normalized_transcript(prompt_path.read_text(encoding="utf-8"))
        specs.append(
            {
                "index": index,
                "id": clip_id,
                "audioPath": resolve_audio_path(raw_audio, manifest_path.parent),
                "transcript": transcript,
                "transcriptSha256": text_sha256(transcript),
                "promptPath": prompt_path,
                "promptTranscript": prompt_transcript,
                "pronunciationNotes": row.get("pronunciationNotes") if isinstance(row.get("pronunciationNotes"), list) else [],
            }
        )
    return specs


def source_candidates(spec: dict[str, Any], source_dirs: list[Path]) -> list[Path]:
    target_path: Path = spec["audioPath"]
    clip_id = str(spec["id"])
    stems = [target_path.stem, clip_id]
    names = [target_path.name]
    candidates: list[Path] = []
    seen: set[str] = set()
    for source_dir in source_dirs:
        for name in names:
            candidate = (source_dir / name).expanduser().resolve()
            key = str(candidate)
            if key not in seen:
                seen.add(key)
                candidates.append(candidate)
        for name in expected_source_names(stems):
            candidate = (source_dir / name).expanduser().resolve()
            key = str(candidate)
            if key not in seen:
                seen.add(key)
                candidates.append(candidate)
    return candidates


def expected_source_names(stems: list[str]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for stem in stems:
        if not stem:
            continue
        for suffix in SOURCE_STEM_SUFFIXES:
            for ext in SOURCE_EXTENSIONS:
                name = f"{stem}{suffix}{ext}"
                if name not in seen:
                    seen.add(name)
                    names.append(name)
    return names


def find_source(spec: dict[str, Any], source_dirs: list[Path]) -> Path | None:
    target_path: Path = spec["audioPath"]
    for candidate in source_candidates(spec, source_dirs):
        if candidate == target_path:
            continue
        if candidate.exists() and candidate.is_file() and candidate.stat().st_size > 0:
            return candidate
    return None


def write_recording_metadata(
    *,
    spec: dict[str, Any],
    source_path: Path,
    method: str,
    conversion_command: str | None,
) -> Path:
    target_path: Path = spec["audioPath"]
    metadata_path = target_path.with_name(f"{target_path.name}.recording.json")
    prompt_transcript = str(spec.get("promptTranscript") or "")
    metadata_path.write_text(
        json.dumps(
            {
                "normalizedAt": utc_stamp(),
                "id": spec["id"],
                "index": spec["index"],
                "audioPath": str(target_path),
                "audioBytes": target_path.stat().st_size,
                "audioSha256": file_sha256(target_path),
                "sourceAudioPath": str(source_path),
                "sourceAudioBytes": source_path.stat().st_size,
                "sourceAudioSha256": file_sha256(source_path),
                "promptPath": str(spec["promptPath"]),
                "transcript": spec["transcript"],
                "transcriptSha256": spec["transcriptSha256"],
                "promptTranscript": prompt_transcript,
                "promptTranscriptSha256": text_sha256(prompt_transcript) if prompt_transcript else None,
                "pronunciationNotes": spec.get("pronunciationNotes", []),
                "normalizer": "normalize_voice_profile_recording_kit_audio.py",
                "normalizerMethod": method,
                "conversionCommand": conversion_command,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return metadata_path


def normalize_audio(
    *,
    source_path: Path,
    target_path: Path,
    dry_run: bool,
) -> tuple[str, str | None]:
    if source_path.suffix.lower() == target_path.suffix.lower() == ".wav":
        if not dry_run:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, target_path)
        return "copy", None

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to convert non-WAV kit recordings")
    conversion_command = command(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(source_path),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            str(target_path),
        ]
    )
    if dry_run:
        return "convert", conversion_command
    target_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(source_path),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            str(target_path),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"ffmpeg exited {proc.returncode}"
        raise RuntimeError(detail)
    return "convert", conversion_command


def run_kit_check(manifest_path: Path, profile_id: str) -> dict[str, Any] | None:
    proc = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "check_voice_profile_recording_kit.py"),
            "--manifest",
            str(manifest_path),
            "--profile-id",
            profile_id,
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {
            "status": "invalid",
            "exitCode": proc.returncode,
            "stdout": proc.stdout.strip() or None,
            "stderr": proc.stderr.strip() or None,
        }
    if isinstance(payload, dict):
        payload["exitCode"] = proc.returncode
        return payload
    return None


def normalize_recordings(
    *,
    manifest_path: Path,
    source_dirs: list[Path],
    overwrite: bool,
    dry_run: bool,
    only_present: bool,
    write_metadata: bool,
    profile_id: str,
    run_check_after: bool,
) -> dict[str, Any]:
    specs = clip_specs(manifest_path)
    default_source_dirs = [manifest_path.parent / "recordings"]
    effective_source_dirs = [path.expanduser().resolve() for path in (source_dirs or default_source_dirs)]
    rows: list[dict[str, Any]] = []
    missing = 0
    written = 0
    skipped = 0
    failures: list[dict[str, Any]] = []

    for spec in specs:
        target_path: Path = spec["audioPath"]
        if target_path.exists() and target_path.stat().st_size > 0 and not overwrite:
            skipped += 1
            rows.append(
                {
                    "index": spec["index"],
                    "id": spec["id"],
                    "status": "exists",
                    "audioPath": str(target_path),
                    "message": "target recording already exists; pass --overwrite to replace it",
                }
            )
            continue

        source_path = find_source(spec, effective_source_dirs)
        if not source_path:
            missing += 1
            rows.append(
                {
                    "index": spec["index"],
                    "id": spec["id"],
                    "status": "missing_source_skipped" if only_present else "missing_source",
                    "audioPath": str(target_path),
                    "expectedSourceNames": sorted(expected_source_names([target_path.stem, str(spec["id"])])),
                }
            )
            continue

        try:
            method, conversion_command = normalize_audio(source_path=source_path, target_path=target_path, dry_run=dry_run)
            metadata_path = None
            if write_metadata and not dry_run:
                metadata_path = write_recording_metadata(
                    spec=spec,
                    source_path=source_path,
                    method=method,
                    conversion_command=conversion_command,
                )
        except Exception as exc:  # noqa: BLE001
            failures.append({"index": spec["index"], "id": spec["id"], "message": str(exc)})
            rows.append(
                {
                    "index": spec["index"],
                    "id": spec["id"],
                    "status": "failed",
                    "sourceAudioPath": str(source_path),
                    "audioPath": str(target_path),
                    "message": str(exc),
                }
            )
            continue

        written += 1
        rows.append(
            {
                "index": spec["index"],
                "id": spec["id"],
                "status": "planned" if dry_run else "normalized",
                "method": method,
                "sourceAudioPath": str(source_path),
                "audioPath": str(target_path),
                "recordingMetadataPath": str(metadata_path) if metadata_path else None,
                "conversionCommand": conversion_command,
            }
        )

    if failures:
        status = "blocked"
    elif missing and only_present and written:
        status = "planned_partial" if dry_run else "partial_normalized"
    elif missing:
        status = "blocked"
    else:
        status = "planned" if dry_run else ("normalized" if written else "all_recordings_present")
    payload: dict[str, Any] = {
        "status": status,
        "manifest": str(manifest_path),
        "profileId": profile_id,
        "dryRun": dry_run,
        "overwrite": overwrite,
        "onlyPresent": only_present,
        "sourceDirs": [str(path) for path in effective_source_dirs],
        "summary": {
            "clips": len(specs),
            "normalized": written,
            "existing": skipped,
            "missingSources": missing,
            "failures": len(failures),
        },
        "rows": rows,
        "nextCommands": {
            "normalizeFromRecordingsDir": command(
                [
                    "python3",
                    "scripts/normalize_voice_profile_recording_kit_audio.py",
                    "--manifest",
                    str(manifest_path),
                    "--check",
                    "--profile-id",
                    profile_id,
                ]
            ),
            "normalizePresentSources": command(
                [
                    "python3",
                    "scripts/normalize_voice_profile_recording_kit_audio.py",
                    "--manifest",
                    str(manifest_path),
                    "--only-present",
                    "--profile-id",
                    profile_id,
                ]
            ),
            "checkRecordingKit": command(
                [
                    "python3",
                    "scripts/check_voice_profile_recording_kit.py",
                    "--manifest",
                    str(manifest_path),
                    "--profile-id",
                    profile_id,
                ]
            ),
        },
    }
    metadata = manifest_metadata(manifest_path)
    if metadata:
        payload["kit"] = {
            "promptSet": metadata.get("promptSet"),
            "requiredClips": metadata.get("requiredClips"),
            "recordingsDir": str(manifest_path.parent / "recordings"),
            "cueSheetHtml": str(manifest_path.parent / "cue-sheet.html"),
        }
    if run_check_after and not dry_run and status != "blocked":
        check_report = run_kit_check(manifest_path, profile_id)
        payload["checkReport"] = check_report
        if not check_report or check_report.get("status") != "ready_to_import":
            payload["status"] = "check_failed"
    return payload


def print_brief(payload: dict[str, Any]) -> None:
    lines = [
        f"Status: {payload['status']}",
        f"Manifest: {payload['manifest']}",
        f"Sources: {', '.join(payload.get('sourceDirs', []))}",
    ]
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    lines.append(
        "Summary: "
        f"{summary.get('normalized', 0)} normalized, "
        f"{summary.get('existing', 0)} existing, "
        f"{summary.get('missingSources', 0)} missing sources, "
        f"{summary.get('failures', 0)} failures"
    )
    lines.append("")
    lines.append("Rows:")
    for row in payload.get("rows", []):
        if not isinstance(row, dict):
            continue
        source = row.get("sourceAudioPath")
        target = row.get("audioPath")
        method = f" ({row.get('method')})" if row.get("method") else ""
        if source:
            lines.append(f"- {row.get('id')}: {row.get('status')}{method} {source} -> {target}")
        else:
            lines.append(f"- {row.get('id')}: {row.get('status')} {target}")
    next_commands = payload.get("nextCommands") if isinstance(payload.get("nextCommands"), dict) else {}
    check_command = next_commands.get("checkRecordingKit")
    if isinstance(check_command, str):
        lines.extend(["", f"Check: {check_command}"])
    print("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Normalize externally recorded AnyVoice kit audio into the exact manifest WAV paths."
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument(
        "--source-dir",
        action="append",
        default=[],
        help="Directory containing files named like profile-clip-01.m4a or profile-clip-01.wav. Defaults to the kit recordings directory.",
    )
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--only-present",
        action="store_true",
        help="Normalize source files that are present and skip missing sources without failing when progress was made.",
    )
    parser.add_argument("--check", action="store_true", help="Run the recording-kit checker after normalization.")
    parser.add_argument("--brief", action="store_true")
    parser.add_argument("--no-write-metadata", action="store_true")
    args = parser.parse_args()

    payload = normalize_recordings(
        manifest_path=Path(args.manifest).expanduser().resolve(),
        source_dirs=[Path(path) for path in args.source_dir],
        overwrite=args.overwrite,
        dry_run=args.dry_run,
        only_present=args.only_present,
        write_metadata=not args.no_write_metadata,
        profile_id=args.profile_id,
        run_check_after=args.check,
    )
    if args.brief:
        print_brief(payload)
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    if payload["status"] in {"blocked", "failed", "check_failed"} and not args.dry_run:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
