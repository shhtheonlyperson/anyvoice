# comfyui-anyvoice

AnyVoice 的 ComfyUI 節點包：貼上 YouTube 連結、上傳音訊檔案，或直接對麥克風
錄音 → 擷取參考音訊與繁體逐字稿 → 建立聲音設定檔 → 用 VoxCPM2 合成聲音複製。
A ComfyUI node pack that ports AnyVoice's "create a voice clone" user journey
into graph workflows, with three entry points: a YouTube link, an audio file
(mp3 / m4a / wav / flac / mp4 audio track), or a direct mic recording.

The nodes are thin wrappers around the same contracts the AnyVoice web app
uses (`yt-dlp` section download, caption/ASR segment planning, the strict
Traditional-Chinese transcript gate, `analyze_voice_reference.py` grading,
VoxCPM2 hot worker / one-shot bridge) and write the same `.anyvoice/runs` +
`.anyvoice/voices` artifacts — a profile enrolled in ComfyUI shows up in the
AnyVoice web app, and vice versa.

## Nodes

| Node | Does |
| --- | --- |
| **AnyVoice YouTube Import** | Parse URL (`t=` param sets the start), download a 30–300s audio section + subtitles via yt-dlp, chunk into 6–18s caption-aligned clips (Whisper ASR fallback), convert transcripts with OpenCC s2twp, gate out non-zh-Hant clips, slice 16k mono wavs |
| **AnyVoice Reference From Audio** | Bridge any `AUDIO` (core **Load Audio** file upload — mp3/m4a/wav/flac/mp4 audio track — or **Record Audio** mic take) into gated reference clips: a typed zh-Hant transcript covers a short (≤20s) clip; longer audio is auto-chunked + Whisper-transcribed like the no-captions YouTube fallback |
| **AnyVoice Clips Preview** | Audition extracted clips (single or all-in-sequence) and read transcripts |
| **AnyVoice Enroll Profile** | Grade each clip A–D with the AnyVoice analyzer, enroll passing clips as tagged run dirs, write `meta.json` + `profile.json` (imported tier: ≥1 A/B clip) |
| **AnyVoice Voice Clone (VoxCPM2)** | Pick the best reference clip, synthesize target text via the hot worker (`ANYVOICE_HOT_WORKER_URL`, NDJSON progress) or the one-shot bridge; quality presets speed/balanced/quality, stability seed 1337, clone modes hifi/prompt |

Custom types: `ANYVOICE_CLIPS` (extracted clips), `ANYVOICE_PROFILE` (enrolled
profile). Final audio is a standard `AUDIO` — preview/save with core nodes.

## Install

```bash
# 1. Link the pack into ComfyUI (the pack must stay inside the anyvoice repo —
#    it resolves the repo's scripts/ and .env.local relative to itself)
ln -s /Users/shh/proj/anyvoice/comfyui-anyvoice \
      <ComfyUI>/custom_nodes/comfyui-anyvoice

# 2. Install the pack's Python deps into the ComfyUI venv
<comfyui-python> -m pip install -r /Users/shh/proj/anyvoice/comfyui-anyvoice/requirements.txt

# 3. Restart ComfyUI; load the template "AnyVoice Voice Clone"
#    (Workflow → Browse Templates → comfyui-anyvoice)
```

External requirements (same as the web app): `yt-dlp`, `ffmpeg`, and the
VoxCPM Python env (`ANYVOICE_VOXCPM_PYTHON`, falls back to
`../shh-voxcpm-service/.venv`, then `../brenda-voice/.venv-voxcpm`).
Configuration is read from process env first,
then the repo's `.env.local` (`ANYVOICE_YTDLP`, `ANYVOICE_FFMPEG`,
`ANYVOICE_HOT_WORKER_URL`, `ANYVOICE_RUNS_DIR`, `ANYVOICE_VOICE_PROFILE_ROOT`,
`ANYVOICE_ASR_PYTHON`, `ANYVOICE_ASR_MODEL`, `ANYVOICE_MODEL_ID`).

For fast synthesis keep the hot worker running:

```bash
/Users/shh/proj/shh-voxcpm-service/.venv/bin/python \
  scripts/voxcpm_hot_worker_anyvoice.py --host 127.0.0.1 --port 8765
```

## The journeys

One template, three sources, one shared pipeline (consent → clips → grade/enroll → clone).
The template uses lazy ComfyUI switches, so Queue evaluates only the selected
source branch:

- Default: YouTube (`Use uploaded audio = false`, `Use recording = false`)
- Audio file: set `Use uploaded audio` to true and keep `Use recording` false
- Direct recording: set `Use recording` to true; this overrides the other source switch

**YouTube link**
1. Paste a YouTube URL (add `&t=300` to start at 5:00) and tick **consent** —
   the same permission gate the web app enforces. 勾選 consent 表示你已確認取得
   此聲音的使用授權。
2. Queue. The import node downloads the section, plans clips from captions
   (or Whisper when there are none), converts Simplified → Traditional, and
   drops clips whose transcript isn't proven zh-Hant.
3. Listen to `section_audio` / the clips preview; the enroll node grades each
   clip (A–D) and builds the profile — `report` lists grades and rejections.
4. Type Traditional-Chinese target text into the clone node and queue again:
   the output is your voice clone. Save/preview with core audio nodes.

**Audio file**
Upload via the core Load Audio node — mp3, m4a, wav, flac, or an mp4's audio
track. For a short clip (≤20s) type its exact zh-Hant transcript and it covers
the whole clip; on longer audio the transcript covers the first 18s, or leave
it empty and the audio is auto-chunked + Whisper-transcribed (capped at the
first 300s). Typed Simplified Chinese is rejected, not converted — only ASR
output goes through OpenCC. Lossy/noisy sources may grade below the A/B bar —
the `report` output shows why a clip was rejected.

**Direct recording**
Click record on the core Record Audio node and read the default script
prefilled in the transcript box (約 12–15 秒，落在 6–20 秒甜蜜區)。If you
deviate from the script, edit the transcript to match what you actually said —
the transcript must be exact (`source_kind=scripted` marks the take as a
scripted read, like the web app's guided recording). Note: ComfyUI's recorder
uses browser-default mic processing (echo cancellation / noise suppression /
AGC) that the web app's guided flow deliberately disables — record in a quiet
room and check the analyzer grade in `report`; bad takes grade C/D and are
rejected.

## Tests

```bash
cd comfyui-anyvoice && <comfyui-python> -m pytest tests/ -q
```

Pure-logic modules (URL/VTT parsing, segment planning, script gate, artifact
layout) are tested without a ComfyUI process; analyzer/synthesis subprocesses
are stubbed.
