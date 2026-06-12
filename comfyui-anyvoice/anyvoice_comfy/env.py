"""Environment discovery for the AnyVoice ComfyUI pack.

Mirrors the resolution rules the Next.js worker and scripts/anyvoice_python_env.py
use, so nodes running inside ComfyUI find the same tools, Python environments,
and artifact roots as the web app. Precedence: process env > <repo>/.env.local >
machine defaults.
"""

from __future__ import annotations

import os
import secrets
import shutil
import sys
from pathlib import Path

_NANOID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"


def repo_root() -> Path:
    """The anyvoice repo root (the pack lives at <repo>/comfyui-anyvoice/)."""
    return Path(__file__).resolve().parents[2]


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


_env_local_cache: dict[str, str] | None = None


def env_local() -> dict[str, str]:
    global _env_local_cache
    if _env_local_cache is None:
        _env_local_cache = _parse_env_file(repo_root() / ".env.local")
    return _env_local_cache


def setting(name: str, default: str = "") -> str:
    """ANYVOICE_* setting: process env first, then <repo>/.env.local."""
    value = os.environ.get(name, "").strip()
    if value:
        return value
    return env_local().get(name, "").strip() or default


def _first_existing(paths: list[str]) -> str | None:
    for candidate in paths:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def ytdlp_path() -> str:
    return (
        setting("ANYVOICE_YTDLP")
        or shutil.which("yt-dlp")
        or _first_existing(["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"])
        or "yt-dlp"
    )


def ffmpeg_path() -> str:
    return (
        setting("ANYVOICE_FFMPEG")
        or setting("ANYVOICE_FFMPEG_PATH")
        or os.environ.get("FFMPEG_PATH", "").strip()
        or shutil.which("ffmpeg")
        or _first_existing(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"])
        or "ffmpeg"
    )


def voxcpm_python() -> str:
    """Heavy audio-stack interpreter, mirroring scripts/anyvoice_python_env.py."""
    explicit = setting("ANYVOICE_VOXCPM_PYTHON")
    if explicit:
        return explicit
    repo = repo_root()
    candidates = [
        repo.parent / "shh-voxcpm-service" / ".venv" / "bin" / "python",
        repo / ".venv-voxcpm" / "bin" / "python",
        repo.parent / "brenda-voice" / ".venv-voxcpm" / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return sys.executable


def asr_python() -> str:
    return setting("ANYVOICE_ASR_PYTHON") or voxcpm_python()


def asr_model() -> str:
    return setting("ANYVOICE_ASR_MODEL", "large-v3")


def model_id() -> str:
    return setting("ANYVOICE_MODEL_ID", "openbmb/VoxCPM2")


def hot_worker_url() -> str:
    return setting("ANYVOICE_HOT_WORKER_URL")


def _resolve_root(value: str, default_relative: str) -> Path:
    raw = value or default_relative
    path = Path(raw)
    if not path.is_absolute():
        path = repo_root() / path
    return path


def runs_root() -> Path:
    return _resolve_root(setting("ANYVOICE_RUNS_DIR"), ".anyvoice/runs")


def voices_root() -> Path:
    return _resolve_root(setting("ANYVOICE_VOICE_PROFILE_ROOT"), ".anyvoice/voices")


def new_job_id(length: int = 10) -> str:
    """nanoid-compatible run id ([A-Za-z0-9_-]), like the Next worker's nanoid(10)."""
    return "".join(secrets.choice(_NANOID_ALPHABET) for _ in range(length))


def new_profile_id() -> str:
    """vp_<nanoid8>, matching lib/voice-profile-registry.ts createVoiceProfile."""
    return "vp_" + new_job_id(8)
