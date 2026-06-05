from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import random
import sys
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


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_path(raw_path: Any, base_dir: Path, label: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise SystemExit(f"train config is missing required path: {label}")
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{line_number} is not valid JSONL: {exc}") from exc
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{line_number} is not a JSON object")
            rows.append(row)
    return rows


def validate_manifest_rows(path: Path, *, require_rows: bool) -> dict[str, Any]:
    rows = read_jsonl(path)
    if require_rows and not rows:
        raise SystemExit(f"manifest has no rows: {path}")
    total_duration = 0.0
    missing_audio: list[str] = []
    missing_text = 0
    bad_hashes: list[str] = []
    for index, row in enumerate(rows, start=1):
        audio_raw = row.get("audio")
        if not isinstance(audio_raw, str) or not audio_raw.strip():
            missing_audio.append(f"row:{index}")
        else:
            audio_path = Path(audio_raw).expanduser()
            if not audio_path.is_absolute():
                audio_path = path.parent / audio_path
            audio_path = audio_path.resolve(strict=False)
            if not audio_path.is_file():
                missing_audio.append(str(audio_path))
            else:
                expected_sha = row.get("audioSha256")
                if isinstance(expected_sha, str) and expected_sha.strip() and sha256_file(audio_path) != expected_sha:
                    bad_hashes.append(str(audio_path))
        text = row.get("text")
        if not isinstance(text, str) or not text.strip():
            missing_text += 1
        duration = row.get("durationSec")
        if isinstance(duration, (int, float)):
            total_duration += float(duration)
    if missing_audio:
        raise SystemExit(f"manifest references missing audio: {', '.join(missing_audio[:5])}")
    if bad_hashes:
        raise SystemExit(f"manifest audio SHA-256 mismatch: {', '.join(bad_hashes[:5])}")
    if missing_text:
        raise SystemExit(f"manifest has {missing_text} row(s) without text: {path}")
    return {
        "path": str(path),
        "rows": len(rows),
        "durationSec": round(total_duration, 3),
        "sha256": sha256_file(path),
    }


def resolve_training_paths(config: dict[str, Any], config_path: Path, args: argparse.Namespace) -> dict[str, Path]:
    config_dir = config_path.parent
    manifests = config.get("manifests") if isinstance(config.get("manifests"), dict) else {}
    trainer = config.get("trainer") if isinstance(config.get("trainer"), dict) else {}
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else resolve_path(trainer.get("outputDir"), config_dir, "trainer.outputDir")
    adapter_path = Path(args.adapter).expanduser().resolve() if args.adapter else resolve_path(lora.get("expectedWeights"), config_dir, "lora.expectedWeights")
    return {
        "config": config_path,
        "dataset": resolve_path(config.get("datasetJson"), config_dir, "datasetJson"),
        "train_manifest": resolve_path(manifests.get("train"), config_dir, "manifests.train"),
        "val_manifest": resolve_path(manifests.get("val"), config_dir, "manifests.val"),
        "output_dir": output_dir,
        "adapter": adapter_path,
        "summary": output_dir / "training-summary.json",
    }


def lora_config_from_train_config(config: dict[str, Any], override_rank: int | None):
    from voxcpm.core import LoRAConfig

    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    rank = override_rank if override_rank is not None else int(lora.get("rank") or 8)
    return LoRAConfig(
        enable_lm=bool(lora.get("enableLm", True)),
        enable_dit=bool(lora.get("enableDit", True)),
        enable_proj=bool(lora.get("enableProj", False)),
        r=rank,
        alpha=int(lora.get("alpha") or 16),
        dropout=float(lora.get("dropout") or 0.0),
    )


def set_seed(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np
        import torch

        np.random.seed(seed)
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        return


def dry_run_payload(config: dict[str, Any], paths: dict[str, Path], args: argparse.Namespace) -> dict[str, Any]:
    train = validate_manifest_rows(paths["train_manifest"], require_rows=True)
    val = validate_manifest_rows(paths["val_manifest"], require_rows=False)
    trainer = config.get("trainer") if isinstance(config.get("trainer"), dict) else {}
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    return {
        "status": "ready",
        "dryRun": True,
        "config": str(paths["config"]),
        "modelId": args.model_id,
        "localFilesOnly": args.local_files_only,
        "outputDir": str(paths["output_dir"]),
        "adapter": str(paths["adapter"]),
        "manifests": {"train": train, "val": val},
        "training": {
            "epochs": args.epochs if args.epochs is not None else trainer.get("epochs"),
            "maxSteps": args.max_steps,
            "batchSize": args.batch_size if args.batch_size is not None else trainer.get("batchSize"),
            "gradientAccumulationSteps": args.gradient_accumulation_steps
            if args.gradient_accumulation_steps is not None
            else trainer.get("gradientAccumulationSteps"),
            "learningRate": args.learning_rate if args.learning_rate is not None else trainer.get("learningRate"),
            "seed": args.seed if args.seed is not None else trainer.get("seed"),
        },
        "lora": {
            "rank": args.lora_rank if args.lora_rank is not None else lora.get("rank"),
            "alpha": lora.get("alpha"),
            "dropout": lora.get("dropout"),
            "enableLm": lora.get("enableLm"),
            "enableDit": lora.get("enableDit"),
            "enableProj": lora.get("enableProj"),
        },
        "message": "dry run validated train/val manifests and trainer arguments without loading the VoxCPM model",
    }


def load_audio_text_dataset_from_jsonl(
    path: Path,
    *,
    tokenizer,
    text_column: str,
    audio_column: str,
    dataset_id_column: str,
    sample_rate: int,
):
    import librosa
    import numpy as np
    import soundfile as sf

    rows = read_jsonl(path)
    normalized_rows: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        audio = row.get(audio_column)
        text = row.get(text_column)
        if not isinstance(audio, str) or not audio.strip():
            raise SystemExit(f"{path}:{index} is missing audio column {audio_column}")
        if not isinstance(text, str) or not text.strip():
            raise SystemExit(f"{path}:{index} is missing text column {text_column}")
        item = dict(row)
        audio_path = Path(audio).expanduser()
        if not audio_path.is_absolute():
            audio_path = path.parent / audio_path
        item["audio"] = str(audio_path.resolve(strict=False))
        if audio_column != "audio":
            item.pop(audio_column, None)
        if text_column != "text":
            item["text"] = item.pop(text_column)
        if dataset_id_column != "dataset_id" and dataset_id_column in item:
            item["dataset_id"] = item.pop(dataset_id_column)
        item["dataset_id"] = int(item.get("dataset_id") or 0)
        item["text_ids"] = list(tokenizer(item["text"]))
        try:
            audio_array, source_sample_rate = sf.read(item["audio"], dtype="float32", always_2d=False)
        except Exception as exc:
            raise SystemExit(f"{path}:{index} failed to read audio {item['audio']}: {exc}") from exc
        if getattr(audio_array, "ndim", 1) > 1:
            audio_array = np.mean(audio_array, axis=1)
        if int(source_sample_rate) != int(sample_rate):
            audio_array = librosa.resample(
                np.asarray(audio_array, dtype=np.float32),
                orig_sr=int(source_sample_rate),
                target_sr=int(sample_rate),
            )
        item["audio_array"] = np.asarray(audio_array, dtype=np.float32)
        item["audio_sampling_rate"] = int(sample_rate)
        normalized_rows.append(item)

    return JsonlVoxCPMDataset(normalized_rows)


def load_audio_text_datasets_from_jsonl(
    train_manifest: Path,
    val_manifest: Path,
    *,
    tokenizer,
    text_column: str,
    audio_column: str,
    dataset_id_column: str,
    sample_rate: int,
):
    train_ds = load_audio_text_dataset_from_jsonl(
        train_manifest,
        tokenizer=tokenizer,
        text_column=text_column,
        audio_column=audio_column,
        dataset_id_column=dataset_id_column,
        sample_rate=sample_rate,
    )
    val_ds = (
        load_audio_text_dataset_from_jsonl(
            val_manifest,
            tokenizer=tokenizer,
            text_column=text_column,
            audio_column=audio_column,
            dataset_id_column=dataset_id_column,
            sample_rate=sample_rate,
        )
        if val_manifest.is_file() and val_manifest.stat().st_size > 0
        else None
    )
    return train_ds, val_ds


class JsonlVoxCPMDataset:
    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows
        self.dataset_ids = [int(row.get("dataset_id") or 0) for row in rows]

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, Any]:
        row = self.rows[index]
        return {
            "text_ids": row["text_ids"],
            "audio_array": row["audio_array"],
            "audio_sampling_rate": row["audio_sampling_rate"],
            "dataset_id": row.get("dataset_id", 0),
            "is_prompt": row.get("is_prompt", False),
        }


def dataset_count(dataset) -> int:
    if hasattr(dataset, "dataset_ids"):
        values = [int(value) for value in getattr(dataset, "dataset_ids") if isinstance(value, (int, float))]
        return max(values) + 1 if values else 1
    if "dataset_id" not in dataset.column_names or len(dataset) == 0:
        return 1
    values = dataset["dataset_id"]
    ints = [int(value) for value in values if isinstance(value, (int, float))]
    return max(ints) + 1 if ints else 1


def run_training(config: dict[str, Any], paths: dict[str, Path], args: argparse.Namespace) -> dict[str, Any]:
    import torch
    from voxcpm.core import VoxCPM
    from voxcpm.training import Accelerator, BatchProcessor, HFVoxCPMDataset

    trainer = config.get("trainer") if isinstance(config.get("trainer"), dict) else {}
    epochs = int(args.epochs if args.epochs is not None else trainer.get("epochs") or 1)
    batch_size = int(args.batch_size if args.batch_size is not None else trainer.get("batchSize") or 1)
    grad_accum = int(
        args.gradient_accumulation_steps
        if args.gradient_accumulation_steps is not None
        else trainer.get("gradientAccumulationSteps")
        or 1
    )
    learning_rate = float(args.learning_rate if args.learning_rate is not None else trainer.get("learningRate") or 1e-4)
    seed = int(args.seed if args.seed is not None else trainer.get("seed") or 1337)
    if epochs <= 0:
        raise SystemExit("--epochs must be positive")
    if batch_size <= 0:
        raise SystemExit("--batch-size must be positive")
    if grad_accum <= 0:
        raise SystemExit("--gradient-accumulation-steps must be positive")
    if args.max_steps is not None and args.max_steps <= 0:
        raise SystemExit("--max-steps must be positive when provided")

    set_seed(seed)
    paths["output_dir"].mkdir(parents=True, exist_ok=True)
    lora_config = lora_config_from_train_config(config, args.lora_rank)
    pipeline = VoxCPM.from_pretrained(
        args.model_id,
        load_denoiser=False,
        cache_dir=args.cache_dir,
        local_files_only=args.local_files_only,
        optimize=False,
        lora_config=lora_config,
    )
    model = pipeline.tts_model
    for _name, param in model.named_parameters():
        param.requires_grad = False
    trainable_params = []
    trainable_names = []
    for name, param in model.named_parameters():
        if "lora_" in name:
            param.requires_grad = True
            trainable_params.append(param)
            trainable_names.append(name)
    if not trainable_params:
        raise SystemExit("VoxCPM model has no LoRA trainable parameters; check lora config")

    train_ds, _val_ds = load_audio_text_datasets_from_jsonl(
        paths["train_manifest"],
        paths["val_manifest"],
        tokenizer=model.text_tokenizer,
        text_column="text",
        audio_column="audio",
        dataset_id_column="dataset_id",
        sample_rate=int(args.sample_rate),
    )
    accelerator = Accelerator(amp=args.amp, seed=seed)
    model = accelerator.prepare_model(model)
    optimizer = torch.optim.AdamW(trainable_params, lr=learning_rate, weight_decay=args.weight_decay)
    loader = accelerator.prepare_dataloader(
        train_ds,
        batch_size=batch_size,
        num_workers=args.num_workers,
        collate_fn=HFVoxCPMDataset.collate_fn,
        drop_last=False,
    )
    batch_processor = BatchProcessor(
        config=accelerator.unwrap(model).config,
        audio_vae=accelerator.unwrap(model).audio_vae,
        dataset_cnt=dataset_count(train_ds),
        device=accelerator.device,
    )
    forward_fields = set(inspect.signature(accelerator.unwrap(model).forward).parameters)

    global_step = 0
    optimizer_steps = 0
    last_loss = None
    model.train()
    optimizer.zero_grad(set_to_none=True)
    for epoch in range(epochs):
        for micro_step, batch in enumerate(loader, start=1):
            packed = batch_processor(batch)
            model_inputs = {key: value for key, value in packed.items() if key in forward_fields}
            with accelerator.autocast():
                output = model(**model_inputs, progress=float(global_step) / float(args.max_steps or 1))
                loss = output["loss/diff"] + float(args.stop_loss_weight) * output["loss/stop"]
                scaled_loss = loss / grad_accum
            accelerator.backward(scaled_loss)
            last_loss = float(loss.detach().cpu())
            should_step = micro_step % grad_accum == 0
            if should_step:
                if args.max_grad_norm > 0:
                    torch.nn.utils.clip_grad_norm_(trainable_params, args.max_grad_norm)
                accelerator.step(optimizer)
                accelerator.update()
                optimizer.zero_grad(set_to_none=True)
                optimizer_steps += 1
                global_step += 1
                if args.max_steps is not None and global_step >= args.max_steps:
                    break
        if args.max_steps is not None and global_step >= args.max_steps:
            break

    if optimizer_steps <= 0:
        raise SystemExit("training completed without optimizer steps; increase data or reduce gradient accumulation")

    unwrapped = accelerator.unwrap(model)
    state_dict = unwrapped.get_lora_state_dict()
    if not state_dict:
        raise SystemExit("trained model returned empty LoRA state dict")
    paths["adapter"].parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": state_dict}, paths["adapter"])
    summary = {
        "status": "trained",
        "dryRun": False,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "config": str(paths["config"]),
        "modelId": args.model_id,
        "adapter": str(paths["adapter"]),
        "adapterSha256": sha256_file(paths["adapter"]),
        "trainableParameterNames": trainable_names,
        "trainableParameterCount": sum(int(param.numel()) for param in trainable_params),
        "optimizerSteps": optimizer_steps,
        "epochsRequested": epochs,
        "maxSteps": args.max_steps,
        "lastLoss": last_loss,
    }
    write_json(paths["summary"], summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a VoxCPM LoRA adapter from an AnyVoice LoRA train_config.json.")
    parser.add_argument("--config", required=True, help="train_config.json from prepare_voxcpm_lora_training_job.py")
    parser.add_argument("--output-dir", help="Training output directory. Defaults to trainer.outputDir from config.")
    parser.add_argument("--adapter", help="Adapter output path. Defaults to lora.expectedWeights from config.")
    parser.add_argument("--model-id", default=os.environ.get("ANYVOICE_MODEL_ID", "openbmb/VoxCPM2"))
    parser.add_argument("--cache-dir")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--epochs", type=int)
    parser.add_argument("--max-steps", type=int)
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--gradient-accumulation-steps", type=int)
    parser.add_argument("--learning-rate", type=float)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--stop-loss-weight", type=float, default=1.0)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--amp", action="store_true")
    parser.add_argument("--lora-rank", type=int)
    args = parser.parse_args()

    config_path = Path(args.config).expanduser().resolve()
    config = load_json(config_path, "train config")
    paths = resolve_training_paths(config, config_path, args)
    if paths["adapter"].parent != paths["output_dir"]:
        raise SystemExit(f"adapter path must live directly under output dir: {paths['adapter']} not in {paths['output_dir']}")
    payload = dry_run_payload(config, paths, args) if args.dry_run else run_training(config, paths, args)
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
