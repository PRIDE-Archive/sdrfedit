"""PDF parsing contract.

The wizard assistant only needs a paper as clean text split into sections, so
every backend (MinerU cloud, self-hosted MinerU, local CLI) implements the same
two methods and returns a `ParsedDocument`.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

SECTION_HEADING_RE = re.compile(r"^\s{0,3}#{1,4}\s+(.+?)\s*$", re.MULTILINE)
# "2.1." or "IV)" style numbering, but only when a separator follows, so that a
# title like "Conclusions" is not mistaken for roman numerals.
HEADING_NUMBER_RE = re.compile(r"^(?:\d+(?:\.\d+)*[.)]?|[ivxlc]+[.)])\s+")

SECTION_ALIASES = {
    "main text": "body",
    "full text": "body",
    "article text": "body",
    "body": "body",
    "abstract": "abstract",
    "introduction": "introduction",
    "background": "introduction",
    "methods": "methods",
    "method": "methods",
    "materials and methods": "methods",
    "material and methods": "methods",
    "experimental procedures": "methods",
    "experimental": "methods",
    "experimental section": "methods",
    "sample preparation": "methods",
    "mass spectrometry": "methods",
    "lc-ms/ms analysis": "methods",
    "data analysis": "methods",
    "results": "results",
    "results and discussion": "results",
    "discussion": "discussion",
    "conclusion": "conclusion",
    "conclusions": "conclusion",
}


class PdfParseError(RuntimeError):
    """Raised when a document cannot be parsed; the message is shown to the user."""


@dataclass
class ParsedDocument:
    markdown: str
    sections: dict[str, str] = field(default_factory=dict)
    parser: str = ""
    page_count: int | None = None

    @property
    def char_count(self) -> int:
        return len(self.markdown)

    def preview(self, limit: int = 600) -> str:
        return self.markdown[:limit]

    def evidence_sections(self) -> dict[str, str]:
        """Use original keys for reads, including documents parsed before aliases changed."""
        sections = self.sections or {"body": self.markdown}
        # Heading labels describe parser output, not evidence quality.
        return {name: text for name, text in sections.items() if text.strip()}



class PdfParser(ABC):
    """A pluggable PDF → markdown backend."""

    name: str = "base"

    @abstractmethod
    async def parse_bytes(self, data: bytes, file_name: str) -> ParsedDocument:
        """Parse an uploaded PDF."""

    @abstractmethod
    async def parse_url(self, url: str) -> ParsedDocument:
        """Parse a PDF reachable at a public URL."""


def normalize_heading(title: str) -> str:
    lowered = re.sub(r"\s+", " ", title or "").strip().lower().rstrip(".:")
    lowered = HEADING_NUMBER_RE.sub("", lowered)
    for alias, canonical in SECTION_ALIASES.items():
        if lowered == alias or lowered.startswith(alias):
            return canonical
    return lowered or "other"


def split_markdown_sections(markdown: str) -> dict[str, str]:
    """Group markdown content under canonical paper section names."""
    if not markdown:
        return {}

    matches = list(SECTION_HEADING_RE.finditer(markdown))
    if not matches:
        return {"body": markdown.strip()}

    sections: dict[str, list[str]] = {}
    preamble = markdown[: matches[0].start()].strip()
    if preamble:
        sections.setdefault("abstract", []).append(preamble)

    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        name = normalize_heading(match.group(1))
        body = markdown[match.end() : end].strip()
        if body:
            sections.setdefault(name, []).append(body)

    return {name: "\n\n".join(parts) for name, parts in sections.items()}
