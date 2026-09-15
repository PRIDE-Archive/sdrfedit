"""Splits a token stream into visible answer text and <think>...</think> content.

Some reasoning models emit their chain-of-thought inline in `content` (see
SYSTEM_PROMPT's output-format instruction). Empirically (verified directly
against the deployed model), this one reliably emits the closing </think> but
usually omits the opening <think> -- it treats the very start of generation as
already inside the block. So each round is assumed to start "thinking" by
default; an explicit <think> if the model does emit one is harmless (its text
just becomes part of the suppressed prefix, discarded the same as everything
else before </think>).

If </think> never appears at all in a round (the model answered directly,
no chain-of-thought this turn), flush() releases everything buffered as the
answer -- so a round that never "thinks" still isn't silently dropped.
"""

from __future__ import annotations

CLOSE_TAG = "</think>"


class ThinkingSplitter:
    def __init__(self) -> None:
        self._buffer = ""
        self._in_thinking = True
        self._saw_close_tag = False

    @property
    def saw_close_tag(self) -> bool:
        """True once </think> has actually been seen this round.

        Lets a caller distinguish "the model answered directly, no thinking"
        (flush() text is a legitimate short answer) from "the model was still
        mid-thought when the round ended, e.g. cut off by a token cap"
        (flush() text is a runaway, possibly huge chunk of raw reasoning that
        should not be dumped on the user as-is -- see agent.py).
        """
        return self._saw_close_tag

    def feed(self, text: str) -> str:
        """Feed the next content fragment.

        Returns the newly-visible text (possibly empty, while still assumed
        to be inside the thinking block). While in the assumed thinking
        block, fed text is only ever held in the buffer, never discarded --
        it's not safe to drop until we actually see </think>, since a round
        that never emits it needs the whole thing released at flush().
        """
        self._buffer += text
        if not self._in_thinking:
            visible, self._buffer = self._buffer, ""
            return visible

        idx = self._buffer.find(CLOSE_TAG)
        if idx == -1:
            return ""

        self._buffer = self._buffer[idx + len(CLOSE_TAG) :]
        self._in_thinking = False
        self._saw_close_tag = True
        visible, self._buffer = self._buffer, ""
        return visible

    def flush(self) -> str:
        """Call once the round's stream ends.

        If </think> was seen, this is just whatever trailing text is still
        buffered (usually nothing -- feed() releases visible text
        immediately once past the tag). If </think> was never seen, the
        model didn't think this turn -- release the whole buffer as the
        answer rather than silently dropping it.
        """
        text, self._buffer = self._buffer, ""
        self._in_thinking = False
        return text
