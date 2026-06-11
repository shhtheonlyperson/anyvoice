"""Sanity checks on the shipped example workflow: valid 0.4 graph whose custom
node types, widget orders, and link endpoints match nodes.py."""

import json
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[1]
    / "example_workflows"
    / "AnyVoice YouTube Voice Clone.json"
)

# Widget-bearing inputs per custom node, in schema declaration order (links
# excluded). Must match define_schema in anyvoice_comfy/nodes.py.
EXPECTED_WIDGETS = {
    "AnyVoiceYouTubeImport": ["url", "consent", "start_seconds", "scan_seconds", "transcript_override", "asr_language"],
    "AnyVoiceClipsPreview": ["clip_index"],
    "AnyVoiceEnrollProfile": ["display_name", "max_clips", "profile_id"],
    "AnyVoiceVoiceClone": ["target_text", "quality", "clone_mode", "seed", "prefer_hot_worker"],
}


def load():
    return json.loads(WORKFLOW.read_text(encoding="utf-8"))


class TestWorkflowJson:
    def test_is_ui_format_04(self):
        data = load()
        assert data["version"] == 0.4
        assert data["last_node_id"] >= max(n["id"] for n in data["nodes"])
        assert data["last_link_id"] >= max(l[0] for l in data["links"])

    def test_widget_value_counts_match_schema(self):
        data = load()
        for node in data["nodes"]:
            expected = EXPECTED_WIDGETS.get(node["type"])
            if expected is not None:
                assert len(node["widgets_values"]) == len(expected), node["type"]

    def test_links_are_consistent(self):
        data = load()
        nodes = {n["id"]: n for n in data["nodes"]}
        for link_id, origin_id, origin_slot, target_id, target_slot, link_type in data["links"]:
            origin = nodes[origin_id]
            target = nodes[target_id]
            assert origin["outputs"][origin_slot]["type"] == link_type
            assert link_id in origin["outputs"][origin_slot]["links"]
            assert target["inputs"][target_slot]["link"] == link_id
            assert target["inputs"][target_slot]["type"] == link_type

    def test_consent_ships_unchecked_and_url_empty(self):
        data = load()
        import_node = next(n for n in data["nodes"] if n["type"] == "AnyVoiceYouTubeImport")
        url, consent = import_node["widgets_values"][0], import_node["widgets_values"][1]
        assert url == ""
        assert consent is False

    def test_uses_only_known_node_types(self):
        data = load()
        known_core = {"PreviewAudio", "SaveAudio", "Note"}
        for node in data["nodes"]:
            assert node["type"] in known_core or node["type"] in EXPECTED_WIDGETS
