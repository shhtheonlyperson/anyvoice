from __future__ import annotations

import argparse
import json
import re
import shlex
from collections import defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
CHOICE_RE = re.compile(r"^winner-(?P<case_id>.+)-r(?P<repeat>\d+)$")


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


def resolve_path(raw_path: Any, base_dir: Path) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def case_texts(report: dict[str, Any]) -> dict[str, str]:
    texts: dict[str, str] = {}
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or "").strip()
        text = str(case.get("text") or "").strip()
        if case_id and text and case_id not in texts:
            texts[case_id] = text
    return texts


def parse_choice_key(choice_key: str) -> tuple[str, int] | None:
    match = CHOICE_RE.match(choice_key)
    if not match:
        return None
    return match.group("case_id"), int(match.group("repeat"))


def compact_case_notes(items: list[dict[str, Any]]) -> list[str]:
    notes: list[str] = []
    seen: set[str] = set()
    for item in items:
        note = str(item.get("note") or "").strip()
        if not note or note in seen:
            continue
        seen.add(note)
        notes.append(note)
    return notes


def build_case_rows(review: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    choices = review.get("choices") if isinstance(review.get("choices"), dict) else {}
    choice_keys = review.get("choiceKeys") if isinstance(review.get("choiceKeys"), list) else []
    keys = [str(key) for key in choice_keys if isinstance(key, str) and key.startswith("winner-")]
    if not keys:
        keys = sorted(key for key in choices if isinstance(key, str) and key.startswith("winner-"))

    texts = case_texts(report)
    per_case: dict[str, list[dict[str, Any]]] = defaultdict(list)
    missing: list[str] = []
    invalid: list[dict[str, Any]] = []
    for key in keys:
        parsed = parse_choice_key(key)
        if not parsed:
            invalid.append({"choiceKey": key, "reason": "unparseable_choice_key"})
            continue
        case_id, repeat = parsed
        value = choices.get(key)
        note_key = f"notes-{case_id}-r{repeat:02d}"
        note = str(choices.get(note_key) or "")
        row = {
            "choiceKey": key,
            "caseId": case_id,
            "repeat": repeat,
            "choice": value if isinstance(value, str) else None,
            "note": note,
            "text": texts.get(case_id),
        }
        per_case[case_id].append(row)
        if not isinstance(value, str) or not value:
            missing.append(key)

    cases: list[dict[str, Any]] = []
    for case_id, rows in sorted(per_case.items()):
        rows.sort(key=lambda row: int(row["repeat"]))
        counts = {
            "tie": sum(1 for row in rows if row.get("choice") == "tie"),
            "rerender": sum(1 for row in rows if row.get("choice") == "rerender"),
            "candidate": sum(1 for row in rows if row.get("choice") in {"A", "B"}),
            "missing": sum(1 for row in rows if not row.get("choice")),
        }
        if counts["rerender"]:
            verdict = "needs_rerender"
        elif counts["missing"]:
            verdict = "missing_choice"
        elif counts["candidate"] == 0:
            verdict = "no_clear_winner"
        else:
            verdict = "reviewed"
        cases.append(
            {
                "caseId": case_id,
                "verdict": verdict,
                "text": rows[0].get("text"),
                "counts": counts,
                "repeats": rows,
                "notes": compact_case_notes(rows),
            }
        )
    return {"cases": cases, "missingChoices": missing, "invalidChoiceKeys": invalid}


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def next_rerender_command(case_ids: list[str], profile_json: str, transcript_validation_json: str | None) -> str | None:
    if not case_ids:
        return None
    parts = [
        "python3",
        "scripts/run_voice_quality_gate.py",
        "--profile-json",
        profile_json,
        "--quality",
        "balanced",
        "--clone-mode",
        "both",
        "--repeats",
        "3",
        "--require-speaker-backend",
        "speechbrain-ecapa",
    ]
    if transcript_validation_json:
        parts.extend(["--transcript-validation-json", transcript_validation_json])
    for case_id in case_ids:
        parts.extend(["--case", case_id])
    return shell_join(parts)


def build_triage(args: argparse.Namespace) -> dict[str, Any]:
    review_path = Path(args.review_json).expanduser().resolve()
    review = load_json(review_path, "review JSON")
    report_path = (
        Path(args.report_json).expanduser().resolve()
        if args.report_json
        else resolve_path(review.get("reportPath") or review.get("report"), review_path.parent)
    )
    if report_path is None:
        raise SystemExit("report JSON path is required when review does not contain reportPath/report")
    report = load_json(report_path, "report JSON")
    rows = build_case_rows(review, report)
    cases = rows["cases"]
    rerender_cases = [case for case in cases if case.get("verdict") == "needs_rerender"]
    no_clear_winner_cases = [case for case in cases if case.get("verdict") == "no_clear_winner"]
    missing_choice_cases = [case for case in cases if case.get("verdict") == "missing_choice"]
    stats = review.get("stats") if isinstance(review.get("stats"), dict) else {}
    rerender_case_ids = [str(case["caseId"]) for case in rerender_cases]
    return {
        "version": 1,
        "status": "needs_fix",
        "reviewJson": str(review_path),
        "reportJson": str(report_path),
        "reviewStatus": review.get("status"),
        "reviewReasons": review.get("reasons") if isinstance(review.get("reasons"), list) else [],
        "summary": {
            "totalCases": len(cases),
            "rerenderCases": len(rerender_cases),
            "noClearWinnerCases": len(no_clear_winner_cases),
            "missingChoiceCases": len(missing_choice_cases),
            "candidateWins": stats.get("candidateWins"),
            "baselineWins": stats.get("baselineWins"),
            "ties": stats.get("ties"),
            "rerenders": stats.get("rerenders"),
            "reviewedRounds": stats.get("reviewedRounds"),
            "rounds": stats.get("rounds"),
            "candidateWinRate": stats.get("candidateWinRate"),
            "minCandidateWinRate": stats.get("minCandidateWinRate"),
        },
        "rerenderCases": rerender_cases,
        "noClearWinnerCases": no_clear_winner_cases,
        "missingChoiceCases": missing_choice_cases,
        "missingChoices": rows["missingChoices"],
        "invalidChoiceKeys": rows["invalidChoiceKeys"],
        "nextCommands": {
            "rerenderRequestedCases": next_rerender_command(
                rerender_case_ids,
                args.profile_json,
                args.transcript_validation_json,
            ),
        },
        "decision": (
            "No-clear-winner/tie cases are acceptable under the current no-regression subjective bar; "
            "fix rerender requests, missing choices, and invalid choices before merging the review proof."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Turn an AnyVoice blind review JSON into an actionable subjective-review triage artifact.")
    parser.add_argument("--review-json", required=True)
    parser.add_argument("--report-json")
    parser.add_argument("--out")
    parser.add_argument("--profile-json", default=str(REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"))
    parser.add_argument("--transcript-validation-json", default=str(REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "transcript-validation.json"))
    args = parser.parse_args()
    payload = build_triage(args)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        out_path = Path(args.out).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        print(json.dumps({"status": "written", "out": str(out_path), "summary": payload["summary"]}, ensure_ascii=False))
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
