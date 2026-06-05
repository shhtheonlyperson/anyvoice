from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ALLOWED_VOICE_BACKENDS = {"voxcpm2-hifi", "voxcpm2-lora", "indextts2", "f5-tts", "fishaudio-s2-pro"}


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


def sha256_file(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def resolve_render_output_path(render: dict[str, Any], score_path: Path) -> Path | None:
    raw_path = render.get("outputWav")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = score_path.parent / path
    return path.resolve(strict=False)


def blind_order_key(case_id: str, repeat: int, clone_mode: str, output_wav: str) -> str:
    token = f"{case_id}\0{repeat}\0{clone_mode}\0{output_wav}".encode("utf-8")
    return hashlib.sha256(token).hexdigest()


def review_json_candidates(report_path: Path, explicit_review_path: Path | None) -> list[Path]:
    candidates: list[Path] = []
    if explicit_review_path is not None:
        candidates.append(explicit_review_path)
    candidates.extend(
        [
            report_path.with_suffix(".review.json"),
            report_path.parent / "review.json",
            report_path.parent / "subjective-review.json",
            report_path.parent / "subjective_review.json",
        ]
    )
    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        resolved = candidate.expanduser().resolve(strict=False)
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(resolved)
    return deduped


def same_path(raw_path: Any, expected: Path, base_dir: Path | None = None) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    path = Path(raw_path).expanduser()
    if not path.is_absolute() and base_dir is not None:
        path = base_dir / path
    return path.resolve(strict=False) == expected.resolve(strict=False)


def resolved_report_audio_path(raw_path: str, report_path: Path) -> Path:
    audio_path = Path(raw_path).expanduser()
    if not audio_path.is_absolute():
        audio_path = report_path.parent / audio_path
    return audio_path.resolve(strict=False)


def resolve_score_source_report_path(score: dict[str, Any], score_path: Path) -> Path | None:
    source_report_raw = score.get("sourceReport")
    if not isinstance(source_report_raw, str) or not source_report_raw.strip():
        return None
    source_report = Path(source_report_raw).expanduser()
    if not source_report.is_absolute():
        source_report = score_path.parent / source_report
    return source_report.resolve(strict=False)


def build_subjective_review_rounds(
    report: dict[str, Any],
    report_path: Path,
    *,
    baseline_clone_mode: str,
    candidate_clone_mode: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rounds: dict[tuple[str, int], dict[str, Any]] = {}
    order: list[tuple[str, int]] = []
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        clone_mode = str(group.get("cloneMode") or "")
        if clone_mode not in {baseline_clone_mode, candidate_clone_mode}:
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "case")
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            if render.get("status") != "ready":
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
            rounds[key]["samples"].append(
                {
                    "cloneMode": clone_mode or str(render.get("cloneMode") or ""),
                    "outputWav": output_wav,
                }
            )

    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    result: list[dict[str, Any]] = []
    ambiguous_rounds: list[dict[str, Any]] = []
    for key in order:
        item = rounds[key]
        samples = item["samples"]
        clone_modes = {str(sample.get("cloneMode") or "") for sample in samples}
        if not {baseline_clone_mode, candidate_clone_mode}.issubset(clone_modes):
            continue
        case_id = str(item["caseId"])
        repeat = int(item["repeat"])
        sample_counts = {
            baseline_clone_mode: sum(1 for sample in samples if sample.get("cloneMode") == baseline_clone_mode),
            candidate_clone_mode: sum(1 for sample in samples if sample.get("cloneMode") == candidate_clone_mode),
        }
        if sample_counts[baseline_clone_mode] != 1 or sample_counts[candidate_clone_mode] != 1:
            ambiguous_rounds.append(
                {
                    "caseId": case_id,
                    "repeat": repeat,
                    "sampleCounts": sample_counts,
                }
            )
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
                "candidateLabel": label_by_mode.get(candidate_clone_mode),
                "baselineLabel": label_by_mode.get(baseline_clone_mode),
            }
        )
    return result, ambiguous_rounds


def evaluate_subjective_review(
    score: dict[str, Any],
    *,
    score_path: Path,
    baseline_clone_mode: str,
    candidate_clone_mode: str,
    explicit_review_path: Path | None,
    min_candidate_win_rate: float,
) -> dict[str, Any]:
    source_report = resolve_score_source_report_path(score, score_path)
    if source_report is None:
        return {"status": "fail", "reasons": ["subjective_review_source_report_missing"]}
    report = load_json(source_report)
    if not isinstance(report, dict):
        return {"status": "fail", "reasons": ["subjective_review_source_report_invalid"], "report": str(source_report)}
    candidates = review_json_candidates(source_report, explicit_review_path)
    review_path = next((candidate for candidate in candidates if candidate.exists()), None)
    if review_path is None:
        return {
            "status": "fail",
            "reasons": ["subjective_review_missing"],
            "report": str(source_report),
            "expectedReviewJson": [str(candidate) for candidate in candidates],
        }
    review = load_json(review_path)
    if not isinstance(review, dict):
        return {"status": "fail", "reasons": ["subjective_review_not_object"], "reviewJson": str(review_path)}
    expected_report_sha = sha256_file(source_report)
    if not expected_report_sha:
        return {
            "status": "fail",
            "reasons": ["subjective_review_source_report_unreadable"],
            "reviewJson": str(review_path),
            "report": str(source_report),
        }
    review_report_sha = review.get("reportSha256")
    if not isinstance(review_report_sha, str) or not review_report_sha.strip():
        return {
            "status": "fail",
            "reasons": ["subjective_review_report_sha256_missing"],
            "reviewJson": str(review_path),
            "report": str(source_report),
            "expectedReportSha256": expected_report_sha,
        }
    if expected_report_sha and review_report_sha.strip().lower() != expected_report_sha.lower():
        return {
            "status": "fail",
            "reasons": ["subjective_review_report_sha256_mismatch"],
            "reviewJson": str(review_path),
            "report": str(source_report),
            "expectedReportSha256": expected_report_sha,
            "reviewReportSha256": review_report_sha,
        }
    review_report_raw = review.get("reportPath") or review.get("report")
    if not isinstance(review_report_raw, str) or not review_report_raw.strip():
        return {
            "status": "fail",
            "reasons": ["subjective_review_report_path_missing"],
            "reviewJson": str(review_path),
            "report": str(source_report),
            "expectedReportSha256": expected_report_sha,
        }
    if not same_path(review_report_raw, source_report, review_path.parent):
        return {
            "status": "fail",
            "reasons": ["subjective_review_report_path_mismatch"],
            "reviewJson": str(review_path),
            "report": str(source_report),
            "reviewReportPath": review_report_raw,
            "expectedReportPath": str(source_report),
            "expectedReportSha256": expected_report_sha,
        }
    expected_save_as = review.get("expectedSaveAs")
    if isinstance(expected_save_as, str) and expected_save_as.strip() and not same_path(expected_save_as, review_path, review_path.parent):
        return {
            "status": "fail",
            "reasons": ["subjective_review_expected_save_as_mismatch"],
            "reviewJson": str(review_path),
            "report": str(source_report),
            "expectedSaveAs": expected_save_as,
            "actualReviewJson": str(review_path),
            "expectedReportSha256": expected_report_sha,
        }
    choices = review.get("choices") if isinstance(review.get("choices"), dict) else None
    if not isinstance(choices, dict):
        return {"status": "fail", "reasons": ["subjective_review_choices_missing"], "reviewJson": str(review_path)}
    rounds, ambiguous_rounds = build_subjective_review_rounds(
        report,
        source_report,
        baseline_clone_mode=baseline_clone_mode,
        candidate_clone_mode=candidate_clone_mode,
    )
    if ambiguous_rounds:
        return {
            "status": "fail",
            "reasons": ["subjective_review_ambiguous_rounds"],
            "reviewJson": str(review_path),
            "report": str(source_report),
            "ambiguousRounds": ambiguous_rounds,
        }
    if not rounds:
        return {
            "status": "fail",
            "reasons": ["subjective_review_rounds_missing"],
            "reviewJson": str(review_path),
            "report": str(source_report),
        }

    candidate_wins = 0
    baseline_wins = 0
    ties = 0
    rerenders = 0
    reviewed = 0
    missing_choices: list[str] = []
    invalid_choices: list[dict[str, Any]] = []
    for round_item in rounds:
        key = str(round_item["choiceKey"])
        value = choices.get(key)
        if not isinstance(value, str) or not value:
            missing_choices.append(key)
            continue
        reviewed += 1
        if value == "rerender":
            rerenders += 1
        elif value == "tie":
            ties += 1
        elif value == round_item.get("candidateLabel"):
            candidate_wins += 1
        elif value == round_item.get("baselineLabel"):
            baseline_wins += 1
        else:
            invalid_choices.append({"choiceKey": key, "value": value})

    total = len(rounds)
    candidate_win_rate = candidate_wins / total if total else 0.0
    stats = {
        "rounds": total,
        "reviewedRounds": reviewed,
        "candidateWins": candidate_wins,
        "baselineWins": baseline_wins,
        "ties": ties,
        "rerenders": rerenders,
        "candidateWinRate": round(candidate_win_rate, 4),
        "minCandidateWinRate": min_candidate_win_rate,
        "reportSha256": expected_report_sha,
    }
    reasons: list[str] = []
    if missing_choices:
        reasons.append("subjective_review_missing_choices")
    if invalid_choices:
        reasons.append("subjective_review_invalid_choices")
    if rerenders:
        reasons.append("subjective_review_rerender_requested")
    if baseline_wins > candidate_wins:
        reasons.append("subjective_review_baseline_preferred_over_candidate")
    review_reasons = review.get("reasons") if isinstance(review.get("reasons"), list) else []
    legacy_preference_only_review = (
        review.get("status") == "review"
        and review_reasons
        and all(reason == "subjective_review_candidate_win_rate_below_threshold" for reason in review_reasons)
    )
    if review.get("status") != "pass" and not legacy_preference_only_review:
        reasons.append("subjective_review_status_not_pass")
    declared_stats = review.get("stats") if isinstance(review.get("stats"), dict) else None
    stat_mismatches: list[dict[str, Any]] = []
    if not isinstance(declared_stats, dict):
        reasons.append("subjective_review_stats_missing")
    else:
        for key, expected in stats.items():
            actual = declared_stats.get(key)
            if actual != expected:
                stat_mismatches.append({"field": key, "expected": expected, "actual": actual})
        if stat_mismatches:
            reasons.append("subjective_review_stats_mismatch")
    return {
        "status": "pass" if not reasons else "fail",
        "reasons": reasons,
        "reviewJson": str(review_path),
        "report": str(source_report),
        "stats": stats,
        "reviewStats": declared_stats,
        "statMismatches": stat_mismatches,
        "missingChoices": missing_choices,
        "invalidChoices": invalid_choices,
    }


def groups_for_mode(score: dict[str, Any], clone_mode: str) -> list[dict[str, Any]]:
    groups = score.get("groups")
    return [
        group
        for group in groups
        if isinstance(group, dict) and str(group.get("cloneMode") or "") == clone_mode
    ] if isinstance(groups, list) else []


def renders_for_groups(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    renders: list[dict[str, Any]] = []
    for group in groups:
        for render in group.get("renders", []):
            if isinstance(render, dict):
                renders.append(render)
    return renders


def average(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 6)


def speaker_values(groups: list[dict[str, Any]]) -> list[float]:
    values: list[float] = []
    for group in groups:
        identity = group.get("speakerIdentity")
        if isinstance(identity, dict) and isinstance(identity.get("avgSpeakerSimilarity"), (int, float)):
            values.append(float(identity["avgSpeakerSimilarity"]))
    return values


def valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and bool(SHA256_RE.fullmatch(value))


def profile_evidence_reasons(score: dict[str, Any], groups: list[dict[str, Any]]) -> list[str]:
    reasons: list[str] = []
    voice_profile = score.get("voiceProfile") if isinstance(score.get("voiceProfile"), dict) else None
    voice_profile_id = voice_profile.get("voiceProfileId") if isinstance(voice_profile, dict) else None
    profile_sha256 = voice_profile.get("profileSha256") if isinstance(voice_profile, dict) else None
    if not isinstance(voice_profile_id, str) or not voice_profile_id.strip():
        reasons.append("score_voice_profile_id_missing")
    if not valid_sha256(profile_sha256):
        reasons.append("score_profile_sha256_missing")
    if reasons:
        return reasons

    expected_id = voice_profile_id.strip()
    expected_sha = str(profile_sha256)
    for group in groups:
        clone_mode = str(group.get("cloneMode") or "")
        case_id = str(group.get("caseId") or "")
        group_label = f"{clone_mode}/{case_id}".strip("/") or clone_mode or case_id or "group"
        if group.get("voiceProfileId") != expected_id:
            reasons.append(f"group_voice_profile_id_mismatch:{group_label}")
        if group.get("profileSha256") != expected_sha:
            reasons.append(f"group_profile_sha256_mismatch:{group_label}")
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
            if render.get("voiceProfileId") != expected_id:
                reasons.append(f"render_voice_profile_id_mismatch:{render_label}")
            if render.get("profileSha256") != expected_sha:
                reasons.append(f"render_profile_sha256_mismatch:{render_label}")
    return reasons


def source_report_profile_evidence_reasons(
    score: dict[str, Any],
    report: dict[str, Any],
    *,
    clone_modes: set[str],
) -> list[str]:
    reasons: list[str] = []
    voice_profile = score.get("voiceProfile") if isinstance(score.get("voiceProfile"), dict) else None
    expected_id = voice_profile.get("voiceProfileId") if isinstance(voice_profile, dict) else None
    expected_sha = voice_profile.get("profileSha256") if isinstance(voice_profile, dict) else None
    if not isinstance(expected_id, str) or not expected_id.strip() or not valid_sha256(expected_sha):
        return reasons

    expected_id = expected_id.strip()
    expected_sha = str(expected_sha)
    report_profile = report.get("voiceProfile") if isinstance(report.get("voiceProfile"), dict) else None
    if not isinstance(report_profile, dict):
        reasons.append("source_report_voice_profile_missing")
    else:
        if report_profile.get("voiceProfileId") != expected_id:
            reasons.append("source_report_voice_profile_id_mismatch")
        if report_profile.get("profileSha256") != expected_sha:
            reasons.append("source_report_profile_sha256_mismatch")

    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        clone_mode = str(group.get("cloneMode") or "")
        if clone_mode not in clone_modes:
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "")
        group_label = f"{clone_mode}/{case_id}".strip("/") or clone_mode or case_id or "group"
        if group.get("voiceProfileId") != expected_id:
            reasons.append(f"source_report_group_voice_profile_id_mismatch:{group_label}")
        if group.get("profileSha256") != expected_sha:
            reasons.append(f"source_report_group_profile_sha256_mismatch:{group_label}")
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
            if render.get("voiceProfileId") != expected_id:
                reasons.append(f"source_report_render_voice_profile_id_mismatch:{render_label}")
            if render.get("profileSha256") != expected_sha:
                reasons.append(f"source_report_render_profile_sha256_mismatch:{render_label}")
    return reasons


def source_report_backend_evidence_reasons(
    report: dict[str, Any],
    *,
    report_path: Path,
    baseline_clone_mode: str,
    candidate_clone_mode: str,
    require_external_candidate: bool,
) -> list[str]:
    reasons: list[str] = []
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    baseline_groups = [group for group in groups if isinstance(group, dict) and str(group.get("cloneMode") or "") == baseline_clone_mode]
    candidate_groups = [group for group in groups if isinstance(group, dict) and str(group.get("cloneMode") or "") == candidate_clone_mode]
    if not baseline_groups:
        reasons.append("source_report_baseline_groups_missing")
    if not candidate_groups:
        reasons.append("source_report_candidate_groups_missing")

    review_groups = [
        group
        for group in groups
        if isinstance(group, dict) and str(group.get("cloneMode") or "") in {baseline_clone_mode, candidate_clone_mode}
    ]
    for group in review_groups:
        clone_mode = str(group.get("cloneMode") or "")
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "")
        group_label = f"{clone_mode}/{case_id}".strip("/") or clone_mode or case_id or "group"
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                reasons.append(f"source_report_review_output_missing:{render_label}")
            if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                reasons.append(f"source_report_review_output_bytes_missing:{render_label}")
            if not valid_sha256(render.get("outputSha256")):
                reasons.append(f"source_report_review_output_sha256_missing:{render_label}")
            output_path = resolve_render_output_path(render, report_path)
            if output_path is None:
                reasons.append(f"source_report_review_output_path_missing:{render_label}")
                continue
            try:
                actual_bytes = output_path.stat().st_size
            except OSError:
                reasons.append(f"source_report_review_output_file_missing:{render_label}")
                continue
            if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                reasons.append(f"source_report_review_output_bytes_mismatch:{render_label}")
            actual_sha256 = sha256_file(output_path)
            if valid_sha256(render.get("outputSha256")) and actual_sha256 != render.get("outputSha256"):
                reasons.append(f"source_report_review_output_sha256_mismatch:{render_label}")

    ready_candidate_renders = 0
    external_candidate_renders = 0
    for group in candidate_groups:
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "")
        group_label = f"{candidate_clone_mode}/{case_id}".strip("/") or candidate_clone_mode
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
            if render.get("status") != "ready":
                reasons.append(f"source_report_candidate_render_not_ready:{render_label}")
                continue
            ready_candidate_renders += 1
            if render.get("externalBackend") is True:
                external_candidate_renders += 1
            if require_external_candidate:
                if render.get("externalBackend") is not True:
                    reasons.append(f"source_report_candidate_external_backend_missing:{render_label}")
                if render.get("outputExists") is not True or render.get("missingOutput") is True:
                    reasons.append(f"source_report_candidate_output_missing:{render_label}")
                if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                    reasons.append(f"source_report_candidate_output_bytes_missing:{render_label}")
                if not valid_sha256(render.get("outputSha256")):
                    reasons.append(f"source_report_candidate_output_sha256_missing:{render_label}")
                output_path = resolve_render_output_path(render, report_path)
                if output_path is None:
                    reasons.append(f"source_report_candidate_output_path_missing:{render_label}")
                    continue
                try:
                    actual_bytes = output_path.stat().st_size
                except OSError:
                    reasons.append(f"source_report_candidate_output_file_missing:{render_label}")
                    continue
                if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                    reasons.append(f"source_report_candidate_output_bytes_mismatch:{render_label}")
                actual_sha256 = sha256_file(output_path)
                if valid_sha256(render.get("outputSha256")) and actual_sha256 != render.get("outputSha256"):
                    reasons.append(f"source_report_candidate_output_sha256_mismatch:{render_label}")

    if not ready_candidate_renders:
        reasons.append("source_report_candidate_ready_renders_missing")
    if require_external_candidate and not external_candidate_renders:
        reasons.append("source_report_candidate_has_no_external_render_evidence")
    return reasons


def source_report_hash_reasons(score: dict[str, Any], score_path: Path) -> list[str]:
    reasons: list[str] = []
    source_report = resolve_score_source_report_path(score, score_path)
    if source_report is None:
        return ["score_source_report_missing"]
    expected_sha = sha256_file(source_report)
    score_sha = score.get("sourceReportSha256")
    if not valid_sha256(score_sha):
        reasons.append("score_source_report_sha256_missing")
    elif str(score_sha).lower() != expected_sha:
        reasons.append("score_source_report_sha256_mismatch")
    return reasons


def evaluate_selection(
    score: dict[str, Any],
    *,
    score_path: Path,
    baseline_clone_mode: str,
    candidate_clone_mode: str,
    require_external_candidate: bool,
    require_subjective_review: bool = True,
    review_path: Path | None = None,
    min_subjective_win_rate: float = 0.8,
    subjective_review_bypass_acknowledged: bool = False,
    subjective_review_bypass_reason: str | None = None,
) -> dict[str, Any]:
    baseline_clone_mode = str(baseline_clone_mode or "").strip()
    candidate_clone_mode = str(candidate_clone_mode or "").strip()
    reasons: list[str] = []
    paired = score.get("pairedComparison") if isinstance(score.get("pairedComparison"), dict) else None
    candidate_groups = groups_for_mode(score, candidate_clone_mode)
    baseline_groups = groups_for_mode(score, baseline_clone_mode)
    candidate_renders = renders_for_groups(candidate_groups)
    external_candidate_renders = [render for render in candidate_renders if render.get("externalBackend") is True]

    if baseline_clone_mode not in ALLOWED_VOICE_BACKENDS:
        reasons.append(f"baseline_backend_not_allowed:{baseline_clone_mode}")
    if candidate_clone_mode not in ALLOWED_VOICE_BACKENDS:
        reasons.append(f"candidate_backend_not_allowed:{candidate_clone_mode}")
    if require_external_candidate and baseline_clone_mode != "voxcpm2-hifi":
        reasons.append("baseline_must_be_voxcpm2_hifi")
    if score.get("verdict") != "pass":
        reasons.append("score_verdict_not_pass")
    reasons.extend(source_report_hash_reasons(score, score_path))
    if not paired:
        reasons.append("missing_paired_comparison")
    else:
        if paired.get("baselineCloneMode") != baseline_clone_mode:
            reasons.append("paired_baseline_mismatch")
        if paired.get("candidateCloneMode") != candidate_clone_mode:
            reasons.append("paired_candidate_mismatch")
        if paired.get("verdict") != "pass":
            reasons.append("paired_comparison_not_pass")
        summary = paired.get("summary") if isinstance(paired.get("summary"), dict) else {}
        if not isinstance(summary.get("pairs"), int) or summary.get("pairs") <= 0:
            reasons.append("paired_comparison_has_no_pairs")
        if isinstance(summary.get("reviewPairs"), int) and summary.get("reviewPairs") > 0:
            reasons.append("paired_comparison_has_review_pairs")
        pairs = paired.get("pairs") if isinstance(paired.get("pairs"), list) else []
        missing_delta_cases = [
            str(row.get("caseId") or "")
            for row in pairs
            if isinstance(row, dict) and not isinstance(row.get("speakerSimilarityDelta"), (int, float))
        ]
        regressed_cases = [
            str(row.get("caseId") or "")
            for row in pairs
            if isinstance(row, dict)
            and isinstance(row.get("speakerSimilarityDelta"), (int, float))
            and float(row["speakerSimilarityDelta"]) < 0
        ]
        missing_latency_cases = [
            str(row.get("caseId") or "")
            for row in pairs
            if isinstance(row, dict) and not isinstance(row.get("latencyRegressionPct"), (int, float))
        ]
        latency_regressed_cases = [
            str(row.get("caseId") or "")
            for row in pairs
            if isinstance(row, dict) and row.get("latencyVerdict") != "pass"
        ]
        if missing_delta_cases:
            reasons.append("speaker_similarity_delta_not_measurable")
        if regressed_cases:
            reasons.append("speaker_similarity_regressed")
        if missing_latency_cases:
            reasons.append("latency_delta_not_measurable")
        if latency_regressed_cases:
            reasons.append("latency_regressed")

    if not baseline_groups:
        reasons.append("missing_baseline_groups")
    if not candidate_groups:
        reasons.append("missing_candidate_groups")
    if require_external_candidate and not external_candidate_renders:
        reasons.append("candidate_has_no_external_render_evidence")

    reasons.extend(profile_evidence_reasons(score, [*baseline_groups, *candidate_groups]))

    for group in baseline_groups:
        case_id = str(group.get("caseId") or "")
        if group.get("verdict") != "pass":
            reasons.append(f"baseline_group_not_pass:{case_id}")
        if group.get("pronunciationVerdict") != "pass":
            reasons.append(f"baseline_pronunciation_not_pass:{case_id}")
        if group.get("stabilityVerdict") != "pass":
            reasons.append(f"baseline_stability_not_pass:{case_id}")
        if group.get("speakerIdentityVerdict") != "pass":
            reasons.append(f"baseline_speaker_identity_not_pass:{case_id}")
        if group.get("audioQualityVerdict") != "pass":
            reasons.append(f"baseline_audio_quality_not_pass:{case_id}")

    for group in candidate_groups:
        case_id = str(group.get("caseId") or "")
        if group.get("verdict") != "pass":
            reasons.append(f"candidate_group_not_pass:{case_id}")
        if group.get("pronunciationVerdict") != "pass":
            reasons.append(f"candidate_pronunciation_not_pass:{case_id}")
        if group.get("stabilityVerdict") != "pass":
            reasons.append(f"candidate_stability_not_pass:{case_id}")
        if group.get("speakerIdentityVerdict") != "pass":
            reasons.append(f"candidate_speaker_identity_not_pass:{case_id}")
        if group.get("audioQualityVerdict") != "pass":
            reasons.append(f"candidate_audio_quality_not_pass:{case_id}")

    for render in candidate_renders:
        if render.get("status") != "ready":
            reasons.append(f"candidate_render_not_ready:{render.get('caseId')}#r{render.get('repeat')}")
    for render in renders_for_groups(baseline_groups):
        if render.get("status") != "ready":
            reasons.append(f"baseline_render_not_ready:{render.get('caseId')}#r{render.get('repeat')}")
    for render in external_candidate_renders:
        label = f"{render.get('caseId')}#r{render.get('repeat')}"
        if render.get("outputExists") is not True or render.get("missingOutput") is True:
            reasons.append(f"external_candidate_output_missing:{label}")
        if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
            reasons.append(f"external_candidate_output_bytes_missing:{label}")
        if not valid_sha256(render.get("outputSha256")):
            reasons.append(f"external_candidate_output_sha256_missing:{label}")
        output_path = resolve_render_output_path(render, score_path)
        if output_path is None:
            reasons.append(f"external_candidate_output_path_missing:{label}")
            continue
        try:
            actual_bytes = output_path.stat().st_size
        except OSError:
            reasons.append(f"external_candidate_output_file_missing:{label}")
            continue
        if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
            reasons.append(f"external_candidate_output_bytes_mismatch:{label}")
        actual_sha256 = sha256_file(output_path)
        if valid_sha256(render.get("outputSha256")) and actual_sha256 != render.get("outputSha256"):
            reasons.append(f"external_candidate_output_sha256_mismatch:{label}")

    candidate_speaker_values = speaker_values(candidate_groups)
    baseline_speaker_values = speaker_values(baseline_groups)
    if not candidate_speaker_values:
        reasons.append("candidate_speaker_similarity_missing")
    if not baseline_speaker_values:
        reasons.append("baseline_speaker_similarity_missing")

    subjective_review = None
    if require_subjective_review:
        subjective_review = evaluate_subjective_review(
            score,
            score_path=score_path,
            baseline_clone_mode=baseline_clone_mode,
            candidate_clone_mode=candidate_clone_mode,
            explicit_review_path=review_path,
            min_candidate_win_rate=min_subjective_win_rate,
        )
        if subjective_review.get("status") != "pass":
            reasons.extend(
                str(reason)
                for reason in subjective_review.get("reasons", [])
                if isinstance(reason, str)
            )
        else:
            source_report_raw = subjective_review.get("report")
            if isinstance(source_report_raw, str) and source_report_raw.strip():
                source_report = load_json(Path(source_report_raw).expanduser().resolve(strict=False))
                if isinstance(source_report, dict):
                    reasons.extend(
                        source_report_profile_evidence_reasons(
                            score,
                            source_report,
                            clone_modes={baseline_clone_mode, candidate_clone_mode},
                        )
                    )
                    reasons.extend(
                        source_report_backend_evidence_reasons(
                            source_report,
                            report_path=Path(source_report_raw).expanduser().resolve(strict=False),
                            baseline_clone_mode=baseline_clone_mode,
                            candidate_clone_mode=candidate_clone_mode,
                            require_external_candidate=require_external_candidate,
                        )
                    )
    else:
        subjective_reasons = ["subjective_review_bypassed"]
        if not subjective_review_bypass_acknowledged:
            subjective_reasons.append("unsafe_subjective_review_bypass_not_acknowledged")
        subjective_review = {
            "status": "bypassed",
            "reasons": subjective_reasons,
            "acceptedUnsafeBypass": bool(subjective_review_bypass_acknowledged),
            "reason": str(subjective_review_bypass_reason or "").strip(),
            "requiredFlags": [
                "--allow-unsafe-subjective-review-bypass",
                "--unsafe-subjective-review-bypass-reason",
            ],
        }
        reasons.extend(subjective_reasons)

    proof_evidence: dict[str, Any] = {"scoreSha256": sha256_file(score_path)}
    if isinstance(subjective_review, dict):
        review_json = subjective_review.get("reviewJson")
        if isinstance(review_json, str) and review_json.strip():
            review_json_path = Path(review_json).expanduser().resolve(strict=False)
            proof_evidence["reviewJson"] = str(review_json_path)
            proof_evidence["reviewSha256"] = sha256_file(review_json_path)
        source_report = subjective_review.get("report")
        if isinstance(source_report, str) and source_report.strip():
            source_report_path = Path(source_report).expanduser().resolve(strict=False)
            proof_evidence["sourceReport"] = str(source_report_path)
            proof_evidence["sourceReportSha256"] = sha256_file(source_report_path)

    # Keep reasons stable and readable when several renders fail the same check.
    deduped_reasons = list(dict.fromkeys(reasons))
    verdict = "accept" if not deduped_reasons else "reject"
    paired_summary = paired.get("summary") if isinstance(paired, dict) and isinstance(paired.get("summary"), dict) else None
    return {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "scoreJson": str(score_path),
        **proof_evidence,
        "voiceProfile": score.get("voiceProfile") if isinstance(score.get("voiceProfile"), dict) else None,
        "baselineCloneMode": baseline_clone_mode,
        "candidateCloneMode": candidate_clone_mode,
        "verdict": verdict,
        "accepted": verdict == "accept",
        "reasons": deduped_reasons,
        "scoreVerdict": score.get("verdict"),
        "pairedComparisonVerdict": paired.get("verdict") if isinstance(paired, dict) else None,
        "pairedSummary": paired_summary,
        "subjectiveReview": subjective_review,
        "baseline": {
            "groups": len(baseline_groups),
            "avgSpeakerSimilarity": average(baseline_speaker_values),
        },
        "candidate": {
            "groups": len(candidate_groups),
            "renders": len(candidate_renders),
            "externalRenders": len(external_candidate_renders),
            "hashedExternalRenders": sum(1 for render in external_candidate_renders if valid_sha256(render.get("outputSha256"))),
            "avgSpeakerSimilarity": average(candidate_speaker_values),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Select or reject an external voice backend candidate from a strict AnyVoice paired score JSON.",
    )
    parser.add_argument("score_json", help="Score JSON produced by score_voice_regression.py.")
    parser.add_argument("--baseline-clone-mode", default="voxcpm2-hifi")
    parser.add_argument("--candidate-clone-mode", required=True)
    parser.add_argument("--allow-native-candidate", action="store_true", help="Do not require external render hash evidence for the candidate.")
    parser.add_argument("--review-json", help="Blind A/B review JSON exported from the source regression report. Defaults to review.json beside the report.")
    parser.add_argument(
        "--skip-subjective-review",
        action="store_true",
        help="Experiment-only bypass for blind review validation; the selection proof remains rejected.",
    )
    parser.add_argument(
        "--allow-unsafe-subjective-review-bypass",
        action="store_true",
        help="Acknowledge that --skip-subjective-review is unsafe and cannot produce an accepted backend proof.",
    )
    parser.add_argument(
        "--unsafe-subjective-review-bypass-reason",
        help="Required human-readable reason when using --skip-subjective-review for internal experiments.",
    )
    parser.add_argument("--min-subjective-win-rate", type=float, default=0.8)
    parser.add_argument("--out", help="Selection proof JSON path. Defaults to <score>.backend-selection.json.")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero unless the candidate is accepted.")
    args = parser.parse_args()

    score_path = Path(args.score_json).expanduser().resolve()
    score = load_json(score_path)
    if not isinstance(score, dict):
        raise SystemExit(f"score JSON must be an object: {score_path}")
    bypass_reason = str(args.unsafe_subjective_review_bypass_reason or "").strip()
    bypass_acknowledged = bool(
        args.skip_subjective_review
        and args.allow_unsafe_subjective_review_bypass
        and bypass_reason
    )
    proof = evaluate_selection(
        score,
        score_path=score_path,
        baseline_clone_mode=args.baseline_clone_mode,
        candidate_clone_mode=args.candidate_clone_mode,
        require_external_candidate=not args.allow_native_candidate,
        require_subjective_review=not args.skip_subjective_review,
        review_path=Path(args.review_json).expanduser().resolve() if args.review_json else None,
        min_subjective_win_rate=args.min_subjective_win_rate,
        subjective_review_bypass_acknowledged=bypass_acknowledged,
        subjective_review_bypass_reason=bypass_reason,
    )
    out_path = Path(args.out).expanduser().resolve() if args.out else score_path.with_suffix(".backend-selection.json")
    write_json(out_path, proof)
    print(json.dumps({**proof, "selection": str(out_path)}, ensure_ascii=False))
    if args.skip_subjective_review and not bypass_acknowledged:
        sys.exit(2)
    if args.strict and proof["verdict"] != "accept":
        sys.exit(2)


if __name__ == "__main__":
    main()
