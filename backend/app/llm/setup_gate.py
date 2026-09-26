"""Deterministic checks before setup suggestions can become Apply cards."""
from ..tools import templates
from ..tools.literature import normalize_doi

MAX_SAMPLE_COUNT = 10000


class SetupGate:
    def __init__(self, store, session_id, accession=None, pride_only=False, explicit_documents=()):
        self.store, self.session_id, self.accession = store, session_id, accession
        self.pride_only = pride_only
        self.explicit_documents = set(explicit_documents)
        context = store.setup_context(session_id, accession)
        self.pride_ready = context.get("pride_ready", not accession)
        self.conflict = context.get("conflict", False)
        self.publication = context.get("publication")

    def observe(self, name, result):
        if not isinstance(result, dict):
            return
        if name == "find_publication" and not result.get("error"):
            self.conflict = result.get("status") in {"identifier_conflict", "needs_confirmation"}
            if result.get("found"):
                self.publication = result
            elif self.conflict:
                self.publication = None
        if result.get("error") or result.get("ok") is False:
            return
        if name == "get_pride_metadata" and result.get("accession") == self.accession:
            self.pride_ready = True
        self.store.save_setup_context(self.session_id, self.accession, {
            "pride_ready": self.pride_ready, "conflict": self.conflict, "publication": self.publication,
        })
        if name == "read_document":
            self.store.record_document_read(self.session_id, result.get("documentId"), result.get("sectionInfo") or {})

    def reason(self):
        if not self.pride_ready:
            return "Fetch get_pride_metadata for the current accession before proposing."
        if self.conflict:
            return "Resolve the publication identifier conflict or title confirmation before proposing."
        if self.pride_only:
            return None
        pending_reads = []
        diagnostics = []
        for doc in self.store.list_for_session(self.session_id):
            if self.accession and doc.document_id not in self.explicit_documents:
                if not self.publication:
                    diagnostics.append(f"{doc.document_id}: publication identity not resolved for {self.accession}; call find_publication with the PRIDE reference DOI/PMID, not read_document again")
                    continue
                identifiers = {**doc.metadata, **(doc.metadata.get("identifiers") or {})}
                def normalize(key, value):
                    return normalize_doi(str(value)) if key == "doi" else str(value).strip().lower()
                keys = ("pmcid", "pmid", "doi")
                if any(self.publication.get(key) and identifiers.get(key) and
                       normalize(key, self.publication[key]) != normalize(key, identifiers[key]) for key in keys):
                    diagnostics.append(f"{doc.document_id}: DOI/PMID/PMCID conflicts with the selected publication")
                    continue
                matched = any(self.publication.get(key) and identifiers.get(key) and
                              normalize(key, self.publication[key]) == normalize(key, identifiers[key]) for key in keys)
                if not matched and not any(candidate.get("url") == doc.origin for candidate in self.publication.get("pdfCandidates", [])):
                    diagnostics.append(f"{doc.document_id}: no matching publication identifier or discovered URL")
                    continue
            if not doc.evidence_sections():
                diagnostics.append(f"{doc.document_id}: no eligible parsed evidence content; available sections: {list(doc.document.sections)}; kind={doc.metadata.get("evidenceKind", "article")}")
                continue
            pending = doc.unread_sections()
            # A proposal may be supported by an already-read passage even when
            # other pages/sections remain unread. Field sufficiency is assessed
            # by the model from that passage, never inferred from heading names.
            if any(stop > start for ranges in doc.read_ranges.values() for start, stop in ranges):
                return None
            pending_reads.extend(f"read_document(documentId={doc.document_id}, sections=['{name}'], offset={offset})"
                                 for name, offset in pending.items())
        if pending_reads:
            return ("Matching paper is already in this session but has unread sections; no passage has been read yet. Do not download it again or ask for upload. "
                    "Continue with " + "; ".join(pending_reads) + ". Read the passages relevant to the proposed fields. Remaining pages are reported but do not block unrelated supported fields.")
        if diagnostics:
            return "Paper evidence check: " + "; ".join(diagnostics)
        return ("No read matching paper evidence. Resolve the publication, acquire/upload the matching paper, "
                "then read relevant passages using the actual availableSections and nextReads. "
                "If unavailable, ask for the paper, or ask the user to explicitly reply 'Continue with PRIDE metadata only'. Do not invent sample counts.")

    async def filter(self, actions):
        setup = [a for a in actions if a.step == "setup"]
        if not setup:
            return actions, []
        reason = self.reason()
        if reason:
            return [a for a in actions if a.step != "setup"], [reason]
        template_ops = {"setTechnologyTemplate": {"technology"}, "setSampleTemplate": {"sample"},
                        "setSampleTemplates": {"sample"}, "setExperimentTemplates": {"experiment"}}
        entries = {}
        if any(a.op in template_ops for a in setup):
            try:
                entries = (await templates._load_manifest()).get("templates", {})
            except Exception:
                return [a for a in actions if a.step != "setup"], ["Template catalogue unavailable; retry before applying setup suggestions."]
        kept, rejected = [], []
        for action in actions:
            if self.pride_only and action.step == "setup":
                action = action.model_copy(update={"confidence": "low"})
            if action.op in template_ops:
                if action.op == "setSampleTemplate" and action.args == [None]:
                    kept.append(action)
                    continue
                names = action.args[0] if action.op in {"setExperimentTemplates", "setSampleTemplates"} else action.args
                if any(not isinstance(n, str) or n not in entries or entries[n].get("layer") not in template_ops[action.op] for n in names):
                    rejected.append(f"{action.op}: unknown template or wrong template layer.")
                    continue
            kept.append(action)
        return kept, rejected
