// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "import_voice_profile_clips.py");
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

function textSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

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
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-import-profile-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("import_voice_profile_clips.py", () => {
  it("imports a trusted analyzed manifest and builds a ready voice profile", async () => {
    const audioDir = path.join(tmpRoot, "audio");
    await mkdir(audioDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const audioPath = path.join(audioDir, `clip-${index + 1}.wav`);
      await writeFile(audioPath, Buffer.from([index + 1, index + 2, index + 3]));
      clips.push({
        id: `clip-${index + 1}`,
        audioPath,
        transcript: transcripts[index],
        sourceKind: "uploaded",
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
    const manifestPath = path.join(tmpRoot, "manifest.json");
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");
    await writeFile(manifestPath, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifestPath,
      "--runs-dir",
      runsDir,
      "--voices-dir",
      voicesDir,
      ...trustManifestQualityFlags,
      "--build-profile",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "imported",
      imported: 5,
      manifestQuality: {
        trusted: true,
        acceptedUnsafeTrust: true,
        reason: "already analyzed migration fixture",
      },
      profile: {
        status: "ready",
        selectedClips: 5,
        remainingClipsNeeded: 0,
      },
    });
    await expect(stat(path.join(runsDir, "clip-1", "request.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(path.join(voicesDir, "local-default", "profile.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(readFile(path.join(runsDir, "clip-1", "prompt-transcript.raw.txt"), "utf-8")).resolves.toBe(transcripts[0]);

    const profile = JSON.parse(await readFile(path.join(voicesDir, "local-default", "profile.json"), "utf-8"));
    expect(profile.status).toBe("ready");
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.referenceClipIds).toHaveLength(5);
    expect(profile.clips).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceRunId: "clip-1", recordingKitClipId: "clip-1" })]),
    );
    const request = JSON.parse(await readFile(path.join(runsDir, "clip-1", "request.json"), "utf-8"));
    expect(request.recordingKitClipId).toBe("clip-1");
    const metadata = JSON.parse(await readFile(path.join(runsDir, "clip-1", "metadata.json"), "utf-8"));
    expect(metadata.recording_kit_clip_id).toBe("clip-1");
    expect(metadata.referenceQualitySource).toMatchObject({
      kind: "trusted_manifest",
      reason: "already analyzed migration fixture",
    });
  });

  it("blocks trusted manifest quality unless the unsafe bypass is acknowledged", async () => {
    const audioPath = path.join(tmpRoot, "clip.wav");
    const manifestPath = path.join(tmpRoot, "manifest.jsonl");
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        id: "clip-1",
        audioPath,
        transcript: transcripts[0],
        quality: {
          grade: "A",
          durationSec: 8,
          snrDb: 28,
          clippingRatio: 0,
          vadActiveRatio: 0.8,
          warnings: [],
        },
      })}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--manifest",
        manifestPath,
        "--runs-dir",
        path.join(tmpRoot, "runs"),
        "--trust-manifest-quality",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "unsafe_trust_manifest_quality_blocked"'),
    });
    await expect(stat(path.join(tmpRoot, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the recording-kit check before direct generated-kit imports", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const id = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      const audioPath = path.join(recordingsDir, `${id}.wav`);
      await writeFile(audioPath, wavBuffer(7 + index));
      clips.push({
        id,
        expectedStem: id,
        audioPath: `recordings/${id}.wav`,
        transcript: transcripts[index],
        sourceKind: "scripted",
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
    const staleAudioPath = path.join(recordingsDir, "profile-clip-02.wav");
    const staleAudioSha256 = await fileSha256(staleAudioPath);
    await writeFile(staleAudioPath, wavBuffer(9));
    await writeFile(
      `${staleAudioPath}.recording.json`,
      `${JSON.stringify(
        {
          id: "profile-clip-02",
          audioPath: staleAudioPath,
          audioSha256: staleAudioSha256,
          transcript: transcripts[1],
          transcriptSha256: textSha256(transcripts[1]),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const manifestPath = path.join(tmpRoot, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ promptSet: "standard", requiredClips: 5, clips }, null, 2)}\n`,
      "utf-8",
    );
    const runsDir = path.join(tmpRoot, "runs");

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifestPath,
        "--runs-dir",
        runsDir,
        ...trustManifestQualityFlags,
      ]);
      throw new Error("expected direct import to fail the recording-kit preflight");
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete_recording_kit");
      expect(payload.imported).toBe(0);
      expect(payload.recordingKitCheck).toMatchObject({
        required: true,
        skipped: false,
        acceptedUnsafeSkip: false,
      });
      expect(payload.recordingKitCheck.result.exitCode).toBe(2);
      expect(payload.recordingKitCheck.result.stdout.checks.find((row: { check: string }) => row.check === "recording_metadata")).toMatchObject({
        ok: false,
        message: "1 clip(s) have stale or unreadable recording sidecars",
      });
      expect(payload.recordingKitCheck.result.stdout.clips[1].errors).toEqual(
        expect.arrayContaining(["recording_metadata_audio_hash_mismatch"]),
      );
    }
    await expect(stat(runsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records the unsafe reason when direct generated-kit import skips the kit check", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const id = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      const audioPath = path.join(recordingsDir, `${id}.wav`);
      await writeFile(audioPath, wavBuffer(7 + index));
      clips.push({
        id,
        expectedStem: id,
        audioPath: `recordings/${id}.wav`,
        transcript: transcripts[index],
        sourceKind: "scripted",
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
    const staleAudioPath = path.join(recordingsDir, "profile-clip-02.wav");
    const staleAudioSha256 = await fileSha256(staleAudioPath);
    await writeFile(staleAudioPath, wavBuffer(9));
    await writeFile(
      `${staleAudioPath}.recording.json`,
      `${JSON.stringify(
        {
          id: "profile-clip-02",
          audioPath: staleAudioPath,
          audioSha256: staleAudioSha256,
          transcript: transcripts[1],
          transcriptSha256: textSha256(transcripts[1]),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const manifestPath = path.join(tmpRoot, "manifest.json");
    const runsDir = path.join(tmpRoot, "runs");
    const voicesDir = path.join(tmpRoot, "voices");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ promptSet: "standard", requiredClips: 5, clips }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifestPath,
      "--runs-dir",
      runsDir,
      "--voices-dir",
      voicesDir,
      ...trustManifestQualityFlags,
      "--skip-kit-check",
      "--allow-unsafe-skip-kit-check",
      "--unsafe-skip-kit-check-reason",
      "migrating previously audited clips",
      "--build-profile",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("imported");
    expect(payload.recordingKitCheck).toEqual({
      required: true,
      skipped: true,
      acceptedUnsafeSkip: true,
      reason: "migrating previously audited clips",
      result: null,
    });
    expect(payload.imported).toBe(5);
    await expect(stat(path.join(voicesDir, "local-default", "profile.json"))).resolves.toMatchObject({
      size: expect.any(Number),
    });
  }, 15000);

  it("defaults generated recording-kit rows without sourceKind to scripted evidence", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const id = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      const audioPath = path.join(recordingsDir, `${id}.wav`);
      await writeFile(audioPath, wavBuffer(7 + index));
      clips.push({
        id,
        expectedStem: id,
        audioPath: `recordings/${id}.wav`,
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
    const manifestPath = path.join(tmpRoot, "manifest.json");
    const runsDir = path.join(tmpRoot, "runs");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ promptSet: "standard", requiredClips: 5, clips }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifestPath,
      "--runs-dir",
      runsDir,
      ...trustManifestQualityFlags,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "imported",
      imported: 5,
      recordingKitCheck: {
        required: true,
        skipped: false,
        acceptedUnsafeSkip: false,
      },
      clips: expect.arrayContaining([expect.objectContaining({ sourceKind: "scripted" })]),
    });
    const request = JSON.parse(await readFile(path.join(runsDir, "profile-clip-01", "request.json"), "utf-8"));
    expect(request).toMatchObject({
      sourceKind: "scripted",
      referenceSource: { kind: "scripted" },
    });
  }, 15_000);

  it("validates a manifest without writing in dry-run mode", async () => {
    const audioPath = path.join(tmpRoot, "clip.wav");
    const manifestPath = path.join(tmpRoot, "manifest.jsonl");
    const runsDir = path.join(tmpRoot, "runs");
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    await writeFile(
      manifestPath,
      `${JSON.stringify({ audioPath, transcript: transcripts[0] })}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifestPath,
      "--runs-dir",
      runsDir,
      "--dry-run",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      status: "planned",
      imported: 1,
      dryRun: true,
      clips: [expect.objectContaining({ transcriptScript: "zh_hant" })],
    });
    await expect(stat(runsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects Simplified or mixed Chinese transcripts before writing run evidence", async () => {
    const audioPath = path.join(tmpRoot, "mixed.wav");
    const manifestPath = path.join(tmpRoot, "manifest.json");
    const runsDir = path.join(tmpRoot, "runs");
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        clips: [
          {
            id: "mixed",
            audioPath,
            transcript: "银行。",
            quality: {
              grade: "A",
              durationSec: 8,
              snrDb: 28,
              clippingRatio: 0,
              vadActiveRatio: 0.8,
              warnings: [],
            },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--manifest",
        manifestPath,
        "--runs-dir",
        runsDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Traditional Chinese"),
    });
    await expect(stat(runsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects Chinese transcripts without clear Traditional marker evidence before writing run evidence", async () => {
    const audioPath = path.join(tmpRoot, "unproven.wav");
    const manifestPath = path.join(tmpRoot, "manifest-unproven.json");
    const runsDir = path.join(tmpRoot, "runs");
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        clips: [
          {
            id: "unproven",
            audioPath,
            transcript: "中文音色自然。",
            quality: {
              grade: "A",
              durationSec: 8,
              snrDb: 28,
              clippingRatio: 0,
              vadActiveRatio: 0.8,
              warnings: [],
            },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--manifest",
        manifestPath,
        "--runs-dir",
        runsDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unproven_chinese_script"),
    });
    await expect(stat(runsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
