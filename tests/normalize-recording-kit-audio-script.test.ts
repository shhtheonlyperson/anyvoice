// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "normalize_voice_profile_recording_kit_audio.py");

let tmpRoot: string;

const transcripts = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

async function transcodeToM4a(inputWav: string, outputM4a: string): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", inputWav, outputM4a]);
    return true;
  } catch {
    return false;
  }
}

async function writeKit(): Promise<string> {
  const kitDir = path.join(tmpRoot, "kit");
  const promptsDir = path.join(kitDir, "prompts");
  await mkdir(promptsDir, { recursive: true });
  const clips = [];
  for (let index = 0; index < transcripts.length; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const id = `profile-clip-${suffix}`;
    await writeFile(path.join(promptsDir, `${id}.txt`), transcripts[index], "utf-8");
    clips.push({
      id,
      audioPath: `recordings/${id}.wav`,
      transcript: transcripts[index],
      sourceKind: "scripted",
    });
  }
  const manifest = path.join(kitDir, "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ requiredClips: 5, clips }, null, 2)}\n`, "utf-8");
  return manifest;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-kit-normalize-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("normalize_voice_profile_recording_kit_audio.py", () => {
  it("normalizes externally recorded files into manifest WAVs and writes transcript sidecars", async () => {
    const manifest = await writeKit();
    const sourceDir = path.join(tmpRoot, "phone-recordings");
    await mkdir(sourceDir, { recursive: true });

    const firstSourceWav = path.join(tmpRoot, "profile-clip-01-source.wav");
    const firstSourceM4a = path.join(sourceDir, "profile-clip-01.m4a");
    await writeFile(firstSourceWav, wavBuffer(7));
    const hasM4a = await transcodeToM4a(firstSourceWav, firstSourceM4a);
    if (hasM4a) {
      await unlink(firstSourceWav);
    } else {
      await writeFile(path.join(sourceDir, "profile-clip-01.wav"), wavBuffer(7));
    }

    for (let index = 1; index < transcripts.length; index += 1) {
      const suffix = String(index + 1).padStart(2, "0");
      await writeFile(path.join(sourceDir, `profile-clip-${suffix}.wav`), wavBuffer(7 + index));
    }

    const { stdout } = await execFileAsync(python, [
      script,
      "--manifest",
      manifest,
      "--source-dir",
      sourceDir,
      "--check",
      "--profile-id",
      "local-test",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("normalized");
    expect(payload.summary).toMatchObject({ normalized: 5, missingSources: 0, failures: 0 });
    expect(payload.checkReport.status).toBe("ready_to_import");
    const firstRow = payload.rows.find((row: { id: string }) => row.id === "profile-clip-01");
    expect(firstRow.sourceAudioPath).toContain(hasM4a ? "profile-clip-01.m4a" : "profile-clip-01.wav");
    expect(firstRow.method).toBe(hasM4a ? "convert" : "copy");

    const target = path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav");
    await expect(stat(target)).resolves.toMatchObject({ size: expect.any(Number) });
    const metadata = JSON.parse(await readFile(`${target}.recording.json`, "utf-8"));
    expect(metadata).toMatchObject({
      id: "profile-clip-01",
      transcript: transcripts[0],
      transcriptSha256: sha256Text(transcripts[0]),
      normalizer: "normalize_voice_profile_recording_kit_audio.py",
    });
  });

  it("blocks when external files are missing", async () => {
    const manifest = await writeKit();
    await expect(
      execFileAsync(python, [script, "--manifest", manifest, "--source-dir", path.join(tmpRoot, "empty")]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"status": "blocked"'),
    });
  });
});
