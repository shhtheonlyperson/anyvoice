// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "check_voice_profile_recording_kit.py");

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

function wavBuffer(durationSec: number, activeVoiceSec = durationSec, amplitude = 9000): Buffer {
  const sampleRate = 8000;
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const activeFrames = Math.max(0, Math.min(frames, Math.round(activeVoiceSec * sampleRate)));
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
  for (let index = 0; index < activeFrames; index += 1) {
    buffer.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, 44 + index * 2);
  }
  return buffer;
}

async function transcodeToM4a(inputWav: string, outputM4a: string): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", inputWav, outputM4a]);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-kit-check-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("check_voice_profile_recording_kit.py", () => {
  it("passes when all manifest recordings exist and transcript coverage is complete", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(7 + index));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(python, [script, "--manifest", manifest]);
    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_to_import");
    expect(payload.summary).toMatchObject({
      clips: 5,
      audioFilesPresent: 5,
      audioFilesWithinDuration: 5,
      audioFilesWithActiveVoice: 5,
      recordingMetadataChecked: 0,
      missingCoverageFeatures: [],
      missingPronunciationPresetIds: [],
    });
    expect(payload.summary.coveredPronunciationPresetIds).toEqual(
      expect.arrayContaining([
        "polyphone:chongqing",
        "polyphone:bank",
        "polyphone:role",
        "polyphone:music",
        "polyphone:changle",
        "brand:anyvoice",
      ]),
    );
    expect(payload.clips[2].pronunciationPresetIds).toEqual(
      expect.arrayContaining([
        "polyphone:chongqing",
        "polyphone:bank",
        "polyphone:role",
        "polyphone:music",
        "polyphone:changle",
        "brand:anyvoice",
      ]),
    );
    expect(payload.clips[0].transcript).toBe(transcripts[0]);
    expect(payload.clips[0].durationSec).toBe(7);
    expect(payload.clips[0].activeVoiceSec).toBe(7);
    expect(payload.nextCommands.importProfileClips).toContain("scripts/import_voice_profile_clips.py");
  });

  it("blocks broad polyphone coverage when exact pronunciation presets are missing", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const sparsePresetTranscripts = [
      "你好，我正在錄製一段聲音樣本，聲音保持乾淨自然。",
      "日期範例是二零二六年五月二十日，我會用自然速度讀完。",
      "如果遇到 AnyVoice 和重慶，我會讀得清楚穩定。",
      "這段錄音包含高低起伏、停頓和短句，讓節奏更自然。",
      "請確認錄音環境安靜、沒有回音，也不要離麥克風太近。",
    ];
    const clips = [];
    for (let index = 0; index < sparsePresetTranscripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(8));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: sparsePresetTranscripts[index],
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "pronunciation_presets"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary.missingCoverageFeatures).toEqual([]);
      expect(payload.summary.coveredPronunciationPresetIds).toEqual(expect.arrayContaining(["brand:anyvoice", "polyphone:chongqing"]));
      expect(payload.summary.missingPronunciationPresetIds).toEqual(
        expect.arrayContaining(["polyphone:bank", "polyphone:role", "polyphone:music", "polyphone:changle"]),
      );
      expect(payload.checks.find((row: { check: string }) => row.check === "coverage")).toMatchObject({ ok: true });
      expect(payload.checks.find((row: { check: string }) => row.check === "pronunciation_presets")).toMatchObject({
        ok: false,
        message: expect.stringContaining("polyphone:bank"),
      });
    }
  });

  it("uses generated manifest requiredClips metadata instead of the legacy five-clip default", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = transcripts.map((transcript, index) => ({
      id: `profile-clip-${index + 1}`,
      audioPath: `recordings/profile-clip-${index + 1}.wav`,
      transcript,
    }));
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(
      manifest,
      `${JSON.stringify(
        {
          promptSet: "extended",
          requiredClips: 10,
          clips,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"message": "5 clips listed / 10 required"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        clips: 5,
        minClips: 10,
        promptSet: "extended",
        requiredClipsSource: "manifest",
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "clip_count")).toMatchObject({
        ok: false,
        message: "5 clips listed / 10 required",
      });
    }
  });

  it("blocks stale prompt files and non-scripted source metadata before import", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    const promptsDir = path.join(tmpRoot, "prompts");
    await mkdir(recordingsDir, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const suffix = String(index + 1).padStart(2, "0");
      const id = `profile-clip-${suffix}`;
      const file = `${id}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(7 + index));
      await writeFile(
        path.join(promptsDir, `${id}.txt`),
        `${index === 1 ? "今天是二零二六年五月十九日，我會用自然的速度，把每一句話清楚地讀完。" : transcripts[index]}\n`,
        "utf-8",
      );
      clips.push({
        id,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
        sourceKind: index === 2 ? "uploaded" : "scripted",
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "prompt_files"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        audioFilesPresent: 5,
        audioFilesWithinDuration: 5,
        audioFilesWithActiveVoice: 5,
        promptFilesChecked: 5,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "prompt_files")).toMatchObject({
        ok: false,
        message: "1 clip(s) have stale or missing prompt files",
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "source_kind")).toMatchObject({
        ok: false,
        message: "1 clip(s) have non-scripted sourceKind",
      });
      expect(payload.clips[1]).toMatchObject({
        promptExists: true,
        errors: expect.arrayContaining(["prompt_transcript_mismatch"]),
      });
      expect(payload.clips[2]).toMatchObject({
        sourceKind: "uploaded",
        errors: expect.arrayContaining(["unexpected_source_kind"]),
      });
    }
  });

  it("blocks stale terminal recording metadata before import", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(7 + index));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
      });
    }
    const staleTranscript = "今天是二零二六年五月十九日，我會用自然的速度，把每一句話清楚地讀完。";
    await writeFile(
      path.join(recordingsDir, "profile-clip-2.wav.recording.json"),
      `${JSON.stringify(
        {
          id: "profile-clip-2",
          transcript: staleTranscript,
          transcriptSha256: textSha256(staleTranscript),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "recording_metadata"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        recordingMetadataChecked: 1,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "recording_metadata")).toMatchObject({
        ok: false,
        message: "1 clip(s) have stale or unreadable recording sidecars",
      });
      expect(payload.clips[1]).toMatchObject({
        recordingMetadataExists: true,
        recordingMetadataTranscriptSha256: textSha256(staleTranscript),
        expectedTranscriptSha256: textSha256(transcripts[1]),
        errors: expect.arrayContaining(["recording_metadata_transcript_mismatch"]),
      });
    }
  });

  it("blocks short and long recording files before import", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const durations = [2, 7, 8, 9, 24];
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(durations[index]));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "audio_duration"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        audioFilesPresent: 5,
        audioFilesWithinDuration: 3,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "audio_duration")).toMatchObject({
        ok: false,
        message: "2 clip(s) outside the 6-20s duration gate",
      });
      expect(payload.clips[0]).toMatchObject({
        durationSec: 2,
        errors: expect.arrayContaining(["audio_too_short"]),
      });
      expect(payload.clips[4]).toMatchObject({
        durationSec: 24,
        errors: expect.arrayContaining(["audio_too_long"]),
      });
    }
  });

  it("blocks rushed takes that miss their per-prompt target duration", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(index === 2 ? 9 : 12));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
        recommendedDurationSec: index === 2 ? 15 : 12,
        durationMode: "auto",
        durationTargetSec: index === 2 ? 15 : 12,
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "audio_target_duration"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        audioFilesPresent: 5,
        audioFilesWithinDuration: 5,
        audioFilesWithActiveVoice: 5,
        audioFilesWithinTargetDuration: 4,
        targetDurationToleranceSec: 2,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "audio_duration")).toMatchObject({
        ok: true,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "audio_target_duration")).toMatchObject({
        ok: false,
        message: "1 clip(s) are too rushed for their prompt target",
      });
      expect(payload.clips[2]).toMatchObject({
        durationSec: 9,
        durationTargetSec: 15,
        minTargetDurationSec: 13,
        errors: expect.arrayContaining(["audio_below_target_duration"]),
      });
    }
  });

  it("blocks recordings with too little active voice before import", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const activeVoiceDurations = [0, 4, 8, 8, 8];
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(8, activeVoiceDurations[index]));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "audio_voice_activity"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        audioFilesPresent: 5,
        audioFilesWithinDuration: 5,
        audioFilesWithActiveVoice: 3,
        minActiveVoiceSec: 5.2,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "audio_voice_activity")).toMatchObject({
        ok: false,
        message: "2 clip(s) below the 5.2s active-voice gate",
      });
      expect(payload.clips[0]).toMatchObject({
        durationSec: 8,
        activeVoiceSec: 0,
        errors: expect.arrayContaining(["audio_low_voice_activity"]),
      });
      expect(payload.clips[1]).toMatchObject({
        durationSec: 8,
        activeVoiceSec: 4,
        errors: expect.arrayContaining(["audio_low_voice_activity"]),
      });
    }
  });

  it("blocks clipped and too-quiet recordings before import", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const amplitudes = [9000, 32767, 1000, 9000, 9000];
    const clips = [];
    for (let index = 0; index < transcripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(8, 8, amplitudes[index]));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "audio_level_quality"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        audioFilesPresent: 5,
        audioFilesWithinDuration: 5,
        audioFilesWithActiveVoice: 5,
        audioFilesPassingLevelQuality: 3,
        minPeakAmplitude: 0.05,
        maxClippingRatio: 0.001,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "audio_level_quality")).toMatchObject({
        ok: false,
        message: "2 clip(s) have clipping, unreadable levels, or too little gain",
      });
      expect(payload.clips[1]).toMatchObject({
        audioLevelQuality: {
          peakAmplitude: 0.99997,
          clippingRatio: 1,
        },
        errors: expect.arrayContaining(["audio_clipping_detected"]),
      });
      expect(payload.clips[2]).toMatchObject({
        audioLevelQuality: {
          peakAmplitude: 0.03052,
          clippingRatio: 0,
        },
        errors: expect.arrayContaining(["audio_too_quiet"]),
      });
    }
  });

  it("applies the active-voice gate to non-WAV recordings", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const silentWav = path.join(recordingsDir, "profile-clip-1-source.wav");
    const silentM4a = path.join(recordingsDir, "profile-clip-1.m4a");
    await writeFile(silentWav, wavBuffer(8, 0));
    const transcoded = await transcodeToM4a(silentWav, silentM4a);
    if (!transcoded) return;

    const clips = [
      {
        id: "profile-clip-1",
        audioPath: "recordings/profile-clip-1.m4a",
        transcript: transcripts[0],
      },
    ];
    for (let index = 1; index < transcripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(8));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: transcripts[index],
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"check": "audio_voice_activity"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary).toMatchObject({
        audioFilesPresent: 5,
        audioFilesWithinDuration: 5,
        audioFilesWithActiveVoice: 4,
      });
      expect(payload.clips[0]).toMatchObject({
        audioPath: expect.stringContaining("profile-clip-1.m4a"),
        durationSec: expect.any(Number),
        activeVoiceSec: 0,
        errors: expect.arrayContaining(["audio_low_voice_activity"]),
      });
    }
  });

  it("blocks mixed Chinese transcripts from satisfying zh-Hant coverage", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const mixedTranscripts = [
      "这个聲音樣本很穩定。春天的陽光灑在湖面上，世界顯得安靜。",
      "今天是二零二六年五月十九日，我会用自然速度，把每一句話清楚讀完。",
      "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準，这个名字要清楚。",
      "我会保持停頓、節奏，讓聲音自然、乾淨。",
      "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，这个聲音要自然。",
    ];
    const clips = [];
    for (let index = 0; index < mixedTranscripts.length; index += 1) {
      const file = `profile-clip-${index + 1}.wav`;
      await writeFile(path.join(recordingsDir, file), wavBuffer(8));
      clips.push({
        id: `profile-clip-${index + 1}`,
        audioPath: `recordings/${file}`,
        transcript: mixedTranscripts[index],
      });
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"missingCoverageFeatures": [\n      "zh_hant"\n    ]'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.summary.coveredFeatures).not.toContain("zh_hant");
      expect(payload.summary.missingCoverageFeatures).toEqual(["zh_hant"]);
      expect(payload.checks.find((row: { check: string }) => row.check === "transcripts")).toMatchObject({
        ok: false,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "coverage")).toMatchObject({
        ok: false,
      });
      expect(payload.clips[0]).toMatchObject({
        transcriptScript: "mixed_zh",
        scriptMarkerHits: expect.arrayContaining([
          expect.objectContaining({ simplified: "这", simplifiedCount: 1 }),
          expect.objectContaining({ simplified: "个", simplifiedCount: 1 }),
        ]),
        errors: ["invalid_chinese_script"],
      });
    }
  });

  it("blocks Chinese transcripts without clear Traditional marker evidence before import", async () => {
    const recordingsDir = path.join(tmpRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const clips = transcripts.map((transcript, index) => ({
      id: `profile-clip-${index + 1}`,
      audioPath: `recordings/profile-clip-${index + 1}.wav`,
      transcript: index === 0 ? "中文音色自然。" : transcript,
    }));
    for (let index = 0; index < clips.length; index += 1) {
      await writeFile(path.join(recordingsDir, `profile-clip-${index + 1}.wav`), wavBuffer(8));
    }
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining("unproven_chinese_script"),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("incomplete");
      expect(payload.checks.find((row: { check: string }) => row.check === "transcripts")).toMatchObject({
        ok: false,
        message: "1 clip(s) need transcript fixes",
      });
      expect(payload.clips[0]).toMatchObject({
        transcriptScript: "zh_unknown",
        errors: ["unproven_chinese_script"],
      });
    }
  });

  it("blocks before import when recording files are missing", async () => {
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(
      manifest,
      `${JSON.stringify({
        clips: transcripts.map((transcript, index) => ({
          id: `profile-clip-${index + 1}`,
          audioPath: `recordings/profile-clip-${index + 1}.wav`,
          transcript,
        })),
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, "--manifest", manifest])).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "incomplete"'),
    });
    try {
      await execFileAsync(python, [script, "--manifest", manifest]);
    } catch (error) {
      const stdout = (error as { stdout: string }).stdout;
      const payload = JSON.parse(stdout);
      expect(payload.checks.find((row: { check: string }) => row.check === "audio_files")).toMatchObject({
        ok: false,
      });
      expect(payload.checks.find((row: { check: string }) => row.check === "coverage")).toMatchObject({
        ok: true,
      });
    }
  });
});
