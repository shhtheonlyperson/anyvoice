"""AUDIO dict ↔ wav bridging (torch-dependent; runs in the ComfyUI venv)."""

import pytest

torch = pytest.importorskip("torch")

from anyvoice_comfy.comfy_audio import comfy_audio_to_wav, wav_to_comfy_audio


def sine_audio(seconds=2.0, rate=16000, channels=1, freq=220.0):
    t = torch.arange(int(seconds * rate)) / rate
    wave_ = (0.5 * torch.sin(2 * torch.pi * freq * t)).float()
    waveform = wave_.repeat(channels, 1).unsqueeze(0)  # [1, C, T]
    return {"waveform": waveform, "sample_rate": rate}


class TestRoundtrip:
    def test_mono_roundtrip(self, tmp_path):
        audio = sine_audio()
        path = comfy_audio_to_wav(audio, tmp_path / "out.wav")
        back = wav_to_comfy_audio(path)
        assert back["sample_rate"] == 16000
        assert back["waveform"].shape == audio["waveform"].shape
        assert torch.allclose(back["waveform"], audio["waveform"], atol=2e-4)

    def test_stereo_roundtrip(self, tmp_path):
        audio = sine_audio(channels=2)
        path = comfy_audio_to_wav(audio, tmp_path / "out.wav")
        back = wav_to_comfy_audio(path)
        assert back["waveform"].shape[1] == 2

    def test_clamps_out_of_range(self, tmp_path):
        audio = sine_audio()
        audio["waveform"] = audio["waveform"] * 4.0
        path = comfy_audio_to_wav(audio, tmp_path / "out.wav")
        back = wav_to_comfy_audio(path)
        assert back["waveform"].abs().max() <= 1.0

    def test_rejects_bad_shape(self, tmp_path):
        with pytest.raises(ValueError, match="B, C, T"):
            comfy_audio_to_wav({"waveform": torch.zeros(2, 16000), "sample_rate": 16000}, tmp_path / "x.wav")

    def test_nan_samples_become_silence(self, tmp_path):
        audio = sine_audio()
        audio["waveform"][0, 0, 100:200] = float("nan")
        path = comfy_audio_to_wav(audio, tmp_path / "out.wav")
        back = wav_to_comfy_audio(path)
        assert torch.isfinite(back["waveform"]).all()
        assert back["waveform"][0, 0, 100:200].abs().max() == 0.0

    def test_max_seconds_caps_written_length(self, tmp_path):
        audio = sine_audio(seconds=4.0)
        path = comfy_audio_to_wav(audio, tmp_path / "out.wav", max_seconds=1.5)
        back = wav_to_comfy_audio(path)
        assert back["waveform"].shape[2] == int(1.5 * 16000)
