"""VoxCPM2 voice-clone synthesis via the AnyVoice backends.

Prefers the preloaded hot worker (scripts/voxcpm_hot_worker_anyvoice.py,
POST /clone, NDJSON progress stream) and falls back to the one-shot bridge
(scripts/synthesize_voxcpm_anyvoice.py --progress-jsonl). Both expect the
verified reference transcript ("ultimate mode") and run inside the VoxCPM
Python environment; ComfyUI only exchanges file paths with them.
"""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import env
from .enroll import GRADE_RANK, EnrolledClip

QUALITY_PRESETS = ("speed", "balanced", "quality")
CLONE_MODES = ("hifi", "prompt")

# Progress phases in stream order, mapped to a coarse completion fraction.
PHASE_PROGRESS = {
    "reference_preprocessing": 10,
    "reference_analyzed": 20,
    "model_loading": 30,
    "model_ready": 45,
    "synthesis_started": 55,
    "audio_ready": 95,
}


class SynthesisError(RuntimeError):
    pass


@dataclass
class SynthesisResult:
    output_wav: Path
    metadata: dict
    run_dir: Path
    backend: str  # hot_worker | one_shot


def select_reference_clip(clips: list[EnrolledClip]) -> EnrolledClip:
    """Best reference: grade A before B, then duration closest to the ~12s
    sweet spot (simplified from selectVoiceProfileClipForTarget)."""
    if not clips:
        raise SynthesisError("voice profile has no usable clips")
    return sorted(clips, key=lambda c: (GRADE_RANK.get(c.grade, 9), abs(c.duration_sec - 12.0)))[0]


def _prepare_run_dir(target_text: str, reference_audio: Path, prompt_transcript: str) -> Path:
    run_dir = env.runs_root() / env.new_job_id()
    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "target.txt").write_text(target_text, encoding="utf-8")
    (run_dir / "target.raw.txt").write_text(target_text, encoding="utf-8")
    (run_dir / "prompt-transcript.txt").write_text(prompt_transcript, encoding="utf-8")
    return run_dir


def _emit(on_progress: Callable[[int, int, str], None] | None, event: dict) -> None:
    if not on_progress:
        return
    phase = str(event.get("phase") or "")
    message = str(event.get("message") or phase or "working")
    on_progress(PHASE_PROGRESS.get(phase, 50), 100, message)


def _synthesize_hot_worker(
    worker_url: str,
    run_dir: Path,
    reference_audio: Path,
    quality: str,
    clone_mode: str,
    seed: int,
    model_id: str,
    on_progress: Callable[[int, int, str], None] | None,
    check_interrupted: Callable[[], None] | None,
    timeout_sec: float,
) -> dict:
    output_path = run_dir / "output.wav"
    metadata_path = run_dir / "metadata.json"
    payload = {
        "textFile": str(run_dir / "target.txt"),
        "promptTextFile": str(run_dir / "prompt-transcript.txt"),
        "referenceAudio": str(reference_audio),
        "output": str(output_path),
        "metadataOutput": str(metadata_path),
        "modelId": model_id,
        "quality": quality,
        "cloneMode": clone_mode,
        "stabilitySeed": seed,
    }
    request = urllib.request.Request(
        worker_url.rstrip("/") + "/clone",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    metadata: dict | None = None
    completed = False
    # The worker streams NDJSON over a long-lived response; errors arrive as
    # {type:'error'} lines with HTTP 200, so parse line types, not status codes.
    with urllib.request.urlopen(request, timeout=timeout_sec) as response:
        for raw_line in response:
            if check_interrupted:
                check_interrupted()
            line = raw_line.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            if event_type == "progress":
                _emit(on_progress, event)
            elif event_type == "metadata":
                metadata = event.get("metadata") or {}
            elif event_type == "error":
                raise SynthesisError(f"hot worker error: {event.get('message') or 'unknown'}")
            elif event_type == "completed":
                completed = True
    if not completed or not output_path.exists():
        raise SynthesisError("hot worker stream ended without a completed synthesis")
    return metadata or {}


def _synthesize_one_shot(
    run_dir: Path,
    reference_audio: Path,
    quality: str,
    clone_mode: str,
    seed: int,
    model_id: str,
    on_progress: Callable[[int, int, str], None] | None,
    check_interrupted: Callable[[], None] | None,
    timeout_sec: float,
) -> dict:
    python = env.voxcpm_python()
    script = env.repo_root() / "scripts" / "synthesize_voxcpm_anyvoice.py"
    output_path = run_dir / "output.wav"
    metadata_path = run_dir / "metadata.json"
    args = [
        python, str(script),
        "--text-file", str(run_dir / "target.txt"),
        "--reference-audio", str(reference_audio),
        "--prompt-text-file", str(run_dir / "prompt-transcript.txt"),
        "--output", str(output_path),
        "--metadata-output", str(metadata_path),
        "--model-id", model_id,
        "--quality", quality,
        "--clone-mode", clone_mode,
        "--seed", str(seed),
        "--progress-jsonl",
    ]
    # stderr goes to a file, not a pipe: torch/HF logging can exceed the pipe
    # buffer and deadlock the child while we block reading stdout.
    stderr_log = run_dir / "synthesis.log"
    with open(stderr_log, "w", encoding="utf-8") as stderr_file:
        process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            text=True,
            cwd=env.repo_root(),
        )
        metadata: dict | None = None
        try:
            assert process.stdout is not None
            for line in process.stdout:
                if check_interrupted:
                    try:
                        check_interrupted()
                    except BaseException:
                        process.kill()
                        raise
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "progress":
                    _emit(on_progress, event)
                elif event.get("type") == "metadata":
                    metadata = event.get("metadata") or {}
            process.wait(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            process.kill()
            raise SynthesisError("one-shot synthesis timed out")
    if process.returncode != 0:
        stderr_tail = stderr_log.read_text(encoding="utf-8", errors="replace")[-500:]
        raise SynthesisError(f"synthesis failed (exit {process.returncode}): {stderr_tail.strip()}")
    if not output_path.exists():
        raise SynthesisError("synthesis produced no output.wav")
    return metadata or {}


def synthesize(
    target_text: str,
    reference_audio: Path,
    prompt_transcript: str,
    quality: str = "balanced",
    clone_mode: str = "hifi",
    seed: int = 1337,
    model_id: str | None = None,
    prefer_hot_worker: bool = True,
    on_progress: Callable[[int, int, str], None] | None = None,
    check_interrupted: Callable[[], None] | None = None,
    timeout_sec: float = 1800.0,
) -> SynthesisResult:
    if quality not in QUALITY_PRESETS:
        quality = "balanced"
    if clone_mode not in CLONE_MODES:
        clone_mode = "hifi"
    resolved_model_id = model_id or env.model_id()
    run_dir = _prepare_run_dir(target_text, reference_audio, prompt_transcript)

    worker_url = env.hot_worker_url() if prefer_hot_worker else ""
    if worker_url:
        try:
            metadata = _synthesize_hot_worker(
                worker_url, run_dir, reference_audio, quality, clone_mode, seed,
                resolved_model_id, on_progress, check_interrupted, timeout_sec,
            )
            return SynthesisResult(
                output_wav=run_dir / "output.wav", metadata=metadata, run_dir=run_dir, backend="hot_worker"
            )
        except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
            # Worker down → cold-start fallback, mirroring the Next worker.
            if on_progress:
                on_progress(5, 100, f"hot worker unavailable ({exc.__class__.__name__}), using one-shot bridge")

    metadata = _synthesize_one_shot(
        run_dir, reference_audio, quality, clone_mode, seed,
        resolved_model_id, on_progress, check_interrupted, timeout_sec,
    )
    return SynthesisResult(
        output_wav=run_dir / "output.wav", metadata=metadata, run_dir=run_dir, backend="one_shot"
    )
