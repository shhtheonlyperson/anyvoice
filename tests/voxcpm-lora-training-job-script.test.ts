// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "prepare_voxcpm_lora_training_job.py");

let tmpRoot: string;

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeDataset({
  clips = 10,
  missingAudio = false,
  proofMode = "valid",
}: {
  clips?: number;
  missingAudio?: boolean;
  proofMode?: "valid" | "missing" | "unsafe" | "failedTranscript" | "dryRunGate" | "skippedGate" | "staleTranscript" | "hifiGate";
} = {}): Promise<string> {
  const datasetDir = path.join(tmpRoot, "dataset");
  const audioDir = path.join(datasetDir, "audio");
  const profilePath = path.join(tmpRoot, "profile.json");
  await mkdir(audioDir, { recursive: true });

  const allRows = [];
  for (let index = 1; index <= clips; index += 1) {
    const audio = path.join(audioDir, `clip-${index}.wav`);
    const audioBytes = Buffer.from([index, index + 1, index + 2]);
    if (!(missingAudio && index === 3)) {
      await writeFile(audio, audioBytes);
    }
    const text = `這是第 ${index} 段合格聲音。`;
    allRows.push({
      audio,
      audioSha256: sha256Buffer(audioBytes),
      text,
      transcriptSha256: sha256Text(text),
      speaker: "local-test",
      split: index <= Math.max(1, clips - 2) ? "train" : "val",
      sourceRunId: `clip-${index}`,
      profileAudioPath: audio,
      durationSec: 7,
      grade: index <= 4 ? "A" : "B",
      consentSource: "anyvoice_profile_enrollment",
    });
  }

  const trainRows = allRows.filter((row) => row.split === "train");
  const valRows = allRows.filter((row) => row.split === "val");
  await writeFile(
    path.join(datasetDir, "manifest.train.jsonl"),
    trainRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf-8",
  );
  await writeFile(
    path.join(datasetDir, "manifest.val.jsonl"),
    valRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf-8",
  );
  await writeFile(
    path.join(datasetDir, "manifest.all.jsonl"),
    allRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf-8",
  );

  let proofs: unknown;
  if (["valid", "failedTranscript", "dryRunGate", "skippedGate", "staleTranscript", "hifiGate"].includes(proofMode)) {
    const transcriptValidation = path.join(datasetDir, "transcript-validation.json");
    const qualityGate = path.join(datasetDir, "quality-gate.json");
    const transcriptStatus = proofMode === "failedTranscript" ? "fail" : "pass";
    const cloneMode = proofMode === "hifiGate" ? "hifi" : "both";
    await writeFile(
      transcriptValidation,
      `${JSON.stringify({
        version: 1,
        profile: profilePath,
        status: transcriptStatus,
        summary: { total: clips, passed: transcriptStatus === "pass" ? clips : Math.max(0, clips - 1), failed: transcriptStatus === "pass" ? 0 : 1 },
        clips: allRows.map((row, index) => ({
          sourceRunId: row.sourceRunId,
          expectedTranscript: proofMode === "staleTranscript" && index === 1 ? "舊的逐字稿。" : row.text,
          audioPath: row.profileAudioPath,
          verdict: "pass",
          cer: { rate: 0 },
          wer: { rate: 0 },
        })),
      })}\n`,
      "utf-8",
    );
    await writeFile(
      qualityGate,
      `${JSON.stringify({
        version: 1,
        status: "pass",
        dryRun: proofMode === "dryRunGate",
        inputs: {
          profileJson: profilePath,
          cloneMode,
          requireSpeakerBackend: cloneMode === "both" ? "speechbrain-ecapa" : null,
          skipProfileVerify: false,
          skipTranscriptValidation: proofMode === "skippedGate",
        },
        proofs: {
          profileVerifyRequired: true,
          profileVerifyPassed: true,
          transcriptValidationRequired: proofMode !== "skippedGate",
          transcriptValidationPassed: true,
          speakerBackendRequirement:
            cloneMode === "both"
              ? { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" }
              : { requested: "auto", selected: "mfcc-cosine", required: null },
        },
        commands: {
          score:
            cloneMode === "both"
              ? "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi --require-paired-improvement"
              : "python3 scripts/score_voice_regression.py",
        },
      })}\n`,
      "utf-8",
    );
    proofs = {
      transcriptValidationJson: transcriptValidation,
      qualityGateJson: qualityGate,
      bypass: {
        transcriptValidationSkipped: false,
        qualityGateSkipped: false,
        unsafeExport: false,
        reason: null,
      },
      productProofQualityGateRequired: true,
    };
  } else if (proofMode === "unsafe") {
    proofs = {
      transcriptValidationJson: null,
      qualityGateJson: null,
      bypass: {
        transcriptValidationSkipped: true,
        qualityGateSkipped: true,
        unsafeExport: true,
        reason: "migration fixture without ASR backend",
      },
    };
  }

  const datasetJson = path.join(datasetDir, "dataset.json");
  await writeFile(
    datasetJson,
    `${JSON.stringify(
      {
        version: 1,
        profilePath,
        voiceProfileId: "local-test",
        totalClips: clips,
        totalDurationSec: clips * 7,
        ...(proofMode === "missing" ? {} : { proofs }),
        manifests: {
          train: path.join(datasetDir, "manifest.train.jsonl"),
          val: path.join(datasetDir, "manifest.val.jsonl"),
          all: path.join(datasetDir, "manifest.all.jsonl"),
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return datasetJson;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-voxcpm-lora-job-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("prepare_voxcpm_lora_training_job.py", () => {
  it("writes a validated handoff with config, wrapper, README, and next commands", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "job");
    const resolvedOutDir = await realpath(tmpRoot).then((root) => path.join(root, "job"));
    const { stdout } = await execFileAsync(python, [
      script,
      "--dataset-json",
      datasetJson,
      "--out-dir",
      outDir,
    ]);

    const payload = JSON.parse(stdout) as {
      trainerStatus: string;
      expectedWeights: string;
      nextCommands: { useAdapter: string; qualityGateDryRun: string; verifyAdapter: string };
    };
    expect(payload.trainerStatus).toBe("needs_trainer_command");
    expect(payload.expectedWeights).toBe(path.join(resolvedOutDir, "output", "lora_weights.ckpt"));
    expect(payload.nextCommands.verifyAdapter).toContain("scripts/verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommands.verifyAdapter).toContain("--require-readable-checkpoint");
    expect(payload.nextCommands.useAdapter).toContain("ANYVOICE_VOXCPM_LORA_PATH=");
    expect(payload.nextCommands.qualityGateDryRun).toContain("run_voice_quality_gate.py");

    const config = JSON.parse(await readFile(path.join(outDir, "train_config.json"), "utf-8"));
    expect(config).toMatchObject({
      voiceProfileId: "local-test",
      dataset: {
        trainClips: 8,
        valClips: 2,
        totalClips: 10,
        totalDurationSec: 70,
      },
      lora: {
        rank: 32,
        alpha: 16,
        expectedWeights: path.join(resolvedOutDir, "output", "lora_weights.ckpt"),
        adapterProof: path.join(resolvedOutDir, "output", "adapter-proof.json"),
      },
      trainer: {
        status: "needs_trainer_command",
      },
      datasetProofs: {
        acceptedUnsafeDataset: false,
        transcriptValidationSkipped: false,
        qualityGateSkipped: false,
        unsafeExport: false,
        productProofQualityGateRequired: true,
      },
    });
    expect(config.voxcpmPackage.trainingUtilities).toContain("voxcpm.training.load_audio_text_datasets");

    const trainScript = await readFile(path.join(outDir, "train.sh"), "utf-8");
    expect(trainScript).toContain("ANYVOICE_VOXCPM_TRAINER_COMMAND");
    expect(trainScript).toContain("No VoxCPM LoRA trainer command is configured");
    expect(trainScript).toContain("verify_voxcpm_lora_adapter.py");

    const readme = await readFile(path.join(outDir, "README.md"), "utf-8");
    expect(readme).toContain("Status: `needs_trainer_command`");
    expect(readme).toContain("scripts/verify_voxcpm_lora_adapter.py");
    expect(readme).toContain("ANYVOICE_VOXCPM_LORA_PATH=");
  });

  it("refuses the old five-clip dataset by default", async () => {
    const datasetJson = await writeDataset({ clips: 5 });
    const outDir = path.join(tmpRoot, "five-clip-job");

    await expect(execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir])).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset has too few clips: 5 < 10"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes the generated train wrapper fail clearly until a trainer is configured", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "unconfigured-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);

    await expect(execFileAsync("bash", [path.join(outDir, "train.sh")])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("No VoxCPM LoRA trainer command is configured"),
    });
  });

  it("embeds a provided trainer command template", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "configured-job");
    await execFileAsync(python, [
      script,
      "--dataset-json",
      datasetJson,
      "--out-dir",
      outDir,
      "--trainer-command",
      "python train_voxcpm_lora.py --config {config} --output-dir {output_dir} --adapter {adapter_path}",
      "--lora-r",
      "16",
      "--lora-alpha",
      "8",
    ]);

    const config = JSON.parse(await readFile(path.join(outDir, "train_config.json"), "utf-8"));
    expect(config.trainer.status).toBe("ready");
    expect(config.trainer.commandTemplate).toContain("train_voxcpm_lora.py");
    expect(config.lora).toMatchObject({ rank: 16, alpha: 8 });

    const trainScript = await readFile(path.join(outDir, "train.sh"), "utf-8");
    expect(trainScript).toContain("DEFAULT_TRAINER_COMMAND='python train_voxcpm_lora.py");
    expect(trainScript).toContain("{adapter_path}");
  });

  it("runs the generated train wrapper with a trainer command and verifies the adapter artifact", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "executable-job");
    const fakeTrainer = path.join(tmpRoot, "fake_voxcpm_lora_trainer.py");
    await writeFile(
      fakeTrainer,
      [
        "from pathlib import Path",
        "import json",
        "import sys",
        "",
        "config_path, output_dir, adapter_path, train_manifest, val_manifest = map(Path, sys.argv[1:6])",
        "payload = json.loads(config_path.read_text(encoding='utf-8'))",
        "assert config_path.name == 'train_config.json'",
        "assert output_dir.resolve() == Path(payload['trainer']['outputDir']).resolve()",
        "assert adapter_path.resolve() == Path(payload['lora']['expectedWeights']).resolve()",
        "assert train_manifest.resolve() == Path(payload['manifests']['train']).resolve()",
        "assert val_manifest.resolve() == Path(payload['manifests']['val']).resolve()",
        "assert train_manifest.exists()",
        "assert val_manifest.exists()",
        "adapter_path.parent.mkdir(parents=True, exist_ok=True)",
        "adapter_path.write_text('fake lora adapter\\n', encoding='utf-8')",
        "",
      ].join("\n"),
      "utf-8",
    );
    const trainerCommand = [
      shellQuote(python),
      shellQuote(fakeTrainer),
      "{config}",
      "{output_dir}",
      "{adapter_path}",
      "{train_manifest}",
      "{val_manifest}",
    ].join(" ");

    await execFileAsync(python, [
      script,
      "--dataset-json",
      datasetJson,
      "--out-dir",
      outDir,
      "--trainer-command",
      trainerCommand,
    ]);

    const { stdout } = await execFileAsync("bash", [path.join(outDir, "train.sh")]);

    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    const resolvedAdapterPath = await realpath(adapterPath);
    const resolvedConfigPath = await realpath(path.join(outDir, "train_config.json"));
    await expect(readFile(adapterPath, "utf-8")).resolves.toBe("fake lora adapter\n");
    const proof = JSON.parse(await readFile(path.join(outDir, "output", "adapter-proof.json"), "utf-8"));
    expect(proof).toMatchObject({
      status: "metadata_pass",
      adapter: {
        path: resolvedAdapterPath,
        bytes: "fake lora adapter\n".length,
      },
      trainConfig: resolvedConfigPath,
    });
    expect(proof.adapter.sha256).toBe(sha256Text("fake lora adapter\n"));
    expect(proof.nextCommands.qualityGateWithAdapterDryRun).toContain("ANYVOICE_VOXCPM_LORA_PATH=");
    expect(proof.nextCommands.qualityGateWithAdapter).toContain("--require-speaker-backend speechbrain-ecapa");
    expect(stdout).toContain(fakeTrainer);
    expect(stdout).toContain(adapterPath);
    expect(stdout).toContain('"proofJson"');
  });

  it("verifies an adapter artifact against the generated training config", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "verified-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const resolvedAdapterPath = await realpath(adapterPath);

    const { stdout } = await execFileAsync(python, [
      path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
      "--train-config",
      path.join(outDir, "train_config.json"),
    ]);
    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("metadata_pass");
    expect(payload.adapter).toMatchObject({
      path: resolvedAdapterPath,
      bytes: "adapter bytes\n".length,
      sha256: sha256Text("adapter bytes\n"),
    });
    expect(payload.proofJson).toBe(await realpath(path.join(outDir, "output", "adapter-proof.json")));
    expect(payload.warnings.join(" ")).toContain("checkpoint tensor keys were not inspected");
  });

  it("refuses an adapter path that does not match the training config", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "wrong-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const wrongAdapter = path.join(tmpRoot, "other-lora.ckpt");
    await writeFile(wrongAdapter, "adapter bytes\n", "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        path.join(outDir, "train_config.json"),
        "--adapter-path",
        wrongAdapter,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("adapter path does not match train config"),
    });
  });

  it("refuses adapter verification when the training config lost product-proof dataset evidence", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "weak-proof-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const configPath = path.join(outDir, "train_config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    delete config.datasetProofs.productProofQualityGateRequired;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("datasetProofs.productProofQualityGateRequired must be true"),
    });
  });

  it("refuses incomplete datasets before writing a job", async () => {
    const datasetJson = await writeDataset({ missingAudio: true });
    const outDir = path.join(tmpRoot, "blocked-job");

    await expect(execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir])).rejects.toMatchObject({
      stderr: expect.stringContaining("audio not found"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses datasets without transcript and quality-gate proof metadata", async () => {
    const datasetJson = await writeDataset({ proofMode: "missing" });
    const outDir = path.join(tmpRoot, "missing-proof-job");

    await expect(execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir])).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset is missing proof metadata"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unsafe-bypassed datasets unless the training handoff acknowledges them", async () => {
    const datasetJson = await writeDataset({ proofMode: "unsafe" });
    const outDir = path.join(tmpRoot, "unsafe-blocked-job");

    await expect(execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir])).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset was exported with unsafe proof bypasses"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses transcript validation proof files that are not passing", async () => {
    const datasetJson = await writeDataset({ proofMode: "failedTranscript" });
    const outDir = path.join(tmpRoot, "failed-transcript-proof-job");

    await expect(execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir])).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation proof must have status='pass'"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses dry-run or skipped-proof quality gate files", async () => {
    const dryRunDatasetJson = await writeDataset({ proofMode: "dryRunGate" });
    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        dryRunDatasetJson,
        "--out-dir",
        path.join(tmpRoot, "dry-run-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof must be a non-dry-run pass"),
    });

    const skippedGateDatasetJson = await writeDataset({ proofMode: "skippedGate" });
    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        skippedGateDatasetJson,
        "--out-dir",
        path.join(tmpRoot, "skipped-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof did not prove transcript validation passed"),
    });
  });

  it("refuses datasets backed by a hifi-only quality gate", async () => {
    const datasetJson = await writeDataset({ proofMode: "hifiGate" });

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "hifi-only-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof is not a paired product-proof gate"),
    });
  });

  it("refuses transcript validation proof that does not match the dataset rows", async () => {
    const datasetJson = await writeDataset({ proofMode: "staleTranscript" });

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-transcript-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation proof does not match every LoRA dataset row"),
    });
  });

  it("refuses hand-edited manifest rows whose hashes no longer match", async () => {
    const datasetJson = await writeDataset();
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as { manifests: { all: string } };
    const lines = (await readFile(dataset.manifests.all, "utf-8")).trim().split("\n");
    const first = JSON.parse(lines[0]);
    first.text = "被手動改過的逐字稿。";
    lines[0] = JSON.stringify(first);
    await writeFile(dataset.manifests.all, `${lines.join("\n")}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "edited-manifest-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcriptSha256 mismatch"),
    });
  });

  it("records an explicit unsafe dataset acknowledgement in the training config", async () => {
    const datasetJson = await writeDataset({ proofMode: "unsafe" });
    const outDir = path.join(tmpRoot, "unsafe-allowed-job");
    await execFileAsync(python, [
      script,
      "--dataset-json",
      datasetJson,
      "--out-dir",
      outDir,
      "--allow-unsafe-dataset",
      "--unsafe-dataset-reason",
      "migration fixture only",
    ]);

    const config = JSON.parse(await readFile(path.join(outDir, "train_config.json"), "utf-8"));
    expect(config.datasetProofs).toMatchObject({
      transcriptValidationSkipped: true,
      qualityGateSkipped: true,
      unsafeExport: true,
      acceptedUnsafeDataset: true,
      acceptedUnsafeDatasetReason: "migration fixture only",
      datasetBypassReason: "migration fixture without ASR backend",
    });
  });
});
