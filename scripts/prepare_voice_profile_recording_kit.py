from __future__ import annotations

import argparse
import html
import json
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from anyvoice_python_env import resolve_analyzer_python
from build_voice_profile import (
    CHINESE_SCRIPT_MARKER_PAIRS,
    PRODUCT_PRONUNCIATION_PRESET_IDS,
    REQUIRED_COVERAGE_FEATURES,
    REQUIRED_PRONUNCIATION_PRESET_IDS,
    detect_chinese_script,
    pronunciation_preset_ids,
    strict_traditional_script_errors,
    transcript_coverage_features,
)
from voice_profile_duration import (
    MAX_PROFILE_DURATION_SEC,
    MIN_ACTIVE_VOICE_SEC,
    MIN_PROFILE_DURATION_SEC,
    recommended_duration_sec,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROMPT_MANIFEST = REPO_ROOT / "examples" / "voice_profile_import_manifest.example.json"
EXTENDED_PROMPT_MANIFEST = REPO_ROOT / "examples" / "voice_profile_import_manifest.extended.zh-Hant.json"
DEFAULT_OUT_ROOT = REPO_ROOT / "generated" / "voice-profile-recording-kits"
PROMPT_SET_MANIFESTS = {
    "standard": DEFAULT_PROMPT_MANIFEST,
    "extended": EXTENDED_PROMPT_MANIFEST,
}
PRONUNCIATION_NOTE_PRESETS = [
    ("Brenda", "Brenda: English name, keep it natural"),
    ("AnyVoice", "AnyVoice: read as English words Any Voice"),
    ("OpenAI", "OpenAI: read as English Open A I"),
    ("Mac Studio", "Mac Studio: read as English words Mac Studio"),
    ("VoxCPM2", "VoxCPM2: read as Vox C P M two"),
    ("TestFlight", "TestFlight: read as English TestFlight"),
    ("TSMC", "TSMC: read as English letters T S M C"),
    ("台北", "台北: ㄊㄞˊ ㄅㄟˇ / tai2 bei3"),
    ("紐約", "紐約: ㄋㄧㄡˇ ㄩㄝ / niu3 yue1"),
    ("重慶", "重慶: ㄔㄨㄥˊ ㄑㄧㄥˋ / chong2 qing4"),
    ("銀行", "銀行: ㄧㄣˊ ㄏㄤˊ / yin2 hang2"),
    ("行長", "行長: ㄒㄧㄥˊ ㄓㄤˇ / xing2 zhang3"),
    ("角色", "角色: ㄐㄩㄝˊ ㄙㄜˋ / jue2 se4"),
    ("音樂", "音樂: ㄧㄣ ㄩㄝˋ / yin1 yue4"),
    ("長樂", "長樂: ㄔㄤˊ ㄌㄜˋ / chang2 le4"),
]


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def command(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"prompt manifest not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"prompt manifest is not valid JSON: {path}: {exc}") from exc


def chinese_script_marker_hits(text: str) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for traditional, simplified in CHINESE_SCRIPT_MARKER_PAIRS:
        traditional_count = text.count(traditional)
        simplified_count = text.count(simplified)
        if traditional_count or simplified_count:
            hits.append(
                {
                    "traditional": traditional,
                    "simplified": simplified,
                    "traditionalCount": traditional_count,
                    "simplifiedCount": simplified_count,
                }
            )
    return hits


def string_list(value: Any) -> list[str]:
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if isinstance(item, str) and item.strip()]
    return []


def pronunciation_notes(row: dict[str, Any], prompt: str) -> list[str]:
    explicit = string_list(row.get("pronunciationNotes") or row.get("pronunciationGuide") or row.get("readingNotes"))
    automatic = [note for term, note in PRONUNCIATION_NOTE_PRESETS if term in prompt]
    seen: set[str] = set()
    notes: list[str] = []
    for note in [*explicit, *automatic]:
        if note not in seen:
            seen.add(note)
            notes.append(note)
    return notes


def prompt_row(path: Path, row: dict[str, Any], index: int) -> dict[str, Any]:
    transcript = row.get("transcript") or row.get("promptTranscript") or row.get("text")
    if not isinstance(transcript, str) or not transcript.strip():
        raise SystemExit(f"prompt manifest row {index} is missing transcript text")
    prompt = transcript.strip()
    transcript_script = detect_chinese_script(prompt)
    script_errors = strict_traditional_script_errors(prompt)
    if script_errors:
        marker_hits = chinese_script_marker_hits(prompt)
        marker_summary = ", ".join(
            f"{hit['traditional']}/{hit['simplified']}={hit['traditionalCount']}/{hit['simplifiedCount']}"
            for hit in marker_hits
            if hit["traditionalCount"] or hit["simplifiedCount"]
        )
        raise SystemExit(
            f"prompt manifest row {index} must use Traditional Chinese before recording; "
            f"detected {transcript_script} in {path}; errors={','.join(script_errors)}"
            + (f" ({marker_summary})" if marker_summary else "")
        )
    return {
        "transcript": prompt,
        "transcriptScript": transcript_script,
        "coverageFeatures": transcript_coverage_features(prompt),
        "pronunciationPresetIds": pronunciation_preset_ids(prompt),
        "scriptMarkerHits": chinese_script_marker_hits(prompt),
        "pronunciationNotes": pronunciation_notes(row, prompt),
    }


def load_prompts(path: Path) -> list[dict[str, Any]]:
    parsed = load_json(path)
    clips = parsed.get("clips") if isinstance(parsed, dict) else parsed
    if not isinstance(clips, list) or not clips:
        raise SystemExit("prompt manifest must be a JSON list or { clips: [...] }")
    prompts: list[dict[str, Any]] = []
    for index, row in enumerate(clips, start=1):
        if not isinstance(row, dict):
            raise SystemExit(f"prompt manifest row {index} is not an object")
        prompts.append(prompt_row(path, row, index))
    return prompts


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def default_out_dir(profile_id: str) -> Path:
    return DEFAULT_OUT_ROOT / f"{profile_id}-{utc_stamp()}"


def required_pronunciation_preset_ids(prompt_set: str) -> list[str]:
    return PRODUCT_PRONUNCIATION_PRESET_IDS if prompt_set == "extended" else REQUIRED_PRONUNCIATION_PRESET_IDS


def coverage_summary(prompts: list[dict[str, Any]], *, prompt_set: str) -> dict[str, Any]:
    covered = sorted({feature for prompt in prompts for feature in prompt["coverageFeatures"]})
    required_presets = required_pronunciation_preset_ids(prompt_set)
    covered_presets = sorted({preset_id for prompt in prompts for preset_id in prompt.get("pronunciationPresetIds", [])})
    return {
        "requiredCoverageFeatures": REQUIRED_COVERAGE_FEATURES,
        "coveredFeatures": covered,
        "missingCoverageFeatures": [feature for feature in REQUIRED_COVERAGE_FEATURES if feature not in covered],
        "requiredPronunciationPresetIds": required_presets,
        "coveredPronunciationPresetIds": covered_presets,
        "missingPronunciationPresetIds": [preset_id for preset_id in required_presets if preset_id not in covered_presets],
    }


def html_list(items: list[str]) -> str:
    if not items:
        return ""
    return "\n".join(f"<li>{html.escape(item)}</li>" for item in items)


def write_cue_sheet_html(
    *,
    path: Path,
    profile_id: str,
    manifest_path: Path,
    recordings_dir: Path,
    rows: list[dict[str, Any]],
    coverage: dict[str, Any],
    proof_command: str,
    record_missing_until_complete_command: str,
    record_next_missing_command: str,
    record_and_prove_command: str,
    record_prove_and_product_proof_command: str,
    record_prove_product_proof_and_lora_command: str,
) -> None:
    covered = ", ".join(str(feature) for feature in coverage["coveredFeatures"]) or "none"
    missing = ", ".join(str(feature) for feature in coverage["missingCoverageFeatures"]) or "none"
    covered_presets = ", ".join(str(preset_id) for preset_id in coverage["coveredPronunciationPresetIds"]) or "none"
    missing_presets = ", ".join(str(preset_id) for preset_id in coverage["missingPronunciationPresetIds"]) or "none"
    clip_count = len(rows)
    cards: list[str] = []
    for row in rows:
        notes = html_list(row.get("pronunciationNotes", []))
        target_duration_sec = row.get("durationTargetSec") or row.get("recommendedDurationSec")
        target_duration = f"{target_duration_sec:g}s" if isinstance(target_duration_sec, (int, float)) else "auto"
        notes_block = f"""
          <section class="notes">
            <h3>Pronunciation notes</h3>
            <ul>{notes}</ul>
          </section>
        """ if notes else ""
        cards.append(
            f"""
        <article class="clip">
          <header>
            <span>{html.escape(str(row["id"]))}</span>
            <span class="duration-target">Target {html.escape(target_duration)}</span>
            <code>{html.escape(str(row["audioPath"]))}</code>
          </header>
          <p>{html.escape(str(row["transcript"]))}</p>
          {notes_block}
        </article>
            """.strip()
        )

    document = f"""<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AnyVoice recording cue sheet - {html.escape(profile_id)}</title>
  <style>
    :root {{
      color-scheme: light;
      --ink: #191714;
      --muted: #6d645b;
      --paper: #fbfaf7;
      --panel: #ffffff;
      --line: #dfd8cf;
      --accent: #00796b;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      padding: 28px;
      background: var(--paper);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }}
    main {{
      max-width: 880px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }}
    h1, h2, h3, p {{ margin: 0; }}
    h1 {{ font-size: 28px; line-height: 1.15; }}
	    .meta, .rule {{
	      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      font-size: 14px;
    }}
	    .rule strong {{ color: var(--ink); }}
	    .proof {{
	      display: grid;
	      gap: 8px;
	      padding: 12px 14px;
	      border: 1px solid var(--line);
	      border-radius: 8px;
	      background: var(--panel);
	    }}
	    .proof p {{
	      color: var(--muted);
	      font-size: 14px;
	    }}
	    .proof code {{
	      display: block;
	      padding: 10px;
	      border-radius: 6px;
	      background: #f5f1eb;
	      color: var(--ink);
	      white-space: pre-wrap;
	      overflow-wrap: anywhere;
	    }}
	    .clips {{ display: grid; gap: 12px; }}
    .clip {{
      display: grid;
      gap: 10px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      break-inside: avoid;
    }}
    .clip header {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }}
    .clip header span {{
      color: var(--accent);
      font-weight: 800;
    }}
    .duration-target {{
      padding: 2px 7px;
      border-radius: 999px;
      background: #e9f4ff;
      color: #0f5d89 !important;
      font-weight: 700 !important;
    }}
    code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }}
    .clip p {{
      font-size: 20px;
      line-height: 1.6;
      letter-spacing: 0;
    }}
    .notes {{
      display: grid;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
    }}
    .notes h3 {{
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0;
    }}
    .notes ul {{
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }}
    .notes li {{
      padding: 4px 7px;
      border-radius: 6px;
      background: #e6f3ef;
      color: #0b6258;
      font-size: 13px;
    }}
    @media print {{
      body {{ padding: 12mm; background: #fff; }}
      .clip {{ page-break-inside: avoid; }}
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <h1>AnyVoice recording cue sheet</h1>
      <p class="meta">Profile: {html.escape(profile_id)}<br />Manifest: {html.escape(str(manifest_path))}<br />Recordings: {html.escape(str(recordings_dir))}</p>
    </header>
	    <section class="rule">
	      <strong>Read only the transcript text.</strong> Pronunciation notes are rehearsal guidance only; do not read note labels, pinyin, or zhuyin into the recording. Use each card target as the timer; every clip must still land between 6-20 seconds with at least 5.2 seconds of speech.
	      <br />Coverage: {html.escape(covered)}. Missing: {html.escape(missing)}.
	      <br />Pronunciation presets: {html.escape(covered_presets)}. Missing presets: {html.escape(missing_presets)}.
	    </section>
		    <section class="proof">
		      <h2>After recording proof</h2>
		      <p>Record all missing clips from the AnyVoice repo. Each take is validated before the next prompt appears; the command stops on the first bad take.</p>
		      <code>{html.escape(record_missing_until_complete_command)}</code>
		      <p>For a single focused take, this records only the next missing clip and validates that clip immediately.</p>
		      <code>{html.escape(record_next_missing_command)}</code>
		      <p>After all {clip_count} WAV files exist, run this from the AnyVoice repo. It checks the kit, enrolls the clips, validates transcripts, runs the quality gate, and stops before LoRA dataset export.</p>
		      <code>{html.escape(proof_command)}</code>
	      <p>If you want one bulk terminal run after rehearsal, this records or skips existing WAVs, checks the kit, then runs the same proof chain.</p>
	      <code>{html.escape(record_and_prove_command)}</code>
	      <p>For the stricter 10x claim, this continues into the paired prompt-vs-hi-fi product proof with the required speaker backend.</p>
	      <code>{html.escape(record_prove_and_product_proof_command)}</code>
	      <p>After product proof passes, this also exports the consented LoRA dataset handoff for adapter training.</p>
	      <code>{html.escape(record_prove_product_proof_and_lora_command)}</code>
	    </section>
	    <section class="clips">
      {"".join(cards)}
    </section>
  </main>
</body>
</html>
"""
    write_text(path, document)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a folder kit for recording AnyVoice profile enrollment clips outside the browser.")
    parser.add_argument("--prompt-set", choices=sorted(PROMPT_SET_MANIFESTS), default="standard", help="Built-in prompt set. Use extended for the 10-clip stability/LoRA capture path.")
    parser.add_argument("--prompt-manifest", help="Prompt source. Overrides --prompt-set when provided.")
    parser.add_argument("--out-dir", help="Output directory. Defaults to generated/voice-profile-recording-kits/<profile-id>-<timestamp>.")
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--audio-extension", default="wav", help="Expected extension for recorded files, without a dot.")
    args = parser.parse_args()

    prompt_set = "custom" if args.prompt_manifest else args.prompt_set
    prompt_manifest = Path(args.prompt_manifest).expanduser().resolve() if args.prompt_manifest else PROMPT_SET_MANIFESTS[args.prompt_set].resolve()
    prompts = load_prompts(prompt_manifest)
    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else default_out_dir(args.profile_id)
    prompts_dir = out_dir / "prompts"
    recordings_dir = out_dir / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    audio_ext = args.audio_extension.lstrip(".") or "wav"

    manifest_rows: list[dict[str, Any]] = []
    for index, prompt in enumerate(prompts, start=1):
        stem = f"profile-clip-{index:02d}"
        prompt_path = prompts_dir / f"{stem}.txt"
        audio_path = f"recordings/{stem}.{audio_ext}"
        transcript = str(prompt["transcript"])
        duration_target_sec = recommended_duration_sec(transcript)
        write_text(prompt_path, transcript + "\n")
        manifest_rows.append(
            {
                "id": stem,
                "expectedStem": stem,
                "audioPath": audio_path,
                "transcript": transcript,
                "transcriptScript": str(prompt["transcriptScript"]),
                "recommendedDurationSec": duration_target_sec,
                "durationMode": "auto",
                "durationTargetSec": duration_target_sec,
                "coverageFeatures": prompt["coverageFeatures"],
                "pronunciationPresetIds": prompt["pronunciationPresetIds"],
                "scriptMarkerHits": prompt["scriptMarkerHits"],
                "pronunciationNotes": prompt["pronunciationNotes"],
                "sourceKind": "scripted",
            }
        )

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "promptSet": prompt_set,
                "requiredClips": len(manifest_rows),
                "clips": manifest_rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    coverage = coverage_summary(prompts, prompt_set=prompt_set)
    cue_sheet_html = out_dir / "cue-sheet.html"
    open_cue_sheet_command = command(["python3", "-m", "webbrowser", "-t", cue_sheet_html.as_uri()])

    import_command = (
        f"{resolve_analyzer_python()} "
        f"scripts/import_voice_profile_clips.py --manifest {manifest_path} --build-profile"
    )
    check_command = f"python3 scripts/check_voice_profile_recording_kit.py --manifest {manifest_path} --profile-id {args.profile_id}"
    record_all_command = (
        "python3 scripts/record_voice_profile_recording_kit.py "
        f"--manifest {manifest_path} --open-cue-sheet --microphone-smoke-sec 2 --check --profile-id {args.profile_id} --countdown-sec 2 --write-metadata --auto-duration"
    )
    record_next_missing_command = (
        "python3 scripts/record_voice_profile_recording_kit.py "
        f"--manifest {manifest_path} --next-missing --open-cue-sheet --microphone-smoke-sec 2 --profile-id {args.profile_id} --countdown-sec 2 --write-metadata --check-selected --auto-duration"
    )
    record_missing_until_complete_command = (
        "python3 scripts/record_voice_profile_recording_kit.py "
        f"--manifest {manifest_path} --record-missing-until-complete --open-cue-sheet --microphone-smoke-sec 2 --profile-id {args.profile_id} --countdown-sec 2 --write-metadata --check --auto-duration"
    )
    preflight_brief_command = (
        "python3 scripts/record_voice_profile_recording_kit.py "
        f"--manifest {manifest_path} --preflight --brief --profile-id {args.profile_id} --auto-duration"
    )
    record_and_prove_command = f"{record_missing_until_complete_command} --run-proof-after-check"
    record_prove_and_product_proof_command = f"{record_missing_until_complete_command} --run-product-proof-after-check"
    record_prove_product_proof_and_lora_command = f"{record_missing_until_complete_command} --prepare-lora-after-product-proof"
    rehearse_command = (
        "python3 scripts/record_voice_profile_recording_kit.py "
        f"--manifest {manifest_path} --rehearse --no-default-recorder --auto-duration --profile-id {args.profile_id}"
    )
    enroll_command = f"python3 scripts/enroll_voice_profile_kit.py --manifest {manifest_path} --profile-id {args.profile_id}"
    verify_command = f"python3 scripts/verify_voice_profile_ready.py --profile-json .anyvoice/voices/{args.profile_id}/profile.json"
    proof_command = (
        "python3 scripts/voice_profile_next_step.py "
        f"--profile-json .anyvoice/voices/{args.profile_id}/profile.json "
        f"--kit-manifest {manifest_path} "
        f"--profile-id {args.profile_id} "
        "--record-countdown-sec 2 --run --auto-advance --allow-enroll --allow-expensive "
        "--stop-before-lora --max-steps 3"
    )
    duration_targets = "\n".join(f"- `{row['id']}`: {row['durationTargetSec']:g} seconds" for row in manifest_rows)
    write_cue_sheet_html(
        path=cue_sheet_html,
        profile_id=args.profile_id,
        manifest_path=manifest_path,
        recordings_dir=recordings_dir,
        rows=manifest_rows,
        coverage=coverage,
        proof_command=proof_command,
        record_missing_until_complete_command=record_missing_until_complete_command,
        record_next_missing_command=record_next_missing_command,
        record_and_prove_command=record_and_prove_command,
        record_prove_and_product_proof_command=record_prove_and_product_proof_command,
        record_prove_product_proof_and_lora_command=record_prove_product_proof_and_lora_command,
    )
    readme = f"""# AnyVoice Profile Recording Kit

Prompt set: `{prompt_set}` ({len(manifest_rows)} clips).

Record each prompt into the matching file under `recordings/`.

Open `cue-sheet.html` for a clean reading view with the exact prompts and
pronunciation notes.

```bash
{open_cue_sheet_command}
```

- Keep each clip between 6 and 20 seconds.
- Keep at least 5.2 seconds of real speaking in each clip; long pauses do not count.
- Use a quiet room and keep a stable distance from the microphone.
- Read the prompt exactly; do not paraphrase or switch Simplified/Traditional Chinese.
- Pronunciation notes are cue-sheet guidance only. Do not read the note labels
  or add pinyin/zhuyin into the recorded transcript.
- Save files as `{audio_ext}` with the exact names already listed in `manifest.json`.
- The terminal recorder refuses target durations outside 6-20 seconds unless
  `--allow-out-of-range-duration` is used for debugging.
- Generated record commands use `--auto-duration` so long Mandarin, Latin-name,
  and polyphone prompts get more time without leaving the 6-20 second gate.
- Generated record commands also run `--microphone-smoke-sec 2` before writing
  kit audio, so bad permissions, low input gain, or clipping stop the session
  before a real profile take is saved.
- The cue sheet and `manifest.json` include a per-clip `recommendedDurationSec`
  target; use those targets instead of forcing every prompt into the same take
  length.
- The checker flags a take as rushed when it is more than 2 seconds below its
  per-clip target, even if it still passes the generic 6-second minimum.
- The checker also blocks clipped or very quiet recordings before import; adjust
  microphone gain and re-record instead of trying to fix source damage later.
- The manifest/checker also track exact pronunciation preset IDs. For the
  extended path, the kit must cover the core risky terms plus `行長` and
  `VoxCPM2`, not just the broad polyphone category.

Auto-duration targets:

{duration_targets}

To record from the terminal, rehearse first, then record all missing clips. The
second command checks each take before moving to the next prompt and stops on the
first failed take:

```bash
{rehearse_command}
{record_missing_until_complete_command}
```

To inspect the current recording status without parsing JSON:

```bash
{preflight_brief_command}
```

To record one focused take instead:

```bash
{record_next_missing_command}
```

To bulk-record without per-take validation after rehearsal:

```bash
{record_all_command}
```

To record, check, and continue into the no-microphone proof chain in one shot:

```bash
{record_and_prove_command}
```

To also run the stricter paired 10x/product proof after that chain passes:

```bash
{record_prove_and_product_proof_command}
```

To export the consented LoRA dataset handoff after that product proof passes:

```bash
{record_prove_product_proof_and_lora_command}
```

If the auto-detected recorder cannot access your microphone, install `sox` or
pass a recorder template with `--recorder-command`. Supported placeholders are
`{{audio_path}}`, `{{duration}}`, `{{index}}`, `{{id}}`, `{{prompt_path}}`, and
`{{transcript}}`.

After recording:

```bash
{proof_command}
```

That command runs the kit check, imports clips, rebuilds the profile, validates
ASR transcript alignment, runs the quality gate, and stops before LoRA dataset
export. To import only without the expensive proof gates, run:

```bash
{enroll_command}
```

To inspect each phase manually:

```bash
{check_command}
{import_command}
{verify_command}
```
"""
    write_text(out_dir / "README.md", readme)
    write_text(recordings_dir / ".gitkeep", "")

    print(
        json.dumps(
            {
                "status": "written",
                "kit": str(out_dir),
                "manifest": str(manifest_path),
                "cueSheetHtml": str(cue_sheet_html),
                "openCueSheetCommand": open_cue_sheet_command,
                "prompts": str(prompts_dir),
                "recordings": str(recordings_dir),
                "clips": len(manifest_rows),
                "clipSpecs": manifest_rows,
                "promptSet": prompt_set,
                "summary": coverage,
                "recordCommand": record_missing_until_complete_command,
                "recordMissingUntilCompleteCommand": record_missing_until_complete_command,
                "recordNextMissingCommand": record_next_missing_command,
                "recordAllCommand": record_all_command,
                "preflightBriefCommand": preflight_brief_command,
                "recordAndProveCommand": record_and_prove_command,
                "recordProveAndProductProofCommand": record_prove_and_product_proof_command,
                "recordProveProductProofAndLoraCommand": record_prove_product_proof_and_lora_command,
                "rehearseCommand": rehearse_command,
                "checkCommand": check_command,
                "enrollCommand": enroll_command,
                "proofCommand": proof_command,
                "importCommand": import_command,
                "verifyCommand": verify_command,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
