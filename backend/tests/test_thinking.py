from app.llm.thinking import ThinkingSplitter


def feed_all(splitter: ThinkingSplitter, chunks: list[str]) -> str:
    visible = [splitter.feed(chunk) for chunk in chunks]
    visible.append(splitter.flush())
    return "".join(visible)


def test_close_tag_only_suppresses_everything_before_it():
    """Empirically, the model reliably emits </think> but omits the opening
    <think> -- it treats generation as already inside the block."""
    chunks = ["Let me think about this...", "reasoning here", "</think>", "The answer", " is 42."]
    result = feed_all(ThinkingSplitter(), chunks)
    assert result == "The answer is 42."


def test_close_tag_split_across_chunk_boundaries():
    chunks = ["hmm reasoning", "</th", "ink>", "Done."]
    result = feed_all(ThinkingSplitter(), chunks)
    assert result == "Done."


def test_explicit_open_tag_is_harmless_and_also_suppressed():
    chunks = ["<think>", "hmm reasoning", "</think>", "Done."]
    result = feed_all(ThinkingSplitter(), chunks)
    assert result == "Done."


def test_no_close_tag_at_all_releases_everything_at_flush():
    """The model sometimes answers directly with no chain-of-thought --
    that text must not be silently dropped."""
    splitter = ThinkingSplitter()
    assert splitter.feed("Direct answer, ") == ""
    assert splitter.feed("no thinking this time.") == ""
    assert splitter.flush() == "Direct answer, no thinking this time."


def test_text_after_close_tag_streams_immediately_not_just_at_flush():
    splitter = ThinkingSplitter()
    assert splitter.feed("reasoning</think>Hello") == "Hello"
    assert splitter.feed(" world") == " world"
    assert splitter.flush() == ""


def test_single_chunk_containing_the_whole_thing():
    result = feed_all(ThinkingSplitter(), ["reasoning</think>Final answer."])
    assert result == "Final answer."
