from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from select_voice_backend_candidate import ALLOWED_VOICE_BACKENDS, evaluate_selection


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
EXTERNAL_VOICE_BACKENDS = {"indextts2", "f5-tts", "fishaudio-s2-pro"}


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
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise SystemExit(f"backend selection proof evidence file is missing or unreadable: {path}") from exc
    return digest.hexdigest()


def canonical_profile_sha256(profile: dict[str, Any]) -> str:
    payload = dict(profile)
    payload.pop("createdAt", None)
    payload.pop("loraPath", None)
    payload.pop("loraAdapter", None)
    payload.pop("preferredBackend", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def resolve_related_path(raw_path: Any, base_dir: Path, label: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise SystemExit(f"backend selection proof does not name {label}")
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False)


def require_policy_evidence_path(raw_path: Any, label: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise SystemExit(f"backend selection proof is missing accepted {label} evidence")
    return Path(raw_path).expanduser().resolve(strict=False)


def require_selection_evidence_sha(selection: dict[str, Any], field: str, path: Path, label: str) -> None:
    expected_sha = selection.get(field)
    if not isinstance(expected_sha, str) or not expected_sha.strip():
        raise SystemExit(f"backend selection proof is missing {label} SHA-256 evidence: {field}")
    actual_sha = sha256_file(path)
    if expected_sha.strip().lower() != actual_sha:
        raise SystemExit(
            f"backend selection proof {label} SHA-256 no longer matches: "
            f"{field}={expected_sha!r}, expected {actual_sha} ({path})"
        )


def same_path(raw_path: Any, expected: Path, base_dir: Path | None = None) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    path = Path(raw_path).expanduser()
    if not path.is_absolute() and base_dir is not None:
        path = base_dir / path
    return path.resolve(strict=False) == expected.resolve(strict=False)


def valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value.lower())


def resolve_render_output_path(render: dict[str, Any], evidence_json_path: Path) -> Path | None:
    raw_path = render.get("outputWav")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = evidence_json_path.parent / path
    return path.resolve(strict=False)


def ready_render_output_evidence_reasons(root_label: str, groups: Any, evidence_json_path: Path) -> list[str]:
    reasons: list[str] = []
    if not isinstance(groups, list):
        return [f"{root_label}.groups"]
    for group_index, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        case_id = str(group.get("caseId") or group_index)
        clone_mode = str(group.get("cloneMode") or root_label)
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render_index, render in enumerate(renders):
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            repeat = render.get("repeat")
            render_label = (
                f"{clone_mode}/{case_id}#r{repeat}" if repeat is not None else f"{clone_mode}/{case_id}#{render_index}"
            )
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                reasons.append(f"{root_label}_ready_render_output_missing:{render_label}")
            if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                reasons.append(f"{root_label}_ready_render_output_bytes_missing:{render_label}")
            if not valid_sha256(render.get("outputSha256")):
                reasons.append(f"{root_label}_ready_render_output_sha256_missing:{render_label}")
            output_path = resolve_render_output_path(render, evidence_json_path)
            if output_path is None:
                reasons.append(f"{root_label}_ready_render_output_path_missing:{render_label}")
                continue
            try:
                actual_bytes = output_path.stat().st_size
            except OSError:
                reasons.append(f"{root_label}_ready_render_output_file_missing:{render_label}")
                continue
            if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                reasons.append(f"{root_label}_ready_render_output_bytes_mismatch:{render_label}")
            actual_sha256 = sha256_file(output_path)
            if valid_sha256(render.get("outputSha256")) and render.get("outputSha256") != actual_sha256:
                reasons.append(f"{root_label}_ready_render_output_sha256_mismatch:{render_label}")
    return reasons


def score_matches_profile(score: dict[str, Any], profile: dict[str, Any]) -> bool:
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip()
    if not voice_profile_id:
        return False
    profile_sha256 = canonical_profile_sha256(profile)
    score_profile = score.get("voiceProfile") if isinstance(score.get("voiceProfile"), dict) else {}
    if score_profile.get("voiceProfileId") != voice_profile_id:
        return False
    if score_profile.get("profileSha256") != profile_sha256:
        return False
    matched = 0
    groups = score.get("groups") if isinstance(score.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        if group.get("voiceProfileId") != voice_profile_id:
            return False
        if group.get("profileSha256") != profile_sha256:
            return False
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            if render.get("voiceProfileId") != voice_profile_id:
                return False
            if render.get("profileSha256") != profile_sha256:
                return False
            matched += 1
    return matched > 0


def validate_selection_proof_contract(selection: dict[str, Any], profile: dict[str, Any]) -> None:
    if selection.get("verdict") != "accept" or selection.get("accepted") is not True:
        raise SystemExit("backend selection proof must have verdict=accept and accepted=true before applying")
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip()
    if not voice_profile_id:
        raise SystemExit("voice profile is missing voiceProfileId")
    profile_sha256 = canonical_profile_sha256(profile)
    selection_profile = selection.get("voiceProfile") if isinstance(selection.get("voiceProfile"), dict) else None
    if not isinstance(selection_profile, dict):
        raise SystemExit("backend selection proof is missing voiceProfile evidence")
    if selection_profile.get("voiceProfileId") != voice_profile_id or selection_profile.get("profileSha256") != profile_sha256:
        raise SystemExit(
            "backend selection proof does not match the target voice profile: "
            f"voiceProfileId={selection_profile.get('voiceProfileId')!r}, "
            f"profileSha256={selection_profile.get('profileSha256')!r}, "
            f"expected voiceProfileId={voice_profile_id!r}, profileSha256={profile_sha256}"
        )


def build_policy(
    *,
    profile: dict[str, Any],
    profile_path: Path,
    selection_path: Path,
    selection: dict[str, Any],
) -> dict[str, Any]:
    validate_selection_proof_contract(selection, profile)
    score_path = resolve_related_path(selection.get("scoreJson"), selection_path.parent, "scoreJson")
    require_selection_evidence_sha(selection, "scoreSha256", score_path, "score JSON")
    score = load_json(score_path, "score JSON")
    baseline = str(selection.get("baselineCloneMode") or "voxcpm2-hifi")
    candidate = str(selection.get("candidateCloneMode") or "")
    if baseline not in ALLOWED_VOICE_BACKENDS:
        raise SystemExit(f"backend selection proof baselineCloneMode is not an allowed voice backend: {baseline}")
    if not candidate:
        raise SystemExit("backend selection proof does not name candidateCloneMode")
    if candidate not in ALLOWED_VOICE_BACKENDS:
        raise SystemExit(f"backend selection proof candidateCloneMode is not an allowed voice backend: {candidate}")
    if candidate not in EXTERNAL_VOICE_BACKENDS:
        raise SystemExit(f"backend selection proof candidateCloneMode must be an external voice backend: {candidate}")
    review_path = resolve_related_path(selection.get("reviewJson"), selection_path.parent, "reviewJson")
    require_selection_evidence_sha(selection, "reviewSha256", review_path, "subjective review JSON")
    source_report_path = resolve_related_path(selection.get("sourceReport"), selection_path.parent, "sourceReport")
    require_selection_evidence_sha(selection, "sourceReportSha256", source_report_path, "source report")
    if not same_path(score.get("sourceReport"), source_report_path, score_path.parent):
        raise SystemExit("backend selection proof sourceReport does not match the score JSON sourceReport")
    if score.get("sourceReportSha256") != selection.get("sourceReportSha256"):
        raise SystemExit("backend selection proof sourceReportSha256 does not match the score JSON sourceReportSha256")
    recomputed = evaluate_selection(
        score,
        score_path=score_path,
        baseline_clone_mode=baseline,
        candidate_clone_mode=candidate,
        require_external_candidate=True,
        review_path=review_path,
    )
    if recomputed.get("verdict") != "accept":
        raise SystemExit(
            "backend selection proof no longer recomputes as accepted: "
            + ", ".join(str(reason) for reason in recomputed.get("reasons", []))
        )
    score_render_reasons = ready_render_output_evidence_reasons("score", score.get("groups"), score_path)
    if score_render_reasons:
        raise SystemExit(
            "backend selection score does not prove ready render output files: " + ", ".join(score_render_reasons)
        )
    if not score_matches_profile(score, profile):
        raise SystemExit("backend selection score does not match the target voice profile")

    subjective = recomputed.get("subjectiveReview") if isinstance(recomputed.get("subjectiveReview"), dict) else {}
    review_json = subjective.get("reviewJson") if isinstance(subjective.get("reviewJson"), str) else (str(review_path) if review_path else None)
    source_report = subjective.get("report") if isinstance(subjective.get("report"), str) else None
    review_json_path = require_policy_evidence_path(review_json, "subjective review JSON")
    recomputed_source_report_path = require_policy_evidence_path(source_report, "source report")
    if not same_path(str(source_report_path), recomputed_source_report_path):
        raise SystemExit("backend selection proof sourceReport does not match the recomputed subjective review source report")
    return {
        "version": 1,
        "status": "accepted",
        "profileJson": str(profile_path),
        "voiceProfileId": str(profile.get("voiceProfileId") or ""),
        "profileSha256": canonical_profile_sha256(profile),
        "backend": candidate,
        "baselineBackend": baseline,
        "selectedAt": datetime.now(timezone.utc).isoformat(),
        "selectionJson": str(selection_path),
        "selectionSha256": sha256_file(selection_path),
        "scoreJson": str(score_path),
        "scoreSha256": sha256_file(score_path),
        "reviewJson": str(review_json_path),
        "reviewSha256": sha256_file(review_json_path),
        "sourceReport": str(recomputed_source_report_path),
        "sourceReportSha256": sha256_file(recomputed_source_report_path),
        "pairedSummary": recomputed.get("pairedSummary"),
        "candidate": recomputed.get("candidate"),
        "subjectiveReview": subjective,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply an accepted backend selection proof to a voice profile manifest.")
    parser.add_argument("selection_json", help="Accepted *.selection.json or *.backend-selection.json proof.")
    parser.add_argument("--profile-json", default=str(DEFAULT_PROFILE_JSON))
    parser.add_argument("--dry-run", action="store_true", help="Validate and print the policy without mutating the profile.")
    args = parser.parse_args()

    selection_path = Path(args.selection_json).expanduser().resolve(strict=False)
    profile_path = Path(args.profile_json).expanduser().resolve(strict=False)
    selection = load_json(selection_path, "backend selection proof")
    profile = load_json(profile_path, "voice profile")
    policy = build_policy(profile=profile, profile_path=profile_path, selection_path=selection_path, selection=selection)
    if not args.dry_run:
        profile["preferredBackend"] = policy
        write_json(profile_path, profile)
    print(
        json.dumps(
            {
                "status": "validated" if args.dry_run else "applied",
                "profileJson": str(profile_path),
                "backend": policy["backend"],
                "selectionJson": policy["selectionJson"],
                "scoreJson": policy["scoreJson"],
                "reviewJson": policy["reviewJson"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
