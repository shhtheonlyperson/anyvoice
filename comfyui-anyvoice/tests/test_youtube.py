"""Parity tests for the lib/youtube-import.ts port (URL/time parsing, VTT,
segment planning, subtitle picking, fixed slices)."""

from anyvoice_comfy.youtube import (
    VttCue,
    clamp_scan_window,
    parse_time_param,
    parse_vtt,
    parse_youtube_url,
    pick_subtitle_file,
    plan_fixed_slices,
    plan_segments,
    select_cues_text,
)


class TestParseTimeParam:
    def test_bare_integer(self):
        assert parse_time_param("300") == 300

    def test_trailing_unit_forms(self):
        assert parse_time_param("300s") == 300
        assert parse_time_param("5m0s") == 300
        assert parse_time_param("1h2m3s") == 3723
        assert parse_time_param("2m") == 120

    def test_clock_forms(self):
        assert parse_time_param("5:00") == 300
        assert parse_time_param("1:05:00") == 3900

    def test_junk_returns_zero(self):
        assert parse_time_param(None) == 0
        assert parse_time_param("") == 0
        assert parse_time_param("abc") == 0
        assert parse_time_param("1:2:3:4") == 0
        assert parse_time_param("-5") == 0


class TestParseYoutubeUrl:
    def test_watch_url_with_t(self):
        parsed = parse_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=300")
        assert parsed is not None
        assert parsed.video_id == "dQw4w9WgXcQ"
        assert parsed.start_seconds == 300

    def test_youtu_be(self):
        parsed = parse_youtube_url("https://youtu.be/dQw4w9WgXcQ?t=5m0s")
        assert parsed is not None
        assert parsed.video_id == "dQw4w9WgXcQ"
        assert parsed.start_seconds == 300

    def test_shorts_and_embed(self):
        assert parse_youtube_url("https://www.youtube.com/shorts/dQw4w9WgXcQ").video_id == "dQw4w9WgXcQ"
        assert parse_youtube_url("https://www.youtube.com/embed/dQw4w9WgXcQ").video_id == "dQw4w9WgXcQ"

    def test_start_param_fallback(self):
        parsed = parse_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=90")
        assert parsed.start_seconds == 90

    def test_invalid(self):
        assert parse_youtube_url("") is None
        assert parse_youtube_url("not a url") is None
        assert parse_youtube_url("https://example.com/watch?v=dQw4w9WgXcQ") is None
        assert parse_youtube_url("https://www.youtube.com/watch?v=short") is None


class TestClampScanWindow:
    def test_default_window(self):
        assert clamp_scan_window(0) == (0, 180)

    def test_clamps_to_band(self):
        assert clamp_scan_window(10, 5) == (10, 40)
        assert clamp_scan_window(10, 9999) == (10, 310)

    def test_negative_start(self):
        assert clamp_scan_window(-5) == (0, 180)


VTT_SAMPLE = """WEBVTT

00:00:01.000 --> 00:00:04.000
你好大家好

00:00:04.000 --> 00:00:09.500
<c>今天我們來談談</c>聲音

00:00:09.500 --> 00:00:09.900


00:00:10.000 --> 00:00:15.000
聲音的故事
"""


class TestParseVtt:
    def test_parses_cues_and_strips_tags(self):
        cues = parse_vtt(VTT_SAMPLE)
        assert [c.text for c in cues] == ["你好大家好", "今天我們來談談聲音", "聲音的故事"]
        assert cues[0].start == 1.0
        assert cues[1].end == 9.5

    def test_skips_empty_cues(self):
        assert all(c.text for c in parse_vtt(VTT_SAMPLE))


class TestPlanSegments:
    def test_chunks_to_target_band(self):
        cues = [VttCue(start=float(i * 5), end=float(i * 5 + 5), text=f"句子{i}") for i in range(12)]
        segments = plan_segments(cues, 0, 60)
        assert segments
        for seg in segments:
            assert seg.end - seg.start >= 6
            assert seg.end - seg.start <= 18

    def test_dedupes_rolling_captions(self):
        cues = [
            VttCue(start=0, end=7, text="你好世界"),
            VttCue(start=7, end=14, text="你好世界 今天天氣"),
        ]
        segments = plan_segments(cues, 0, 20)
        assert len(segments) == 1
        assert segments[0].text == "你好世界 今天天氣"

    def test_empty_without_overlap(self):
        cues = [VttCue(start=100, end=110, text="外面")]
        assert plan_segments(cues, 0, 60) == []


class TestSelectCuesText:
    def test_merges_and_dedupes(self):
        cues = [
            VttCue(start=0, end=5, text="你好"),
            VttCue(start=5, end=10, text="你好"),
            VttCue(start=10, end=15, text="世界"),
        ]
        assert select_cues_text(cues, 0, 20) == "你好 世界"


class TestPickSubtitleFile:
    def test_prefers_zh_hant(self):
        files = ["youtube.en.vtt", "youtube.zh-Hant.vtt", "youtube.zh-CN.vtt"]
        picked = pick_subtitle_file(files)
        assert picked == ("youtube.zh-Hant.vtt", "zh-hant")

    def test_any_zh_before_other(self):
        files = ["youtube.en.vtt", "youtube.zh-CN.vtt"]
        assert pick_subtitle_file(files)[0] == "youtube.zh-CN.vtt"

    def test_none_without_vtt(self):
        assert pick_subtitle_file(["youtube.srt"]) is None


class TestPlanFixedSlices:
    def test_covers_window(self):
        slices = plan_fixed_slices(180)
        assert slices
        assert slices[0][0] == 0
        for rel_start, duration in slices:
            assert duration >= 6 or rel_start + duration >= 180

    def test_too_short_window(self):
        assert plan_fixed_slices(4) == []
