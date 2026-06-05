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
const script = path.join(process.cwd(), "scripts", "record_voice_profile_recording_kit.py");

let tmpRoot: string;

const transcripts = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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

async function writeManifest({
  promptSet,
  requiredClips,
  durationTargets,
}: {
  promptSet?: string;
  requiredClips?: number;
  durationTargets?: number[];
} = {}): Promise<string> {
  const recordingsDir = path.join(tmpRoot, "kit", "recordings");
  await mkdir(recordingsDir, { recursive: true });
  const clips = transcripts.map((transcript, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      id: `profile-clip-${suffix}`,
      audioPath: `recordings/profile-clip-${suffix}.wav`,
      transcript,
      ...(durationTargets?.[index] ? { durationTargetSec: durationTargets[index], recommendedDurationSec: durationTargets[index] } : {}),
      ...(index === 2
        ? {
            pronunciationNotes: [
              "Brenda: English name, keep it natural",
              "AnyVoice: read as English words Any Voice",
              "重慶: ㄔㄨㄥˊ ㄑㄧㄥˋ / chong2 qing4",
              "銀行: ㄧㄣˊ ㄏㄤˊ / yin2 hang2",
              "長樂: ㄔㄤˊ ㄌㄜˋ / chang2 le4",
            ],
          }
        : {}),
    };
  });
  const manifest = path.join(tmpRoot, "kit", "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ ...(promptSet ? { promptSet } : {}), ...(requiredClips ? { requiredClips } : {}), clips }, null, 2)}\n`, "utf-8");
  return manifest;
}

async function writeMixedScriptManifest(): Promise<string> {
  const recordingsDir = path.join(tmpRoot, "kit", "recordings");
  await mkdir(recordingsDir, { recursive: true });
  const clips = transcripts.map((transcript, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      id: `profile-clip-${suffix}`,
      audioPath: `recordings/profile-clip-${suffix}.wav`,
      transcript: index === 0 ? "这个聲音樣本要穩定，請保持自然。" : transcript,
    };
  });
  const manifest = path.join(tmpRoot, "kit", "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");
  return manifest;
}

async function writeUnprovenScriptManifest(): Promise<string> {
  const recordingsDir = path.join(tmpRoot, "kit", "recordings");
  await mkdir(recordingsDir, { recursive: true });
  const clips = transcripts.map((transcript, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      id: `profile-clip-${suffix}`,
      audioPath: `recordings/profile-clip-${suffix}.wav`,
      transcript: index === 0 ? "中文音色自然。" : transcript,
    };
  });
  const manifest = path.join(tmpRoot, "kit", "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");
  return manifest;
}

async function writeFakeRecorder({ amplitude = 9000 }: { amplitude?: number } = {}): Promise<{ command: string; log: string }> {
  const fakeRecorder = path.join(tmpRoot, "fake_recorder.py");
  const log = path.join(tmpRoot, "fake-recorder.log");
  await writeFile(
    fakeRecorder,
    [
      "from pathlib import Path",
      "import sys",
      "import wave",
      "",
      "audio_path = Path(sys.argv[1])",
      "duration = float(sys.argv[2])",
      "clip_id = sys.argv[3]",
      "log_path = Path(sys.argv[4])",
      "sample_rate = 8000",
      "frames = max(1, round(duration * sample_rate))",
      "audio_path.parent.mkdir(parents=True, exist_ok=True)",
      "with wave.open(str(audio_path), 'wb') as handle:",
      "    handle.setnchannels(1)",
      "    handle.setsampwidth(2)",
      "    handle.setframerate(sample_rate)",
      "    data = bytearray()",
      "    for index in range(frames):",
      `        value = ${amplitude} if index % 2 == 0 else -${amplitude}`,
      "        data.extend(int(value).to_bytes(2, 'little', signed=True))",
      "    handle.writeframes(bytes(data))",
      "with log_path.open('a', encoding='utf-8') as handle:",
      "    handle.write(clip_id + '\\n')",
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    command: `${shellQuote(python)} ${shellQuote(fakeRecorder)} {audio_path} {duration} {id} ${shellQuote(log)}`,
    log,
  };
}

async function writeFakeProofCommand(): Promise<{ command: string; log: string }> {
  const fakeProof = path.join(tmpRoot, "fake_proof.py");
  const log = path.join(tmpRoot, "fake-proof.log");
  await writeFile(
    fakeProof,
    [
      "import json",
      "import sys",
      "from pathlib import Path",
      "",
      "manifest = Path(sys.argv[1])",
      "profile_id = sys.argv[2]",
      "profile_json = Path(sys.argv[3])",
      "countdown_sec = int(sys.argv[4])",
      "log_path = Path(sys.argv[5])",
      "payload = {",
      "    'status': 'ready_for_lora_dataset',",
      "    'manifest': str(manifest),",
      "    'profileId': profile_id,",
      "    'profileJson': str(profile_json),",
      "    'recordCountdownSec': countdown_sec,",
      "}",
      "log_path.write_text(json.dumps(payload, ensure_ascii=False) + '\\n', encoding='utf-8')",
      "print(json.dumps(payload, ensure_ascii=False))",
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    command: `${shellQuote(python)} ${shellQuote(fakeProof)} {manifest} {profile_id} {profile_json} {record_countdown_sec} ${shellQuote(log)}`,
    log,
  };
}

async function writeFakeProductProofCommand(): Promise<{ command: string; log: string }> {
  const fakeProof = path.join(tmpRoot, "fake_product_proof.py");
  const log = path.join(tmpRoot, "fake-product-proof.log");
  await writeFile(
    fakeProof,
    [
      "import json",
      "import sys",
      "from pathlib import Path",
      "",
      "manifest = Path(sys.argv[1])",
      "profile_id = sys.argv[2]",
      "log_path = Path(sys.argv[3])",
      "payload = {",
      "    'status': 'product_proof_pass',",
      "    'manifest': str(manifest),",
      "    'profileId': profile_id,",
      "    'pairedImprovement': 'required',",
      "    'speakerBackend': 'speechbrain-ecapa',",
      "}",
      "log_path.write_text(json.dumps(payload, ensure_ascii=False) + '\\n', encoding='utf-8')",
      "print(json.dumps(payload, ensure_ascii=False))",
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    command: `${shellQuote(python)} ${shellQuote(fakeProof)} {manifest} {profile_id} ${shellQuote(log)}`,
    log,
  };
}

async function writeFakeLoraDatasetCommand(): Promise<{ command: string; log: string }> {
  const fakeLora = path.join(tmpRoot, "fake_lora_dataset.py");
  const log = path.join(tmpRoot, "fake-lora-dataset.log");
  await writeFile(
    fakeLora,
    [
      "import json",
      "import sys",
      "from pathlib import Path",
      "",
      "manifest = Path(sys.argv[1])",
      "profile_id = sys.argv[2]",
      "log_path = Path(sys.argv[3])",
      "payload = {",
      "    'status': 'written',",
      "    'manifest': str(manifest),",
      "    'profileId': profile_id,",
      "    'datasetJson': str(manifest.parent / 'lora-dataset' / 'dataset.json'),",
      "}",
      "log_path.write_text(json.dumps(payload, ensure_ascii=False) + '\\n', encoding='utf-8')",
      "print(json.dumps(payload, ensure_ascii=False))",
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    command: `${shellQuote(python)} ${shellQuote(fakeLora)} {manifest} {profile_id} ${shellQuote(log)}`,
    log,
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-kit-record-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("record_voice_profile_recording_kit.py", () => {
  it("prints a no-microphone rehearsal cue sheet without requiring a recorder", async () => {
    const manifest = await writeManifest();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--rehearse",
      "--no-default-recorder",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_to_rehearse");
    expect(payload.message).toBe("read these prompts exactly before recording");
    expect(payload.recorder).toMatchObject({ configured: false, source: "disabled" });
    expect(payload.recordingGuidance).toMatchObject({
      targetDurationSec: 9,
      minDurationSec: 6,
      maxDurationSec: 20,
      minActiveVoiceSec: 5.2,
      checklist: expect.arrayContaining([
        "read the prompt exactly",
        "use strict Traditional Chinese",
        "avoid long silent pauses",
      ]),
    });
    expect(payload.summary).toMatchObject({
      clips: 5,
      existing: 0,
      promptBlocked: 0,
      missingCoverageFeatures: [],
      missingPronunciationPresetIds: [],
    });
    expect(payload.summary.coveredFeatures).toEqual(
      expect.arrayContaining(["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"]),
    );
    expect(payload.summary.coveredPronunciationPresetIds).toEqual(
      expect.arrayContaining(["brand:anyvoice", "polyphone:chongqing", "polyphone:bank", "polyphone:role", "polyphone:music", "polyphone:changle"]),
    );
    expect(payload.clips[2]).toMatchObject({
      id: "profile-clip-03",
      transcript: transcripts[2],
      coverageFeatures: expect.arrayContaining(["latin_terms", "polyphones"]),
      pronunciationPresetIds: expect.arrayContaining(["brand:anyvoice", "polyphone:chongqing", "polyphone:bank"]),
      pronunciationNotes: expect.arrayContaining([
        expect.stringContaining("Brenda"),
        expect.stringContaining("重慶"),
        expect.stringContaining("長樂"),
      ]),
    });
    expect(payload.nextCommands.rehearse).toContain("--rehearse");
    expect(payload.nextCommands.rehearse).toContain("--auto-duration");
    expect(payload.nextCommands.rehearse).toContain("--profile-id local-default");
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints the recording plan in dry-run mode without requiring a recorder", async () => {
    const manifest = await writeManifest();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--dry-run",
      "--no-default-recorder",
    ]);

    const payload = JSON.parse(stdout);
    const resolvedRoot = await realpath(tmpRoot);
    expect(payload.status).toBe("dry_run");
    expect(payload.recorder).toMatchObject({ configured: false, source: "disabled" });
    expect(payload.countdownSec).toBe(0);
    expect(payload.clips).toHaveLength(5);
    expect(payload.clips[0]).toMatchObject({
      id: "profile-clip-01",
      exists: false,
      audioPath: path.join(resolvedRoot, "kit", "recordings", "profile-clip-01.wav"),
    });
    expect(payload.nextCommands.record).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextCommands.record).toContain("--open-cue-sheet");
    expect(payload.nextCommands.record).toContain("--profile-id local-default");
    expect(payload.nextCommands.preflight).toContain("--preflight");
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can use transcript-aware per-clip duration targets in dry-run mode", async () => {
    const manifest = await writeManifest();
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--manifest",
        manifest,
        "--dry-run",
        "--auto-duration",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("dry_run");
    expect(payload.durationMode).toBe("auto");
    expect(payload.recordingGuidance).toMatchObject({
      durationMode: "auto",
      targetDurationSec: null,
      targetDurationLabel: "auto per clip",
    });
    expect(payload.clips[0]).toMatchObject({
      id: "profile-clip-01",
      recommendedDurationSec: 13,
      durationMode: "auto",
      durationTargetSec: 13,
    });
    expect(payload.clips[1]).toMatchObject({ durationTargetSec: 10 });
    expect(payload.clips[2]).toMatchObject({ recommendedDurationSec: 15, durationTargetSec: 15 });
    expect(payload.clips[0].commandPreview).toContain("--seconds 13");
    expect(payload.clips[2].commandPreview).toContain("--seconds 15");
    expect(payload.nextCommands.recordMissingUntilComplete).toContain("--auto-duration");
    expect(payload.nextCommands.recordMissingUntilComplete).toContain("--microphone-smoke-sec 2");
  });

  it("preflights missing recordings with a configured recorder without touching audio files", async () => {
    const manifest = await writeManifest({ promptSet: "extended", requiredClips: 10 });
    await writeFile(path.join(tmpRoot, "kit", "cue-sheet.html"), "<!doctype html>\n", "utf-8");
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--manifest",
        manifest,
        "--preflight",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const payload = JSON.parse(stdout);
    const resolvedRoot = await realpath(tmpRoot);
    expect(payload.status).toBe("ready_to_record");
    expect(payload).toMatchObject({
      kit: path.join(resolvedRoot, "kit"),
      prompts: path.join(resolvedRoot, "kit", "prompts"),
      recordings: path.join(resolvedRoot, "kit", "recordings"),
      cueSheetHtml: path.join(resolvedRoot, "kit", "cue-sheet.html"),
      openCueSheetCommand: expect.stringContaining("python3 -m webbrowser -t file://"),
    });
    expect(payload.manifestMetadata).toMatchObject({ promptSet: "extended", requiredClips: 10 });
    expect(payload.summary).toMatchObject({ clips: 5, existing: 0, toRecord: 5, toSkipExisting: 0, writeBlocked: 0 });
    expect(payload.clips[0]).toMatchObject({
      action: "record",
      exists: false,
      writeAccess: expect.objectContaining({ parentCreatable: true }),
    });
    expect(payload.clips[0].commandPreview).toContain("fake-recorder --out");
    expect(payload.nextCommands.preflightBrief).toContain("--preflight");
    expect(payload.nextCommands.preflightBrief).toContain("--brief");
    expect(payload.nextCommands.microphoneSmokeTest).toContain("--microphone-smoke-sec 2");
    expect(payload.nextCommands.openCueSheet).toContain("python3 -m webbrowser -t file://");
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can run an explicit microphone smoke test during preflight without writing kit recordings", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--preflight",
      "--microphone-smoke-sec",
      "1",
      "--recorder-command",
      fake.command,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_to_record");
    expect(payload.microphoneSmokeTest).toMatchObject({
      status: "passed",
      durationSec: 1,
      clipId: "profile-clip-01",
      exitCode: 0,
      errors: [],
      minPeakAmplitude: 0.05,
      maxClippingRatio: 0.001,
      keptAudio: false,
    });
    expect(payload.microphoneSmokeTest.audioBytes).toBeGreaterThan(0);
    expect(payload.microphoneSmokeTest.audioLevelQuality).toMatchObject({
      peakAmplitude: expect.any(Number),
      clippingRatio: 0,
    });
    expect(payload.microphoneSmokeTest.command).toContain("microphone-smoke.wav");
    expect((await readFile(fake.log, "utf-8")).trim()).toBe("profile-clip-01");
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks preflight when the explicit microphone smoke test fails", async () => {
    const manifest = await writeManifest();
    const failingRecorder = path.join(tmpRoot, "failing_recorder.py");
    await writeFile(
      failingRecorder,
      [
        "import sys",
        "print('microphone unavailable', file=sys.stderr)",
        "raise SystemExit(9)",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--preflight",
      "--microphone-smoke-sec",
      "1",
      "--recorder-command",
      `${shellQuote(python)} ${shellQuote(failingRecorder)}`,
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("microphone smoke test failed"),
    });

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--preflight",
        "--microphone-smoke-sec",
        "1",
        "--recorder-command",
        `${shellQuote(python)} ${shellQuote(failingRecorder)}`,
      ]);
      throw new Error("expected smoke test failure");
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.microphoneSmokeTest).toMatchObject({
        status: "failed",
        exitCode: 9,
        audioBytes: 0,
        errors: [],
        stderr: expect.stringContaining("microphone unavailable"),
      });
    }
  });

  it("blocks preflight when the microphone smoke test is too quiet", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder({ amplitude: 1000 });

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--preflight",
        "--microphone-smoke-sec",
        "1",
        "--recorder-command",
        fake.command,
      ]);
      throw new Error("expected quiet smoke test failure");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(2);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.message).toContain("input level");
      expect(payload.microphoneSmokeTest).toMatchObject({
        status: "failed",
        audioBytes: expect.any(Number),
        errors: expect.arrayContaining(["audio_too_quiet"]),
        minPeakAmplitude: 0.05,
        maxClippingRatio: 0.001,
      });
      expect(payload.microphoneSmokeTest.audioLevelQuality.peakAmplitude).toBeLessThan(0.05);
    }
  });

  it("blocks preflight when the microphone smoke test clips", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder({ amplitude: 32767 });

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--preflight",
        "--microphone-smoke-sec",
        "1",
        "--recorder-command",
        fake.command,
      ]);
      throw new Error("expected clipped smoke test failure");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(2);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.message).toContain("input level");
      expect(payload.microphoneSmokeTest).toMatchObject({
        status: "failed",
        audioBytes: expect.any(Number),
        errors: expect.arrayContaining(["audio_clipping_detected"]),
        minPeakAmplitude: 0.05,
        maxClippingRatio: 0.001,
      });
      expect(payload.microphoneSmokeTest.audioLevelQuality.clippingRatio).toBeGreaterThan(0.001);
    }
  });

  it("runs a passing microphone smoke test before recording a real clip", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder();

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--recorder-command",
      fake.command,
      "--next-missing",
      "--duration-sec",
      "7",
      "--microphone-smoke-sec",
      "1",
      "--countdown-sec",
      "0",
      "--yes",
      "--write-metadata",
      "--check-selected",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("selected_recording_ready");
    expect(payload.microphoneSmokeTest).toMatchObject({
      status: "passed",
      durationSec: 1,
      clipId: "profile-clip-01",
      errors: [],
    });
    expect(payload.summary).toMatchObject({ requestedClips: 1, recorded: 1, failed: 0 });
    expect((await readFile(fake.log, "utf-8")).trim().split("\n")).toEqual(["profile-clip-01", "profile-clip-01"]);
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).resolves.toBeTruthy();
  });

  it("blocks real recording before writing kit audio when the microphone smoke test fails", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder({ amplitude: 1000 });

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--recorder-command",
        fake.command,
        "--next-missing",
        "--duration-sec",
        "7",
        "--microphone-smoke-sec",
        "1",
        "--countdown-sec",
        "0",
        "--yes",
        "--write-metadata",
        "--check-selected",
      ]);
      throw new Error("expected pre-recording smoke test failure");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(2);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("microphone_smoke_failed");
      expect(payload.microphoneSmokeTest).toMatchObject({
        status: "failed",
        errors: expect.arrayContaining(["audio_too_quiet"]),
      });
      expect(payload.results).toBeUndefined();
    }
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints a compact human-readable preflight brief for terminal recording", async () => {
    const manifest = await writeManifest({ promptSet: "extended", requiredClips: 10 });
    await writeFile(path.join(tmpRoot, "kit", "cue-sheet.html"), "<!doctype html>\n", "utf-8");
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--manifest",
        manifest,
        "--preflight",
        "--brief",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const resolvedRoot = await realpath(tmpRoot);
    expect(stdout).toContain("Status: ready_to_record");
    expect(stdout).toContain("Kit metadata: promptSet=extended, requiredClips=10");
    expect(stdout).toContain(`Cue sheet: ${path.join(resolvedRoot, "kit", "cue-sheet.html")}`);
    expect(stdout).toContain("Open cue sheet: python3 -m webbrowser -t file://");
    expect(stdout).toContain("To record: profile-clip-01");
    expect(stdout).toContain("Next clip:");
    expect(stdout).toContain(transcripts[0]);
    expect(stdout).toContain("Record all missing + check:");
    expect(stdout).toContain("--record-missing-until-complete");
    expect(stdout).toContain("--auto-duration");
    expect(stdout).toContain("--check");
    expect(stdout).toContain("Record + product proof + LoRA handoff:");
    expect(stdout).toContain("--prepare-lora-after-product-proof");
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("selects only the next missing clip when requested", async () => {
    const manifest = await writeManifest();
    const env = {
      ...process.env,
      ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
    };

    const first = await execFileAsync(
      python,
      [
        script,
        "--manifest",
        manifest,
        "--preflight",
        "--next-missing",
      ],
      { env },
    );
    const firstPayload = JSON.parse(first.stdout);
    expect(firstPayload.status).toBe("ready_to_record");
    expect(firstPayload.selection).toMatchObject({
      mode: "next_missing",
      requestedClips: 5,
      selectedClips: 1,
      selectedClipIds: ["profile-clip-01"],
    });
    expect(firstPayload.summary).toMatchObject({ clips: 1, existing: 0, toRecord: 1 });
    expect(firstPayload.clips).toHaveLength(1);
    expect(firstPayload.clips[0].id).toBe("profile-clip-01");
    expect(firstPayload.nextCommands.recordNextMissing).toContain("--next-missing");
    expect(firstPayload.nextCommands.recordNextMissing).toContain("--write-metadata");
    expect(firstPayload.nextCommands.recordNextMissing).toContain("--check-selected");
    expect(firstPayload.nextCommands.recordMissingUntilComplete).toContain("--record-missing-until-complete");
    expect(firstPayload.nextCommands.recordMissingUntilComplete).toContain("--check");

    await writeFile(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"), wavBuffer(7));

    const second = await execFileAsync(
      python,
      [
        script,
        "--manifest",
        manifest,
        "--preflight",
        "--next-missing",
      ],
      { env },
    );
    const secondPayload = JSON.parse(second.stdout);
    expect(secondPayload.summary).toMatchObject({ clips: 1, existing: 0, toRecord: 1 });
    expect(secondPayload.selection).toMatchObject({
      selectedClips: 1,
      selectedClipIds: ["profile-clip-02"],
    });
    expect(secondPayload.clips[0].id).toBe("profile-clip-02");
  });

  it("blocks out-of-gate target durations before recorder setup", async () => {
    const manifest = await writeManifest();

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--preflight",
      "--duration-sec",
      "2",
    ])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--duration-sec must be between 6 and 20"),
    });
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks preflight when prompt files drift from the manifest transcript", async () => {
    const manifest = await writeManifest();
    const promptsDir = path.join(tmpRoot, "kit", "prompts");
    await mkdir(promptsDir, { recursive: true });
    for (let index = 0; index < transcripts.length; index += 1) {
      const suffix = String(index + 1).padStart(2, "0");
      const prompt = index === 0 ? "今天是二零二六年五月十九日，我會用自然的速度，把每一句話清楚地讀完。" : transcripts[index];
      await writeFile(path.join(promptsDir, `profile-clip-${suffix}.txt`), `${prompt}\n`, "utf-8");
    }

    await expect(
      execFileAsync(
        python,
        [
          script,
          "--manifest",
          manifest,
          "--preflight",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("prompt files do not match"),
    });
    try {
      await execFileAsync(
        python,
        [
          script,
          "--manifest",
          manifest,
          "--preflight",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
          },
        },
      );
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.summary).toMatchObject({ promptBlocked: 1 });
      expect(payload.clips[0]).toMatchObject({
        promptExists: true,
        promptErrors: ["prompt_transcript_mismatch"],
      });
    }
  });

  it("blocks rehearsal when prompt files drift from the manifest transcript", async () => {
    const manifest = await writeManifest();
    const promptsDir = path.join(tmpRoot, "kit", "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(path.join(promptsDir, "profile-clip-01.txt"), "今天是二零二六年五月十九日。\n", "utf-8");

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--rehearse",
      "--no-default-recorder",
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("prompt files do not match"),
    });
  });

  it("blocks rehearsal before cue-sheet use when transcripts are Simplified or mixed Chinese", async () => {
    const manifest = await writeMixedScriptManifest();

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--rehearse",
      "--no-default-recorder",
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("Simplified or mixed Chinese"),
    });
    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--rehearse",
        "--no-default-recorder",
      ]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.summary).toMatchObject({ transcriptBlocked: 1 });
      expect(payload.clips[0]).toMatchObject({
        transcriptScript: "mixed_zh",
        transcriptErrors: ["invalid_chinese_script"],
      });
    }
  });

  it("blocks preflight before recording Simplified or mixed Chinese transcripts", async () => {
    const manifest = await writeMixedScriptManifest();

    await expect(
      execFileAsync(
        python,
        [
          script,
          "--manifest",
          manifest,
          "--preflight",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("Simplified or mixed Chinese"),
    });
    try {
      await execFileAsync(
        python,
        [
          script,
          "--manifest",
          manifest,
          "--preflight",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
          },
        },
      );
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.summary).toMatchObject({ transcriptBlocked: 1, toRecord: 5 });
      expect(payload.clips[0]).toMatchObject({
        transcriptScript: "mixed_zh",
        transcriptErrors: ["invalid_chinese_script"],
        scriptMarkerHits: expect.arrayContaining([
          expect.objectContaining({ simplified: "这", simplifiedCount: 1 }),
          expect.objectContaining({ traditional: "聲", traditionalCount: 1 }),
        ]),
      });
    }
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks preflight before recording Chinese transcripts without Traditional marker evidence", async () => {
    const manifest = await writeUnprovenScriptManifest();

    await expect(
      execFileAsync(
        python,
        [
          script,
          "--manifest",
          manifest,
          "--preflight",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("unproven_chinese_script"),
    });
    try {
      await execFileAsync(
        python,
        [
          script,
          "--manifest",
          manifest,
          "--preflight",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
          },
        },
      );
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.summary).toMatchObject({ transcriptBlocked: 1, toRecord: 5 });
      expect(payload.clips[0]).toMatchObject({
        transcriptScript: "zh_unknown",
        transcriptErrors: ["unproven_chinese_script"],
      });
    }
  });

  it("blocks preflight when recordings are missing and no recorder is configured", async () => {
    const manifest = await writeManifest();

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--preflight",
      "--no-default-recorder",
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"status": "blocked"'),
    });
  });

  it("allows preflight without a recorder when all selected clips already exist", async () => {
    const manifest = await writeManifest();
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeFile(path.join(tmpRoot, "kit", "recordings", `profile-clip-${suffix}.wav`), wavBuffer(7));
    }

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--preflight",
      "--no-default-recorder",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("all_recordings_present");
    expect(payload.summary).toMatchObject({ clips: 5, existing: 5, toRecord: 0, toSkipExisting: 5, writeBlocked: 0 });
    expect(payload.clips[0]).toMatchObject({ action: "skip_existing", exists: true });
  });

  it("blocks preflight when an existing skipped recording has stale metadata", async () => {
    const manifest = await writeManifest();
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeFile(path.join(tmpRoot, "kit", "recordings", `profile-clip-${suffix}.wav`), wavBuffer(7));
    }
    const staleTranscript = "今天是二零二六年五月十九日，我會用自然的速度，把每一句話清楚地讀完。";
    await writeFile(
      path.join(tmpRoot, "kit", "recordings", "profile-clip-02.wav.recording.json"),
      `${JSON.stringify(
        {
          id: "profile-clip-02",
          transcript: staleTranscript,
          transcriptSha256: textSha256(staleTranscript),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--preflight",
      "--no-default-recorder",
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("recording sidecars do not match"),
    });
    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--preflight",
        "--no-default-recorder",
      ]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("blocked");
      expect(payload.summary).toMatchObject({
        existing: 5,
        toRecord: 0,
        toSkipExisting: 5,
        recordingMetadataChecked: 1,
        recordingMetadataBlocked: 1,
      });
      expect(payload.clips[1]).toMatchObject({
        action: "skip_existing",
        recordingMetadataExists: true,
        recordingMetadataTranscriptSha256: textSha256(staleTranscript),
        expectedTranscriptSha256: textSha256(transcripts[1]),
        recordingMetadataErrors: expect.arrayContaining([
          "recording_metadata_transcript_mismatch",
          "recording_metadata_audio_path_missing",
          "recording_metadata_audio_hash_missing",
        ]),
      });
    }
  });

  it("shows the rendered recorder command in dry-run mode", async () => {
    const manifest = await writeManifest();
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--manifest",
        manifest,
        "--dry-run",
        "--duration-sec",
        "8",
        "--countdown-sec",
        "2",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("dry_run");
    expect(payload.countdownSec).toBe(2);
    expect(payload.recorder).toMatchObject({
      configured: true,
      source: "env:ANYVOICE_RECORDER_COMMAND",
      template: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
    });
    expect(payload.clips[0].commandPreview).toContain("fake-recorder --out");
    expect(payload.clips[0].commandPreview).toContain("--seconds 8");
    expect(payload.clips[0].commandPreview).toContain("--clip profile-clip-01");
    expect(payload.nextCommands.record).toContain("--countdown-sec 2");
    expect(payload.nextCommands.record).toContain("--write-metadata");
    expect(payload.nextCommands.recordNextMissing).toContain("--next-missing");
    expect(payload.nextCommands.recordNextMissing).toContain("--open-cue-sheet");
    expect(payload.nextCommands.recordNextMissing).toContain("--check-selected");
    expect(payload.nextCommands.recordMissingUntilComplete).toContain("--record-missing-until-complete");
    expect(payload.nextCommands.recordMissingUntilComplete).toContain("--open-cue-sheet");
    expect(payload.nextCommands.recordMissingUntilComplete).toContain("--check");
    expect(payload.nextCommands.recordAndProve).toContain("--check");
    expect(payload.nextCommands.recordAndProve).toContain("--open-cue-sheet");
    expect(payload.nextCommands.recordProveAndProductProof).toContain("--check");
    expect(payload.nextCommands.recordProveAndProductProof).toContain("--open-cue-sheet");
    expect(payload.nextCommands.recordProveProductProofAndLoraHandoff).toContain("--check");
    expect(payload.nextCommands.recordProveProductProofAndLoraHandoff).toContain("--open-cue-sheet");
  });

  it("blocks recording when --open-cue-sheet is requested but the cue sheet is missing", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder();

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--recorder-command",
      fake.command,
      "--next-missing",
      "--open-cue-sheet",
      "--duration-sec",
      "7",
      "--countdown-sec",
      "0",
      "--yes",
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("cue_sheet_open_failed"),
    });

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--recorder-command",
        fake.command,
        "--next-missing",
        "--open-cue-sheet",
        "--duration-sec",
        "7",
        "--countdown-sec",
        "0",
        "--yes",
      ]);
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.cueSheetReview).toMatchObject({
        requested: true,
        exists: false,
        status: "missing",
      });
      expect(payload.cueSheetReview.command).toContain("python3 -m webbrowser -t file://");
    }
    await expect(stat(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks a newly recorded next-missing clip without failing on other missing clips", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--recorder-command",
      fake.command,
      "--next-missing",
      "--duration-sec",
      "7",
      "--countdown-sec",
      "0",
      "--yes",
      "--write-metadata",
      "--check-selected",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("selected_recording_ready");
    expect(payload.summary).toMatchObject({ requestedClips: 1, recorded: 1, failed: 0 });
    expect(payload.checkReport.status).toBe("incomplete");
    expect(payload.selectedCheck).toMatchObject({
      ok: true,
      selectedClipIds: ["profile-clip-01"],
      failedClipIds: [],
      failures: [],
    });
    expect(payload.checkReport.summary).toMatchObject({ audioFilesPresent: 1 });
    expect((await readFile(fake.log, "utf-8")).trim()).toBe("profile-clip-01");
  });

  it("records missing clips sequentially and stops on the first failed selected check", async () => {
    const manifest = await writeManifest();
    const fakeRecorder = path.join(tmpRoot, "fake_recorder_short_second.py");
    const log = path.join(tmpRoot, "fake-recorder-short-second.log");
    await writeFile(
      fakeRecorder,
      [
        "from pathlib import Path",
        "import sys",
        "import wave",
        "",
        "audio_path = Path(sys.argv[1])",
        "duration = float(sys.argv[2])",
        "clip_id = sys.argv[3]",
        "log_path = Path(sys.argv[4])",
        "if clip_id == 'profile-clip-02':",
        "    duration = 3.0",
        "sample_rate = 8000",
        "frames = max(1, round(duration * sample_rate))",
        "audio_path.parent.mkdir(parents=True, exist_ok=True)",
        "with wave.open(str(audio_path), 'wb') as handle:",
        "    handle.setnchannels(1)",
        "    handle.setsampwidth(2)",
        "    handle.setframerate(sample_rate)",
        "    data = bytearray()",
        "    for index in range(frames):",
        "        value = 9000 if index % 2 == 0 else -9000",
        "        data.extend(int(value).to_bytes(2, 'little', signed=True))",
        "    handle.writeframes(bytes(data))",
        "with log_path.open('a', encoding='utf-8') as handle:",
        "    handle.write(clip_id + '\\n')",
        "",
      ].join("\n"),
      "utf-8",
    );

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--recorder-command",
        `${shellQuote(python)} ${shellQuote(fakeRecorder)} {audio_path} {duration} {id} ${shellQuote(log)}`,
        "--record-missing-until-complete",
        "--duration-sec",
        "7",
        "--countdown-sec",
        "0",
        "--yes",
        "--write-metadata",
        "--check",
      ]);
      throw new Error("expected selected check failure");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(5);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("selected_check_failed");
      expect(payload.selection).toMatchObject({
        mode: "record_missing_until_complete",
        selectedClips: 5,
      });
      expect(payload.summary).toMatchObject({ requestedClips: 5, recorded: 2, failed: 0 });
      expect(payload.perClipChecks).toHaveLength(2);
      expect(payload.perClipChecks[0].selectedCheck).toMatchObject({ ok: true, selectedClipIds: ["profile-clip-01"] });
      expect(payload.perClipChecks[1].selectedCheck).toMatchObject({ ok: false, selectedClipIds: ["profile-clip-02"] });
      expect(payload.perClipChecks[1].selectedCheck.failures[0]).toMatchObject({
        check: "audio_duration",
        id: "profile-clip-02",
        errors: expect.arrayContaining(["audio_too_short"]),
      });
    }
    expect((await readFile(log, "utf-8")).trim().split("\n")).toEqual(["profile-clip-01", "profile-clip-02"]);
  });

  it("fails selected checks immediately for a rushed take below its prompt target", async () => {
    const manifest = await writeManifest({ durationTargets: [10] });
    const fake = await writeFakeRecorder();

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--recorder-command",
        fake.command,
        "--next-missing",
        "--duration-sec",
        "7",
        "--countdown-sec",
        "0",
        "--yes",
        "--write-metadata",
        "--check-selected",
      ]);
      throw new Error("expected selected target-duration failure");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(5);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("selected_check_failed");
      expect(payload.selectedCheck).toMatchObject({
        ok: false,
        selectedClipIds: ["profile-clip-01"],
        failedClipIds: ["profile-clip-01"],
      });
      expect(payload.selectedCheck.failures[0]).toMatchObject({
        check: "audio_target_duration",
        id: "profile-clip-01",
        errors: expect.arrayContaining(["audio_below_target_duration"]),
        durationSec: 7,
        durationTargetSec: 10,
        minTargetDurationSec: 8,
        targetDurationToleranceSec: 2,
      });
    }
  });

  it("fails selected checks immediately for clipped recording levels", async () => {
    const manifest = await writeManifest();
    const fakeRecorder = path.join(tmpRoot, "fake_recorder_clipped.py");
    const log = path.join(tmpRoot, "fake-recorder-clipped.log");
    await writeFile(
      fakeRecorder,
      [
        "from pathlib import Path",
        "import sys",
        "import wave",
        "",
        "audio_path = Path(sys.argv[1])",
        "duration = float(sys.argv[2])",
        "clip_id = sys.argv[3]",
        "log_path = Path(sys.argv[4])",
        "sample_rate = 8000",
        "frames = max(1, round(duration * sample_rate))",
        "audio_path.parent.mkdir(parents=True, exist_ok=True)",
        "with wave.open(str(audio_path), 'wb') as handle:",
        "    handle.setnchannels(1)",
        "    handle.setsampwidth(2)",
        "    handle.setframerate(sample_rate)",
        "    data = bytearray()",
        "    for index in range(frames):",
        "        value = 32767 if index % 2 == 0 else -32767",
        "        data.extend(int(value).to_bytes(2, 'little', signed=True))",
        "    handle.writeframes(bytes(data))",
        "with log_path.open('a', encoding='utf-8') as handle:",
        "    handle.write(clip_id + '\\n')",
        "",
      ].join("\n"),
      "utf-8",
    );

    try {
      await execFileAsync(python, [
        script,
        "--manifest",
        manifest,
        "--recorder-command",
        `${shellQuote(python)} ${shellQuote(fakeRecorder)} {audio_path} {duration} {id} ${shellQuote(log)}`,
        "--next-missing",
        "--duration-sec",
        "7",
        "--countdown-sec",
        "0",
        "--yes",
        "--write-metadata",
        "--check-selected",
      ]);
      throw new Error("expected selected level-quality failure");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(5);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.status).toBe("selected_check_failed");
      expect(payload.selectedCheck).toMatchObject({
        ok: false,
        selectedClipIds: ["profile-clip-01"],
        failedClipIds: ["profile-clip-01"],
      });
      expect(payload.selectedCheck.failures[0]).toMatchObject({
        check: "audio_level_quality",
        id: "profile-clip-01",
        errors: expect.arrayContaining(["audio_clipping_detected"]),
        minPeakAmplitude: 0.05,
        maxClippingRatio: 0.001,
      });
      expect(payload.selectedCheck.failures[0].audioLevelQuality.peakAmplitude).toBeGreaterThan(0.99);
    }
    expect((await readFile(log, "utf-8")).trim()).toBe("profile-clip-01");
  });

  it("records all missing clips with a recorder template and verifies the kit", async () => {
    const manifest = await writeManifest();
    const fake = await writeFakeRecorder();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--recorder-command",
      fake.command,
      "--record-missing-until-complete",
      "--duration-sec",
      "7",
      "--countdown-sec",
      "0",
      "--yes",
      "--write-metadata",
      "--check",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_to_import");
    expect(payload.summary).toMatchObject({ requestedClips: 5, recorded: 5, skippedExisting: 0, failed: 0 });
    expect(payload.perClipChecks).toHaveLength(5);
    expect(payload.perClipChecks[4].selectedCheck).toMatchObject({ ok: true, selectedClipIds: ["profile-clip-05"] });
    expect(payload.checkReport.status).toBe("ready_to_import");
    expect(payload.checkReport.summary).toMatchObject({
      audioFilesPresent: 5,
      audioFilesWithinDuration: 5,
      audioFilesWithActiveVoice: 5,
      recordingMetadataChecked: 5,
      missingCoverageFeatures: [],
      missingPronunciationPresetIds: [],
    });
    const resolvedRoot = await realpath(tmpRoot);
    expect(payload.results[0].recordingMetadataPath).toBe(
      path.join(resolvedRoot, "kit", "recordings", "profile-clip-01.wav.recording.json"),
    );
    const sidecar = JSON.parse(
      await readFile(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav.recording.json"), "utf-8"),
    );
    const audioPath = path.join(resolvedRoot, "kit", "recordings", "profile-clip-01.wav");
    expect(sidecar).toMatchObject({
      id: "profile-clip-01",
      audioPath,
      audioBytes: expect.any(Number),
      audioSha256: await fileSha256(audioPath),
      transcript: transcripts[0],
      transcriptSha256: textSha256(transcripts[0]),
      pronunciationPresetIds: [],
      durationTargetSec: 7,
    });
    expect((await readFile(fake.log, "utf-8")).trim().split("\n")).toEqual([
      "profile-clip-01",
      "profile-clip-02",
      "profile-clip-03",
      "profile-clip-04",
      "profile-clip-05",
    ]);
  });

  it("can run the no-microphone proof command after a passing kit check", async () => {
    const manifest = await writeManifest();
    const fakeRecorder = await writeFakeRecorder();
    const fakeProof = await writeFakeProofCommand();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--recorder-command",
      fakeRecorder.command,
      "--duration-sec",
      "7",
      "--countdown-sec",
      "0",
      "--yes",
      "--write-metadata",
      "--run-proof-after-check",
      "--proof-command",
      fakeProof.command,
    ]);

    const payload = JSON.parse(stdout);
    const resolvedRoot = await realpath(tmpRoot);
    expect(payload.status).toBe("proof_ready");
    expect(payload.checkReport.status).toBe("ready_to_import");
    expect(payload.proofRun).toMatchObject({
      status: "passed",
      exitCode: 0,
      stdout: {
        status: "ready_for_lora_dataset",
        manifest: path.join(resolvedRoot, "kit", "manifest.json"),
        profileId: "local-default",
        profileJson: path.join(process.cwd(), ".anyvoice", "voices", "local-default", "profile.json"),
        recordCountdownSec: 0,
      },
    });
    expect(payload.proofRun.command).toContain("fake_proof.py");
    const proofLog = JSON.parse((await readFile(fakeProof.log, "utf-8")).trim());
    expect(proofLog).toMatchObject(payload.proofRun.stdout);
  });

  it("runs proof against existing recordings without requiring a recorder backend", async () => {
    const manifest = await writeManifest();
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeFile(path.join(tmpRoot, "kit", "recordings", `profile-clip-${suffix}.wav`), wavBuffer(7));
    }
    const fakeProof = await writeFakeProofCommand();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--no-default-recorder",
      "--check",
      "--run-proof-after-check",
      "--proof-command",
      fakeProof.command,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("proof_ready");
    expect(payload.recorder).toMatchObject({ configured: false, source: "disabled" });
    expect(payload.summary).toMatchObject({ requestedClips: 5, recorded: 0, skippedExisting: 5, failed: 0 });
    expect(payload.checkReport.status).toBe("ready_to_import");
    expect(payload.proofRun).toMatchObject({ status: "passed", exitCode: 0 });
  });

  it("can continue into the stricter product proof after the normal proof passes", async () => {
    const manifest = await writeManifest();
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeFile(path.join(tmpRoot, "kit", "recordings", `profile-clip-${suffix}.wav`), wavBuffer(7));
    }
    const fakeProof = await writeFakeProofCommand();
    const fakeProductProof = await writeFakeProductProofCommand();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--no-default-recorder",
      "--run-product-proof-after-check",
      "--proof-command",
      fakeProof.command,
      "--product-proof-command",
      fakeProductProof.command,
    ]);

    const payload = JSON.parse(stdout);
    const resolvedRoot = await realpath(tmpRoot);
    expect(payload.status).toBe("product_proof_ready");
    expect(payload.proofRun).toMatchObject({ status: "passed", exitCode: 0 });
    expect(payload.productProofRun).toMatchObject({
      status: "passed",
      exitCode: 0,
      stdout: {
        status: "product_proof_pass",
        manifest: path.join(resolvedRoot, "kit", "manifest.json"),
        profileId: "local-default",
        pairedImprovement: "required",
        speakerBackend: "speechbrain-ecapa",
      },
    });
    expect(payload.nextCommands.recordProveAndProductProof).toContain("--run-product-proof-after-check");
  });

  it("can export the LoRA handoff after the stricter product proof passes", async () => {
    const manifest = await writeManifest();
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeFile(path.join(tmpRoot, "kit", "recordings", `profile-clip-${suffix}.wav`), wavBuffer(7));
    }
    const fakeProof = await writeFakeProofCommand();
    const fakeProductProof = await writeFakeProductProofCommand();
    const fakeLora = await writeFakeLoraDatasetCommand();
    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--no-default-recorder",
      "--prepare-lora-after-product-proof",
      "--proof-command",
      fakeProof.command,
      "--product-proof-command",
      fakeProductProof.command,
      "--lora-dataset-command",
      fakeLora.command,
    ]);

    const payload = JSON.parse(stdout);
    const resolvedRoot = await realpath(tmpRoot);
    expect(payload.status).toBe("lora_handoff_ready");
    expect(payload.productProofRun).toMatchObject({ status: "passed", exitCode: 0 });
    expect(payload.loraDatasetRun).toMatchObject({
      status: "passed",
      exitCode: 0,
      stdout: {
        status: "written",
        manifest: path.join(resolvedRoot, "kit", "manifest.json"),
        profileId: "local-default",
        datasetJson: path.join(resolvedRoot, "kit", "lora-dataset", "dataset.json"),
      },
    });
    expect(payload.nextCommands.recordProveProductProofAndLoraHandoff).toContain("--prepare-lora-after-product-proof");
  });

  it("skips non-empty existing recordings unless overwrite is requested", async () => {
    const manifest = await writeManifest();
    await writeFile(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"), wavBuffer(7));
    const fake = await writeFakeRecorder();

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--recorder-command",
      fake.command,
      "--duration-sec",
      "8",
      "--countdown-sec",
      "0",
      "--yes",
      "--check",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_to_import");
    expect(payload.summary).toMatchObject({ requestedClips: 5, recorded: 4, skippedExisting: 1, failed: 0 });
    expect(payload.results[0]).toMatchObject({ id: "profile-clip-01", status: "skipped_existing" });
    expect((await readFile(fake.log, "utf-8")).trim().split("\n")).toEqual([
      "profile-clip-02",
      "profile-clip-03",
      "profile-clip-04",
      "profile-clip-05",
    ]);
  });

  it("blocks recording when no recorder command is configured", async () => {
    const manifest = await writeManifest();

    await expect(execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--no-default-recorder",
      "--yes",
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"status": "blocked"'),
    });
  });
});
