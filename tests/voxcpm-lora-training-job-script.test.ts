// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "prepare_voxcpm_lora_training_job.py");
const trainerPreflightScript = path.join(process.cwd(), "scripts", "check_voxcpm_lora_trainer.py");
const trainerScript = path.join(process.cwd(), "scripts", "train_voxcpm_lora.py");

let tmpRoot: string;

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
  proofMode?:
    | "valid"
    | "missing"
    | "unsafe"
    | "failedTranscript"
    | "dryRunGate"
    | "skippedGate"
    | "staleTranscript"
    | "staleTranscriptProfileHash"
    | "staleGateTranscript"
    | "hifiGate"
    | "staleGate"
    | "staleDatasetProfile";
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
  const profile = {
    version: 1,
    voiceProfileId: "local-test",
    clips: allRows.map((row) => ({
      sourceRunId: row.sourceRunId,
      audioPath: row.audio,
      transcriptRaw: row.text,
      quality: { durationSec: row.durationSec },
    })),
  };
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
  const profileSha256 = createHash("sha256").update(canonicalJson(profile), "utf8").digest("hex");

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
  if (
    [
      "valid",
      "failedTranscript",
      "dryRunGate",
      "skippedGate",
      "staleTranscript",
      "staleTranscriptProfileHash",
      "staleGateTranscript",
      "hifiGate",
      "staleGate",
      "staleDatasetProfile",
    ].includes(proofMode)
  ) {
    const transcriptValidation = path.join(datasetDir, "transcript-validation.json");
    const gateTranscriptValidation =
      proofMode === "staleGateTranscript"
        ? path.join(datasetDir, "quality-gate-transcript-validation.json")
        : transcriptValidation;
    const qualityGate = path.join(datasetDir, "quality-gate.json");
    const transcriptStatus = proofMode === "failedTranscript" ? "fail" : "pass";
    const cloneMode = proofMode === "hifiGate" ? "hifi" : "both";
    const transcriptValidationPayload = {
      version: 1,
      profile: profilePath,
      voiceProfileId: "local-test",
      profileSha256: proofMode === "staleTranscriptProfileHash" ? "0".repeat(64) : profileSha256,
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
    };
    await writeFile(transcriptValidation, `${JSON.stringify(transcriptValidationPayload)}\n`, "utf-8");
    if (proofMode === "staleGateTranscript") {
      const gateTranscriptPayload = JSON.parse(JSON.stringify(transcriptValidationPayload));
      gateTranscriptPayload.clips[1].expectedTranscript = "舊的逐字稿。";
      await writeFile(gateTranscriptValidation, `${JSON.stringify(gateTranscriptPayload)}\n`, "utf-8");
    }
    const transcriptValidationSha256 = await sha256File(transcriptValidation);
    const gateTranscriptValidationSha256 = await sha256File(gateTranscriptValidation);
    const reportPath = path.join(datasetDir, "report.json");
    const asrPath = path.join(datasetDir, "asr.json");
    const speakerPath = path.join(datasetDir, "speaker.json");
    const scorePath = path.join(datasetDir, "score.json");
    const samplePath = path.join(datasetDir, "sample.wav");
    const sampleHifiPath = path.join(datasetDir, "sample-hifi.wav");
    const sampleAudio = Buffer.from([11, 12, 13, 14]);
    const sampleHifiAudio = Buffer.from([21, 22, 23, 24, 25]);
    await writeFile(samplePath, sampleAudio);
    await writeFile(sampleHifiPath, sampleHifiAudio);
    const sampleProof = {
      outputWav: "sample.wav",
      outputExists: true,
      missingOutput: false,
      outputBytes: sampleAudio.byteLength,
      outputSha256: sha256Buffer(sampleAudio),
    };
    const sampleHifiProof = {
      outputWav: "sample-hifi.wav",
      outputExists: true,
      missingOutput: false,
      outputBytes: sampleHifiAudio.byteLength,
      outputSha256: sha256Buffer(sampleHifiAudio),
    };
    const profileEvidence = { voiceProfileId: "local-test", profileSha256 };
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          version: 1,
          voiceProfile: profileEvidence,
          groups: [
            {
              ...profileEvidence,
              cloneMode: cloneMode === "both" ? "prompt" : "hifi",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              renders: [{ ...profileEvidence, repeat: 1, status: "ready", ...sampleProof }],
            },
            ...(cloneMode === "both"
              ? [
                  {
                    ...profileEvidence,
                    cloneMode: "hifi",
                    case: { id: "zh_hant_polyphones", text: "重慶角色" },
                    renders: [{ ...profileEvidence, repeat: 1, status: "ready", ...sampleHifiProof }],
                  },
                ]
              : []),
          ],
          ...(cloneMode === "both"
            ? {
                pairedComparison: {
                  verdict: "pass",
                  baselineCloneMode: "prompt",
                  candidateCloneMode: "hifi",
                  summary: { pairs: 1, passingPairs: 1, reviewPairs: 0 },
                },
              }
            : {}),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(asrPath, `${JSON.stringify({ "hifi/zh_hant_polyphones/r01": "重慶角色" }, null, 2)}\n`, "utf-8");
    await writeFile(
      speakerPath,
      `${JSON.stringify({ version: 1, backend: "speechbrain-ecapa", summary: { total: 1, scored: 1, failed: 0 } }, null, 2)}\n`,
      "utf-8",
    );
    const reportSha256 = await sha256File(reportPath);
    const asrSha256 = await sha256File(asrPath);
    const speakerSha256 = await sha256File(speakerPath);
    await writeFile(
      scorePath,
      `${JSON.stringify(
        {
          version: 1,
          verdict: "pass",
          sourceReport: reportPath,
          sourceReportSha256: reportSha256,
          asrJson: asrPath,
          asrJsonSha256: asrSha256,
          speakerJson: speakerPath,
          speakerJsonSha256: speakerSha256,
          voiceProfile: profileEvidence,
          groups: [
            {
              ...profileEvidence,
              cloneMode: cloneMode === "both" ? "prompt" : "hifi",
              renders: [{ ...profileEvidence, repeat: 1, status: "ready", ...sampleProof }],
            },
            ...(cloneMode === "both"
              ? [
                  {
                    ...profileEvidence,
                    cloneMode: "hifi",
                    renders: [{ ...profileEvidence, repeat: 1, status: "ready", ...sampleHifiProof }],
                  },
                ]
              : []),
          ],
          ...(cloneMode === "both"
            ? {
                pairedComparison: {
                  verdict: "pass",
                  baselineCloneMode: "prompt",
                  candidateCloneMode: "hifi",
                  summary: { pairs: 1, passingPairs: 1, reviewPairs: 0 },
                },
              }
            : {}),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const scoreSha256 = await sha256File(scorePath);
    await writeFile(
      qualityGate,
      `${JSON.stringify({
        version: 1,
        status: "pass",
        dryRun: proofMode === "dryRunGate",
        inputs: {
          profileJson: profilePath,
          profileSha256: proofMode === "staleGate" ? "2".repeat(64) : profileSha256,
          cloneMode,
          requireSpeakerBackend: cloneMode === "both" ? "speechbrain-ecapa" : null,
          transcriptValidationJson: gateTranscriptValidation,
          transcriptValidationSha256: gateTranscriptValidationSha256,
          skipProfileVerify: false,
          skipTranscriptValidation: proofMode === "skippedGate",
        },
        proofs: {
          profileVerifyRequired: true,
          profileVerifyPassed: true,
          profileVerifySkipped: false,
          transcriptValidationRequired: proofMode !== "skippedGate",
          transcriptValidationJson: gateTranscriptValidation,
          transcriptValidationSha256: gateTranscriptValidationSha256,
          transcriptValidationPassed: true,
          transcriptValidationSkipped: proofMode === "skippedGate",
          speakerBackendRequirement:
            cloneMode === "both"
              ? { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" }
              : { requested: "auto", selected: "mfcc-cosine", required: null },
          artifacts: {
            report: { path: reportPath, sha256: reportSha256 },
            asr: { path: asrPath, sha256: asrSha256 },
            speaker: { path: speakerPath, sha256: speakerSha256 },
            score: { path: scorePath, sha256: scoreSha256 },
          },
        },
        commands: {
          score:
            cloneMode === "both"
              ? "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi --require-paired-improvement"
              : "python3 scripts/score_voice_regression.py",
        },
        paths: {
          qualityGate,
          report: reportPath,
          asr: asrPath,
          speaker: speakerPath,
          score: scorePath,
          profileTranscriptValidation: gateTranscriptValidation,
        },
      })}\n`,
      "utf-8",
    );
    const qualityGateSha256 = await sha256File(qualityGate);
    proofs = {
      transcriptValidationJson: transcriptValidation,
      transcriptValidationSha256,
      qualityGateJson: qualityGate,
      qualityGateSha256,
      bypass: {
        transcriptValidationSkipped: false,
        qualityGateSkipped: false,
        unsafeExport: false,
        reason: null,
      },
      productProofQualityGateRequired: true,
    };
    if (proofMode === "staleDatasetProfile") {
      await writeFile(profilePath, `${JSON.stringify({ ...profile, auditMarker: "profile changed after dataset export" }, null, 2)}\n`, "utf-8");
    }
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
        profileSha256,
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
      nextCommands: {
        configureTrainer: string;
        trainerPreflight: string;
        useAdapter: string;
        qualityGateDryRun: string;
        verifyAdapter: string;
      };
    };
    expect(payload.trainerStatus).toBe("needs_trainer_command");
    expect(payload.expectedWeights).toBe(path.join(resolvedOutDir, "output", "lora_weights.ckpt"));
    expect(payload.nextCommands.configureTrainer).toContain("scripts/train_voxcpm_lora.py");
    expect(payload.nextCommands.configureTrainer).toContain("--config {config}");
    expect(payload.nextCommands.trainerPreflight).toContain("scripts/check_voxcpm_lora_trainer.py");
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
    expect(readme).toContain("scripts/train_voxcpm_lora.py");
    expect(readme).toContain("scripts/check_voxcpm_lora_trainer.py");
    expect(readme).toContain("scripts/verify_voxcpm_lora_adapter.py");
    expect(readme).toContain("ANYVOICE_VOXCPM_LORA_PATH=");
  });

  it("dry-runs the repo-local VoxCPM LoRA trainer without writing an adapter", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "dry-run-trainer-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);

    const { stdout } = await execFileAsync(python, [
      trainerScript,
      "--config",
      path.join(outDir, "train_config.json"),
      "--dry-run",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "ready",
      dryRun: true,
      modelId: "openbmb/VoxCPM2",
      manifests: {
        train: { rows: 8, durationSec: 56 },
        val: { rows: 2, durationSec: 14 },
      },
      lora: {
        rank: 32,
        alpha: 16,
        enableLm: true,
        enableDit: true,
        enableProj: false,
      },
    });
    const resolvedOutDir = await realpath(outDir);
    expect(payload.adapter).toBe(path.join(resolvedOutDir, "output", "lora_weights.ckpt"));
    await expect(stat(payload.adapter)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes trainer dry-run fail before model loading when manifest audio is missing", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "dry-run-missing-audio-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const config = JSON.parse(await readFile(path.join(outDir, "train_config.json"), "utf-8"));
    const firstTrainRow = JSON.parse((await readFile(config.manifests.train, "utf-8")).trim().split("\n")[0]);
    await rm(firstTrainRow.audio, { force: true });

    await expect(
      execFileAsync(python, [
        trainerScript,
        "--config",
        path.join(outDir, "train_config.json"),
        "--dry-run",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("manifest references missing audio"),
    });
  });

  it("preflights the generated training job and reports the missing trainer command", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "preflight-missing-command-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);

    await expect(
      execFileAsync(python, [
        trainerPreflightScript,
        "--train-config",
        path.join(outDir, "train_config.json"),
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"trainer_command_missing"'),
    });
  });

  it("passes trainer preflight with a valid command template and importable voxcpm training utilities", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "preflight-ready-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const fakeTrainer = path.join(tmpRoot, "train_voxcpm_lora.py");
    await writeFile(fakeTrainer, "print('trainer placeholder')\n", "utf-8");
    const fakePackageRoot = path.join(tmpRoot, "fake-pythonpath");
    const fakeTrainingDir = path.join(fakePackageRoot, "voxcpm", "training");
    await mkdir(fakeTrainingDir, { recursive: true });
    await writeFile(path.join(fakePackageRoot, "voxcpm", "__init__.py"), "__version__ = 'test'\n", "utf-8");
    await writeFile(
      path.join(fakeTrainingDir, "__init__.py"),
      [
        "def load_audio_text_datasets(*args, **kwargs):",
        "    return None",
        "class HFVoxCPMDataset:",
        "    pass",
        "class BatchProcessor:",
        "    pass",
        "",
      ].join("\n"),
      "utf-8",
    );

    const { stdout } = await execFileAsync(
      python,
      [
        trainerPreflightScript,
        "--train-config",
        path.join(outDir, "train_config.json"),
        "--trainer-command",
        `${shellQuote(python)} ${shellQuote(fakeTrainer)} --config {config} --output-dir {output_dir} --adapter {adapter_path}`,
      ],
      {
        env: {
          ...process.env,
          PYTHONPATH: fakePackageRoot,
        },
      },
    );
    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("pass");
    expect(payload.reasons).toEqual([]);
    expect(payload.trainerCommand.validation.status).toBe("pass");
    expect(payload.trainerCommand.resolution.status).toBe("pass");
    expect(payload.voxcpmRuntime.trainingUtilities).toMatchObject({
      load_audio_text_datasets: true,
      HFVoxCPMDataset: true,
      BatchProcessor: true,
    });
  });

  it("preflights the Python executable used by the trainer command before the --python fallback", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "preflight-command-python-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const fakeTrainer = path.join(tmpRoot, "train_voxcpm_lora.py");
    await writeFile(fakeTrainer, "print('trainer placeholder')\n", "utf-8");
    const fakeCommandPython = path.join(tmpRoot, "python-no-voxcpm");
    await writeFile(
      fakeCommandPython,
      [
        "#!/usr/bin/env bash",
        "cat <<'JSON'",
        JSON.stringify({
          status: "missing",
          python: "python-no-voxcpm",
          voxcpmImported: false,
          trainingImported: false,
          trainingUtilities: {},
          trainerCli: { path: null, status: "unknown" },
          errors: ["ModuleNotFoundError: No module named 'voxcpm'"],
        }),
        "JSON",
        "",
      ].join("\n"),
      "utf-8",
    );
    await chmod(fakeCommandPython, 0o755);
    const fakePackageRoot = path.join(tmpRoot, "fallback-pythonpath");
    const fakeTrainingDir = path.join(fakePackageRoot, "voxcpm", "training");
    await mkdir(fakeTrainingDir, { recursive: true });
    await writeFile(path.join(fakePackageRoot, "voxcpm", "__init__.py"), "__version__ = 'test'\n", "utf-8");
    await writeFile(
      path.join(fakeTrainingDir, "__init__.py"),
      [
        "def load_audio_text_datasets(*args, **kwargs):",
        "    return None",
        "class HFVoxCPMDataset:",
        "    pass",
        "class BatchProcessor:",
        "    pass",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(
      execFileAsync(
        python,
        [
          trainerPreflightScript,
          "--train-config",
          path.join(outDir, "train_config.json"),
          "--python",
          python,
          "--trainer-command",
          `${shellQuote(fakeCommandPython)} ${shellQuote(fakeTrainer)} --config {config} --output-dir {output_dir} --adapter {adapter_path}`,
        ],
        {
          env: {
            ...process.env,
            PYTHONPATH: fakePackageRoot,
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"source": "trainer_command"'),
    });
  });

  it("blocks trainer preflight when the configured Python trainer script is missing", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "preflight-missing-trainer-script-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);

    await expect(
      execFileAsync(python, [
        trainerPreflightScript,
        "--train-config",
        path.join(outDir, "train_config.json"),
        "--trainer-command",
        `${shellQuote(python)} ${shellQuote(path.join(tmpRoot, "missing_train_voxcpm_lora.py"))} --config {config} --output-dir {output_dir} --adapter {adapter_path}`,
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"trainer_command_unresolved"'),
    });
  });

  it("refuses a five-clip dataset by default", async () => {
    const datasetJson = await writeDataset({ clips: 5 });
    const outDir = path.join(tmpRoot, "five-clip-job");

    await expect(execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir])).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset has too few clips: 5 < 7"),
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

  it("makes the generated train wrapper reject incomplete trainer command templates", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "invalid-env-command-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);

    await expect(
      execFileAsync("bash", [path.join(outDir, "train.sh")], {
        env: {
          ...process.env,
          ANYVOICE_VOXCPM_TRAINER_COMMAND: "python train_voxcpm_lora.py --config {config}",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("trainer command template must include required placeholder(s)"),
    });
  });

  it("makes the generated train wrapper reject unknown trainer command placeholders clearly", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "unknown-placeholder-command-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);

    await expect(
      execFileAsync("bash", [path.join(outDir, "train.sh")], {
        env: {
          ...process.env,
          ANYVOICE_VOXCPM_TRAINER_COMMAND:
            "python train_voxcpm_lora.py --config {config} --output-dir {output_dir} --adapter {adapter_path} --bad {bad}",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown trainer command placeholder {bad}"),
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

  it("rejects provided trainer command templates that cannot receive required paths", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "invalid-configured-job");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        outDir,
        "--trainer-command",
        "python train_voxcpm_lora.py --config {config}",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--trainer-command must include required placeholder(s)"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
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
    const configPath = path.join(outDir, "train_config.json");
    const resolvedAdapterPath = await realpath(adapterPath);
    const resolvedConfigPath = await realpath(configPath);
    await expect(readFile(adapterPath, "utf-8")).resolves.toBe("fake lora adapter\n");
    const proof = JSON.parse(await readFile(path.join(outDir, "output", "adapter-proof.json"), "utf-8"));
    expect(proof).toMatchObject({
      status: "metadata_pass",
      adapter: {
        path: resolvedAdapterPath,
        bytes: "fake lora adapter\n".length,
      },
      trainConfig: resolvedConfigPath,
      trainConfigSha256: await sha256File(configPath),
    });
    expect(proof.adapter.sha256).toBe(sha256Text("fake lora adapter\n"));
    expect(proof.nextCommands.qualityGateWithAdapterDryRun).toContain("ANYVOICE_VOXCPM_LORA_PATH=");
    expect(proof.nextCommands.qualityGateWithAdapter).toContain("--require-speaker-backend speechbrain-ecapa");
    expect(proof.nextCommands.qualityGateWithAdapter).toContain("--transcript-validation-json");
    expect(proof.nextCommands.qualityGateWithAdapter).toContain(path.join("dataset", "transcript-validation.json"));
    expect(stdout).toContain(fakeTrainer);
    expect(stdout).toContain(adapterPath);
    expect(stdout).toContain('"proofJson"');
  });

  it("verifies an adapter artifact against the generated training config", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "verified-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    const configPath = path.join(outDir, "train_config.json");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const resolvedAdapterPath = await realpath(adapterPath);

    const { stdout } = await execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]);
    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("metadata_pass");
    expect(payload.adapter).toMatchObject({
      path: resolvedAdapterPath,
      bytes: "adapter bytes\n".length,
      sha256: sha256Text("adapter bytes\n"),
    });
    expect(payload.trainConfigSha256).toBe(await sha256File(configPath));
    expect(payload.proofJson).toBe(await realpath(path.join(outDir, "output", "adapter-proof.json")));
    expect(payload.warnings.join(" ")).toContain("checkpoint tensor keys were not inspected");
    expect(payload.nextCommands.qualityGateWithAdapter).toContain("--transcript-validation-json");
    expect(payload.nextCommands.qualityGateWithAdapter).toContain(path.join("dataset", "transcript-validation.json"));
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

  it("refuses adapter verification when the dataset proof profile hash is stale", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "stale-profile-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const configPath = path.join(outDir, "train_config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.datasetProofs.profileSha256 = "0".repeat(64);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("datasetProofs.profileSha256"),
    });
  });

  it("refuses adapter verification when the train config voice profile id is stale", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "stale-voice-profile-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const configPath = path.join(outDir, "train_config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.voiceProfileId = "other-profile";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA train config voiceProfileId does not match profilePath"),
    });
  });

  it("refuses adapter verification when train config manifest paths drift from dataset.json", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "stale-manifest-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const configPath = path.join(outDir, "train_config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.manifests.train = path.join(tmpRoot, "other-train-manifest.jsonl");
    await writeFile(config.manifests.train, "{}\n", "utf-8");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA train config manifest paths do not match dataset.json"),
    });
  });

  it("refuses adapter verification when quality gate artifacts changed after training handoff", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "stale-quality-gate-artifact-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const configPath = path.join(outDir, "train_config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const gate = JSON.parse(await readFile(config.datasetProofs.qualityGateJson, "utf-8"));
    await writeFile(gate.paths.asr, `${JSON.stringify({ stale: "changed after training handoff" }, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof asr artifact SHA-256 no longer matches the file"),
    });
  });

  it("refuses adapter verification when quality gate score JSON references a stale ASR hash", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "stale-quality-gate-score-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const configPath = path.join(outDir, "train_config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const gate = JSON.parse(await readFile(config.datasetProofs.qualityGateJson, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    score.asrJsonSha256 = "0".repeat(64);
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(config.datasetProofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    config.datasetProofs.qualityGateSha256 = await sha256File(config.datasetProofs.qualityGateJson);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate score JSON asrJsonSha256 no longer matches paths.asr"),
    });
  });

  it("refuses adapter verification when quality gate score JSON carries stale profile evidence", async () => {
    const datasetJson = await writeDataset();
    const outDir = path.join(tmpRoot, "stale-quality-gate-score-profile-adapter-job");
    await execFileAsync(python, [script, "--dataset-json", datasetJson, "--out-dir", outDir]);
    const adapterPath = path.join(outDir, "output", "lora_weights.ckpt");
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, "adapter bytes\n", "utf-8");
    const configPath = path.join(outDir, "train_config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const gate = JSON.parse(await readFile(config.datasetProofs.qualityGateJson, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    score.voiceProfile.profileSha256 = "0".repeat(64);
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(config.datasetProofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    config.datasetProofs.qualityGateSha256 = await sha256File(config.datasetProofs.qualityGateJson);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        path.join(process.cwd(), "scripts", "verify_voxcpm_lora_adapter.py"),
        "--train-config",
        configPath,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("score.voiceProfile.profileSha256"),
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

  it("refuses quality gate proofs that omit transcript validation proof JSON", async () => {
    const datasetJson = await writeDataset({ proofMode: "valid" });
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string; qualityGateSha256: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    delete gate.inputs.transcriptValidationJson;
    delete gate.proofs.transcriptValidationJson;
    delete gate.paths.profileTranscriptValidation;
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    dataset.proofs.qualityGateSha256 = await sha256File(dataset.proofs.qualityGateJson);
    await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "missing-gate-transcript-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof is missing transcript validation proof path"),
    });
  });

  it("refuses transcript validation proof files changed after dataset export", async () => {
    const datasetJson = await writeDataset({ proofMode: "valid" });
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { transcriptValidationJson: string };
    };
    const validation = JSON.parse(await readFile(dataset.proofs.transcriptValidationJson, "utf-8"));
    validation.mutatedAfterDataset = true;
    await writeFile(dataset.proofs.transcriptValidationJson, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "mutated-transcript-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset transcriptValidationSha256 no longer matches the referenced file"),
    });
  });

  it("refuses quality gate proof files changed after dataset export", async () => {
    const datasetJson = await writeDataset({ proofMode: "valid" });
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    gate.mutatedAfterDataset = true;
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "mutated-quality-gate-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset qualityGateSha256 no longer matches the referenced file"),
    });
  });

  it("refuses quality gate proof artifacts changed after dataset export", async () => {
    const datasetJson = await writeDataset({ proofMode: "valid" });
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    await writeFile(gate.paths.asr, `${JSON.stringify({ stale: "changed after score" }, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "mutated-asr-artifact-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof asr artifact SHA-256 no longer matches the file"),
    });
  });

  it("refuses quality gate score JSON bound to a stale ASR hash", async () => {
    const datasetJson = await writeDataset({ proofMode: "valid" });
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string; qualityGateSha256: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    score.asrJsonSha256 = "0".repeat(64);
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    dataset.proofs.qualityGateSha256 = await sha256File(dataset.proofs.qualityGateJson);
    await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-score-asr-hash-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate score JSON asrJsonSha256 no longer matches paths.asr"),
    });
  });

  it("refuses quality gate score JSON with stale profile evidence", async () => {
    const datasetJson = await writeDataset({ proofMode: "valid" });
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string; qualityGateSha256: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    score.voiceProfile.profileSha256 = "0".repeat(64);
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    dataset.proofs.qualityGateSha256 = await sha256File(dataset.proofs.qualityGateJson);
    await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-score-profile-evidence-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("score.voiceProfile.profileSha256"),
    });
  });

  it("refuses quality gate scores that omit ready render output proof", async () => {
    const datasetJson = await writeDataset({ proofMode: "valid" });
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string; qualityGateSha256: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    delete score.groups[0].renders[0].outputBytes;
    delete score.groups[0].renders[0].outputSha256;
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    dataset.proofs.qualityGateSha256 = await sha256File(dataset.proofs.qualityGateJson);
    await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "missing-score-render-output-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate score/report does not prove ready render output files"),
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

  it("refuses product proof gates whose transcript proof says it was skipped", async () => {
    const datasetJson = await writeDataset();
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string; qualityGateSha256: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    gate.proofs.transcriptValidationSkipped = true;
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    dataset.proofs.qualityGateSha256 = await sha256File(dataset.proofs.qualityGateJson);
    await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "skipped-transcript-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof did not prove transcript validation passed"),
    });
  });

  it("refuses product proof gates whose profile proof says it was skipped", async () => {
    const datasetJson = await writeDataset();
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string; qualityGateSha256: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    gate.proofs.profileVerifySkipped = true;
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    dataset.proofs.qualityGateSha256 = await sha256File(dataset.proofs.qualityGateJson);
    await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "skipped-profile-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof did not prove profile verification passed"),
    });
  });

  it("refuses product proof gates whose score artifact lacks paired comparison proof", async () => {
    const datasetJson = await writeDataset();
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as {
      proofs: { qualityGateJson: string; qualityGateSha256: string };
    };
    const gate = JSON.parse(await readFile(dataset.proofs.qualityGateJson, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    delete score.pairedComparison;
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(dataset.proofs.qualityGateJson, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    dataset.proofs.qualityGateSha256 = await sha256File(dataset.proofs.qualityGateJson);
    await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "missing-paired-score-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof is not a paired product-proof gate"),
    });
  });

  it("refuses product proof quality gates captured for a different profile manifest", async () => {
    const datasetJson = await writeDataset({ proofMode: "staleGate" });

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-gate-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate proof is stale for the LoRA dataset profile"),
    });
  });

  it("refuses transcript validation proof with stale profile hash evidence", async () => {
    const datasetJson = await writeDataset({ proofMode: "staleTranscriptProfileHash" });

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-transcript-profile-hash-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation proof is stale for the LoRA dataset profile"),
    });
  });

  it("refuses product proof gates whose nested transcript validation rows are stale", async () => {
    const datasetJson = await writeDataset({ proofMode: "staleGateTranscript" });

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-gate-transcript-proof-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation proof does not match every LoRA dataset row"),
    });
  });

  it("refuses datasets whose profile hash is stale for profilePath", async () => {
    const datasetJson = await writeDataset({ proofMode: "staleDatasetProfile" });

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-dataset-profile-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset profileSha256 is stale for profilePath"),
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

  it("refuses datasets whose train and validation manifests do not partition the all manifest", async () => {
    const datasetJson = await writeDataset();
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as { manifests: { train: string } };
    const lines = (await readFile(dataset.manifests.train, "utf-8")).trim().split("\n");
    await writeFile(dataset.manifests.train, `${lines.slice(0, 1).join("\n")}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "partial-train-manifest-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("train/val manifests must exactly partition manifest.all.jsonl"),
    });
  });

  it("refuses dataset rows whose source profile audio hash no longer matches", async () => {
    const datasetJson = await writeDataset();
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as { manifests: { train: string; all: string } };
    const rewriteFirstRow = async (manifestPath: string, mutate: (row: Record<string, unknown>) => void) => {
      const lines = (await readFile(manifestPath, "utf-8")).trim().split("\n");
      const first = JSON.parse(lines[0]) as Record<string, unknown>;
      mutate(first);
      lines[0] = JSON.stringify(first);
      await writeFile(manifestPath, `${lines.join("\n")}\n`, "utf-8");
    };
    const datasetAudio = path.join(tmpRoot, "copied-dataset-audio.wav");
    const originalProfileAudio = path.join(tmpRoot, "original-profile-audio.wav");
    const originalBytes = Buffer.from([91, 92, 93, 94]);
    await writeFile(datasetAudio, originalBytes);
    await writeFile(originalProfileAudio, originalBytes);
    const audioSha256 = sha256Buffer(originalBytes);
    for (const manifest of [dataset.manifests.train, dataset.manifests.all]) {
      await rewriteFirstRow(manifest, (row) => {
        row.audio = datasetAudio;
        row.profileAudioPath = originalProfileAudio;
        row.audioSha256 = audioSha256;
      });
    }
    await writeFile(originalProfileAudio, Buffer.from([1, 1, 1, 1]));

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "stale-profile-audio-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("profileAudioPath SHA-256 mismatch"),
    });
  });

  it("refuses dataset rows whose source profile audio is missing", async () => {
    const datasetJson = await writeDataset();
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as { manifests: { train: string; all: string } };
    const missingProfileAudio = path.join(tmpRoot, "missing-profile-audio.wav");
    for (const manifest of [dataset.manifests.train, dataset.manifests.all]) {
      const lines = (await readFile(manifest, "utf-8")).trim().split("\n");
      const first = JSON.parse(lines[0]);
      first.profileAudioPath = missingProfileAudio;
      lines[0] = JSON.stringify(first);
      await writeFile(manifest, `${lines.join("\n")}\n`, "utf-8");
    }

    await expect(
      execFileAsync(python, [
        script,
        "--dataset-json",
        datasetJson,
        "--out-dir",
        path.join(tmpRoot, "missing-profile-audio-job"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("profileAudioPath not found"),
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
