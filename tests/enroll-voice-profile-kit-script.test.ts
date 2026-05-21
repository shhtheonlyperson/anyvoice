// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "enroll_voice_profile_kit.py");
const trustManifestQualityFlags = [
  "--trust-manifest-quality",
  "--allow-unsafe-trust-manifest-quality",
  "--unsafe-manifest-quality-reason",
  "already analyzed migration fixture",
];

let tmpRoot: string;

const transcripts = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

function wavBuffer(durationSec: number): Buffer {
  const sampleRate = 8000;
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(index % 2 === 0 ? 9000 : -9000, 44 + index * 2);
  }
  return buffer;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-kit-enroll-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeManifest({ withAudio }: { withAudio: boolean }): Promise<string> {
  const recordingsDir = path.join(tmpRoot, "recordings");
  await mkdir(recordingsDir, { recursive: true });
  const clips = [];
  for (let index = 0; index < transcripts.length; index += 1) {
    const file = `profile-clip-${index + 1}.wav`;
    if (withAudio) {
      await writeFile(path.join(recordingsDir, file), wavBuffer(7 + index));
    }
    clips.push({
      id: `profile-clip-${index + 1}`,
      audioPath: `recordings/${file}`,
      transcript: transcripts[index],
      quality: {
        grade: index === transcripts.length - 1 ? "B" : "A",
        durationSec: 7 + index,
        snrDb: 28,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
    });
  }
  const manifest = path.join(tmpRoot, "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");
  return manifest;
}

async function writeAsrJson({ wrong = false }: { wrong?: boolean } = {}): Promise<string> {
  const asrPath = path.join(tmpRoot, wrong ? "asr-wrong.json" : "asr.json");
  const transcriptsById = Object.fromEntries(
    transcripts.map((transcript, index) => [
      `profile-clip-${index + 1}`,
      wrong && index === 0 ? "這段逐字稿完全不一樣。" : transcript,
    ]),
  );
  await writeFile(asrPath, `${JSON.stringify({ transcripts: transcriptsById }, null, 2)}\n`, "utf-8");
  return asrPath;
}

describe("enroll_voice_profile_kit.py", () => {
  it("checks, imports, builds, and verifies a ready profile in one command", async () => {
    const manifest = await writeManifest({ withAudio: true });
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--runs-dir",
      runsDir,
      "--voices-dir",
      voicesDir,
      "--analyzer-python",
      python,
      ...trustManifestQualityFlags,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready");
    expect(payload.manifestQuality).toEqual({
      trusted: true,
      acceptedUnsafeTrust: true,
      reason: "already analyzed migration fixture",
    });
    expect(payload.steps.map((step: { name: string }) => step.name)).toEqual([
      "recording_kit_check",
      "import_profile_clips",
      "verify_voice_profile",
    ]);
    expect(payload.steps.every((step: { exitCode: number }) => step.exitCode === 0)).toBe(true);
    expect(payload.steps[2].stdout.status).toBe("ready");
    const profilePath = path.join(voicesDir, "local-default", "profile.json");
    await expect(stat(profilePath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(JSON.parse(await readFile(profilePath, "utf-8")).status).toBe("ready");
    const request = JSON.parse(await readFile(path.join(runsDir, "profile-clip-1", "request.json"), "utf-8"));
    expect(request).toMatchObject({
      sourceKind: "scripted",
      referenceSource: { kind: "scripted" },
    });
  }, 15000);

  it("can validate transcripts and require the validation report before reporting ready", async () => {
    const manifest = await writeManifest({ withAudio: true });
    const asrJson = await writeAsrJson();
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--runs-dir",
      runsDir,
      "--voices-dir",
      voicesDir,
      "--analyzer-python",
      python,
      ...trustManifestQualityFlags,
      "--validate-transcripts",
      "--transcript-python",
      python,
      "--transcript-asr-json",
      asrJson,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready");
    expect(payload.manifestQuality).toEqual({
      trusted: true,
      acceptedUnsafeTrust: true,
      reason: "already analyzed migration fixture",
    });
    expect(payload.transcriptValidationJson).toContain(path.join("voices", "local-default", "transcript-validation.json"));
    expect(payload.transcriptPython).toBe(python);
    expect(payload.steps.map((step: { name: string }) => step.name)).toEqual([
      "recording_kit_check",
      "import_profile_clips",
      "validate_profile_transcripts",
      "verify_voice_profile",
    ]);
    expect(payload.steps[2].stdout).toMatchObject({
      status: "pass",
      passed: 5,
      failed: 0,
      backend: "external-asr",
    });
    expect(payload.steps[2].command[0]).toBe(python);
    expect(payload.steps[3].command).toContain("--require-transcript-validation");
    expect(payload.steps[3].stdout.checks.find((row: { check: string }) => row.check === "transcript_validation")).toMatchObject({
      ok: true,
    });
  });

  it("stops when transcript validation fails", async () => {
    const manifest = await writeManifest({ withAudio: true });
    const asrJson = await writeAsrJson({ wrong: true });
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");

    await expect(
      execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--runs-dir",
        runsDir,
        "--voices-dir",
        voicesDir,
        "--analyzer-python",
        python,
        ...trustManifestQualityFlags,
        "--validate-transcripts",
        "--transcript-asr-json",
        asrJson,
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "transcript_validation_failed"'),
    });
  });

  it("blocks trusted manifest quality unless the unsafe bypass is acknowledged", async () => {
    const manifest = await writeManifest({ withAudio: true });
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");

    await expect(
      execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--runs-dir",
        runsDir,
        "--voices-dir",
        voicesDir,
        "--analyzer-python",
        python,
        "--trust-manifest-quality",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "unsafe_trust_manifest_quality_blocked"'),
    });
    await expect(stat(path.join(voicesDir, "local-default", "profile.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops before import when the recording kit is incomplete", async () => {
    const manifest = await writeManifest({ withAudio: false });
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");

    await expect(
      execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--runs-dir",
        runsDir,
        "--voices-dir",
        voicesDir,
        "--analyzer-python",
        python,
        ...trustManifestQualityFlags,
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "incomplete_recording_kit"'),
    });
    await expect(stat(path.join(voicesDir, "local-default", "profile.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks unsafe kit-check skips unless the bypass is acknowledged", async () => {
    const manifest = await writeManifest({ withAudio: false });
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");

    await expect(
      execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--runs-dir",
        runsDir,
        "--voices-dir",
        voicesDir,
        "--analyzer-python",
        python,
        ...trustManifestQualityFlags,
        "--skip-kit-check",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "unsafe_skip_kit_check_blocked"'),
    });
    await expect(stat(path.join(voicesDir, "local-default", "profile.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records the reason when an unsafe kit-check skip is explicitly allowed", async () => {
    const manifest = await writeManifest({ withAudio: true });
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--runs-dir",
      runsDir,
      "--voices-dir",
      voicesDir,
      "--analyzer-python",
      python,
      ...trustManifestQualityFlags,
      "--skip-kit-check",
      "--allow-unsafe-skip-kit-check",
      "--unsafe-skip-kit-check-reason",
      "migrating already checked clips",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready");
    expect(payload.kitCheck).toEqual({
      skipped: true,
      acceptedUnsafeSkip: true,
      reason: "migrating already checked clips",
    });
    expect(payload.manifestQuality).toEqual({
      trusted: true,
      acceptedUnsafeTrust: true,
      reason: "already analyzed migration fixture",
    });
    expect(payload.steps.map((step: { name: string }) => step.name)).toEqual([
      "import_profile_clips",
      "verify_voice_profile",
    ]);
  }, 15000);
});
