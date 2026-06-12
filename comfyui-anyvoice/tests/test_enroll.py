"""Enrollment artifact-layout and manifest tests (analyzer stubbed)."""

import json
from pathlib import Path

import pytest

from anyvoice_comfy import enroll
from anyvoice_comfy.enroll import (
    EnrolledClip,
    clip_rejection_reasons,
    ensure_profile_meta,
    persist_profile_manifest,
    select_clips,
    voice_profile_hash_from_id,
    write_enrollment_run,
)


@pytest.fixture
def anyvoice_roots(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    voices = tmp_path / "voices"
    monkeypatch.setenv("ANYVOICE_RUNS_DIR", str(runs))
    monkeypatch.setenv("ANYVOICE_VOICE_PROFILE_ROOT", str(voices))
    return runs, voices


def make_wav(path: Path, seconds: float = 1.0, rate: int = 16000) -> Path:
    import struct
    import wave

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        frames = int(seconds * rate)
        wav.writeframes(struct.pack(f"<{frames}h", *([0] * frames)))
    return path


def quality(grade="A", duration=12.0, warnings=()):
    return {
        "grade": grade,
        "durationSec": duration,
        "snrDb": 30.0,
        "clippingRatio": 0.0,
        "vadActiveRatio": 0.8,
        "warnings": list(warnings),
    }


def clip(run_dir: Path, run_id="run-1", grade="A", duration=12.0, transcript="這是繁體測試", warnings=()):
    return EnrolledClip(
        run_id=run_id,
        run_dir=run_dir,
        transcript=transcript,
        reference_quality=quality(grade, duration, warnings),
    )


class TestWriteEnrollmentRun:
    def test_writes_web_app_compatible_artifacts(self, anyvoice_roots, tmp_path):
        runs, _ = anyvoice_roots
        source = make_wav(tmp_path / "clip.wav")
        run_dir = runs / "testrun001"
        write_enrollment_run(run_dir, source, "這是繁體測試", "vp_test1234", "openbmb/VoxCPM2")

        assert (run_dir / "reference.wav").exists()
        assert (run_dir / "prompt-transcript.txt").read_text(encoding="utf-8") == "這是繁體測試"
        assert (run_dir / "prompt-transcript.raw.txt").exists()

        request = json.loads((run_dir / "request.json").read_text(encoding="utf-8"))
        assert request["status"] == "profile_enrollment"
        assert request["voiceProfileId"] == "vp_test1234"
        assert request["sourceKind"] == "uploaded"
        assert request["modelId"] == "openbmb/VoxCPM2"
        assert request["textPreparation"]["promptTranscript"]["raw"] == "這是繁體測試"

        text_prep = json.loads((run_dir / "text-prep.json").read_text(encoding="utf-8"))
        assert text_prep["version"] == 1


class TestProfileMeta:
    def test_creates_shared_meta(self, anyvoice_roots):
        _, voices = anyvoice_roots
        ensure_profile_meta("vp_test1234", "測試聲音")
        meta = json.loads((voices / "vp_test1234" / "meta.json").read_text(encoding="utf-8"))
        assert meta["id"] == "vp_test1234"
        assert meta["displayName"] == "測試聲音"
        assert "userId" not in meta
        assert meta["hash"] == voice_profile_hash_from_id("vp_test1234")

    def test_does_not_overwrite_existing(self, anyvoice_roots):
        _, voices = anyvoice_roots
        ensure_profile_meta("vp_test1234", "first")
        ensure_profile_meta("vp_test1234", "second")
        meta = json.loads((voices / "vp_test1234" / "meta.json").read_text(encoding="utf-8"))
        assert meta["displayName"] == "first"

    def test_hash_is_16_bit_nonzero(self):
        for profile_id in ("vp_abc12345", "vp_zz", "local-default"):
            value = voice_profile_hash_from_id(profile_id)
            assert 0 < value <= 0xFFFF


class TestSelection:
    def test_rejects_bad_grades_durations_warnings_scripts(self, tmp_path):
        assert clip_rejection_reasons(clip(tmp_path, grade="C")) == ["grade_c"]
        assert "too_short" in clip_rejection_reasons(clip(tmp_path, duration=3.0))
        assert "too_long" in clip_rejection_reasons(clip(tmp_path, duration=25.0))
        assert "low_snr" in clip_rejection_reasons(clip(tmp_path, warnings=["low_snr"]))
        assert "transcript_script_zh_unknown" in clip_rejection_reasons(clip(tmp_path, transcript="早安你好"))
        assert clip_rejection_reasons(clip(tmp_path)) == []

    def test_ranks_a_before_b_and_dedupes_transcripts(self, tmp_path):
        clips = [
            clip(tmp_path, run_id="b-clip", grade="B"),
            clip(tmp_path, run_id="a-clip", grade="A", transcript="這是另一段繁體"),
            clip(tmp_path, run_id="a-dup", grade="A", transcript="這是另一段 繁體"),
        ]
        selected, rejected = select_clips(clips)
        assert [c.run_id for c in selected] == ["a-clip", "b-clip"]
        assert any(reasons == ["duplicate_transcript"] for _, reasons in rejected)

    def test_caps_at_max_clips(self, tmp_path):
        clips = [
            clip(tmp_path, run_id=f"r{i}", transcript=f"這是繁體測試第{'一二三四五六七八九十十一十二'[i]}段")
            for i in range(12)
        ]
        selected, _ = select_clips(clips, max_clips=10)
        assert len(selected) == 10


class TestManifest:
    def test_persists_imported_tier_manifest(self, anyvoice_roots, tmp_path):
        runs, voices = anyvoice_roots
        run_dir = runs / "manifestrun"
        run_dir.mkdir(parents=True)
        make_wav(run_dir / "reference.wav")
        ensure_profile_meta("vp_manifest1", "測試")
        selected = [clip(run_dir, run_id="manifestrun")]
        manifest_path = persist_profile_manifest("vp_manifest1", selected, [], "openbmb/VoxCPM2")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert manifest["voiceProfileId"] == "vp_manifest1"
        assert manifest["status"] == "ready"
        assert manifest["usable"] is True
        assert manifest["studioGrade"] is False
        assert manifest["requirements"]["minClips"] == 1
        assert manifest["clips"][0]["sourceRunId"] == "manifestrun"
        assert manifest["clips"][0]["voiceProfileId"] == "vp_manifest1"
        assert (voices / "vp_manifest1" / "clips" / "001.wav").exists()

    def test_prefers_normalized_reference(self, anyvoice_roots, tmp_path):
        runs, _ = anyvoice_roots
        run_dir = runs / "normrun"
        run_dir.mkdir(parents=True)
        make_wav(run_dir / "reference.wav")
        make_wav(run_dir / "reference_16k_mono.wav")
        c = clip(run_dir, run_id="normrun")
        assert c.audio_path().name == "reference_16k_mono.wav"


class TestEnrollClipsAnalyzerStub:
    def test_enroll_clips_with_stubbed_analyzer(self, anyvoice_roots, tmp_path, monkeypatch):
        runs, voices = anyvoice_roots
        source = make_wav(tmp_path / "in.wav", seconds=12.0)

        def fake_analyzer(run_dir, model_id, source_kind="uploaded", timeout_sec=120.0):
            metadata = {"referenceQuality": quality()}
            (run_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            return metadata["referenceQuality"]

        monkeypatch.setattr(enroll, "run_analyzer", fake_analyzer)
        selected, rejected, manifest_path = enroll.enroll_clips(
            [(source, "這是繁體測試")],
            profile_id="vp_stub12345",
            display_name="stub",
        )
        assert len(selected) == 1
        assert rejected == []
        assert manifest_path.exists()
        request = json.loads((selected[0].run_dir / "request.json").read_text(encoding="utf-8"))
        assert request["voiceProfileId"] == "vp_stub12345"
