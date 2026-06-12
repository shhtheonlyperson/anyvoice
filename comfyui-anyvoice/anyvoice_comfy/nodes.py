"""ComfyUI nodes for the AnyVoice YouTube-link → voice-clone journey.

Graph shape (see example_workflows/):

    AnyVoiceYouTubeImport ─ clips ─→ AnyVoiceEnrollProfile ─ profile ─→ AnyVoiceVoiceClone ─ audio ─→ Preview/Save
                          └ clips ─→ AnyVoiceClipsPreview (audition the extracted reference clips)

The nodes exchange file paths and write the same .anyvoice run/profile
artifacts as the web app, so a voice cloned here is immediately usable there.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from comfy_api.latest import ComfyExtension, io

from . import env
from .comfy_audio import comfy_audio_to_wav, concat_comfy_audio, wav_to_comfy_audio
from .enroll import EnrolledClip, enroll_clips
from .reference_import import ReferenceImportError, import_audio_reference
from .synth import select_reference_clip, synthesize
from .textgate import (
    simplified_or_mixed_chinese_script_errors,
    simplified_to_traditional,
    strict_traditional_chinese_script_errors,
)
from .youtube import YoutubeImportError, import_youtube_reference, parse_youtube_url

AnyVoiceClips = io.Custom("ANYVOICE_CLIPS")
AnyVoiceProfile = io.Custom("ANYVOICE_PROFILE")

PROFILE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")

CONSENT_MESSAGE = (
    "consent is required: confirm you have permission to clone this voice "
    "(切換 consent 開關，確認你已取得此聲音的使用授權)"
)


def _progress_reporter():
    from comfy.utils import ProgressBar

    pbar = ProgressBar(100)

    def report(done: int, total: int, message: str) -> None:
        pbar.update_absolute(round(100 * done / max(1, total)))

    return report


def _check_interrupted() -> None:
    import comfy.model_management

    comfy.model_management.throw_exception_if_processing_interrupted()


class AnyVoiceYouTubeImport(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AnyVoiceYouTubeImport",
            display_name="AnyVoice YouTube Import",
            category="AnyVoice",
            description=(
                "Download a YouTube audio section (default 180s from the URL's t= "
                "param), chunk it into 6–18s reference clips aligned to captions "
                "(Whisper ASR fallback), convert transcripts to Traditional "
                "Chinese, and gate out unproven-script clips. 從 YouTube 連結擷取"
                "參考音訊與逐字稿。"
            ),
            inputs=[
                io.String.Input(
                    "url",
                    placeholder="https://www.youtube.com/watch?v=…&t=300",
                    tooltip="watch / youtu.be / shorts / embed URL; a t= param sets the scan start",
                ),
                io.Boolean.Input(
                    "consent",
                    default=False,
                    tooltip="Confirm you have permission to clone this voice (consent gate, same as the web app)",
                ),
                io.Int.Input(
                    "start_seconds",
                    default=-1,
                    min=-1,
                    max=86_400,
                    tooltip="Scan start in seconds; -1 uses the URL's t= param (or 0)",
                ),
                io.Int.Input(
                    "scan_seconds",
                    default=180,
                    min=30,
                    max=300,
                    tooltip="How much audio to scan and chunk into reference clips",
                ),
                io.String.Input(
                    "transcript_override",
                    multiline=True,
                    default="",
                    optional=True,
                    tooltip="Exact zh-Hant transcript of the section head; skips captions/ASR and imports a single clip",
                ),
                io.String.Input(
                    "asr_language",
                    default="zh",
                    optional=True,
                    tooltip="Whisper language hint for the no-captions fallback",
                ),
            ],
            outputs=[
                AnyVoiceClips.Output(display_name="clips"),
                io.Audio.Output(display_name="section_audio"),
                io.String.Output(display_name="report"),
            ],
        )

    @classmethod
    def validate_inputs(cls, url, consent):
        if url and url.strip() and parse_youtube_url(url) is None:
            return f"not a valid YouTube URL: {url}"
        if not consent:
            return CONSENT_MESSAGE
        return True

    @classmethod
    def execute(cls, url, consent, start_seconds, scan_seconds, transcript_override="", asr_language="zh") -> io.NodeOutput:
        if not consent:
            raise ValueError(CONSENT_MESSAGE)
        try:
            result = import_youtube_reference(
                url=url,
                start_seconds=start_seconds,
                scan_seconds=scan_seconds,
                transcript_override=transcript_override or "",
                language=(asr_language or "zh").strip() or "zh",
                convert_simplified=simplified_to_traditional,
                strict_script_errors=strict_traditional_chinese_script_errors,
                on_progress=_progress_reporter(),
                check_interrupted=_check_interrupted,
            )
        except YoutubeImportError as exc:
            raise ValueError(f"YouTube import failed ({exc.status_code}): {exc}") from exc
        if not result.clips:
            skipped = ", ".join(sorted({s["reason"] for s in result.skipped})) or "none"
            raise ValueError(
                "no clip passed the Traditional-Chinese transcript gate "
                f"(skipped reasons: {skipped}) — use transcript_override with a zh-Hant transcript"
            )

        clips_payload = {
            "version": 1,
            "baseRunDir": str(result.base_run_dir),
            "sourceKind": "uploaded",
            "videoId": result.video_id,
            "transcriptSource": result.transcript_source,
            "subtitleLang": result.subtitle_lang,
            "startSeconds": result.start_seconds,
            "endSeconds": result.end_seconds,
            "clips": [
                {
                    "audioPath": str(clip.wav_path),
                    "transcript": clip.transcript,
                    "relStart": clip.rel_start,
                    "durationSec": clip.duration,
                }
                for clip in result.clips
            ],
            "skipped": result.skipped,
        }
        report = json.dumps(
            {
                "videoId": result.video_id,
                "window": [result.start_seconds, result.end_seconds],
                "transcriptSource": result.transcript_source,
                "subtitleLang": result.subtitle_lang,
                "clips": len(result.clips),
                "skipped": result.skipped,
                "baseRunDir": str(result.base_run_dir),
            },
            ensure_ascii=False,
            indent=2,
        )
        section_audio = wav_to_comfy_audio(result.section_wav)
        return io.NodeOutput(clips_payload, section_audio, report)


class AnyVoiceReferenceFromAudio(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AnyVoiceReferenceFromAudio",
            display_name="AnyVoice Reference From Audio",
            category="AnyVoice",
            description=(
                "Turn any AUDIO (Load Audio file: mp3/m4a/wav/mp4…, or Record "
                "Audio mic take) into gated reference clips. A typed zh-Hant "
                "transcript covers a short (≤20s) clip; longer audio is "
                "auto-chunked and Whisper-transcribed. 將上傳檔案或麥克風錄音"
                "變成參考片段。"
            ),
            inputs=[
                io.Audio.Input("audio", tooltip="Connect Load Audio (file upload) or Record Audio (mic)"),
                io.String.Input(
                    "transcript",
                    multiline=True,
                    default="",
                    tooltip=(
                        "Exact Traditional-Chinese transcript of the clip head (≤ ~18s). "
                        "Leave empty to auto-transcribe with Whisper. 錄音流程請照著此文字唸。"
                    ),
                ),
                io.Boolean.Input(
                    "consent",
                    default=False,
                    tooltip="Confirm you have permission to clone this voice (consent gate, same as the web app)",
                ),
                io.Combo.Input(
                    "source_kind",
                    options=["uploaded", "scripted", "freeform"],
                    default="uploaded",
                    tooltip="uploaded = file import; scripted = mic take reading the given text; freeform = mic take in own words",
                ),
                io.Boolean.Input(
                    "auto_transcribe",
                    default=True,
                    tooltip="When transcript is empty, slice and transcribe with Whisper (like the YouTube no-captions fallback)",
                ),
                io.String.Input(
                    "asr_language",
                    default="zh",
                    optional=True,
                    tooltip="Whisper language hint for auto-transcription",
                ),
            ],
            outputs=[
                AnyVoiceClips.Output(display_name="clips"),
                io.String.Output(display_name="report"),
            ],
        )

    @classmethod
    def validate_inputs(cls, consent):
        if not consent:
            return CONSENT_MESSAGE
        return True

    @classmethod
    def execute(cls, audio, transcript, consent, source_kind, auto_transcribe, asr_language="zh") -> io.NodeOutput:
        if not consent:
            raise ValueError(CONSENT_MESSAGE)
        base_run_dir = env.runs_root() / env.new_job_id()
        base_run_dir.mkdir(parents=True, exist_ok=False)
        source_wav = comfy_audio_to_wav(audio, base_run_dir / "audio-source.wav")
        try:
            result = import_audio_reference(
                source_wav,
                transcript=transcript or "",
                auto_transcribe=auto_transcribe,
                language=(asr_language or "zh").strip() or "zh",
                source_kind=source_kind,
                convert_simplified=simplified_to_traditional,
                strict_script_errors=strict_traditional_chinese_script_errors,
                on_progress=_progress_reporter(),
                check_interrupted=_check_interrupted,
            )
        except ReferenceImportError as exc:
            raise ValueError(f"audio import failed: {exc}") from exc
        if not result.clips:
            skipped = ", ".join(sorted({s["reason"] for s in result.skipped})) or "none"
            raise ValueError(
                "no clip passed the Traditional-Chinese transcript gate "
                f"(skipped reasons: {skipped}) — type the exact zh-Hant transcript"
            )

        clips_payload = {
            "version": 1,
            "baseRunDir": str(result.base_run_dir),
            "sourceKind": source_kind,
            "transcriptSource": result.transcript_source,
            "clips": [
                {
                    "audioPath": str(clip.wav_path),
                    "transcript": clip.transcript,
                    "relStart": clip.rel_start,
                    "durationSec": clip.duration,
                }
                for clip in result.clips
            ],
            "skipped": result.skipped,
        }
        report = json.dumps(
            {
                "sourceKind": source_kind,
                "durationSec": round(result.duration_sec, 2),
                "truncatedAtSec": result.truncated_at_sec,
                "transcriptSource": result.transcript_source,
                "clips": len(result.clips),
                "skipped": result.skipped,
                "baseRunDir": str(result.base_run_dir),
            },
            ensure_ascii=False,
            indent=2,
        )
        return io.NodeOutput(clips_payload, report)


class AnyVoiceClipsPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AnyVoiceClipsPreview",
            display_name="AnyVoice Clips Preview",
            category="AnyVoice",
            description="Audition extracted reference clips and read their transcripts. 試聽擷取出的參考片段。",
            inputs=[
                AnyVoiceClips.Input("clips"),
                io.Int.Input(
                    "clip_index",
                    default=-1,
                    min=-1,
                    max=63,
                    tooltip="-1 plays all clips in sequence; otherwise a single clip index",
                ),
            ],
            outputs=[
                io.Audio.Output(display_name="audio"),
                io.String.Output(display_name="transcript"),
            ],
        )

    @classmethod
    def execute(cls, clips, clip_index) -> io.NodeOutput:
        entries = clips.get("clips") or []
        if not entries:
            raise ValueError("no clips to preview")
        if clip_index >= len(entries):
            raise ValueError(f"clip_index {clip_index} out of range (have {len(entries)} clips)")
        picked = entries if clip_index < 0 else [entries[clip_index]]
        audios = [wav_to_comfy_audio(entry["audioPath"]) for entry in picked]
        audio = audios[0] if len(audios) == 1 else concat_comfy_audio(audios)
        transcript = "\n".join(
            f"[{index}] {entry['transcript']}"
            for index, entry in enumerate(entries if clip_index < 0 else [entries[clip_index]])
        )
        return io.NodeOutput(audio, transcript)


class AnyVoiceEnrollProfile(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AnyVoiceEnrollProfile",
            display_name="AnyVoice Enroll Profile",
            category="AnyVoice",
            description=(
                "Grade each clip with the AnyVoice reference analyzer (A–D) and "
                "enroll the passing ones into a voice profile shared with the "
                "AnyVoice web app. 將片段評級並建立語音設定檔。"
            ),
            inputs=[
                AnyVoiceClips.Input("clips"),
                io.String.Input(
                    "display_name",
                    default="YouTube 聲音",
                    tooltip="Profile name shown in the AnyVoice web app",
                ),
                io.Int.Input("max_clips", default=10, min=1, max=10),
                io.String.Input(
                    "profile_id",
                    default="",
                    optional=True,
                    tooltip="Existing profile id to add clips to; empty creates a new vp_… profile",
                ),
            ],
            outputs=[
                AnyVoiceProfile.Output(display_name="profile"),
                io.Audio.Output(display_name="reference_audio"),
                io.String.Output(display_name="report"),
            ],
            is_output_node=True,
        )

    @classmethod
    def validate_inputs(cls, profile_id):
        if profile_id and profile_id.strip() and not PROFILE_ID_RE.fullmatch(profile_id.strip()):
            return "profile_id must contain only letters, numbers, dash, or underscore"
        return True

    @classmethod
    def execute(cls, clips, display_name, profile_id="", max_clips=10) -> io.NodeOutput:
        entries = clips.get("clips") or []
        if not entries:
            raise ValueError("no clips to enroll")
        resolved_profile_id = (profile_id or "").strip() or env.new_profile_id()
        if resolved_profile_id == "local-default":
            raise ValueError(
                "local-default is the curated self-recorded profile — enroll YouTube imports into their own profile"
            )
        clip_specs = [(Path(entry["audioPath"]), entry["transcript"]) for entry in entries]
        source_kind = clips.get("sourceKind") or "uploaded"
        selected, rejected, manifest_path = enroll_clips(
            clip_specs,
            profile_id=resolved_profile_id,
            display_name=display_name.strip() or "YouTube 聲音",
            max_clips=max_clips,
            source_kind=source_kind,
            on_progress=_progress_reporter(),
            check_interrupted=_check_interrupted,
        )
        if not selected:
            reasons = sorted({reason for _, rs in rejected for reason in rs})
            raise ValueError(
                "no clip passed enrollment (analyzer grades must be A/B, 6–20s): "
                + ", ".join(reasons)
            )
        best = selected[0]
        profile_payload = {
            "version": 1,
            "profileId": resolved_profile_id,
            "displayName": display_name,
            "manifestPath": str(manifest_path),
            "clips": selected,  # EnrolledClip objects, consumed by AnyVoiceVoiceClone
        }
        report = json.dumps(
            {
                "profileId": resolved_profile_id,
                "manifestPath": str(manifest_path),
                "enrolled": [
                    {
                        "runId": clip.run_id,
                        "grade": clip.grade,
                        "durationSec": clip.duration_sec,
                        "transcript": clip.transcript,
                    }
                    for clip in selected
                ],
                "rejected": [
                    {"runId": clip.run_id, "grade": clip.grade, "reasons": reasons}
                    for clip, reasons in rejected
                ],
                "webApp": "this profile is now visible in the AnyVoice app (.anyvoice/voices)",
            },
            ensure_ascii=False,
            indent=2,
        )
        return io.NodeOutput(profile_payload, wav_to_comfy_audio(best.audio_path()), report)


class AnyVoiceVoiceClone(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AnyVoiceVoiceClone",
            display_name="AnyVoice Voice Clone (VoxCPM2)",
            category="AnyVoice",
            description=(
                "Synthesize target text in the enrolled voice via VoxCPM2 — "
                "prefers the AnyVoice hot worker, falls back to the one-shot "
                "bridge. 用複製的聲音合成目標文字。"
            ),
            inputs=[
                AnyVoiceProfile.Input("profile"),
                io.String.Input(
                    "target_text",
                    multiline=True,
                    default="你好，這是用 AnyVoice 從 YouTube 建立的聲音複製測試。",
                    tooltip="Text to speak (Traditional Chinese; Simplified is rejected)",
                ),
                io.Combo.Input("quality", options=["speed", "balanced", "quality"], default="balanced"),
                io.Combo.Input("clone_mode", options=["hifi", "prompt"], default="hifi"),
                io.Int.Input(
                    "seed",
                    default=1337,
                    min=0,
                    max=2_147_483_647,
                    tooltip="Stability seed (1337 = AnyVoice default for repeatable renders)",
                ),
                io.Boolean.Input(
                    "prefer_hot_worker",
                    default=True,
                    tooltip="Use ANYVOICE_HOT_WORKER_URL when reachable; otherwise spawn the one-shot bridge",
                ),
            ],
            outputs=[
                io.Audio.Output(display_name="audio"),
                io.String.Output(display_name="metadata"),
            ],
        )

    @classmethod
    def execute(cls, profile, target_text, quality, clone_mode, seed, prefer_hot_worker) -> io.NodeOutput:
        text = (target_text or "").strip()
        if not text:
            raise ValueError("target_text is empty")
        if simplified_or_mixed_chinese_script_errors(text):
            raise ValueError(
                "target text must not be Simplified/mixed Chinese (請使用繁體中文)"
            )
        clips: list[EnrolledClip] = profile.get("clips") or []
        reference = select_reference_clip(clips)
        result = synthesize(
            target_text=text,
            reference_audio=reference.audio_path(),
            prompt_transcript=reference.transcript,
            quality=quality,
            clone_mode=clone_mode,
            seed=seed,
            prefer_hot_worker=prefer_hot_worker,
            on_progress=_progress_reporter(),
            check_interrupted=_check_interrupted,
        )
        metadata = dict(result.metadata)
        metadata["comfy"] = {
            "backend": result.backend,
            "runDir": str(result.run_dir),
            "profileId": profile.get("profileId"),
            "referenceRunId": reference.run_id,
            "referenceGrade": reference.grade,
        }
        return io.NodeOutput(
            wav_to_comfy_audio(result.output_wav),
            json.dumps(metadata, ensure_ascii=False, indent=2),
        )


class AnyVoiceExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            AnyVoiceYouTubeImport,
            AnyVoiceReferenceFromAudio,
            AnyVoiceClipsPreview,
            AnyVoiceEnrollProfile,
            AnyVoiceVoiceClone,
        ]


async def comfy_entrypoint() -> AnyVoiceExtension:
    return AnyVoiceExtension()
