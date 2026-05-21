from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from voice_clone_regression import (
    DEFAULT_EVAL_SET,
    load_eval_set,
    prepare_voice_text,
    pronunciation_overrides_from_case,
    stability_summary,
    utc_stamp,
    wav_metrics,
    write_html_report,
)


REPO_ROOT = Path(__file__).resolve().parent.parent


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON: {path}: {exc}") from exc


def load_optional_json(path_value: str | None, *, dry_run: bool) -> dict[str, Any] | None:
    if not path_value:
        return None
    path = Path(path_value).expanduser()
    if dry_run and not path.exists():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def load_eval_cases(path: Path) -> dict[str, dict[str, Any]]:
    cases = load_eval_set(path)
    return {case["id"]: case for case in cases}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def flatten_manifest(data: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add_group(group: dict[str, Any]) -> None:
        backend = group.get("backend") or group.get("voiceBackend") or group.get("cloneMode")
        if not isinstance(backend, str) or not backend.strip():
            raise SystemExit("backend group is missing backend/voiceBackend/cloneMode")
        defaults = {
            "backend": backend.strip(),
            "referenceAudio": group.get("referenceAudio"),
            "promptText": group.get("promptText"),
            "promptTextFile": group.get("promptTextFile"),
            "voiceProfileId": group.get("voiceProfileId"),
            "profileClipId": group.get("profileClipId"),
        }
        for render in as_list(group.get("renders")):
            if not isinstance(render, dict):
                continue
            rows.append({**defaults, **render, "backend": str(render.get("backend") or defaults["backend"])})

    if isinstance(data, list):
        for row in data:
            if isinstance(row, dict):
                rows.append(row)
        return rows

    if not isinstance(data, dict):
        raise SystemExit("backend render manifest must be a JSON object or array")

    for group in as_list(data.get("backends")):
        if isinstance(group, dict):
            add_group(group)

    if isinstance(data.get("renders"), list):
        if data.get("backend") or data.get("voiceBackend") or data.get("cloneMode"):
            add_group(data)
        else:
            for row in as_list(data.get("renders")):
                if isinstance(row, dict):
                    rows.append(row)

    return rows


def read_prompt_text(row: dict[str, Any], *, dry_run: bool) -> str | None:
    prompt_text = row.get("promptText")
    if isinstance(prompt_text, str):
        return prompt_text
    prompt_file = row.get("promptTextFile")
    if isinstance(prompt_file, str) and prompt_file:
        path = Path(prompt_file).expanduser()
        if dry_run and not path.exists():
            return None
        return path.read_text(encoding="utf-8").strip()
    return None


def resolve_path(base_dir: Path, value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return str(path.resolve(strict=False))


def require_row_string(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"backend render row is missing {key}: {row!r}")
    return value.strip()


def normalize_render_row(
    row: dict[str, Any],
    *,
    manifest_dir: Path,
    eval_cases: dict[str, dict[str, Any]],
    dry_run: bool,
    allow_missing: bool,
) -> dict[str, Any]:
    backend = row.get("backend") or row.get("voiceBackend") or row.get("cloneMode")
    if not isinstance(backend, str) or not backend.strip():
        raise SystemExit(f"backend render row is missing backend: {row!r}")
    case_id = row.get("caseId") or row.get("case")
    if not isinstance(case_id, str) or not case_id.strip():
        raise SystemExit(f"backend render row is missing caseId: {row!r}")
    case_id = case_id.strip()
    if case_id not in eval_cases:
        raise SystemExit(f"unknown eval case id in backend render manifest: {case_id}")

    output_wav = resolve_path(manifest_dir, require_row_string(row, "outputWav"))
    assert output_wav is not None
    if not dry_run and not allow_missing and not Path(output_wav).exists():
        raise SystemExit(f"backend render output is missing: {output_wav}")

    repeat = int(row.get("repeat") or 1)
    status = str(row.get("status") or ("dry_run" if dry_run else "ready"))
    normalized: dict[str, Any] = {
        "caseId": case_id,
        "cloneMode": backend.strip(),
        "voiceBackend": backend.strip(),
        "repeat": repeat,
        "command": str(row.get("command") or "external-render"),
        "referenceAudio": resolve_path(manifest_dir, row.get("referenceAudio")),
        "targetTextFile": resolve_path(manifest_dir, row.get("targetTextFile")),
        "targetTextRawFile": resolve_path(manifest_dir, row.get("targetTextRawFile")),
        "textPrepFile": resolve_path(manifest_dir, row.get("textPrepFile")),
        "promptTextFile": resolve_path(manifest_dir, row.get("promptTextFile")),
        "profileClipId": row.get("profileClipId"),
        "voiceProfileId": row.get("voiceProfileId"),
        "targetCoverageFeatures": row.get("targetCoverageFeatures") if isinstance(row.get("targetCoverageFeatures"), list) else None,
        "matchedCoverageFeatures": row.get("matchedCoverageFeatures") if isinstance(row.get("matchedCoverageFeatures"), list) else None,
        "targetPronunciationPresetIds": row.get("targetPronunciationPresetIds") if isinstance(row.get("targetPronunciationPresetIds"), list) else None,
        "matchedPronunciationPresetIds": row.get("matchedPronunciationPresetIds") if isinstance(row.get("matchedPronunciationPresetIds"), list) else None,
        "stabilitySeed": row.get("stabilitySeed") if isinstance(row.get("stabilitySeed"), int) or row.get("stabilitySeed") is None else None,
        "outputWav": output_wav,
        "metadata": resolve_path(manifest_dir, row.get("metadata")),
        "status": status,
        "externalBackend": True,
    }
    prompt_text = read_prompt_text(row, dry_run=dry_run)
    if prompt_text is not None:
        normalized["promptText"] = prompt_text
    if isinstance(row.get("metadataJson"), dict):
        normalized["metadataJson"] = row["metadataJson"]
    if isinstance(row.get("textPreparation"), dict):
        normalized["textPreparation"] = row["textPreparation"]
    else:
        text_prep = load_optional_json(normalized.get("textPrepFile"), dry_run=dry_run)
        if text_prep is not None:
            normalized["textPreparation"] = text_prep
        else:
            case = eval_cases[case_id]
            normalized["textPreparation"] = {
                "version": 1,
                "targetText": prepare_voice_text(
                    str(case.get("text") or ""),
                    auto_apply_presets=True,
                    pronunciation_overrides=pronunciation_overrides_from_case(case),
                ),
            }
    if not dry_run and Path(output_wav).exists():
        normalized["audioMetrics"] = wav_metrics(Path(output_wav))
    return normalized


def group_renders(renders: list[dict[str, Any]], eval_cases: dict[str, dict[str, Any]], dry_run: bool) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    order: list[tuple[str, str]] = []
    for render in renders:
        key = (str(render["cloneMode"]), str(render["caseId"]))
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(render)

    groups: list[dict[str, Any]] = []
    for clone_mode, case_id in order:
        rows = sorted(grouped[(clone_mode, case_id)], key=lambda item: int(item.get("repeat") or 1))
        groups.append(
            {
                "cloneMode": clone_mode,
                "voiceBackend": clone_mode,
                "case": eval_cases[case_id],
                "renders": rows,
                "stability": {} if dry_run else stability_summary(rows),
            }
        )
    return groups


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Register externally rendered backend WAVs as an AnyVoice regression report for ASR, speaker, scoring, and blind A/B review.",
    )
    parser.add_argument("manifest", help="JSON manifest of external backend renders.")
    parser.add_argument("--eval-set", default=str(DEFAULT_EVAL_SET))
    parser.add_argument("--out-dir", default=str(REPO_ROOT / "generated" / "voice-regression" / f"external-{utc_stamp()}"))
    parser.add_argument("--report", help="Report JSON path. Defaults to <out-dir>/report.json.")
    parser.add_argument("--dry-run", action="store_true", help="Do not require output WAVs or compute audio metrics.")
    parser.add_argument("--allow-missing", action="store_true", help="Register missing output WAVs as rows instead of exiting.")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).expanduser().resolve()
    eval_path = Path(args.eval_set).expanduser().resolve()
    eval_cases = load_eval_cases(eval_path)
    raw_rows = flatten_manifest(load_json(manifest_path))
    if not raw_rows:
        raise SystemExit(f"backend render manifest has no render rows: {manifest_path}")

    renders = [
        normalize_render_row(
            row,
            manifest_dir=manifest_path.parent,
            eval_cases=eval_cases,
            dry_run=args.dry_run,
            allow_missing=args.allow_missing,
        )
        for row in raw_rows
    ]
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = Path(args.report).expanduser().resolve() if args.report else out_dir / "report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evalSet": str(eval_path),
        "externalRenderManifest": str(manifest_path),
        "dryRun": args.dry_run,
        "caseIds": sorted({str(render["caseId"]) for render in renders}),
        "cloneMode": "external",
        "groups": group_renders(renders, eval_cases, args.dry_run),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    html_path = write_html_report(report_path, report)
    print(
        json.dumps(
            {
                "report": str(report_path),
                "html": str(html_path),
                "groups": len(report["groups"]),
                "renders": len(renders),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
