from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CHOICE_RE = re.compile(r"^winner-(?P<case_id>.+)-r(?P<repeat>\d+)$")
VALID_DIRECT_CHOICES = {"tie", "rerender"}


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"{label} not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} is not valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"{label} is not a JSON object: {path}")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def same_path(raw: Any, expected: Path, base_dir: Path) -> bool:
    if not isinstance(raw, str) or not raw.strip():
        return False
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False) == expected.resolve(strict=False)


def resolved_report_audio_path(raw: str, report_path: Path) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = report_path.parent / path
    return path.resolve(strict=False)


def blind_order_key(case_id: str, repeat: int, clone_mode: str, output_wav: str) -> str:
    value = f"{case_id}\0{repeat}\0{clone_mode}\0{output_wav}".encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def parse_choice_key(choice_key: str) -> tuple[str, int] | None:
    match = CHOICE_RE.match(choice_key)
    if not match:
        return None
    return match.group("case_id"), int(match.group("repeat"))


def build_rounds(report: dict[str, Any], report_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rounds: dict[tuple[str, int], dict[str, Any]] = {}
    order: list[tuple[str, int]] = []
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        clone_mode = str(group.get("cloneMode") or "")
        if clone_mode not in {"prompt", "hifi"}:
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "case").strip()
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            output_wav = render.get("outputWav")
            if not isinstance(output_wav, str) or not output_wav.strip():
                continue
            audio_path = resolved_report_audio_path(output_wav, report_path)
            try:
                if not audio_path.is_file() or audio_path.stat().st_size <= 0:
                    continue
            except OSError:
                continue
            repeat = int(render.get("repeat") or 1)
            key = (case_id, repeat)
            if key not in rounds:
                rounds[key] = {"caseId": case_id, "repeat": repeat, "samples": []}
                order.append(key)
            rounds[key]["samples"].append({"cloneMode": clone_mode, "outputWav": output_wav})

    result: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for key in order:
        item = rounds[key]
        case_id = str(item["caseId"])
        repeat = int(item["repeat"])
        samples = item["samples"]
        sample_counts = {
            "prompt": sum(1 for sample in samples if sample.get("cloneMode") == "prompt"),
            "hifi": sum(1 for sample in samples if sample.get("cloneMode") == "hifi"),
        }
        if sample_counts["prompt"] != 1 or sample_counts["hifi"] != 1:
            ambiguous.append({"caseId": case_id, "repeat": repeat, "sampleCounts": sample_counts})
            continue
        ordered = sorted(
            samples,
            key=lambda sample: blind_order_key(
                case_id,
                repeat,
                str(sample.get("cloneMode") or ""),
                str(sample.get("outputWav") or ""),
            ),
        )
        label_by_mode = {
            str(sample.get("cloneMode") or ""): labels[index]
            for index, sample in enumerate(ordered)
            if index < len(labels)
        }
        result.append(
            {
                "caseId": case_id,
                "repeat": repeat,
                "choiceKey": f"winner-{case_id}-r{repeat:02d}",
                "candidateLabel": label_by_mode.get("hifi"),
                "baselineLabel": label_by_mode.get("prompt"),
            }
        )
    return result, ambiguous


def round_maps(report: dict[str, Any], report_path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    rounds, ambiguous = build_rounds(report, report_path)
    return {str(row["choiceKey"]): row for row in rounds}, ambiguous


def validate_review_binding(review: dict[str, Any], review_path: Path, report_path: Path) -> list[str]:
    errors: list[str] = []
    expected_sha = file_sha256(report_path)
    report_sha = review.get("reportSha256")
    if not isinstance(report_sha, str) or report_sha.lower() != expected_sha.lower():
        errors.append("report_sha256_mismatch")
    report_raw = review.get("reportPath") or review.get("report")
    if not same_path(report_raw, report_path, review_path.parent):
        errors.append("report_path_mismatch")
    if not isinstance(review.get("choices"), dict):
        errors.append("choices_missing")
    return errors


def selected_role(choice: str, round_item: dict[str, Any]) -> str | None:
    if choice == "tie":
        return "tie"
    if choice == "rerender":
        return "rerender"
    if choice == round_item.get("candidateLabel"):
        return "candidate"
    if choice == round_item.get("baselineLabel"):
        return "baseline"
    return None


def choice_for_role(role: str, round_item: dict[str, Any]) -> str:
    if role == "tie":
        return "tie"
    if role == "rerender":
        return "rerender"
    key = "candidateLabel" if role == "candidate" else "baselineLabel"
    value = round_item.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"round {round_item.get('choiceKey')} has no {key}")
    return value


def evaluate_choices(rounds_by_key: dict[str, dict[str, Any]], choices: dict[str, Any]) -> dict[str, Any]:
    candidate_wins = 0
    baseline_wins = 0
    ties = 0
    rerenders = 0
    reviewed = 0
    missing: list[str] = []
    invalid: list[dict[str, Any]] = []
    for key, round_item in rounds_by_key.items():
        value = choices.get(key)
        if not isinstance(value, str) or not value:
            missing.append(key)
            continue
        role = selected_role(value, round_item)
        if role is None:
            invalid.append({"choiceKey": key, "value": value})
            continue
        reviewed += 1
        if role == "candidate":
            candidate_wins += 1
        elif role == "baseline":
            baseline_wins += 1
        elif role == "tie":
            ties += 1
        elif role == "rerender":
            rerenders += 1
    total = len(rounds_by_key)
    reasons: list[str] = []
    if missing or invalid or rerenders:
        reasons.append("subjective_review_incomplete_or_rerender")
    if baseline_wins > candidate_wins:
        reasons.append("subjective_review_baseline_preferred_over_candidate")
    return {
        "status": "pass" if not reasons else "review",
        "reasons": reasons,
        "stats": {
            "rounds": total,
            "reviewedRounds": reviewed,
            "candidateWins": candidate_wins,
            "baselineWins": baseline_wins,
            "ties": ties,
            "rerenders": rerenders,
            "candidateWinRate": round(candidate_wins / total, 4) if total else 0,
            "minCandidateWinRate": 0.8,
        },
        "missingChoices": missing,
        "invalidChoices": invalid,
    }


def merge_reviews(args: argparse.Namespace) -> dict[str, Any]:
    base_report_path = Path(args.base_report).expanduser().resolve()
    base_review_path = Path(args.base_review).expanduser().resolve()
    replacement_report_path = Path(args.replacement_report).expanduser().resolve()
    replacement_review_path = Path(args.replacement_review).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()

    base_report = load_json(base_report_path, "base report")
    base_review = load_json(base_review_path, "base review")
    replacement_report = load_json(replacement_report_path, "replacement report")
    replacement_review = load_json(replacement_review_path, "replacement review")

    errors: list[str] = []
    errors.extend(f"base_review_{error}" for error in validate_review_binding(base_review, base_review_path, base_report_path))
    errors.extend(
        f"replacement_review_{error}"
        for error in validate_review_binding(replacement_review, replacement_review_path, replacement_report_path)
    )
    base_rounds, base_ambiguous = round_maps(base_report, base_report_path)
    replacement_rounds, replacement_ambiguous = round_maps(replacement_report, replacement_report_path)
    if base_ambiguous:
        errors.append("base_report_ambiguous_rounds")
    if replacement_ambiguous:
        errors.append("replacement_report_ambiguous_rounds")

    base_choices_raw = base_review.get("choices") if isinstance(base_review.get("choices"), dict) else {}
    replacement_choices_raw = replacement_review.get("choices") if isinstance(replacement_review.get("choices"), dict) else {}
    if errors:
        return {"status": "blocked", "reasons": errors}

    choices = dict(base_choices_raw)
    replaced: list[dict[str, Any]] = []
    missing_replacements: list[str] = []
    invalid_replacements: list[dict[str, Any]] = []
    for key, base_round in base_rounds.items():
        if base_choices_raw.get(key) != "rerender":
            continue
        replacement_round = replacement_rounds.get(key)
        if not replacement_round:
            missing_replacements.append(key)
            continue
        replacement_choice = replacement_choices_raw.get(key)
        if not isinstance(replacement_choice, str) or not replacement_choice:
            missing_replacements.append(key)
            continue
        role = selected_role(replacement_choice, replacement_round)
        if role is None or role == "rerender":
            invalid_replacements.append({"choiceKey": key, "value": replacement_choice})
            continue
        merged_choice = choice_for_role(role, base_round)
        old_note_key = f"notes-{base_round['caseId']}-r{int(base_round['repeat']):02d}"
        old_note = choices.get(old_note_key)
        replacement_note = replacement_choices_raw.get(old_note_key)
        choices[key] = merged_choice
        choices[old_note_key] = replacement_note if isinstance(replacement_note, str) else ""
        replaced.append(
            {
                "choiceKey": key,
                "caseId": base_round["caseId"],
                "repeat": base_round["repeat"],
                "replacementChoice": replacement_choice,
                "replacementRole": role,
                "mergedChoice": merged_choice,
                "oldChoice": "rerender",
                "oldNote": old_note if isinstance(old_note, str) else "",
                "replacementNote": replacement_note if isinstance(replacement_note, str) else "",
            }
        )

    filled_missing: list[str] = []
    if args.fill_missing == "tie":
        for key in base_rounds:
            value = choices.get(key)
            if not isinstance(value, str) or not value:
                choices[key] = "tie"
                filled_missing.append(key)

    if missing_replacements or invalid_replacements:
        return {
            "status": "blocked",
            "reasons": ["replacement_review_incomplete_or_invalid"],
            "missingReplacementChoices": missing_replacements,
            "invalidReplacementChoices": invalid_replacements,
            "replacedChoices": replaced,
        }

    evaluated = evaluate_choices(base_rounds, choices)
    report_sha = file_sha256(base_report_path)
    stats = {**evaluated["stats"], "reportSha256": report_sha}
    payload = {
        "version": 1,
        "status": evaluated["status"],
        "reasons": evaluated["reasons"],
        "report": str(base_report_path),
        "reportPath": str(base_report_path),
        "reportSha256": report_sha,
        "expectedSaveAs": str(out_path),
        "choiceKeys": list(base_rounds.keys()),
        "reviewedAt": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "missingChoices": evaluated["missingChoices"],
        "invalidChoices": evaluated["invalidChoices"],
        "choices": choices,
        "merge": {
            "version": 1,
            "baseReviewJson": str(base_review_path),
            "baseReviewSha256": file_sha256(base_review_path),
            "replacementReviewJson": str(replacement_review_path),
            "replacementReviewSha256": file_sha256(replacement_review_path),
            "replacementReportJson": str(replacement_report_path),
            "replacementReportSha256": file_sha256(replacement_report_path),
            "replacedChoices": replaced,
            "filledMissingChoices": filled_missing,
        },
    }
    write_json(out_path, payload)
    return {
        "status": "written",
        "out": str(out_path),
        "reviewStatus": payload["status"],
        "reasons": payload["reasons"],
        "stats": stats,
        "missingChoices": payload["missingChoices"],
        "invalidChoices": payload["invalidChoices"],
        "replacedChoices": len(replaced),
        "filledMissingChoices": filled_missing,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge a rerender-only AnyVoice blind review back into the original full review.")
    parser.add_argument("--base-review", required=True)
    parser.add_argument("--base-report", required=True)
    parser.add_argument("--replacement-review", required=True)
    parser.add_argument("--replacement-report", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--fill-missing", choices=("none", "tie"), default="none")
    args = parser.parse_args()
    result = merge_reviews(args)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if result.get("status") != "written":
        sys.exit(2)


if __name__ == "__main__":
    main()
