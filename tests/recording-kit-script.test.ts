// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "prepare_voice_profile_recording_kit.py");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-recording-kit-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("prepare_voice_profile_recording_kit.py", () => {
  it("writes prompt files, a relative import manifest, and runnable instructions", async () => {
    const outDir = path.join(tmpRoot, "kit");
    const { stdout } = await execFileAsync(python, [script, "--out-dir", outDir]);
    const payload = JSON.parse(stdout);
    const resolvedOutDir = await realpath(outDir);
    expect(payload).toMatchObject({
      status: "written",
      promptSet: "standard",
      clips: 5,
      kit: resolvedOutDir,
      manifest: path.join(resolvedOutDir, "manifest.json"),
      cueSheetHtml: path.join(resolvedOutDir, "cue-sheet.html"),
      openCueSheetCommand: expect.stringContaining("python3 -m webbrowser -t file://"),
      prompts: path.join(resolvedOutDir, "prompts"),
      recordings: path.join(resolvedOutDir, "recordings"),
      summary: {
        missingCoverageFeatures: [],
        missingPronunciationPresetIds: [],
        coveredFeatures: expect.arrayContaining(["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"]),
        coveredPronunciationPresetIds: expect.arrayContaining([
          "polyphone:chongqing",
          "polyphone:bank",
          "polyphone:role",
          "polyphone:music",
          "polyphone:changle",
          "brand:anyvoice",
        ]),
      },
    });
    expect(payload.clipSpecs).toHaveLength(5);
    expect(payload.clipSpecs[0]).toMatchObject({
      id: "profile-clip-01",
      expectedStem: "profile-clip-01",
      transcript: expect.stringContaining("你好，我正在錄製一段聲音樣本"),
      recommendedDurationSec: expect.any(Number),
      durationMode: "auto",
      durationTargetSec: expect.any(Number),
      pronunciationPresetIds: [],
    });
    expect(payload.recordCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.recordCommand).toContain("--record-missing-until-complete");
    expect(payload.recordCommand).toContain("--open-cue-sheet");
    expect(payload.recordCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.recordCommand).toContain("--check");
    expect(payload.recordCommand).toContain("--profile-id local-default");
    expect(payload.recordCommand).toContain("--auto-duration");
    expect(payload.recordMissingUntilCompleteCommand).toContain("--record-missing-until-complete");
    expect(payload.recordMissingUntilCompleteCommand).toContain("--open-cue-sheet");
    expect(payload.recordMissingUntilCompleteCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.recordMissingUntilCompleteCommand).toContain("--check");
    expect(payload.recordMissingUntilCompleteCommand).toContain("--auto-duration");
    expect(payload.recordNextMissingCommand).toContain("--next-missing");
    expect(payload.recordNextMissingCommand).toContain("--open-cue-sheet");
    expect(payload.recordNextMissingCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.recordNextMissingCommand).toContain("--check-selected");
    expect(payload.recordNextMissingCommand).toContain("--auto-duration");
    expect(payload.recordAllCommand).toContain("--check");
    expect(payload.recordAllCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.recordAllCommand).toContain("--auto-duration");
    expect(payload.recordAllCommand).not.toContain("--next-missing");
    expect(payload.recordAllCommand).not.toContain("--record-missing-until-complete");
    expect(payload.preflightBriefCommand).toContain("--preflight");
    expect(payload.preflightBriefCommand).toContain("--brief");
    expect(payload.preflightBriefCommand).toContain("--auto-duration");
    expect(payload.recordAndProveCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.recordAndProveCommand).toContain("--record-missing-until-complete");
    expect(payload.recordAndProveCommand).toContain("--open-cue-sheet");
    expect(payload.recordAndProveCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.recordAndProveCommand).toContain("--auto-duration");
    expect(payload.recordAndProveCommand).toContain("--run-proof-after-check");
    expect(payload.recordProveAndProductProofCommand).toContain("--run-product-proof-after-check");
    expect(payload.recordProveAndProductProofCommand).toContain("--open-cue-sheet");
    expect(payload.recordProveAndProductProofCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.recordProveAndProductProofCommand).toContain("--auto-duration");
    expect(payload.recordProveProductProofAndLoraCommand).toContain("--prepare-lora-after-product-proof");
    expect(payload.recordProveProductProofAndLoraCommand).toContain("--open-cue-sheet");
    expect(payload.recordProveProductProofAndLoraCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.recordProveProductProofAndLoraCommand).toContain("--auto-duration");
    expect(payload.rehearseCommand).toContain("--rehearse");
    expect(payload.rehearseCommand).toContain("--no-default-recorder");
    expect(payload.rehearseCommand).toContain("--auto-duration");
    expect(payload.rehearseCommand).toContain("--profile-id local-default");
    expect(payload.checkCommand).toContain("scripts/check_voice_profile_recording_kit.py");
    expect(payload.checkCommand).toContain("--profile-id local-default");
    expect(payload.enrollCommand).toContain("scripts/enroll_voice_profile_kit.py");
    expect(payload.enrollCommand).toContain("--profile-id local-default");
    expect(payload.proofCommand).toContain("scripts/voice_profile_next_step.py");
    expect(payload.proofCommand).toContain("--allow-enroll --allow-expensive");
    expect(payload.proofCommand).toContain("--stop-before-lora");
    expect(payload.proofCommand).not.toContain("--allow-recording");

    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({
      promptSet: "standard",
      requiredClips: 5,
    });
    expect(manifest.clips).toHaveLength(5);
    expect(manifest.clips[0]).toMatchObject({
      id: "profile-clip-01",
      audioPath: "recordings/profile-clip-01.wav",
      transcriptScript: "zh_hant",
      recommendedDurationSec: expect.any(Number),
      durationMode: "auto",
      durationTargetSec: expect.any(Number),
      coverageFeatures: expect.arrayContaining(["zh_hant"]),
      pronunciationPresetIds: [],
      sourceKind: "scripted",
    });
    expect(manifest.clips[0].transcript).toContain("你好，我正在錄製一段聲音樣本");
    expect(manifest.clips[1].transcript).toContain("日期範例是二零二六年五月二十日");
    expect(manifest.clips[1].transcript).not.toContain("今天是");
    expect(manifest.clips[2].pronunciationNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Brenda"),
        expect.stringContaining("AnyVoice"),
        expect.stringContaining("台北"),
        expect.stringContaining("紐約"),
        expect.stringContaining("重慶"),
        expect.stringContaining("銀行"),
        expect.stringContaining("長樂"),
      ]),
    );
    expect(manifest.clips[2].pronunciationPresetIds).toEqual(
      expect.arrayContaining([
        "polyphone:chongqing",
        "polyphone:bank",
        "polyphone:role",
        "polyphone:music",
        "polyphone:changle",
        "brand:anyvoice",
      ]),
    );
    await expect(stat(path.join(outDir, "prompts", "profile-clip-01.txt"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(path.join(outDir, "recordings", ".gitkeep"))).resolves.toMatchObject({ size: 0 });
    const readme = await readFile(path.join(outDir, "README.md"), "utf-8");
    const cueSheet = await readFile(path.join(outDir, "cue-sheet.html"), "utf-8");
    expect(cueSheet).toContain("<title>AnyVoice recording cue sheet - local-default</title>");
    expect(cueSheet).toContain("profile-clip-03");
    expect(cueSheet).toContain("如果遇到重要名字");
    expect(cueSheet).toContain("重慶: ㄔㄨㄥˊ ㄑㄧㄥˋ / chong2 qing4");
    expect(cueSheet).toContain("台北: ㄊㄞˊ ㄅㄟˇ / tai2 bei3");
    expect(cueSheet).toContain("紐約: ㄋㄧㄡˇ ㄩㄝ / niu3 yue1");
    expect(cueSheet).toContain("Pronunciation notes are rehearsal guidance only");
    expect(cueSheet).toContain("Target ");
    expect(cueSheet).toContain("After recording proof");
    expect(cueSheet).toContain("--record-missing-until-complete");
    expect(cueSheet).toContain("--auto-duration");
    expect(cueSheet).toContain("--next-missing");
    expect(cueSheet).toContain("--check-selected");
    expect(cueSheet).toContain("--stop-before-lora");
    expect(cueSheet).toContain("--run-proof-after-check");
    expect(cueSheet).toContain("--run-product-proof-after-check");
    expect(cueSheet).toContain("--prepare-lora-after-product-proof");
    expect(readme).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(readme).toContain("record all missing clips");
    expect(readme).toContain("--record-missing-until-complete");
    expect(readme).toContain("--auto-duration");
    expect(readme).toContain("Auto-duration targets:");
    expect(readme).toContain("recommendedDurationSec");
    expect(readme).toContain("--next-missing");
    expect(readme).toContain("--check-selected");
    expect(readme).toContain("--preflight --brief");
    expect(readme).toContain("cue-sheet.html");
    expect(readme).toContain("python3 -m webbrowser -t file://");
    expect(readme).toContain("--rehearse");
    expect(readme).toContain("--run-proof-after-check");
    expect(readme).toContain("--run-product-proof-after-check");
    expect(readme).toContain("--prepare-lora-after-product-proof");
    expect(readme).toContain("scripts/voice_profile_next_step.py");
    expect(readme).toContain("--stop-before-lora");
    expect(readme).toContain("scripts/enroll_voice_profile_kit.py");
    expect(readme).toContain("scripts/check_voice_profile_recording_kit.py");
    expect(readme).toContain("scripts/import_voice_profile_clips.py");
    expect(readme).toContain("verify_voice_profile_ready.py");
    expect(readme).toContain("Pronunciation notes are cue-sheet guidance only");
  });

  it("can generate a custom kit from a small prompt manifest", async () => {
    const promptManifest = path.join(tmpRoot, "prompts.json");
    const outDir = path.join(tmpRoot, "custom-kit");
    await writeFile(
      promptManifest,
      `${JSON.stringify({ clips: [{ transcript: "請用繁體中文錄製第一段。" }, { transcript: "AnyVoice 第二段錄音。" }] }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--prompt-manifest",
      promptManifest,
      "--out-dir",
      outDir,
      "--audio-extension",
      "m4a",
    ]);

    const payload = JSON.parse(stdout);
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({
      promptSet: "custom",
      requiredClips: 2,
    });
    expect(manifest.clips).toHaveLength(2);
    expect(payload.promptSet).toBe("custom");
    expect(manifest.clips[1]).toMatchObject({
      id: "profile-clip-02",
      audioPath: "recordings/profile-clip-02.m4a",
      transcript: "AnyVoice 第二段錄音。",
      transcriptScript: "zh_hant",
      coverageFeatures: ["latin_terms", "zh_hant"],
      pronunciationPresetIds: ["brand:anyvoice"],
      pronunciationNotes: [expect.stringContaining("AnyVoice")],
    });
  });

  it("can generate the extended 10-clip stability kit", async () => {
    const outDir = path.join(tmpRoot, "extended-kit");
    const { stdout } = await execFileAsync(python, [script, "--prompt-set", "extended", "--out-dir", outDir]);
    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "written",
      promptSet: "extended",
      clips: 10,
      summary: {
        missingCoverageFeatures: [],
        missingPronunciationPresetIds: [],
        coveredFeatures: expect.arrayContaining(["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"]),
        coveredPronunciationPresetIds: expect.arrayContaining([
          "polyphone:chongqing",
          "polyphone:bank",
          "polyphone:role",
          "polyphone:music",
          "polyphone:changle",
          "polyphone:bank-president",
          "brand:anyvoice",
          "brand:voxcpm2",
        ]),
      },
    });
    expect(payload.clipSpecs).toHaveLength(10);
    expect(payload.clipSpecs[9]).toMatchObject({ id: "profile-clip-10", expectedStem: "profile-clip-10" });
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({
      promptSet: "extended",
      requiredClips: 10,
    });
    expect(manifest.clips).toHaveLength(10);
    expect(manifest.clips[9]).toMatchObject({
      id: "profile-clip-10",
      audioPath: "recordings/profile-clip-10.wav",
      transcriptScript: "zh_hant",
      sourceKind: "scripted",
    });
    expect(manifest.clips[7].transcript).toContain("OpenAI");
    expect(manifest.clips[7].pronunciationNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("OpenAI"),
        expect.stringContaining("Mac Studio"),
        expect.stringContaining("VoxCPM2"),
        expect.stringContaining("TestFlight"),
      ]),
    );
    expect(manifest.clips[8].pronunciationNotes).toEqual(expect.arrayContaining([expect.stringContaining("行長")]));
    expect(manifest.clips[8].pronunciationPresetIds).toEqual(expect.arrayContaining(["polyphone:bank-president"]));
    const readme = await readFile(path.join(outDir, "README.md"), "utf-8");
    const cueSheet = await readFile(path.join(outDir, "cue-sheet.html"), "utf-8");
    expect(readme).toContain("Prompt set: `extended` (10 clips)");
    expect(cueSheet).toContain("OpenAI: read as English Open A I");
    expect(cueSheet).toContain("VoxCPM2: read as Vox C P M two");
    expect(cueSheet).toContain("After all 10 WAV files exist");
  });

  it("rejects Simplified or mixed Chinese prompt manifests before creating a kit", async () => {
    const promptManifest = path.join(tmpRoot, "mixed-prompts.json");
    const outDir = path.join(tmpRoot, "blocked-kit");
    await writeFile(
      promptManifest,
      `${JSON.stringify({ clips: [{ transcript: "这个聲音要穩定，請保持自然。" }] }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--prompt-manifest",
        promptManifest,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("must use Traditional Chinese before recording"),
    });
    await expect(stat(path.join(outDir, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects Chinese prompts without clear Traditional marker evidence before recording", async () => {
    const promptManifest = path.join(tmpRoot, "unproven-prompts.json");
    const outDir = path.join(tmpRoot, "unproven-kit");
    await writeFile(
      promptManifest,
      `${JSON.stringify({ clips: [{ transcript: "中文聲音要自然。".replace("聲", "音") }] }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--prompt-manifest",
        promptManifest,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unproven_chinese_script"),
    });
    await expect(stat(path.join(outDir, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
