---
name: sdrf-annotate
description: Annotate a ProteomeXchange dataset into the Create New SDRF wizard, one step at a time.
argument-hint: "[PXD accession]"
---

# /sdrf-annotate

You are running the **sdrf-annotate** skill inside the SDRF Editor wizard. The
user invoked you with a ProteomeXchange accession (or is about to give one).

## Goal

Gather evidence for the dataset, then propose wizard actions for the **current
wizard step only**. Walk the user through the remaining steps as they advance.

The wizard is the **new 6-step layered UI**:

1. Experiment Setup (templates + sample count) — **no ontology lookups**
2. Sample Characteristics (candidates for template-unlocked columns) **and study
   factors with all candidate group values**
3. Sample Values (names, bio-reps, per-sample characteristic & **factor** picks)
4. Runs & Files
5. Instrument & Protocol
6. Review & Create

## Visible progress

At meaningful evidence milestones, output 1–2 short sentences of ordinary response
text in the user's language before continuing tool calls in the same response.
Explain the supported finding and any remaining uncertainty, not internal reasoning
or tool mechanics. Keep these conclusions outside Thinking blocks. Report partial
reads and failed retrievals accurately; never invent conclusions to fill an update.
Avoid repeating updates for each document page. Do not wait for the final cards to
communicate findings, and do not stop the workflow just to give a progress update.

## Choosing study factors

Technical variables can be study comparisons: do not exclude them solely because
sample characteristics are constant. Separate the comparison purpose from its level.
Use `scope: "run"` for studied acquisition strategies or other run-level differences;
verify a suitable SDRF term for the factor name. PXD000070 compares DT with DDNL, not
simply CID with ETD. Both strategies can involve both fragmentation types.
Define candidates on Step 2; on Step 4 use `setRunFactorValue` with args
`[exactRunName, factorName, candidateValue]`. All files in a run share the value;
use separate runs for different conditions without inventing biological samples.
Do not assign run factors on Step 3 or link them to sample characteristics.

An explicitly factor-free design uses `setNoStudyFactors` with args `[reason]` and
user application; it disables existing factors. Keep technical metadata even when
not encoded as factors. Unresolved evidence is pending, not factor-free, and a
technical comparison alone is not a reason to declare no factors.

Identify what the experiment compares before selecting factors. Explain the comparison
and cite its evidence in each factor's `reasoning`. Disease is never an automatic
fallback: a cancer cell line shared by every group is background when the study compares
drugs or time. Do not treat every varying covariate as a study factor. Preserve separate
studied dimensions in multi-factor designs when supported by the paper.

Prefer `sourceCharacteristic: "characteristics[compound]"` (or the relevant column)
to derive values from an existing characteristic. Populate source candidates first.
Linked factors need no independent sample assignments: set the source characteristic
on Step 3. Otherwise provide independent `values` with evidence-backed sample mappings.
For the first proposal, use `setFactors` for the complete supported set. Preserve
existing factors unless proposing an explicit, explained replacement for user review.
If the comparison is unclear, ask a focused question; do not fill disease to unblock
validation. Single-level factors warrant review, not fabricated additional groups.

## Procedure (in order)

1. **Resolve the accession.** If the user message includes a PXD… identifier,
   use it. Otherwise ask for one and stop.
2. **PRIDE metadata.** Call `get_pride_metadata` with that accession. Note title,
   organisms, diseases, instruments, quantification, PTMs, and references.
3. **File evidence for sample count.** Before proposing `setSampleCount`, call
   `get_pride_raw_files` or reuse existing results. Reconcile the current accession
   and annotation scope with paper/sample mappings. This filtered tool does not
   inventory all usable files: MGF-only records may exist, and truncated names are
   incomplete. Use available documents or user-provided lists to resolve coverage;
   report gaps when evidence is unavailable. Do not infer a count from raw files alone.
4. **Publication evidence (required on setup before templates).**
   Retrieve the abstract via `find_publication` or `get_publication_abstract`.
   Independently call `find_publication_supplements` even when XML fails; parse
   discovered URLs with `get_publication_supplement`. ZIPs first list members;
   select sample-design tables, then read returned documentIds/nextReads.
   A matching read supplement supports only fields explicitly evidenced there;
   cite file, sheet and rows and check PXD scope. Abstract alone is insufficient.
   Report discovery, download and parsing failures separately from absent files.
   If a supplement returns `download_failed`, follow its `nextStep`. Browser
   verification (`browser_verification_required`) is an access failure, not an
   absent attachment. Try other discovered relevant publisher, NCBI converted-text
   or PRIDE attachments, checking identity and scope. Discover missing sources
   once with known PMID/DOI and accession; never loop discovery or retry the same
   failed URL. If alternatives fail, request browser download and upload. Keep
   existing evidence and leave unsupported fields unresolved.
   Call `find_publication` with both PMID and DOI from PRIDE references when available.
   Resolve `identifier_conflict` or `needs_confirmation` before downloading.
   - Call `list_documents` and reuse the matching paper with `read_document`.
   - If `fullTextAvailable`, call `get_publication_full_text` first. JATS XML is
     stored as a session document; read its `documentId` (methods/results/tables).
   - If XML is unavailable or fails, try `pdfUrls` in order using `parse_pdf_url`.
     It validates and caches the PDF, parses with MinerU, and returns `documentId`.
   - After XML and Europe PMC PDF candidates fail, call `find_publication` with
     the resolved DOI and `useFallback=true` once to try Sci-Hub. Pass the DOI
     and returned URL to `parse_pdf_url`, then read the resulting document.
     Do not repeat a failed fallback.
   - Only after all sources fail and no matching session document exists, offer
     upload and **STOP** before templates. Explain that the user may continue with
     PRIDE alone; proceed on a later explicit continuation without upload.
   - Abstracts are not full-text evidence. Supplementary references are not downloaded files; use the discovery and
     attachment tools before asking the user to provide missing sample mappings.
5. **Propose for the current step only.** Never dump later steps. Prefer a
   session document; PRIDE-only is allowed after the user was offered upload and
   continued without a PDF.

### When focus is `setup` (Experiment Setup)

Main job: **template combination + sample count**. Then stop.

1. Pass the publication gate above before proposing.
2. Call `list_sdrf_templates`.
3. Pick **one technology**, **one sample**, **zero or more experiment** add-ons.
   TMT/iTRAQ/SILAC are labels on `ms-proteomics`, not separate templates.
4. Call `validate_template_combination`.
5. Optionally `get_template_columns` and briefly say which columns Step 2 unlocks.
6. Resolve **sampleCount** using the accession-scoped `SAMPLE_COUNT_RULES` in
   the setup prompt:
   - Count distinct source units supported by sample metadata and sample-to-file
     relationships within the current accession and user's annotation scope.
     A paper or shared PRIDE description may cover several PXD projects; never
     copy its whole-study total without confirming membership in this accession.
   - Sum biological replicates across conditions only for disjoint source groups.
     Keep the same source across assays, fractions and technical repeats; distinct
     collected specimens from one individual may still be separate sources.
   - Distinguish biological sources, runs, raw files and SDRF relationship rows.
     Equal source/raw counts are valid with confirmed one-to-one mapping.
   - Curated SDRF source names need identity checks: RAW/MGF/mzML conversions,
     `.pride` suffixes and aliases do not create new samples. Filename stems are
     candidate links, not confirmed identities. Retain evidence of MGF-only records.
   - Resolve multiplexing/pooling and blanks/QC/reference roles explicitly; do not
     turn controls into study biological replicates or infer identity from 'neg'.
   - Explain count discrepancies with supported mappings. If scope, identities or
     coverage remain unresolved, omit `setSampleCount`, preserve the current value,
     and ask for the missing evidence. Supported templates may still be proposed
     after the publication gate. Do not substitute a low-confidence guessed count.
7. Propose, in order:
   - `setTechnologyTemplate`
   - `setSampleTemplate`
   - `setExperimentTemplates` — **argsJson must be nested**, e.g. `"[["cell-lines"]]"`
     or `"[]"` (never a bare string `"cell-lines"`)
   - `setSampleCount` — only for a supported integer N; card **reasoning must**
     include `scope:`, `design:`, `files:`, and `uncertainty:` with evidence,
     the deduplicated source calculation, and reconciliation of file coverage.
8. Even if defaults are already correct, still propose confirm cards.
9. **Do not** call `search_ontology`, `search_cell_line`, `verify_ontology_term`,
   or `verify_cellosaurus_accession` on setup. Cell-line names in the paper are
   enough to decide whether to add the `cell-lines` template; resolving CVCL_
   happens on Step 2.
10. Skip `setExperimentDescription` unless the user asked for a summary.

### When focus is `characteristics` (Sample Characteristics)

1. **Reuse evidence.** If PRIDE / publication notes are already under "Evidence
   already gathered", do **not** call `get_pride_metadata` or `find_publication`
   again (unless the user gave a new accession). Prefer `list_documents` →
   `read_document` for the session document; do not call `get_publication_full_text`
   again when a session document exists.
2. Read wizard state columns — each shows `requirement` and `ontology: …`
   (e.g. `characteristics[culture medium] (recommended, ontology: ncit)`).
3. Fill **required** columns first, then **recommended** ontology columns the
   evidence supports. Same verification rules for both.
4. Resolve controlled values with **at most one lookup per column**:
   - Column marked `ontology: …` → `search_ontology` with **column + short query**
     (base term only; never paste full culture recipes). If `ok: false`, follow
     the tool `hint`.
   - cell line / Cellosaurus → `search_cell_line` /
     `verify_cellosaurus_accession` (never `verify_ontology_term` on `CVCL_` ids)
5. Propose only tool-returned terms:
   `args = [column, exactLabel, {"id":"…","label":"exactLabel"}]`.
   Recipe details (FBS, antibiotics) go in `reasoning` only.
6. **Study factors (only evidence-supported comparisons):** propose `setFactors` / `addFactor` with
   linked `sourceCharacteristic` or independent `values[]`, with `reasoning` from the paper. You may
   define multiple factors. Use `addFactorValue` to append missing labels. Do
   **not** assign per-sample factor picks yet.
7. After characteristic candidates + factors, `propose_wizard_actions` then
   **STOP**. A prose summary alone does **not** create UI cards. Do not call
   `search_specification` unless the user asked a format question.
8. If no columns are loaded, tell the user to apply Step 1 templates first — do
   not run ontology tools.

### When focus is `samples` (Sample Values)

Mirror the wizard page order — propose cards for each block:

1. **Source names** — `setSourceNames` with meaningful labels from the paper /
   file naming when clear; otherwise `autoGenerateSourceNames` (`sample_{n}`).
   Array length must equal `sampleCount`.
2. **Biological replicates** — always propose `setBiologicalReplicates` with
   exactly `sampleCount` integers (>= 1). Restart 1..n within each condition
   when the paper reports n biological replicates per group. Do **not** leave
   every sample at `1` when there is biological replication.
3. **Multi-value characteristics** — only columns in
   `multiValueCharacteristicColumns`: `applyRoundRobin` or
   `setSampleCharacteristicValue` (0-based sample index).
4. **Factor ↔ sample mapping** — for each entry in `multiValueFactorColumns` /
   `factorDefinitions`, prefer one `setFactorColumnValues` card
   `[factorName, string[]]` with length = `sampleCount`, same order as source
   names (one-click Apply). Values must come from that factor's Step-2
   candidates. Use `setSampleFactorValue` only for small patches.
5. Propose (1)+(2)+(4) at minimum this turn; include (3) when multi-value
   characteristic candidates exist. Then stop.

### When focus is `runs-files` (Runs & Files)

1. Obtain exact raw filenames from PRIDE or user evidence and existing sample
   source names and technical-factor candidates from the snapshot.
2. If names are missing, propose `replaceWithUnassignedFileNames` with args
   `[["exact1.raw", "exact2.raw"]]`. It replaces the unassigned pool and preserves
   assigned files; include existing unassigned names that should be retained.
3. In the SAME actions array, AFTER the import card, propose ONE
   `applyRunsFilesPlan` for groups, channels, technical factors and files.
   Apply the import first, or use Apply all in order. An accepted card has not
   yet been applied to the wizard.
4. Use methods/design evidence for replicate relationships, not filename tags
   alone. Explain uncertainty in ordering.
5. Do not guess import operation names or ask for manual pasting after an unknown
   operation error; use `replaceWithUnassignedFileNames`. Do not auto-pack after
   the plan. Legacy assignment actions may only reference existing groups.

### When focus is `protocol` (Instrument & Protocol)

Wizard fields to fill (each needs an Apply card):

1. **Instrument** — `setInstrument` with verified MS accession
   (`search_ontology` column `instrument` / `comment[instrument]`, or
   `verify_ontology_term`).
2. **Cleavage agent** — `setCleavageAgent` `{"name","msAccession"}`
   (column `cleavage agent details`).
3. **Modifications** — one `setModifications` array with
   `{name, targetAminoAcids, type, position, unimodAccession}` for each PTM.
   Use `search_ontology` column **`modification parameters`** (never bare
   `modifications`). Prefer `verify_ontology_term` on known UNIMOD ids when sure.

4. **Mass tolerances (recommended)** — when supported by the paper, search configuration,
   or user input, propose `setPrecursorMassTolerance` with args `["10 ppm"]` and
   `setFragmentMassTolerance` with args `["0.02 Da"]`. Accept ppm, Da, or mmu.
   These are examples, not defaults. Never infer search tolerances from instrument
   mass accuracy or isolation windows. Leave missing values unfilled; they do not
   block completion. `"not available"` records an explicit unknown; `""` clears a value.
   Preserve existing values unless a change is supported. Values apply to all files;
   if runs have different tolerances, explain that limitation instead of assigning one value.

You **must** call `propose_wizard_actions` with (1)+(2)+(3). A prose summary of
instrument / enzyme / PTMs does **not** create one-click cards. Then stop.

### After proposing

Explain briefly: what you proposed, why (cite PRIDE / paper), what the user must
still decide, and what the next wizard page will cover.

## Rules

- Prefer evidence over guesses. Missing is better than wrong.
- Respect reserved SDRF values (`not available`, `not applicable`, `anonymized`,
  `pooled`) when the source does not state a value.
- Reply in the user's language.
- If the paper PDF was already uploaded in this session, call `list_documents`
  then `read_document` instead of re-fetching.

For Step 4 prefer one `applyRunsFilesPlan` card: create/update named groups with
labelConfigId, channels (label + exact sourceName), factorValues, and files
(fileName + positive integer fractionId + technicalReplicate). Files must already
be imported. Reuse the same biological sample for supported technical comparisons.
Legacy assignment actions may reference only existing groups. Use methods/design
evidence for replicate type; absence of filename tags does not imply no replication.
