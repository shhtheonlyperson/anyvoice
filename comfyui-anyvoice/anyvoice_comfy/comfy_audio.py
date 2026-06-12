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


def comfy_audio_to_wav(audio: dict, path: str | Path, max_seconds: float | None = None) -> Path:
    """Write an AUDIO dict (first batch item) to a 16-bit PCM wav. The pipeline
    re-normalizes to 16k mono via ffmpeg afterwards, so channels/rate are kept
    as-is here. max_seconds caps the written length (nothing past the pipeline's
    scan window is ever consumed); NaNs are zeroed (float→int16 of NaN is
    undefined behavior)."""
    import torch

    path = Path(path)
    waveform = audio["waveform"]
    if waveform.ndim != 3 or waveform.shape[2] == 0:
        raise ValueError(f"expected AUDIO waveform [B, C, T], got shape {tuple(waveform.shape)}")
    sample_rate = int(audio["sample_rate"])
    item = waveform[0]
    if max_seconds is not None:
        item = item[:, : int(max_seconds * sample_rate)]
    item = torch.nan_to_num(item.cpu().float(), nan=0.0).clamp(-1.0, 1.0)  # [C, T]
    pcm = (item * 32767.0).round().to(torch.int16).t().contiguous()  # [T, C] interleaved

    import wave

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(item.shape[0])
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.numpy().tobytes())
    return path


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
