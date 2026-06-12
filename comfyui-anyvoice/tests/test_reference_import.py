"""Audio-file/recording reference import: branch behavior, gating, provenance.

Uses real ffmpeg for slicing (same as production) and stubs Whisper ASR.
"""

import json
import math
import struct
import wave
from pathlib import Path

import pytest

from anyvoice_comfy import reference_import
from anyvoice_comfy.reference_import import (
    ReferenceImportError,
    import_audio_reference,
    wav_duration_seconds,
)
from anyvoice_comfy.textgate import strict_traditional_chinese_script_errors


def make_tone_wav(path: Path, seconds: float, rate: int = 16000) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(seconds * rate)
    samples = [int(12000 * math.sin(2 * math.pi * 220 * i / rate)) for i in range(frames)]
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(struct.pack(f"<{frames}h", *samples))
    return path


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("ANYVOICE_RUNS_DIR", str(tmp_path / "runs"))
    run = tmp_path / "runs" / "testimport"
    run.mkdir(parents=True)
    return run


class TestWavDuration:
    def test_reports_duration(self, run_dir):
        wav = make_tone_wav(run_dir / "audio-source.wav", 8.0)
        assert wav_duration_seconds(wav) == pytest.approx(8.0, abs=0.01)


class TestShortAudio:
    def test_rejects_below_minimum(self, run_dir):
        wav = make_tone_wav(run_dir / "audio-source.wav", 3.0)
        with pytest.raises(ReferenceImportError, match="at least 6s"):
            import_audio_reference(wav, transcript="這是繁體測試")


class TestProvidedTranscript:
    def test_single_clip_within_band(self, run_dir):
        wav = make_tone_wav(run_dir / "audio-source.wav", 12.0)
        result = import_audio_reference(
            wav,
            transcript="這是繁體中文的測試",
            strict_script_errors=strict_traditional_chinese_script_errors,
        )
        assert result.transcript_source == "provided"
        assert len(result.clips) == 1
        clip = result.clips[0]
        assert clip.transcript == "這是繁體中文的測試"
        assert clip.duration == pytest.approx(12.0, abs=0.1)
        assert clip.wav_path.exists()

    def test_long_audio_with_transcript_takes_head(self, run_dir):
        wav = make_tone_wav(run_dir / "audio-source.wav", 40.0)
        result = import_audio_reference(
            wav,
            transcript="這是繁體中文的測試",
            strict_script_errors=strict_traditional_chinese_script_errors,
        )
        assert len(result.clips) == 1
        assert result.clips[0].duration == pytest.approx(18.0, abs=0.1)

    def test_simplified_transcript_is_gated(self, run_dir):
        wav = make_tone_wav(run_dir / "audio-source.wav", 12.0)
        result = import_audio_reference(
            wav,
            transcript="这是简体测试",
            strict_script_errors=strict_traditional_chinese_script_errors,
        )
        assert result.clips == []
        assert result.skipped[0]["reason"] == "simplified_or_mixed"

    def test_opencc_conversion_applied(self, run_dir):
        pytest.importorskip("opencc")
        from anyvoice_comfy.textgate import simplified_to_traditional

        wav = make_tone_wav(run_dir / "audio-source.wav", 12.0)
        result = import_audio_reference(
            wav,
            transcript="这是简体中文的测试",
            convert_simplified=simplified_to_traditional,
            strict_script_errors=strict_traditional_chinese_script_errors,
        )
        assert len(result.clips) == 1
        assert "這" in result.clips[0].transcript


class TestAsrFallback:
    def test_requires_transcript_when_auto_off(self, run_dir):
        wav = make_tone_wav(run_dir / "audio-source.wav", 12.0)
        with pytest.raises(ReferenceImportError, match="transcript is required"):
            import_audio_reference(wav, transcript="", auto_transcribe=False)

    def test_slices_and_transcribes(self, run_dir, monkeypatch):
        wav = make_tone_wav(run_dir / "audio-source.wav", 30.0)
        monkeypatch.setattr(
            reference_import, "transcribe_audio_file", lambda path, language="zh": "這是繁體轉寫結果"
        )
        result = import_audio_reference(
            wav,
            transcript="",
            strict_script_errors=strict_traditional_chinese_script_errors,
        )
        assert result.transcript_source == "asr"
        # 30s span at ~14s target → 2 slices; duplicate-transcript dedup happens
        # later at enrollment, so both clips survive import.
        assert len(result.clips) == 2

    def test_truncates_very_long_audio(self, run_dir, monkeypatch):
        wav = make_tone_wav(run_dir / "audio-source.wav", 320.0)
        calls = []

        def fake_asr(path, language="zh"):
            calls.append(path)
            return f"這是第{len(calls)}段繁體轉寫"

        monkeypatch.setattr(reference_import, "transcribe_audio_file", fake_asr)
        result = import_audio_reference(
            wav,
            transcript="",
            strict_script_errors=strict_traditional_chinese_script_errors,
        )
        assert result.truncated_at_sec == 300.0
        assert len(calls) <= 10  # slices capped before transcription

    def test_empty_asr_raises(self, run_dir, monkeypatch):
        wav = make_tone_wav(run_dir / "audio-source.wav", 30.0)
        monkeypatch.setattr(reference_import, "transcribe_audio_file", lambda path, language="zh": "")
        with pytest.raises(ReferenceImportError, match="no text"):
            import_audio_reference(wav, transcript="")


class TestProvenance:
    def test_writes_audio_import_sidecar(self, run_dir):
        wav = make_tone_wav(run_dir / "audio-source.wav", 12.0)
        import_audio_reference(
            wav,
            transcript="這是繁體中文的測試",
            source_kind="scripted",
            strict_script_errors=strict_traditional_chinese_script_errors,
        )
        sidecar = json.loads((run_dir / "audio-import.json").read_text(encoding="utf-8"))
        assert sidecar["source"] == "audio"
        assert sidecar["sourceKind"] == "scripted"
        assert sidecar["transcriptSource"] == "provided"
        assert sidecar["importedVia"] == "comfyui-anyvoice"
        assert len(sidecar["clips"]) == 1
