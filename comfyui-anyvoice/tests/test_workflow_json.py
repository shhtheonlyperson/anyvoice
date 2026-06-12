"""Sanity checks on the shipped example workflow: a valid 0.4 graph whose
custom node types, widget orders, and link endpoints match nodes.py."""

import json
from pathlib import Path

import pytest

WORKFLOW_DIR = Path(__file__).resolve().parents[1] / "example_workflows"
WORKFLOWS = sorted(WORKFLOW_DIR.glob("*.json"))

# Widget-bearing inputs per custom node, in serialized order: required inputs
# in schema declaration order, then optional. Must match define_schema in
# anyvoice_comfy/nodes.py (connections like clips/profile/audio don't count).
EXPECTED_WIDGETS = {
    "AnyVoiceYouTubeImport": ["url", "consent", "start_seconds", "scan_seconds", "transcript_override", "asr_language"],
    "AnyVoiceReferenceFromAudio": ["transcript", "consent", "source_kind", "auto_transcribe", "asr_language"],
    "AnyVoiceClipsPreview": ["clip_index"],
    "AnyVoiceEnrollProfile": ["display_name", "max_clips", "profile_id"],
    "AnyVoiceVoiceClone": ["target_text", "quality", "clone_mode", "seed", "prefer_hot_worker"],
    "ComfySwitchNode": ["switch"],
}

# Index of the consent widget per consent-gated node type.
CONSENT_INDEX = {"AnyVoiceYouTubeImport": 1, "AnyVoiceReferenceFromAudio": 1}

KNOWN_CORE = {"PreviewAudio", "SaveAudio", "Note", "LoadAudio", "RecordAudio"}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_expected_template_exists():
    names = {p.stem for p in WORKFLOWS}
    assert names == {"AnyVoice Voice Clone"}


@pytest.mark.parametrize("workflow_path", WORKFLOWS, ids=lambda p: p.stem)
class TestWorkflowJson:
    def test_is_ui_format_04(self, workflow_path):
        data = load(workflow_path)
        assert data["version"] == 0.4
        assert data["last_node_id"] >= max(n["id"] for n in data["nodes"])
        assert data["last_link_id"] >= max(l[0] for l in data["links"])

    def test_widget_value_counts_match_schema(self, workflow_path):
        data = load(workflow_path)
        for node in data["nodes"]:
            expected = EXPECTED_WIDGETS.get(node["type"])
            if expected is not None:
                assert len(node["widgets_values"]) == len(expected), (workflow_path.stem, node["type"])

    def test_links_are_consistent(self, workflow_path):
        data = load(workflow_path)
        nodes = {n["id"]: n for n in data["nodes"]}
        link_ids = set()
        for link_id, origin_id, origin_slot, target_id, target_slot, link_type in data["links"]:
            assert link_id not in link_ids, f"duplicate link id {link_id}"
            link_ids.add(link_id)
            origin = nodes[origin_id]
            target = nodes[target_id]
            assert origin["outputs"][origin_slot]["type"] == link_type
            assert link_id in origin["outputs"][origin_slot]["links"]
            assert target["inputs"][target_slot]["link"] == link_id
            assert target["inputs"][target_slot]["type"] == link_type
        # Every link id referenced by a node exists in the links table.
        for node in data["nodes"]:
            for output in node.get("outputs", []):
                for link_id in output.get("links") or []:
                    assert link_id in link_ids
            for inp in node.get("inputs", []):
                if inp.get("link") is not None:
                    assert inp["link"] in link_ids

    def test_consent_ships_unchecked(self, workflow_path):
        data = load(workflow_path)
        gated = [n for n in data["nodes"] if n["type"] in CONSENT_INDEX]
        assert gated, "every template must contain a consent-gated entry node"
        for node in gated:
            assert node["widgets_values"][CONSENT_INDEX[node["type"]]] is False

    def test_uses_only_known_node_types(self, workflow_path):
        data = load(workflow_path)
        for node in data["nodes"]:
            assert node["type"] in KNOWN_CORE or node["type"] in EXPECTED_WIDGETS


def test_combined_template_ships_all_three_sources():
    data = load(WORKFLOW_DIR / "AnyVoice Voice Clone.json")
    types = [node["type"] for node in data["nodes"]]
    assert types.count("AnyVoiceYouTubeImport") == 1
    assert types.count("LoadAudio") == 1
    assert types.count("RecordAudio") == 1
    assert types.count("AnyVoiceReferenceFromAudio") == 2
    assert types.count("ComfySwitchNode") == 4


def test_youtube_source_ships_empty_url():
    data = load(WORKFLOW_DIR / "AnyVoice Voice Clone.json")
    import_node = next(n for n in data["nodes"] if n["type"] == "AnyVoiceYouTubeImport")
    assert import_node["widgets_values"][0] == ""


def test_audio_sources_ship_with_distinct_modes():
    data = load(WORKFLOW_DIR / "AnyVoice Voice Clone.json")
    source_nodes = [n for n in data["nodes"] if n["type"] == "AnyVoiceReferenceFromAudio"]
    source_kinds = {n["widgets_values"][2]: n for n in source_nodes}
    assert set(source_kinds) == {"uploaded", "scripted"}
    assert source_kinds["uploaded"]["widgets_values"][0] == ""
    transcript = source_kinds["scripted"]["widgets_values"][0]
    assert len(transcript) >= 20, "record template must prefill the default script to read"


def test_switches_default_to_youtube_path():
    data = load(WORKFLOW_DIR / "AnyVoice Voice Clone.json")
    switches = [n for n in data["nodes"] if n["type"] == "ComfySwitchNode"]
    assert len(switches) == 4
    assert all(n["widgets_values"] == [False] for n in switches)
    assert {n["title"] for n in switches} == {
        "Use uploaded audio?",
        "Use recording?",
        "Source preview: uploaded audio?",
        "Source preview: recording?",
    }

    links = {link_id: (origin_id, origin_slot, target_id, target_slot, link_type) for link_id, origin_id, origin_slot, target_id, target_slot, link_type in data["links"]}
    nodes = {node["id"]: node for node in data["nodes"]}

    clips_selector = nodes[21]
    assert clips_selector["inputs"][0]["link"] == 3
    assert clips_selector["inputs"][1]["link"] == 4
    assert links[3][0] == 20  # non-record path comes from the uploaded-vs-youtube selector
    assert links[4][0] == 14  # recording override comes directly from the scripted recording source
