import numpy as np
import pytest

from app.config import Settings
from app.parsing.base import normalize_heading, split_markdown_sections
from app.parsing.mineru_api import extract_markdown_from_zip
from app.parsing.base import PdfParseError
from app.rag.chunker import SpecChunk
from app.rag.store import SpecStore, tokenize
from app.session import MAX_EVIDENCE_ENTRIES, SessionStore
from app.tools.literature import _next_step, parse_jats
from app.tools.ontology import ontologies_for
from app.tools.pride import normalize_accession
from app.tools.http import ToolHttpError


@pytest.fixture
def store(tmp_path):
    settings = Settings(spec_index_dir=str(tmp_path / "index"), embedding_api_key="")
    return SpecStore(settings)


def _chunk(chunk_id: str, title: str, text: str) -> SpecChunk:
    return SpecChunk(
        chunk_id=chunk_id,
        title=title,
        heading_path=[title],
        section_number="1",
        anchor=f"#{chunk_id}",
        text=text,
    )


async def test_lexical_search_finds_the_right_section(store):
    store.save(
        [
            _chunk("reserved", "Reserved words", "not available, not applicable, anonymized and pooled are reserved."),
            _chunk("factors", "Factor values", "factor value columns describe the study variable under investigation."),
        ],
        vectors=None,
        source="test",
        embedding_model=None,
    )

    assert store.ready
    assert store.retrieval_mode == "lexical"

    hits = await store.search("which reserved words exist", k=2)
    assert hits[0].chunk.chunk_id == "reserved"


async def test_search_returns_nothing_for_empty_index(store):
    assert await store.search("anything") == []
    assert store.retrieval_mode == "unavailable"


async def test_vectors_are_persisted_and_normalized(store):
    store.save(
        [_chunk("a", "A", "alpha text"), _chunk("b", "B", "beta text")],
        vectors=[[3.0, 0.0], [0.0, 4.0]],
        source="test",
        embedding_model="fake",
    )

    assert store.has_vectors
    norms = np.linalg.norm(store._vectors, axis=1)
    assert np.allclose(norms, 1.0)
    # No embedding key configured, so retrieval stays lexical even with vectors present.
    assert store.retrieval_mode == "lexical"


def test_tokenize_drops_stopwords_but_keeps_column_syntax():
    tokens = tokenize("What is the format of comment[label]?")
    assert "comment" in tokens
    assert "the" not in tokens


def test_normalize_accession_extracts_from_free_text():
    assert normalize_accession("please annotate pxd012345 for me") == "PXD012345"
    with pytest.raises(ToolHttpError):
        normalize_accession("no accession here")


def test_ontologies_for_column_strips_the_wrapper():
    assert ontologies_for("characteristics[disease]") == ["efo", "mondo", "doid"]
    assert ontologies_for("comment[instrument]") == ["ms"]
    assert ontologies_for("characteristics[culture medium]") == ["ncit"]
    assert ontologies_for("characteristics[unmapped thing]")  # falls back to defaults


def test_ontologies_for_protocol_column_aliases():
    assert ontologies_for("modifications") == ["unimod", "mod"]
    assert ontologies_for("modification parameters") == ["unimod", "mod"]
    assert ontologies_for("comment[modification parameters]") == ["unimod", "mod"]
    assert ontologies_for("cleavage agent") == ["ms"]
    assert ontologies_for("cleavage agent details") == ["ms"]
    assert ontologies_for("enzyme") == ["ms"]


def test_split_markdown_sections_groups_aliases():
    markdown = """# Title

## Abstract
We measured proteins.

## Materials and Methods
Cells were lysed and digested with trypsin.

## Results
We found proteins.
"""
    sections = split_markdown_sections(markdown)
    assert "methods" in sections
    assert "trypsin" in sections["methods"]
    assert "results" in sections


def test_normalize_heading_handles_numbering():
    assert normalize_heading("2.1. Experimental procedures") == "methods"
    assert normalize_heading("Conclusions") == "conclusion"


def test_parse_jats_extracts_titled_sections():
    xml = """<article>
      <front><article-meta><title-group><article-title>A paper</article-title></title-group>
      <abstract><p>Short abstract.</p></abstract></article-meta></front>
      <body>
        <sec><title>Methods</title><p>Trypsin digestion, TMT 10-plex labelling.</p></sec>
        <sec><title>References</title><p>Should be skipped.</p></sec>
      </body>
    </article>"""
    parsed = parse_jats(xml)

    assert parsed["title"] == "A paper"
    assert "TMT 10-plex" in parsed["sections"]["methods"]
    assert "references" not in parsed["sections"]


def test_evidence_is_scoped_per_session_and_deduplicated_by_key():
    store = SessionStore()

    store.add_evidence("a", "pride:PXD1", "40 raw files")
    store.add_evidence("a", "pride:PXD1", "42 raw files")
    store.add_evidence("a", "publication:PMC1", "open access")
    store.add_evidence("b", "pride:PXD9", "other session")
    store.add_evidence("a", "empty", "   ")

    texts = [note.text for note in store.get_evidence("a")]
    assert texts == ["42 raw files", "open access"]
    assert [note.text for note in store.get_evidence("b")] == ["other session"]
    assert store.get_evidence("unknown") == []


def test_evidence_keeps_only_the_most_recent_entries():
    store = SessionStore()
    for index in range(MAX_EVIDENCE_ENTRIES + 3):
        store.add_evidence("a", f"key{index}", f"note {index}")

    notes = store.get_evidence("a")
    assert len(notes) == MAX_EVIDENCE_ENTRIES
    assert notes[-1].text == f"note {MAX_EVIDENCE_ENTRIES + 2}"


def test_extract_markdown_from_zip_picks_the_largest_markdown():
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("small.md", "# tiny")
        archive.writestr("full.md", "# real content\n" + "x" * 500)
        archive.writestr("layout.json", "{}")

    assert "real content" in extract_markdown_from_zip(buffer.getvalue())

    with pytest.raises(PdfParseError):
        extract_markdown_from_zip(b"not a zip")


def test_literature_next_step_prefers_xml_session_document():
    for has_pdf in (True, False):
        message = _next_step(True, has_pdf, True).lower()
        assert "get_publication_full_text first" in message
        assert "session document" in message
        assert "read_document" in message


def test_literature_next_step_non_oa_asks_upload_and_stop():
    message = _next_step(False, False, False).lower()
    assert "list_documents" in message
    assert "upload" in message
    assert "stop" in message or "do not propose" in message

    fallback_message = _next_step(False, False, True).lower()
    assert "usefallback=true" in fallback_message
    assert "sci-hub" in fallback_message

    # Non-OA but with pdfUrls still goes through MinerU parse.
    pdf_message = _next_step(False, True, True).lower()
    assert "parse_pdf_url" in pdf_message
    assert "check_pdf_url" in pdf_message
