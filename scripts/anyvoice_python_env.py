"""Shared resolution of the VoxCPM analysis/synthesis Python interpreter.

The heavy audio stack (VoxCPM, ASR, speaker embedding) lives in a dedicated
virtualenv, not the system Python. Resolution order:

1. Explicit ``override`` argument (a CLI flag or pre-resolved env value).
2. ``ANYVOICE_VOXCPM_PYTHON`` environment variable.
3. This repo's own ``.venv-voxcpm/`` (see ``requirements-voxcpm.txt``).
4. A sibling ``brenda-voice`` checkout's ``.venv-voxcpm/`` — the venv this
   repo historically borrowed, derived from the repo location rather than a
   hardcoded home directory, so a moved or absent checkout degrades cleanly.
5. ``sys.executable`` as the last resort.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def candidate_venv_pythons() -> list[Path]:
    return [
        REPO_ROOT / ".venv-voxcpm" / "bin" / "python",
        REPO_ROOT.parent / "brenda-voice" / ".venv-voxcpm" / "bin" / "python",
    ]


def resolve_analyzer_python(override: str = "") -> str:
    explicit = (override or "").strip()
    if explicit:
        return explicit
    from_env = (os.environ.get("ANYVOICE_VOXCPM_PYTHON") or "").strip()
    if from_env:
        return from_env
    for candidate in candidate_venv_pythons():
        if candidate.exists():
            return str(candidate)
    return sys.executable
