from app.skills import parse_slash_command


def test_sdrf_annotate_with_accession():
    skill = parse_slash_command("/sdrf-annotate PXD000547")
    assert skill is not None
    assert skill.name == "sdrf-annotate"
    assert skill.accession == "PXD000547"
    assert "PXD000547" in skill.user_prompt
    assert "PRIDE" in skill.instructions or "get_pride_metadata" in skill.instructions


def test_sdrf_annotate_colon_alias():
    skill = parse_slash_command("/sdrf:annotate PXD1")
    assert skill is not None
    assert skill.name == "sdrf-annotate"
    assert skill.accession == "PXD1"


def test_sdrf_annotate_without_accession_still_loads():
    skill = parse_slash_command("/sdrf-annotate")
    assert skill is not None
    assert skill.accession is None
    assert "accession" in skill.user_prompt.lower()


def test_ordinary_chat_is_not_a_skill():
    assert parse_slash_command("Please annotate PXD000547 for me") is None
    assert parse_slash_command("/unknown PXD1") is None


def test_annotation_skill_uses_scoped_counts_and_preserves_unresolved_values():
    skill = parse_slash_command("/sdrf-annotate PXD001359")
    assert skill is not None
    for rule in (
        "current accession and user's annotation scope",
        "never\n     copy its whole-study total",
        "MGF-only records",
        "Equal source/raw counts are valid",
        "omit `setSampleCount`, preserve the current value",
        "`scope:`, `design:`, `files:`, and `uncertainty:`",
    ):
        assert rule in skill.instructions
    assert "universal definition" not in skill.instructions
    assert "never set\n   `sampleCount` to `rawFileCount`" not in skill.instructions
