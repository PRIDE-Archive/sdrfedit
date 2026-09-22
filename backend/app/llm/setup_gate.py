"""Deterministic checks before setup suggestions can become Apply cards."""
from ..tools import templates

MAX_SAMPLE_COUNT = 10000


class SetupGate:
    def __init__(self, store, session_id, accession=None, pride_only=False, explicit_documents=()):
        self.store, self.session_id, self.accession = store, session_id, accession
        self.pride_only = pride_only
        self.explicit_documents = set(explicit_documents)
        self.pride_ready = not accession
        self.conflict = False
        self.publication = None
        self.reads = {}

    def observe(self, name, result):
        if not isinstance(result, dict):
            return
        if name == "find_publication":
            self.conflict = result.get("status") in {"identifier_conflict", "needs_confirmation"}
            self.publication = result if result.get("found") else None
        if result.get("error") or result.get("ok") is False:
            return
        if name == "get_pride_metadata" and result.get("accession") == self.accession:
            self.pride_ready = True
        if name == "read_document":
            doc = result.get("documentId")
            for section, info in (result.get("sectionInfo") or {}).items():
                if info.get("returnedChars", 0):
                    self.reads.setdefault((doc, section), []).append(
                        (info["offset"], info["offset"] + info["returnedChars"]))

    def reason(self):
        if not self.pride_ready:
            return "Fetch get_pride_metadata for the current accession before proposing."
        if self.conflict:
            return "Resolve the publication identifier conflict or title confirmation before proposing."
        if self.pride_only:
            return None
        for doc in self.store.list_for_session(self.session_id):
            if self.accession and doc.document_id not in self.explicit_documents:
                if not self.publication:
                    continue
                identifiers = {**doc.metadata, **(doc.metadata.get("identifiers") or {})}
                matched = any(self.publication.get(key) and str(self.publication[key]).lower() ==
                           str(identifiers.get(key, "")).lower() for key in ("pmcid", "pmid", "doi"))
                if not matched and not any(candidate.get("url") == doc.origin for candidate in self.publication.get("pdfCandidates", [])):
                    continue
            sections = doc.document.sections or {"body": doc.document.markdown}
            required = [key for key in ("methods", "results", "tables", "body") if sections.get(key)]
            if not required:
                continue
            complete = True
            for key in required:
                end = 0
                for start, stop in sorted(self.reads.get((doc.document_id, key), [])):
                    if start > end:
                        break
                    end = max(end, stop)
                complete &= end >= len(sections[key])
            if complete:
                return None
        return ("No fully read matching paper evidence. Resolve the publication, acquire/upload the matching paper, "
                "then read methods/results/tables (or body), following nextReads until complete. "
                "If unavailable, ask for the paper, or ask the user to explicitly reply 'Continue with PRIDE metadata only'. Do not invent sample counts.")

    async def filter(self, actions):
        setup = [a for a in actions if a.step == "setup"]
        if not setup:
            return actions, []
        reason = self.reason()
        if reason:
            return [a for a in actions if a.step != "setup"], [reason]
        template_ops = {"setTechnologyTemplate": {"technology"}, "setSampleTemplate": {"sample"},
                        "setExperimentTemplates": {"experiment", "sample"}}
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
                names = action.args[0] if action.op == "setExperimentTemplates" else action.args
                if any(not isinstance(n, str) or n not in entries or entries[n].get("layer") not in template_ops[action.op] for n in names):
                    rejected.append(f"{action.op}: unknown template or wrong template layer.")
                    continue
            kept.append(action)
        return kept, rejected
