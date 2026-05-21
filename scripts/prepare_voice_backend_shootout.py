from __future__ import annotations

import argparse
import json
import shlex
import string
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from voice_clone_regression import (
    DEFAULT_EVAL_SET,
    DEFAULT_PROFILE_JSON,
    default_stability_seed,
    detect_chinese_script,
    load_eval_set,
    load_profile,
    prepare_voice_text,
    profile_clips,
    pronunciation_overrides_from_case,
    read_prompt_text,
    reference_for_case,
    require_profile_target_scripts,
    require_ready_profile,
    select_cases,
    shell_join,
    utc_stamp,
)
from verify_voice_profile_ready import readiness_report as verify_profile_readiness_report


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_RENDER_COMMAND = "ANYVOICE_BACKEND_RENDER_COMMAND"
ALLOWED_COMMAND_PLACEHOLDERS = {
    "backend",
    "case_id",
    "repeat",
    "target_text",
    "target_text_file",
    "target_text_raw",
    "target_text_raw_file",
    "text_prep_file",
    "reference_audio",
    "prompt_text_file",
    "output_wav",
    "seed",
}


class QuotedTemplateValues(dict[str, str]):
    def __missing__(self, key: str) -> str:
        raise KeyError(
            f"unknown command template placeholder {{{key}}}; "
            f"allowed placeholders: {', '.join(sorted(ALLOWED_COMMAND_PLACEHOLDERS))}"
        )


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def safe_backend_id(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in value.strip().lower())
    return safe.strip("-") or "backend"


def command_template_fields(command_template: str) -> set[str]:
    fields: set[str] = set()
    try:
        parsed = string.Formatter().parse(command_template)
        for _, field_name, _, _ in parsed:
            if not field_name:
                continue
            field_root = field_name.split(".", 1)[0].split("[", 1)[0]
            if field_root not in ALLOWED_COMMAND_PLACEHOLDERS:
                raise SystemExit(
                    f"unknown command template placeholder {{{field_root}}}; "
                    f"allowed placeholders: {', '.join(sorted(ALLOWED_COMMAND_PLACEHOLDERS))}"
                )
            fields.add(field_root)
    except ValueError as exc:
        raise SystemExit(f"invalid command template: {exc}") from exc
    return fields


def validate_command_template(command_template: str, *, source: str) -> None:
    fields = command_template_fields(command_template)
    if "output_wav" not in fields:
        raise SystemExit(f"{source} must include {{output_wav}} so renders land at the planned output path")
    if "reference_audio" not in fields:
        raise SystemExit(f"{source} must include {{reference_audio}} so clone identity evidence is fixed per job")
    if not {"target_text_file", "target_text"}.intersection(fields):
        raise SystemExit(f"{source} must include {{target_text_file}} or {{target_text}} for model-facing text input")


def resolve_existing_or_planned(path_value: str, *, dry_run: bool, label: str) -> Path:
    path = Path(path_value).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve(strict=False)
    if not dry_run and not path.exists():
        raise SystemExit(f"{label} is missing: {path}")
    return path.resolve(strict=False)


def same_resolved_path(raw_path: Any, expected_path: Path, base_dir: Path) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False) == expected_path.resolve(strict=False)


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"{label} not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} is not valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"{label} is not a JSON object: {path}")
    return payload


def transcript_validation_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("clips")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def validate_profile_transcript_validation(
    *,
    profile_path: Path,
    profile: dict[str, Any],
    transcript_validation_json: Path,
) -> None:
    payload = load_json_object(transcript_validation_json, "transcript validation JSON")
    if payload.get("status") != "pass":
        raise SystemExit(
            "transcript validation JSON must pass before a profile backend shootout: "
            f"status={payload.get('status')!r} ({transcript_validation_json})"
        )
    if not same_resolved_path(payload.get("profile"), profile_path, transcript_validation_json.parent):
        raise SystemExit(
            "transcript validation JSON does not match the shootout profile: "
            f"{payload.get('profile')!r} != {profile_path} ({transcript_validation_json})"
        )
    by_source = {str(row.get("sourceRunId") or ""): row for row in transcript_validation_rows(payload) if row.get("sourceRunId")}
    missing: list[str] = []
    failed: list[str] = []
    for clip in profile_clips(profile):
        source_run_id = str(clip.get("sourceRunId") or "").strip()
        if not source_run_id:
            continue
        row = by_source.get(source_run_id)
        if not row:
            missing.append(source_run_id)
        elif row.get("verdict") != "pass":
            failed.append(source_run_id)
    if missing or failed:
        raise SystemExit(
            "transcript validation JSON does not pass every selected profile clip before backend shootout: "
            f"{len(missing)} missing, {len(failed)} failed ({transcript_validation_json})"
        )


def require_strict_ready_profile(
    *,
    profile_path: Path,
    profile: dict[str, Any],
    transcript_validation_json: Path,
) -> None:
    report = verify_profile_readiness_report(
        profile_path=profile_path,
        profile=profile,
        min_clips_override=None,
        min_total_duration_sec=30.0,
        check_audio_exists=True,
        audio_exists_bypass_reason=None,
        transcript_validation_json=transcript_validation_json,
        require_transcript_validation=True,
    )
    if report.get("status") == "ready":
        return
    failed = [
        f"{row.get('check')}: {row.get('message')}"
        for row in report.get("checks", [])
        if isinstance(row, dict) and row.get("ok") is not True
    ]
    detail = "; ".join(failed[:6]) or "strict verifier returned blocked"
    raise SystemExit(
        "profile backend shootout requires strict ready profile proof before planning: "
        f"{detail} ({profile_path})"
    )


def materialize_prompt_text(
    *,
    out_dir: Path,
    prompt_text: str,
    prompt_text_file: str | None,
    dry_run: bool,
) -> Path:
    if prompt_text_file:
        return resolve_existing_or_planned(prompt_text_file, dry_run=dry_run, label="prompt text file")
    prompt_path = out_dir / "reference" / "prompt-transcript.txt"
    write_text(prompt_path, f"{prompt_text.strip()}\n")
    return prompt_path


def quoted_template_values(job: dict[str, Any]) -> QuotedTemplateValues:
    return QuotedTemplateValues(
        {
            "backend": shlex.quote(str(job["backend"])),
            "case_id": shlex.quote(str(job["caseId"])),
            "repeat": shlex.quote(str(job["repeat"])),
            "target_text": shlex.quote(str(job["targetText"])),
            "target_text_file": shlex.quote(str(job["targetTextFile"])),
            "target_text_raw": shlex.quote(str(job["targetTextRaw"])),
            "target_text_raw_file": shlex.quote(str(job["targetTextRawFile"])),
            "text_prep_file": shlex.quote(str(job["textPrepFile"])),
            "reference_audio": shlex.quote(str(job["referenceAudio"])),
            "prompt_text_file": shlex.quote(str(job["promptTextFile"])),
            "output_wav": shlex.quote(str(job["outputWav"])),
            "seed": shlex.quote("" if job.get("stabilitySeed") is None else str(job["stabilitySeed"])),
        }
    )


def render_command(command_template: str | None, job: dict[str, Any]) -> str:
    if not command_template:
        return f"runtime-env:{ENV_RENDER_COMMAND}"
    try:
        return command_template.format_map(quoted_template_values(job))
    except KeyError as exc:
        raise SystemExit(str(exc)) from exc


def build_jobs(
    *,
    out_dir: Path,
    backends: list[str],
    cases: list[dict[str, Any]],
    repeats: int,
    reference_audio: str,
    prompt_text_file: Path,
    profile_path: Path | None,
    profile: dict[str, Any] | None,
    dry_run: bool,
    command_template: str | None,
    stability_seed: int | None,
) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    target_dir = out_dir / "targets"
    prompt_dir = out_dir / "reference-prompts"

    for case in cases:
        case_id = str(case["id"])
        target_text_raw = str(case["text"])
        target_preparation = prepare_voice_text(
            target_text_raw,
            auto_apply_presets=True,
            pronunciation_overrides=pronunciation_overrides_from_case(case),
        )
        target_text = str(target_preparation["model"])
        text_preparation = {
            "version": 1,
            "targetText": target_preparation,
        }
        target_text_file = target_dir / f"{case_id}.txt"
        target_text_raw_file = target_dir / f"{case_id}.raw.txt"
        text_prep_file = target_dir / f"{case_id}.text-prep.json"
        write_text(target_text_file, f"{target_text}\n")
        write_text(target_text_raw_file, f"{target_text_raw}\n")
        write_text(text_prep_file, json.dumps(text_preparation, ensure_ascii=False, indent=2) + "\n")

        reference = reference_for_case(
            case=case,
            reference_audio=reference_audio,
            prompt_text=prompt_text_file.read_text(encoding="utf-8").strip() if prompt_text_file.exists() else "",
            profile_path=profile_path,
            profile=profile,
            dry_run=dry_run,
        )
        case_prompt_text_file = prompt_text_file
        if reference.get("promptText"):
            profile_clip_id = str(reference.get("profileClipId") or "reference")
            case_prompt_text_file = prompt_dir / f"{safe_backend_id(profile_clip_id)}-{case_id}.txt"
            write_text(case_prompt_text_file, f"{str(reference['promptText']).strip()}\n")

        for backend in backends:
            backend_id = safe_backend_id(backend)
            for repeat in range(1, repeats + 1):
                output_wav = out_dir / "renders" / backend_id / f"{case_id}-r{repeat:02d}.wav"
                job: dict[str, Any] = {
                    "backend": backend,
                    "caseId": case_id,
                    "repeat": repeat,
                    "rendererStatus": "ready" if command_template else "needs_renderer_command",
                    "commandTemplateSource": "cli" if command_template else "runtime_env",
                    "commandTemplateEnv": None if command_template else ENV_RENDER_COMMAND,
                    "targetText": target_text,
                    "targetTextRaw": target_text_raw,
                    "targetScript": detect_chinese_script(target_text_raw),
                    "targetTextFile": str(target_text_file),
                    "targetTextRawFile": str(target_text_raw_file),
                    "textPrepFile": str(text_prep_file),
                    "textPreparation": text_preparation,
                    "stabilitySeed": stability_seed,
                    "referenceAudio": str(reference["referenceAudio"]),
                    "promptTextFile": str(case_prompt_text_file),
                    "voiceProfileId": reference.get("voiceProfileId"),
                    "profileClipId": reference.get("profileClipId"),
                    "targetCoverageFeatures": reference.get("targetCoverageFeatures"),
                    "matchedCoverageFeatures": reference.get("matchedCoverageFeatures"),
                    "targetPronunciationPresetIds": reference.get("targetPronunciationPresetIds"),
                    "matchedPronunciationPresetIds": reference.get("matchedPronunciationPresetIds"),
                    "outputWav": str(output_wav),
                }
                job["command"] = render_command(command_template, job)
                jobs.append(job)

    return jobs


def manifest_from_jobs(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": 1,
        "description": "Planned external backend renders for AnyVoice scoring.",
        "renders": [
            {
                "backend": job["backend"],
                "caseId": job["caseId"],
                "repeat": job["repeat"],
                "rendererStatus": job["rendererStatus"],
                "commandTemplateSource": job["commandTemplateSource"],
                "commandTemplateEnv": job.get("commandTemplateEnv"),
                "referenceAudio": job["referenceAudio"],
                "promptTextFile": job["promptTextFile"],
                "targetTextFile": job["targetTextFile"],
                "targetTextRawFile": job["targetTextRawFile"],
                "textPrepFile": job["textPrepFile"],
                "textPreparation": job["textPreparation"],
                "stabilitySeed": job["stabilitySeed"],
                "voiceProfileId": job.get("voiceProfileId"),
                "profileClipId": job.get("profileClipId"),
                "targetCoverageFeatures": job.get("targetCoverageFeatures"),
                "matchedCoverageFeatures": job.get("matchedCoverageFeatures"),
                "targetPronunciationPresetIds": job.get("targetPronunciationPresetIds"),
                "matchedPronunciationPresetIds": job.get("matchedPronunciationPresetIds"),
                "outputWav": job["outputWav"],
                "command": job["command"],
                "metadataJson": {
                    "plannedBy": "scripts/prepare_voice_backend_shootout.py",
                    "targetTextFile": job["targetTextFile"],
                    "targetTextRawFile": job["targetTextRawFile"],
                    "textPrepFile": job["textPrepFile"],
                    "textPreparation": job["textPreparation"],
                    "targetScript": job["targetScript"],
                    "stabilitySeed": job["stabilitySeed"],
                },
            }
            for job in jobs
        ],
    }


def write_env_render_helper(lines: list[str]) -> None:
    allowed_json = json.dumps(sorted(ALLOWED_COMMAND_PLACEHOLDERS))
    required_text_json = json.dumps(sorted(["target_text_file", "target_text"]))
    lines.extend(
        [
            f'if [[ -z "${{{ENV_RENDER_COMMAND}:-}}" ]]; then',
            "  cat >&2 <<'EOF'",
            f"Missing renderer command template. Set {ENV_RENDER_COMMAND} to run this plan.",
            "",
            "Example:",
            f"{ENV_RENDER_COMMAND}='python render_backend.py --backend {{backend}} --text-file {{target_text_file}} --reference {{reference_audio}} --prompt {{prompt_text_file}} --out {{output_wav}}' ./render.sh",
            "",
            "Required placeholders: {output_wav}, {reference_audio}, and one of {target_text_file} or {target_text}.",
            "Allowed placeholders: {backend}, {case_id}, {repeat}, {target_text}, {target_text_file}, {target_text_raw}, {target_text_raw_file}, {text_prep_file}, {reference_audio}, {prompt_text_file}, {output_wav}.",
            "EOF",
            "  exit 64",
            "fi",
            "",
            "render_with_env_template() {",
            "  python3 - \"$@\" <<'PY'",
            "import shlex",
            "import string",
            "import sys",
            "",
            f"allowed = set({allowed_json})",
            f"required_text = set({required_text_json})",
            "template = sys.argv[1]",
            "keys = [",
            "    'backend',",
            "    'case_id',",
            "    'repeat',",
            "    'target_text',",
            "    'target_text_file',",
            "    'target_text_raw',",
            "    'target_text_raw_file',",
            "    'text_prep_file',",
            "    'reference_audio',",
            "    'prompt_text_file',",
            "    'output_wav',",
            "]",
            "values = {key: shlex.quote(value) for key, value in zip(keys, sys.argv[2:])}",
            "fields = set()",
            "try:",
            "    for _, field_name, _, _ in string.Formatter().parse(template):",
            "        if not field_name:",
            "            continue",
            "        field_root = field_name.split('.', 1)[0].split('[', 1)[0]",
            "        if field_root not in allowed:",
            "            raise SystemExit(f'unknown command template placeholder {{{field_root}}}')",
            "        fields.add(field_root)",
            "except ValueError as exc:",
            "    raise SystemExit(f'invalid command template: {exc}') from exc",
            "if 'output_wav' not in fields:",
            "    raise SystemExit('command template must include {output_wav}')",
            "if 'reference_audio' not in fields:",
            "    raise SystemExit('command template must include {reference_audio}')",
            "if not required_text.intersection(fields):",
            "    raise SystemExit('command template must include {target_text_file} or {target_text}')",
            "class Values(dict):",
            "    def __missing__(self, key):",
            "        raise KeyError(f'unknown command template placeholder {{{key}}}')",
            "try:",
            "    print(template.format_map(Values(values)))",
            "except KeyError as exc:",
            "    raise SystemExit(str(exc)) from exc",
            "PY",
            "}",
            "",
        ]
    )


def write_render_script(path: Path, jobs: list[dict[str, Any]], *, command_template: str | None) -> None:
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        "# Generated by scripts/prepare_voice_backend_shootout.py.",
    ]
    if not command_template:
        lines.append(f"# Runtime renderer template comes from ${ENV_RENDER_COMMAND}.")
    lines.append("")
    if not command_template:
        write_env_render_helper(lines)
    for job in jobs:
        lines.append(f"mkdir -p {shlex.quote(str(Path(job['outputWav']).parent))}")
        if command_template:
            lines.append(str(job["command"]))
        else:
            lines.append(
                "cmd=$(render_with_env_template "
                + " ".join(
                    [
                        f'"${{{ENV_RENDER_COMMAND}}}"',
                        shlex.quote(str(job["backend"])),
                        shlex.quote(str(job["caseId"])),
                        shlex.quote(str(job["repeat"])),
                        shlex.quote(str(job["targetText"])),
                        shlex.quote(str(job["targetTextFile"])),
                        shlex.quote(str(job["targetTextRaw"])),
                        shlex.quote(str(job["targetTextRawFile"])),
                        shlex.quote(str(job["textPrepFile"])),
                        shlex.quote(str(job["referenceAudio"])),
                        shlex.quote(str(job["promptTextFile"])),
                        shlex.quote(str(job["outputWav"])),
                    ]
                )
                + ")"
            )
            lines.append('echo "+ $cmd"')
            lines.append('eval "$cmd"')
        lines.append("")
    write_text(path, "\n".join(lines))
    path.chmod(0o755)


def write_readme(
    *,
    path: Path,
    jobs: list[dict[str, Any]],
    manifest_path: Path,
    report_dir: Path,
    render_script: Path,
    eval_set: Path,
    command_template: str | None,
) -> None:
    backends = sorted({str(job["backend"]) for job in jobs})
    case_ids = sorted({str(job["caseId"]) for job in jobs})
    register_cmd = [
        "python3",
        "scripts/register_voice_backend_renders.py",
        str(manifest_path),
        "--out-dir",
        str(report_dir),
    ]
    dry_register_cmd = [*register_cmd, "--dry-run"]
    score_cmd = [
        "python3",
        "scripts/score_voice_regression.py",
        str(report_dir / "report.json"),
        "--asr-json",
        str(report_dir / "asr.json"),
        "--speaker-json",
        str(report_dir / "speaker.json"),
        "--out",
        str(report_dir / "score.json"),
        "--strict",
    ]
    text = f"""# AnyVoice Backend Shootout

Generated: {datetime.now(timezone.utc).isoformat()}

Backends: {", ".join(backends)}
Eval set: `{eval_set}`
Cases: {", ".join(case_ids)}
Planned renders: {len(jobs)}

## Render

```bash
{shell_join([str(render_script)])}
```

{"The generated render script is ready to run with the command template that was provided." if command_template else f"The generated render script requires `{ENV_RENDER_COMMAND}` at runtime. It exits before rendering if the env var is missing or if the template omits `{{output_wav}}`, `{{reference_audio}}`, and model-facing text via `{{target_text_file}}` or `{{target_text}}`."}

External renderers should use `targetTextFile` / `{{target_text_file}}` for
model input. The raw eval sentence is preserved separately as
`targetTextRawFile` / `{{target_text_raw_file}}`, and `textPrepFile` records the
pronunciation preset mapping used by the scorer.
`stabilitySeed` / `{{seed}}` is the deterministic seed used for paired
candidate comparison when the backend supports explicit seeding.

## Register Renders

Preview the report shape before WAVs exist:

```bash
{shell_join(dry_register_cmd)}
```

After rendering WAVs:

```bash
{shell_join(register_cmd)}
```

## Score

Run ASR and speaker scoring first, then:

```bash
{shell_join(score_cmd)}
```

Use `--baseline-clone-mode voxcpm2-hifi --candidate-clone-mode <backend> --require-paired-improvement` when the manifest includes both a baseline and candidate backend for the same cases.
"""
    write_text(path, text)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare an executable AnyVoice backend shootout plan for IndexTTS2, F5-TTS, or another external renderer.",
    )
    parser.add_argument("--backend", action="append", help="Backend id to plan. Can be repeated. Defaults to indextts2 and f5-tts.")
    parser.add_argument("--eval-set", default=str(DEFAULT_EVAL_SET))
    parser.add_argument("--case", dest="case_ids", action="append", default=[])
    parser.add_argument("--tag", dest="tags", action="append", default=[])
    parser.add_argument("--max-cases", type=int)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=default_stability_seed(), help="Stability seed forwarded to backend render plans. Set ANYVOICE_STABILITY_SEED=off to disable.")
    parser.add_argument("--out-dir", default=str(REPO_ROOT / "generated" / "voice-backend-shootouts" / utc_stamp()))
    parser.add_argument("--profile-json", default="")
    parser.add_argument("--transcript-validation-json", default="", help="Passing ASR transcript-validation report for --profile-json. Defaults to <profile-dir>/transcript-validation.json.")
    parser.add_argument("--reference-audio", default="")
    parser.add_argument("--prompt-text", default="")
    parser.add_argument("--prompt-text-file", default="")
    parser.add_argument("--dry-run", action="store_true", help="Allow missing reference paths while planning.")
    parser.add_argument(
        "--command-template",
        help=(
            "Shell command template used for each render. Placeholders are shell-quoted: "
            "{backend}, {case_id}, {repeat}, {target_text}, {target_text_file}, "
            "{target_text_raw}, {target_text_raw_file}, {text_prep_file}, "
            "{reference_audio}, {prompt_text_file}, {output_wav}, {seed}."
        ),
    )
    args = parser.parse_args()

    if args.repeats < 1:
        raise SystemExit("--repeats must be >= 1")
    if args.seed is not None and not 0 <= args.seed <= 2_147_483_647:
        raise SystemExit("--seed must be between 0 and 2147483647, or omitted")
    if args.command_template:
        validate_command_template(args.command_template, source="--command-template")

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    eval_path = Path(args.eval_set).expanduser().resolve()
    cases = select_cases(load_eval_set(eval_path), args.case_ids, args.tags, args.max_cases)
    backends = args.backend or ["indextts2", "f5-tts"]

    profile_path: Path | None = None
    profile: dict[str, Any] | None = None
    transcript_validation_json: Path | None = None
    reference_audio = args.reference_audio
    prompt_text = read_prompt_text(args.prompt_text, args.prompt_text_file or None)
    prompt_text_file = materialize_prompt_text(
        out_dir=out_dir,
        prompt_text=prompt_text,
        prompt_text_file=args.prompt_text_file or None,
        dry_run=args.dry_run,
    )

    if args.profile_json:
        profile_path = Path(args.profile_json).expanduser().resolve()
        profile = load_profile(profile_path)
        require_ready_profile(profile_path, profile)
        require_profile_target_scripts(cases)
        transcript_validation_json = (
            Path(args.transcript_validation_json).expanduser().resolve()
            if args.transcript_validation_json
            else (profile_path.parent / "transcript-validation.json").resolve()
        )
        validate_profile_transcript_validation(
            profile_path=profile_path,
            profile=profile,
            transcript_validation_json=transcript_validation_json,
        )
        require_strict_ready_profile(
            profile_path=profile_path,
            profile=profile,
            transcript_validation_json=transcript_validation_json,
        )
        reference_audio = ""
    else:
        if not reference_audio:
            reference_audio = str(DEFAULT_PROFILE_JSON.parent / "clips" / "reference.wav")
            if not args.dry_run:
                raise SystemExit("provide --profile-json or --reference-audio, or use --dry-run for a placeholder plan")
        else:
            reference_audio = str(resolve_existing_or_planned(reference_audio, dry_run=args.dry_run, label="reference audio"))
        if not prompt_text_file.exists() and not args.dry_run:
            raise SystemExit("provide --prompt-text or --prompt-text-file")

    jobs = build_jobs(
        out_dir=out_dir,
        backends=backends,
        cases=cases,
        repeats=args.repeats,
        reference_audio=reference_audio,
        prompt_text_file=prompt_text_file,
        profile_path=profile_path,
        profile=profile,
        dry_run=args.dry_run,
        command_template=args.command_template,
        stability_seed=args.seed,
    )

    jobs_path = out_dir / "jobs.json"
    manifest_path = out_dir / "manifest.json"
    render_script = out_dir / "render.sh"
    report_dir = out_dir / "registered-report"
    readme_path = out_dir / "README.md"
    write_text(jobs_path, json.dumps({"version": 1, "jobs": jobs}, ensure_ascii=False, indent=2) + "\n")
    write_text(manifest_path, json.dumps(manifest_from_jobs(jobs), ensure_ascii=False, indent=2) + "\n")
    write_render_script(render_script, jobs, command_template=args.command_template)
    write_readme(
        path=readme_path,
        jobs=jobs,
        manifest_path=manifest_path,
        report_dir=report_dir,
        render_script=render_script,
        eval_set=eval_path,
        command_template=args.command_template,
    )

    print(
        json.dumps(
            {
                "outDir": str(out_dir),
                "jobs": str(jobs_path),
                "manifest": str(manifest_path),
                "renderScript": str(render_script),
                "readme": str(readme_path),
                "backends": backends,
                "cases": [case["id"] for case in cases],
                "renders": len(jobs),
                "rendererStatus": "ready" if args.command_template else "needs_renderer_command",
                "rendererCommandEnv": None if args.command_template else ENV_RENDER_COMMAND,
                "stabilitySeed": args.seed,
                "transcriptValidationJson": str(transcript_validation_json) if transcript_validation_json else None,
                "nextCommands": {
                    "render": str(render_script),
                    "registerDryRun": shell_join(
                        [
                            "python3",
                            "scripts/register_voice_backend_renders.py",
                            str(manifest_path),
                            "--dry-run",
                            "--out-dir",
                            str(report_dir),
                        ]
                    ),
                    "register": shell_join(
                        [
                            "python3",
                            "scripts/register_voice_backend_renders.py",
                            str(manifest_path),
                            "--out-dir",
                            str(report_dir),
                        ]
                    ),
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
