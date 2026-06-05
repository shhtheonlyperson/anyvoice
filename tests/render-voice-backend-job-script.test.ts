// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "render_voice_backend_job.py");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-render-backend-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeInputs(): Promise<{
  targetText: string;
  reference: string;
  prompt: string;
  textPrep: string;
  output: string;
}> {
  await mkdir(tmpRoot, { recursive: true });
  const targetText = path.join(tmpRoot, "target.txt");
  const reference = path.join(tmpRoot, "reference.wav");
  const prompt = path.join(tmpRoot, "prompt.txt");
  const textPrep = path.join(tmpRoot, "text-prep.json");
  const output = path.join(tmpRoot, "output.wav");
  await writeFile(targetText, "請用穩定的聲音說這一句。\n", "utf-8");
  await writeFile(reference, Buffer.from("RIFF-reference"));
  await writeFile(prompt, "這是參考音逐字稿。\n", "utf-8");
  await writeFile(textPrep, `${JSON.stringify({ version: 1 }, null, 2)}\n`, "utf-8");
  return { targetText, reference, prompt, textPrep, output };
}

async function writeFakePython(): Promise<string> {
  const fakePython = path.join(tmpRoot, "fake-python.sh");
  await writeFile(
    fakePython,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
metadata=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"; shift 2 ;;
    --metadata-output)
      metadata="$2"; shift 2 ;;
    *)
      shift ;;
  esac
done
if [[ -z "$out" ]]; then
  echo "missing --output" >&2
  exit 2
fi
mkdir -p "$(dirname "$out")"
printf "RIFFfake" > "$out"
if [[ -n "$metadata" ]]; then
  mkdir -p "$(dirname "$metadata")"
  printf '{"fake":true}\\n' > "$metadata"
fi
`,
    "utf-8",
  );
  await chmod(fakePython, 0o755);
  return fakePython;
}

async function writeFakeMlxAudioCli(): Promise<string> {
  const fakeCli = path.join(tmpRoot, "fake-mlx-audio.sh");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env bash
set -euo pipefail
out_dir=""
prefix=""
format="wav"
model=""
ref_audio=""
ref_text=""
text=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output_path)
      out_dir="$2"; shift 2 ;;
    --file_prefix)
      prefix="$2"; shift 2 ;;
    --audio_format)
      format="$2"; shift 2 ;;
    --model)
      model="$2"; shift 2 ;;
    --ref_audio)
      ref_audio="$2"; shift 2 ;;
    --ref_text)
      ref_text="$2"; shift 2 ;;
    --text)
      text="$2"; shift 2 ;;
    *)
      shift ;;
  esac
done
if [[ -z "$out_dir" || -z "$prefix" ]]; then
  echo "missing output args" >&2
  exit 2
fi
mkdir -p "$out_dir"
printf "RIFFfish" > "$out_dir/$prefix.$format"
printf '{"model":"%s","refAudio":"%s","refText":"%s","text":"%s"}\\n' "$model" "$ref_audio" "$ref_text" "$text" >&2
`,
    "utf-8",
  );
  await chmod(fakeCli, 0o755);
  return fakeCli;
}

async function writeFakeMlxAudioCliThatSwallowsModelError(): Promise<string> {
  const fakeCli = path.join(tmpRoot, "fake-mlx-audio-error.sh");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env bash
printf "Error loading model: No codec weights found\\n"
exit 0
`,
    "utf-8",
  );
  await chmod(fakeCli, 0o755);
  return fakeCli;
}

async function writeFakeUv(): Promise<string> {
  const fakeUv = path.join(tmpRoot, "fake-uv.sh");
  await writeFile(
    fakeUv,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "run" || "$2" != "mlx-indextts" ]]; then
  echo "unexpected uv command: $*" >&2
  exit 2
fi
mode="$3"
shift 3
out=""
text=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o)
      out="$2"; shift 2 ;;
    -t)
      text="$2"; shift 2 ;;
    *)
      shift ;;
  esac
done
if [[ -z "$out" ]]; then
  echo "missing -o" >&2
  exit 2
fi
mkdir -p "$(dirname "$out")"
case "$mode" in
  speaker)
    printf "speaker-cache" > "$out" ;;
  generate)
    printf "RIFFindex:%s" "$text" > "$out" ;;
  *)
    echo "unexpected mlx-indextts mode: $mode" >&2
    exit 2 ;;
esac
`,
    "utf-8",
  );
  await chmod(fakeUv, 0o755);
  return fakeUv;
}

async function writeFakeF5TtsCli(): Promise<string> {
  const fakeCli = path.join(tmpRoot, "fake-f5-tts.sh");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env bash
set -euo pipefail
out_dir=""
out_file=""
model=""
ref_audio=""
ref_text=""
gen_text=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output_dir)
      out_dir="$2"; shift 2 ;;
    --output_file)
      out_file="$2"; shift 2 ;;
    --model)
      model="$2"; shift 2 ;;
    --ref_audio)
      ref_audio="$2"; shift 2 ;;
    --ref_text)
      ref_text="$2"; shift 2 ;;
    --gen_text)
      gen_text="$2"; shift 2 ;;
    *)
      shift ;;
  esac
done
if [[ -z "$out_dir" || -z "$out_file" ]]; then
  echo "missing output args" >&2
  exit 2
fi
mkdir -p "$out_dir"
printf "RIFFf5:%s" "$gen_text" > "$out_dir/$out_file"
printf '{"model":"%s","refAudio":"%s","refText":"%s","genText":"%s"}\\n' "$model" "$ref_audio" "$ref_text" "$gen_text" >&2
`,
    "utf-8",
  );
  await chmod(fakeCli, 0o755);
  return fakeCli;
}

async function writeIndexTtsFixture(): Promise<{ hfHome: string; runtimeDir: string }> {
  const hfHome = path.join(tmpRoot, "hf-home-indextts");
  const snapshot = path.join(
    hfHome,
    "hub",
    "models--vanch007--mlx-indextts2-standard-fp16",
    "snapshots",
    "abc123",
  );
  await mkdir(snapshot, { recursive: true });
  await mkdir(path.join(hfHome, "hub", "models--vanch007--mlx-indextts2-standard-fp16", "refs"), { recursive: true });
  await writeFile(path.join(hfHome, "hub", "models--vanch007--mlx-indextts2-standard-fp16", "refs", "main"), "abc123\n", "utf-8");
  for (const name of [
    "config.yaml",
    "vq2emb.safetensors",
    "gpt.safetensors",
    "s2mel.safetensors",
    "bigvgan.safetensors",
    "tokenizer.model",
  ]) {
    await writeFile(path.join(snapshot, name), `${name}\n`, "utf-8");
  }
  const runtimeDir = path.join(tmpRoot, "mlx-indextts-runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "pyproject.toml"), "[project]\nname = \"fake-mlx-indextts\"\n", "utf-8");
  return { hfHome, runtimeDir };
}

describe("render_voice_backend_job.py", () => {
  it("renders voxcpm2-hifi jobs through the local VoxCPM command adapter", async () => {
    const inputs = await writeInputs();
    const fakePython = await writeFakePython();

    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "voxcpm2-hifi",
      "--case-id",
      "zh_hant_tone_contrast",
      "--repeat",
      "2",
      "--text-file",
      inputs.targetText,
      "--reference",
      inputs.reference,
      "--prompt",
      inputs.prompt,
      "--text-prep-file",
      inputs.textPrep,
      "--out",
      inputs.output,
      "--python",
      fakePython,
      "--hot-worker-url",
      "",
      "--seed",
      "1337",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "ready",
      backend: "voxcpm2-hifi",
      caseId: "zh_hant_tone_contrast",
      repeat: 2,
      renderer: "python",
      cloneMode: "hifi",
      stabilitySeed: 1337,
      outputExists: true,
      missingOutput: false,
      outputBytes: 8,
    });
    expect(payload.command).toContain("synthesize_voxcpm_anyvoice.py");
    expect(await readFile(inputs.output, "utf-8")).toBe("RIFFfake");
  });

  it("renders indextts2 jobs through the local mlx-indextts adapter", async () => {
    const inputs = await writeInputs();
    const fakeUv = await writeFakeUv();
    const { hfHome, runtimeDir } = await writeIndexTtsFixture();
    const runtimeDirReal = await realpath(runtimeDir);
    const metadata = path.join(tmpRoot, "index.metadata.json");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--backend",
        "indextts2",
        "--case-id",
        "zh_hant_short_identity",
        "--repeat",
        "3",
        "--text-file",
        inputs.targetText,
        "--reference",
        inputs.reference,
        "--prompt",
        inputs.prompt,
        "--out",
        inputs.output,
        "--metadata-output",
        metadata,
        "--uv",
        fakeUv,
        "--indextts-runtime-dir",
        runtimeDir,
        "--indextts-model",
        "vanch007/mlx-indextts2-standard-fp16",
      ],
      { env: { ...process.env, HF_HOME: hfHome, HUGGINGFACE_HUB_CACHE: "" } },
    );

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "ready",
      backend: "indextts2",
      caseId: "zh_hant_short_identity",
      repeat: 3,
      renderer: "mlx_indextts",
      cloneMode: "indextts2",
      externalModelId: "vanch007/mlx-indextts2-standard-fp16",
      runtimeDir: runtimeDirReal,
      outputExists: true,
      missingOutput: false,
    });
    expect(payload.speakerCommand).toContain("mlx-indextts speaker");
    expect(payload.command).toContain("mlx-indextts generate");
    expect(await readFile(inputs.output, "utf-8")).toContain("RIFFindex:請用穩定的聲音說這一句。");
    const meta = JSON.parse(await readFile(metadata, "utf-8"));
    expect(meta).toMatchObject({
      renderer: "mlx_indextts",
      backend: "indextts2",
      model: "vanch007/mlx-indextts2-standard-fp16",
      outputExists: true,
    });
  });

  it("preflights indextts2 local adapter, uv runtime, and Hugging Face cache", async () => {
    const fakeUv = await writeFakeUv();
    const { hfHome, runtimeDir } = await writeIndexTtsFixture();

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--preflight",
        "--backend",
        "indextts2",
        "--uv",
        fakeUv,
        "--indextts-runtime-dir",
        runtimeDir,
        "--indextts-model",
        "vanch007/mlx-indextts2-standard-fp16",
      ],
      { env: { ...process.env, HF_HOME: hfHome, HUGGINGFACE_HUB_CACHE: "" } },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      version: 1,
      backend: "indextts2",
      supportedLocalAdapter: true,
      localAdapter: "mlx_indextts",
      status: "ready",
      uv: fakeUv,
      uvAvailable: true,
      runtimeDir,
      runtimeReady: true,
      modelCache: {
        modelId: "vanch007/mlx-indextts2-standard-fp16",
        status: "ready",
        indextts2Status: "ready",
      },
    });
  });

  it("renders f5-tts jobs through the official CLI adapter", async () => {
    const inputs = await writeInputs();
    const fakeCli = await writeFakeF5TtsCli();
    const metadata = path.join(tmpRoot, "f5.metadata.json");

    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "f5-tts",
      "--case-id",
      "zh_hant_tone_contrast",
      "--repeat",
      "1",
      "--text-file",
      inputs.targetText,
      "--reference",
      inputs.reference,
      "--prompt",
      inputs.prompt,
      "--out",
      inputs.output,
      "--metadata-output",
      metadata,
      "--f5-tts-command",
      fakeCli,
      "--f5-tts-device",
      "cpu",
      "--f5-tts-nfe-step",
      "8",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "ready",
      backend: "f5-tts",
      caseId: "zh_hant_tone_contrast",
      repeat: 1,
      renderer: "f5_tts_cli",
      cloneMode: "f5-tts",
      externalModelId: "SWivid/F5-TTS",
      f5Model: "F5TTS_v1_Base",
      outputExists: true,
      missingOutput: false,
    });
    expect(payload.command).toContain("--ref_audio");
    expect(payload.command).toContain("--ref_text");
    expect(await readFile(inputs.output, "utf-8")).toContain("RIFFf5:請用穩定的聲音說這一句。");
    const meta = JSON.parse(await readFile(metadata, "utf-8"));
    expect(meta).toMatchObject({
      renderer: "f5_tts_cli",
      backend: "f5-tts",
      model: "F5TTS_v1_Base",
      modelId: "SWivid/F5-TTS",
      outputExists: true,
    });
  });

  it("preflights f5-tts official CLI availability", async () => {
    const fakeCli = await writeFakeF5TtsCli();

    const { stdout } = await execFileAsync(python, [
      script,
      "--preflight",
      "--backend",
      "f5-tts",
      "--f5-tts-command",
      fakeCli,
      "--f5-tts-device",
      "cpu",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      version: 1,
      backend: "f5-tts",
      supportedLocalAdapter: true,
      localAdapter: "f5_tts_cli",
      status: "ready",
      cli: {
        available: true,
        command: [fakeCli],
      },
      model: "F5TTS_v1_Base",
      modelId: "SWivid/F5-TTS",
      device: "cpu",
    });
  });

  it("renders fishaudio-s2-pro jobs through the local mlx-audio adapter", async () => {
    const inputs = await writeInputs();
    const fakeCli = await writeFakeMlxAudioCli();
    const metadata = path.join(tmpRoot, "fish.metadata.json");

    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "fishaudio-s2-pro",
      "--case-id",
      "zh_hant_custom_readings",
      "--repeat",
      "1",
      "--text-file",
      inputs.targetText,
      "--reference",
      inputs.reference,
      "--prompt",
      inputs.prompt,
      "--out",
      inputs.output,
      "--metadata-output",
      metadata,
      "--mlx-audio-tts-generate",
      fakeCli,
      "--mlx-model",
      "fishaudio/s2-pro",
      "--lang-code",
      "zh",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "ready",
      backend: "fishaudio-s2-pro",
      caseId: "zh_hant_custom_readings",
      repeat: 1,
      renderer: "mlx_audio",
      cloneMode: "fishaudio-s2-pro",
      externalModelId: "fishaudio/s2-pro",
      languageCode: "zh",
      outputExists: true,
      missingOutput: false,
      outputBytes: 8,
    });
    expect(payload.command).toContain("--ref_audio");
    expect(payload.command).toContain("--ref_text");
    expect(await readFile(inputs.output, "utf-8")).toBe("RIFFfish");
    const meta = JSON.parse(await readFile(metadata, "utf-8"));
    expect(meta).toMatchObject({
      renderer: "mlx_audio",
      backend: "fishaudio-s2-pro",
      model: "fishaudio/s2-pro",
      outputExists: true,
    });
  });

  it("fails fishaudio-s2-pro renders when mlx-audio reports a swallowed model loading error", async () => {
    const inputs = await writeInputs();
    const fakeCli = await writeFakeMlxAudioCliThatSwallowsModelError();

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "fishaudio-s2-pro",
        "--text-file",
        inputs.targetText,
        "--reference",
        inputs.reference,
        "--prompt",
        inputs.prompt,
        "--out",
        inputs.output,
        "--mlx-audio-tts-generate",
        fakeCli,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Error loading model: No codec weights found"),
    });
  });

  it("preflights fishaudio-s2-pro local adapter, CLI, and Hugging Face cache", async () => {
    const fakeCli = await writeFakeMlxAudioCli();
    const hfHome = path.join(tmpRoot, "hf-home");
    await mkdir(path.join(hfHome, "hub", "models--fishaudio--s2-pro", "snapshots", "abc123"), { recursive: true });
    await mkdir(path.join(hfHome, "hub", "models--fishaudio--s2-pro", "refs"), { recursive: true });
    await writeFile(path.join(hfHome, "hub", "models--fishaudio--s2-pro", "refs", "main"), "abc123\n", "utf-8");
    await writeFile(path.join(hfHome, "hub", "models--fishaudio--s2-pro", "snapshots", "abc123", "config.json"), "{}\n", "utf-8");
    await writeFile(path.join(hfHome, "hub", "models--fishaudio--s2-pro", "snapshots", "abc123", "codec.safetensors"), "codec\n", "utf-8");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--preflight",
        "--backend",
        "fishaudio-s2-pro",
        "--mlx-audio-tts-generate",
        fakeCli,
        "--mlx-model",
        "fishaudio/s2-pro",
      ],
      { env: { ...process.env, HF_HOME: hfHome, HUGGINGFACE_HUB_CACHE: "" } },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      version: 1,
      backend: "fishaudio-s2-pro",
      supportedLocalAdapter: true,
      localAdapter: "mlx_audio",
      status: "ready",
      cli: { available: true, path: fakeCli },
      modelCache: {
        modelId: "fishaudio/s2-pro",
        status: "ready",
        snapshotFiles: 2,
        codecStatus: "ready",
      },
    });
  });

  it("preflights downloaded fishaudio-s2-pro PyTorch codec weights as incompatible with the MLX adapter", async () => {
    const fakeCli = await writeFakeMlxAudioCli();
    const hfHome = path.join(tmpRoot, "hf-home-pth");
    const snapshot = path.join(hfHome, "hub", "models--fishaudio--s2-pro", "snapshots", "abc123");
    await mkdir(snapshot, { recursive: true });
    await mkdir(path.join(hfHome, "hub", "models--fishaudio--s2-pro", "refs"), { recursive: true });
    await writeFile(path.join(hfHome, "hub", "models--fishaudio--s2-pro", "refs", "main"), "abc123\n", "utf-8");
    await writeFile(path.join(snapshot, "config.json"), "{}\n", "utf-8");
    await writeFile(path.join(snapshot, "codec.pth"), "codec\n", "utf-8");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--preflight",
        "--backend",
        "fishaudio-s2-pro",
        "--mlx-audio-tts-generate",
        fakeCli,
        "--mlx-model",
        "fishaudio/s2-pro",
      ],
      { env: { ...process.env, HF_HOME: hfHome, HUGGINGFACE_HUB_CACHE: "" } },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      backend: "fishaudio-s2-pro",
      status: "incompatible_model_cache",
      modelCache: {
        status: "ready",
        codecFiles: ["codec.pth"],
        codecStatus: "unsupported_codec_pth",
      },
    });
  });

  it("preflights a shootout manifest and reports backend-specific renderer blockers", async () => {
    const manifest = path.join(tmpRoot, "manifest.json");
    await writeFile(
      manifest,
      `${JSON.stringify({
        renders: [
          {
            backend: "voxcpm2-hifi",
            outputWav: path.join(tmpRoot, "voxcpm.wav"),
            commandTemplateEnv: "ANYVOICE_BACKEND_RENDER_COMMAND_VOXCPM2_HIFI",
            commandTemplateFallbackEnv: "ANYVOICE_BACKEND_RENDER_COMMAND",
          },
          {
            backend: "made-up-tts",
            outputWav: path.join(tmpRoot, "made-up.wav"),
            commandTemplateEnv: "ANYVOICE_BACKEND_RENDER_COMMAND_MADE_UP_TTS",
            commandTemplateFallbackEnv: "ANYVOICE_BACKEND_RENDER_COMMAND",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(path.join(tmpRoot, "voxcpm.wav"), Buffer.from("RIFFdone"));

    const { stdout } = await execFileAsync(
      python,
      [script, "--preflight", "--manifest", manifest],
      {
        env: {
          ...process.env,
          ANYVOICE_BACKEND_RENDER_COMMAND: "",
          ANYVOICE_BACKEND_RENDER_COMMAND_F5_TTS: "",
          ANYVOICE_BACKEND_RENDER_COMMAND_VOXCPM2_HIFI: "",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "needs_renderer_setup",
      blockingBackends: ["made-up-tts"],
    });
    expect(payload.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backend: "voxcpm2-hifi",
          status: "ready",
          renderedRenders: 1,
          missingRenders: 0,
        }),
        expect.objectContaining({
          backend: "made-up-tts",
          status: "needs_external_renderer_command",
          missingCommandTemplateEnvs: ["ANYVOICE_BACKEND_RENDER_COMMAND_MADE_UP_TTS"],
          local: expect.objectContaining({ supportedLocalAdapter: false }),
        }),
      ]),
    );
  });

  it("can skip unsupported external backends while filling local baseline renders", async () => {
    const inputs = await writeInputs();
    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "made-up-tts",
      "--case-id",
      "zh_hant_tone_contrast",
      "--repeat",
      "1",
      "--text-file",
      inputs.targetText,
      "--reference",
      inputs.reference,
      "--prompt",
      inputs.prompt,
      "--out",
      inputs.output,
      "--skip-unsupported",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "skipped",
      backend: "made-up-tts",
      reason: "unsupported_backend_requires_external_renderer",
    });
  });
});
