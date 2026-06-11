"""Bridge between on-disk wav files and ComfyUI AUDIO dicts.

AUDIO is {"waveform": float32 tensor [B, C, T], "sample_rate": int}. Inside
ComfyUI we reuse comfy_extras.nodes_audio.load (PyAV-backed, handles any
ffmpeg-readable file); the stdlib `wave` fallback covers the PCM wavs this
pipeline produces when running outside the server (tests, scripts).
"""

from __future__ import annotations

from pathlib import Path


def _load_with_comfy(path: Path):
    from comfy_extras.nodes_audio import load

    waveform, sample_rate = load(str(path))
    return waveform, sample_rate


def _load_with_wave(path: Path):
    import wave

    import torch

    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if sample_width != 2:
        raise ValueError(f"wave fallback only supports 16-bit PCM, got width {sample_width}")
    data = torch.frombuffer(bytearray(frames), dtype=torch.int16).float() / 32768.0
    waveform = data.view(-1, channels).t().contiguous()
    return waveform, sample_rate


def wav_to_comfy_audio(path: str | Path) -> dict:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"audio file not found: {path}")
    try:
        waveform, sample_rate = _load_with_comfy(path)
    except ImportError:
        waveform, sample_rate = _load_with_wave(path)
    return {"waveform": waveform.unsqueeze(0), "sample_rate": int(sample_rate)}


def concat_comfy_audio(audios: list[dict], gap_seconds: float = 0.4) -> dict:
    """Concatenate same-provenance AUDIO dicts on the time axis with short
    silence gaps (for auditioning extracted clips in sequence)."""
    import torch

    if not audios:
        raise ValueError("no audio to concatenate")
    sample_rate = audios[0]["sample_rate"]
    channels = audios[0]["waveform"].shape[1]
    gap = torch.zeros((1, channels, int(sample_rate * gap_seconds)), dtype=torch.float32)
    pieces: list = []
    for index, audio in enumerate(audios):
        waveform = audio["waveform"]
        if audio["sample_rate"] != sample_rate or waveform.shape[1] != channels:
            raise ValueError("clips must share sample rate and channel count")
        if index > 0:
            pieces.append(gap)
        pieces.append(waveform)
    return {"waveform": torch.cat(pieces, dim=2), "sample_rate": sample_rate}
