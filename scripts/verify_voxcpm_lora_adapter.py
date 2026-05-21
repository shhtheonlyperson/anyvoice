from __future__ import annotations

import argparse
import hashlib
import json
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent


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


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_path(raw_path: str, base_dir: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def resolve_adapter_path(raw_path: str, base_dir: Path) -> Path:
    path = resolve_path(raw_path, base_dir)
    if path.is_dir():
        path = path / "lora_weights.ckpt"
    return path.resolve()


def require_dict(payload: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise SystemExit(f"{label} is missing object field: {key}")
    return value


def validate_dataset_proof_contract(proofs: dict[str, Any], *, allow_unsafe_dataset: bool) -> None:
    unsafe_flags = {
        "acceptedUnsafeDataset": proofs.get("acceptedUnsafeDataset") is True,
        "transcriptValidationSkipped": proofs.get("transcriptValidationSkipped") is True,
        "qualityGateSkipped": proofs.get("qualityGateSkipped") is True,
        "unsafeExport": proofs.get("unsafeExport") is True,
    }
    if any(unsafe_flags.values()):
        if not allow_unsafe_dataset:
            raise SystemExit("adapter comes from an unsafe-bypassed dataset; pass --allow-unsafe-dataset to acknowledge it")
        return
    if proofs.get("productProofQualityGateRequired") is not True:
        raise SystemExit(
            "LoRA train config did not preserve paired product-proof dataset evidence: "
            "datasetProofs.productProofQualityGateRequired must be true"
        )


def inspect_checkpoint(path: Path, *, require_readable: bool) -> dict[str, Any]:
    suffix = path.suffix.lower()
    loader = "torch"
    try:
        if suffix == ".safetensors":
            from safetensors.torch import load_file  # type: ignore

            state = load_file(str(path), device="cpu")
            loader = "safetensors"
        else:
            import torch  # type: ignore

            state = torch.load(str(path), map_location="cpu")
    except ModuleNotFoundError as exc:
        if require_readable:
            raise SystemExit(f"checkpoint inspection dependency is missing: {exc.name}") from exc
        return {
            "status": "unavailable",
            "loader": loader,
            "reason": f"missing_dependency:{exc.name}",
            "loraParameterKeys": None,
        }
    except Exception as exc:
        if require_readable:
            raise SystemExit(f"checkpoint could not be read: {path}: {exc}") from exc
        return {
            "status": "unreadable",
            "loader": loader,
            "reason": str(exc),
            "loraParameterKeys": None,
        }

    if isinstance(state, dict):
        candidates = state.get("state_dict") if isinstance(state.get("state_dict"), dict) else state
        keys = [str(key) for key in candidates.keys()] if isinstance(candidates, dict) else []
    else:
        keys = []
    lora_keys = sorted(key for key in keys if "lora_A" in key or "lora_B" in key)
    if not lora_keys:
        raise SystemExit(f"checkpoint is readable but contains no LoRA parameter keys: {path}")
    return {
        "status": "readable",
        "loader": loader,
        "parameterKeyCount": len(keys),
        "loraParameterKeyCount": len(lora_keys),
        "loraParameterKeys": lora_keys[:20],
    }


def next_commands(*, adapter_path: Path, profile_path: str | None) -> dict[str, str]:
    profile_arg = profile_path or ".anyvoice/voices/local-default/profile.json"
    env_prefix = f"ANYVOICE_VOXCPM_LORA_PATH={shlex.quote(str(adapter_path))}"
    quality_gate = [
        "python3",
        "scripts/run_voice_quality_gate.py",
        "--profile-json",
        profile_arg,
        "--quality",
        "balanced",
        "--clone-mode",
        "hifi",
        "--require-speaker-backend",
        "speechbrain-ecapa",
        "--repeats",
        "3",
    ]
    return {
        "useAdapter": f"{env_prefix} ANYVOICE_ENABLE_LOCAL_VOXCPM=1 ANYVOICE_STUB=0 npm run dev",
        "qualityGateWithAdapterDryRun": f"{env_prefix} {shell_join([*quality_gate, '--dry-run'])}",
        "qualityGateWithAdapter": f"{env_prefix} {shell_join(quality_gate)}",
    }


def verify(
    *,
    config_path: Path,
    adapter_path: Path | None,
    min_bytes: int,
    require_readable_checkpoint: bool,
    allow_unsafe_dataset: bool,
) -> dict[str, Any]:
    config = load_json(config_path, "LoRA train config")
    lora = require_dict(config, "lora", "LoRA train config")
    dataset = require_dict(config, "dataset", "LoRA train config")
    proofs = require_dict(config, "datasetProofs", "LoRA train config")
    expected_raw = lora.get("expectedWeights")
    if not isinstance(expected_raw, str) or not expected_raw.strip():
        raise SystemExit(f"LoRA train config is missing lora.expectedWeights: {config_path}")
    expected_path = resolve_adapter_path(expected_raw, config_path.parent)
    actual_path = resolve_adapter_path(str(adapter_path), config_path.parent) if adapter_path else expected_path
    if actual_path != expected_path:
        raise SystemExit(f"adapter path does not match train config: {actual_path} != {expected_path}")
    validate_dataset_proof_contract(proofs, allow_unsafe_dataset=allow_unsafe_dataset)
    if not actual_path.exists() or not actual_path.is_file():
        raise SystemExit(f"LoRA adapter file is missing: {actual_path}")
    size = actual_path.stat().st_size
    if size < min_bytes:
        raise SystemExit(f"LoRA adapter file is too small: {size} < {min_bytes} bytes")
    total_clips = dataset.get("totalClips")
    total_duration = dataset.get("totalDurationSec")
    min_clips = dataset.get("minClips")
    min_duration = dataset.get("minTotalDurationSec")
    if not isinstance(total_clips, int) or not isinstance(min_clips, int) or total_clips < min_clips:
        raise SystemExit("LoRA train config dataset clip count is below its minimum")
    if (
        not isinstance(total_duration, (int, float))
        or not isinstance(min_duration, (int, float))
        or float(total_duration) < float(min_duration)
    ):
        raise SystemExit("LoRA train config dataset duration is below its minimum")

    checkpoint = inspect_checkpoint(actual_path, require_readable=require_readable_checkpoint)
    status = "pass" if checkpoint.get("status") == "readable" else "metadata_pass"
    profile_path = config.get("profilePath") if isinstance(config.get("profilePath"), str) else None
    return {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "adapter": {
            "path": str(actual_path),
            "bytes": size,
            "sha256": sha256_file(actual_path),
        },
        "trainConfig": str(config_path),
        "voiceProfileId": config.get("voiceProfileId"),
        "profilePath": profile_path,
        "dataset": dataset,
        "datasetProofs": proofs,
        "lora": {
            "rank": lora.get("rank"),
            "alpha": lora.get("alpha"),
            "dropout": lora.get("dropout"),
            "enableLm": lora.get("enableLm"),
            "enableDit": lora.get("enableDit"),
            "enableProj": lora.get("enableProj"),
        },
        "checkpoint": checkpoint,
        "nextCommands": next_commands(adapter_path=actual_path, profile_path=profile_path),
        "warnings": []
        if checkpoint.get("status") == "readable"
        else [
            "Adapter file metadata passed, but checkpoint tensor keys were not inspected in this Python environment.",
            "Run again with the VoxCPM/Torch environment and --require-readable-checkpoint before treating this as final proof.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify a trained VoxCPM LoRA adapter against an AnyVoice training job config.")
    parser.add_argument("--train-config", required=True, help="Path to train_config.json from prepare_voxcpm_lora_training_job.py.")
    parser.add_argument("--adapter-path", help="Adapter file or directory. Defaults to lora.expectedWeights from train_config.json.")
    parser.add_argument("--out", help="Optional JSON proof output path. Defaults to <adapter-dir>/adapter-proof.json.")
    parser.add_argument("--min-bytes", type=int, default=1)
    parser.add_argument("--require-readable-checkpoint", action="store_true", help="Require torch/safetensors checkpoint inspection and LoRA parameter keys.")
    parser.add_argument("--allow-unsafe-dataset", action="store_true", help="Acknowledge that the training job came from an unsafe-bypassed dataset.")
    args = parser.parse_args()
    if args.min_bytes <= 0:
        raise SystemExit("--min-bytes must be positive")

    config_path = Path(args.train_config).expanduser().resolve()
    adapter_path = Path(args.adapter_path).expanduser().resolve() if args.adapter_path else None
    payload = verify(
        config_path=config_path,
        adapter_path=adapter_path,
        min_bytes=args.min_bytes,
        require_readable_checkpoint=args.require_readable_checkpoint,
        allow_unsafe_dataset=args.allow_unsafe_dataset,
    )
    out_path = Path(args.out).expanduser().resolve() if args.out else Path(payload["adapter"]["path"]).with_name("adapter-proof.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    payload["proofJson"] = str(out_path)
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
