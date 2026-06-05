from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from prepare_voxcpm_lora_training_job import (
    default_trainer_command_template,
    validate_dataset,
    validate_dataset_proofs,
    validate_trainer_command_resolution,
    validate_trainer_command_template,
)


REQUIRED_TRAINING_UTILITIES = [
    "load_audio_text_datasets",
    "HFVoxCPMDataset",
    "BatchProcessor",
]


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


def require_path(value: Any, *, base_dir: Path, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"train config is missing required path: {label}")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def inspect_voxcpm_runtime(python: str) -> dict[str, Any]:
    probe = r"""
import importlib
import importlib.metadata
import json
import shutil

result = {
    "status": "missing",
    "python": None,
    "voxcpmImported": False,
    "voxcpmVersion": None,
    "trainingImported": False,
    "trainingUtilities": {},
    "trainerCli": {"path": shutil.which("voxcpm"), "status": "unknown"},
    "errors": [],
}
try:
    import sys
    result["python"] = sys.executable
    voxcpm = importlib.import_module("voxcpm")
    result["voxcpmImported"] = True
    result["voxcpmModule"] = getattr(voxcpm, "__file__", None)
    try:
        result["voxcpmVersion"] = importlib.metadata.version("voxcpm")
    except importlib.metadata.PackageNotFoundError:
        result["voxcpmVersion"] = getattr(voxcpm, "__version__", None)
    training = importlib.import_module("voxcpm.training")
    result["trainingImported"] = True
    result["trainingModule"] = getattr(training, "__file__", None)
    for name in ("load_audio_text_datasets", "HFVoxCPMDataset", "BatchProcessor"):
        result["trainingUtilities"][name] = hasattr(training, name)
    result["status"] = "pass" if all(result["trainingUtilities"].values()) else "partial"
except Exception as exc:
    result["errors"].append(f"{type(exc).__name__}: {exc}")
print(json.dumps(result, ensure_ascii=False))
"""
    completed = subprocess.run(
        [python, "-c", probe],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return {
            "status": "missing",
            "python": python,
            "voxcpmImported": False,
            "trainingImported": False,
            "trainingUtilities": {},
            "trainerCli": {"path": None, "status": "unknown"},
            "errors": [completed.stderr.strip() or completed.stdout.strip() or f"python exited {completed.returncode}"],
        }
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            "status": "missing",
            "python": python,
            "voxcpmImported": False,
            "trainingImported": False,
            "trainingUtilities": {},
            "trainerCli": {"path": None, "status": "unknown"},
            "errors": [f"runtime probe did not return JSON: {completed.stdout.strip()}"],
        }
    return payload if isinstance(payload, dict) else {"status": "missing", "errors": ["runtime probe returned non-object JSON"]}


def command_template_from(config: dict[str, Any], override: str | None) -> tuple[str | None, str]:
    if override:
        return override, "--trainer-command"
    env_template = os.environ.get("ANYVOICE_VOXCPM_TRAINER_COMMAND")
    if env_template:
        return env_template, "ANYVOICE_VOXCPM_TRAINER_COMMAND"
    trainer = config.get("trainer") if isinstance(config.get("trainer"), dict) else {}
    config_template = trainer.get("commandTemplate")
    if isinstance(config_template, str) and config_template.strip():
        return config_template, "train_config.trainer.commandTemplate"
    return None, "missing"


def python_from_command_resolution(resolution: dict[str, Any]) -> str | None:
    executable = resolution.get("executable") if isinstance(resolution.get("executable"), dict) else {}
    raw = str(executable.get("raw") or "")
    name = Path(raw).name.lower()
    if not (name == "python" or name.startswith("python")):
        return None
    resolved = executable.get("resolved")
    return str(resolved or raw) if resolved or raw else None


def validate_config_paths(config: dict[str, Any], config_path: Path) -> dict[str, Any]:
    config_dir = config_path.parent
    dataset_path = require_path(config.get("datasetJson"), base_dir=config_dir, label="datasetJson")
    manifests = config.get("manifests") if isinstance(config.get("manifests"), dict) else {}
    train_manifest = require_path(manifests.get("train"), base_dir=config_dir, label="manifests.train")
    val_manifest = require_path(manifests.get("val"), base_dir=config_dir, label="manifests.val")
    all_manifest = require_path(manifests.get("all"), base_dir=config_dir, label="manifests.all")
    trainer = config.get("trainer") if isinstance(config.get("trainer"), dict) else {}
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    output_dir = require_path(trainer.get("outputDir"), base_dir=config_dir, label="trainer.outputDir")
    adapter_path = require_path(lora.get("expectedWeights"), base_dir=config_dir, label="lora.expectedWeights")
    train_script = require_path(trainer.get("trainScript"), base_dir=config_dir, label="trainer.trainScript")

    missing = [
        str(path)
        for path in (dataset_path, train_manifest, val_manifest, all_manifest, train_script)
        if not path.exists()
    ]
    if missing:
        raise SystemExit(f"train config references missing file(s): {', '.join(missing)}")
    if adapter_path.parent != output_dir:
        raise SystemExit(
            "train config adapter path must live under trainer.outputDir: "
            f"{adapter_path} is not in {output_dir}"
        )
    return {
        "datasetJson": str(dataset_path),
        "trainManifest": str(train_manifest),
        "valManifest": str(val_manifest),
        "allManifest": str(all_manifest),
        "outputDir": str(output_dir),
        "adapterPath": str(adapter_path),
        "trainScript": str(train_script),
    }


def build_payload(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    config_path = Path(args.train_config).expanduser().resolve()
    config = load_json(config_path, "train config")
    paths = validate_config_paths(config, config_path)
    dataset = config.get("dataset") if isinstance(config.get("dataset"), dict) else {}
    min_clips = int(dataset.get("minClips") or 7)
    min_duration = float(dataset.get("minTotalDurationSec") or 60)
    validation = validate_dataset(
        dataset_path=Path(paths["datasetJson"]),
        min_clips=min_clips,
        min_total_duration_sec=min_duration,
        require_val=True,
    )
    proof_validation = validate_dataset_proofs(
        dataset=validation["dataset"],
        dataset_path=Path(paths["datasetJson"]),
        all_rows=validation["allRows"],
        allow_unsafe_dataset=args.allow_unsafe_dataset,
        unsafe_dataset_reason=args.unsafe_dataset_reason,
    )

    template, template_source = command_template_from(config, args.trainer_command)
    template_validation: dict[str, Any]
    reasons: list[str] = []
    if template:
        try:
            template_validation = validate_trainer_command_template(template, source=template_source)
            command_resolution = validate_trainer_command_resolution(
                template,
                config=config_path,
                output_dir=Path(paths["outputDir"]),
                adapter_path=Path(paths["adapterPath"]),
                train_manifest=Path(paths["trainManifest"]),
                val_manifest=Path(paths["valManifest"]),
                base_dir=config_path.parent,
                source=template_source,
            )
            if command_resolution.get("status") != "pass":
                reasons.append("trainer_command_unresolved")
        except SystemExit as exc:
            template_validation = {"status": "fail", "source": template_source, "message": str(exc)}
            command_resolution = {"status": "fail", "source": template_source, "errors": [str(exc)]}
            reasons.append("trainer_command_invalid")
    else:
        template_validation = {
            "status": "missing",
            "source": template_source,
            "message": "set ANYVOICE_VOXCPM_TRAINER_COMMAND or regenerate the job with --trainer-command",
        }
        command_resolution = {"status": "missing", "source": template_source, "errors": ["trainer_command_missing"]}
        reasons.append("trainer_command_missing")

    runtime_python = args.python
    runtime_source = "--python"
    command_python = (
        python_from_command_resolution(command_resolution)
        if isinstance(command_resolution, dict) and command_resolution.get("status") == "pass"
        else None
    )
    if command_python:
        runtime_python = command_python
        runtime_source = "trainer_command"
    runtime = inspect_voxcpm_runtime(runtime_python)
    runtime["source"] = runtime_source
    if str(args.python) != str(runtime_python):
        runtime["requestedPython"] = args.python

    utility_map = runtime.get("trainingUtilities") if isinstance(runtime.get("trainingUtilities"), dict) else {}
    missing_utilities = [name for name in REQUIRED_TRAINING_UTILITIES if utility_map.get(name) is not True]
    if runtime.get("status") != "pass" or missing_utilities:
        reasons.append("voxcpm_training_runtime_incomplete")

    status = "pass" if not reasons else "blocked"
    suggested_trainer_template = template or default_trainer_command_template()
    payload = {
        "status": status,
        "reasons": reasons,
        "trainConfig": str(config_path),
        "paths": paths,
        "dataset": {
            "totalClips": len(validation["allRows"]),
            "trainClips": len(validation["trainRows"]),
            "valClips": len(validation["valRows"]),
            "totalDurationSec": round(float(validation["totalDurationSec"]), 3),
            "proofs": proof_validation,
        },
        "trainerCommand": {
            "source": template_source,
            "template": template,
            "validation": template_validation,
            "resolution": command_resolution,
        },
        "voxcpmRuntime": runtime,
        "nextCommands": {
            "configureTrainer": f"export ANYVOICE_VOXCPM_TRAINER_COMMAND={shlex.quote(suggested_trainer_template)}",
            "train": f"bash {paths['trainScript']}",
        },
    }
    return payload, 0 if status == "pass" else 2


def main() -> None:
    parser = argparse.ArgumentParser(description="Preflight a VoxCPM LoRA trainer command and runtime before running training.")
    parser.add_argument("--train-config", required=True, help="Path to train_config.json produced by prepare_voxcpm_lora_training_job.py.")
    parser.add_argument("--trainer-command", help="Optional trainer command template override.")
    parser.add_argument("--python", default=sys.executable, help="Python interpreter that should import voxcpm.training.")
    parser.add_argument("--allow-unsafe-dataset", action="store_true")
    parser.add_argument("--unsafe-dataset-reason", default="")
    args = parser.parse_args()

    payload, exit_code = build_payload(args)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
