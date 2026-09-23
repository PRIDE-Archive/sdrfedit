"""Step-focus prompts must match the new 6-step wizard semantics."""

from app.llm.prompts import (
    CHARACTERISTICS_PROCEDURE,
    PROTOCOL_PROCEDURE,
    RUNS_FILES_PROCEDURE,
    SAMPLE_COUNT_RULES,
    SAMPLES_PROCEDURE,
    SETUP_PROCEDURE,
    STEP_GOALS,
    WIZARD_STEPS_DOC,
    render_step_focus,
    render_wizard_context,
)
from app.schemas import CharacteristicColumnInfo, FactorInfo, MsRunSummary, WizardSnapshot
from app.schemas import OPS_BY_STEP


def test_every_step_advertises_its_entire_operation_whitelist():
    for step, operations in OPS_BY_STEP.items():
        text = render_step_focus(step, None)
        catalogue = text.split("Operation arguments and usage:")[0]
        for operation in operations:
            assert operation in catalogue


def test_runs_files_explains_import_arguments_and_dependency():
    text = render_step_focus("runs-files", WizardSnapshot())
    assert 'replaceWithUnassignedFileNames [["exact1.raw", "exact2.raw"]]' in text
    assert "import card BEFORE the plan card" in text
    assert "existing unassigned names" in text


def test_wizard_steps_doc_matches_new_ui():
    assert "Experiment Setup" in WIZARD_STEPS_DOC
    assert "Runs & Files" in WIZARD_STEPS_DOC
    assert "templates decide" in WIZARD_STEPS_DOC.lower() or "Templates decide" in WIZARD_STEPS_DOC


def test_setup_goal_is_template_first():
    goal = STEP_GOALS["setup"].lower()
    assert "template" in goal
    assert "primary" in goal
    assert "secondary" in goal or "optional" in goal
    assert "description" in goal
    assert "biological replicate" in goal or "sum of biological" in goal
    assert "condition" in goal
    assert "rawfilecount" in goal.replace(" ", "").replace("_", "")


def test_sample_count_rules_define_accession_scoped_sources():
    text = SAMPLE_COUNT_RULES.lower()
    assert "biological" in text
    assert "condition" in text
    assert "raw file" in text or "rawfilecount" in text.replace(" ", "").replace("_", "")
    assert "design:" in SAMPLE_COUNT_RULES
    assert "scope:" in SAMPLE_COUNT_RULES
    assert "files:" in SAMPLE_COUNT_RULES
    assert "uncertainty:" in SAMPLE_COUNT_RULES
    assert SAMPLE_COUNT_RULES in SETUP_PROCEDURE


def test_setup_procedure_forbids_condition_count_as_sample_count():
    text = SETUP_PROCEDURE.lower()
    assert "biological source count" in text
    assert "condition" in text
    assert "rawfilecount" in text.replace(" ", "").replace("_", "") or "raw file" in text
    assert "design:" in SETUP_PROCEDURE


def test_characteristics_goal_uses_template_unlocked_columns():
    goal = STEP_GOALS["characteristics"].lower()
    assert "unlocked" in goal or "template" in goal
    assert "candidate" in goal
    assert "factor" in goal


def test_samples_goal_follows_wizard_order():
    goal = STEP_GOALS["samples"].lower()
    assert "source name" in goal or "biological" in goal
    assert "biological" in goal
    assert "factor" in goal
    assert "setfactorcolumnvalues" in goal.replace(" ", "") or "setFactorColumnValues" in STEP_GOALS["samples"]


def test_runs_files_goal_requires_named_mapping():
    goal = STEP_GOALS["runs-files"].lower()
    assert "applyrunsfilesplan" in goal.replace(" ", "").replace("_", "")
    assert "fraction" in goal or "technical" in goal


def test_protocol_goal_requires_propose_cards():
    goal = STEP_GOALS["protocol"].lower()
    assert "propose_wizard_actions" in STEP_GOALS["protocol"] or "propose" in goal
    assert "setinstrument" in goal.replace(" ", "").replace("_", "") or "instrument" in goal
    assert "modification parameters" in goal or "setmodifications" in goal.replace(" ", "")


def test_render_step_focus_protocol_includes_procedure():
    text = render_step_focus("protocol", WizardSnapshot(sampleCount=1))
    assert PROTOCOL_PROCEDURE.splitlines()[0] in text
    assert "setInstrument" in text
    assert "setCleavageAgent" in text
    assert "setModifications" in text
    assert "propose_wizard_actions" in text
    assert "modification parameters" in text


def test_render_step_focus_runs_files_includes_procedure():
    text = render_step_focus("runs-files", WizardSnapshot(sampleCount=4, msRunCount=0))
    assert RUNS_FILES_PROCEDURE.splitlines()[0] in text
    assert "assignFilesToRunsByName" in text
    assert "Editable table" in text or "fractionId" in text
    assert "No groups yet" in text


def test_render_step_focus_samples_includes_procedure():
    text = render_step_focus("samples", WizardSnapshot(sampleCount=22))
    assert SAMPLES_PROCEDURE.splitlines()[0] in text
    assert "setBiologicalReplicates" in text
    assert "setSourceNames" in text
    assert "setFactorColumnValues" in text
    assert "factor" in text.lower()


def test_render_step_focus_characteristics_includes_factors():
    text = render_step_focus("characteristics", WizardSnapshot(sampleCount=4))
    assert CHARACTERISTICS_PROCEDURE.splitlines()[0] in text
    assert "setFactors" in text
    assert "addFactorValue" in text


def test_render_wizard_context_includes_sample_values_state():
    snapshot = WizardSnapshot(
        sampleCount=4,
        sampleSourceNames=["a", "b", "c", "d"],
        biologicalReplicates=[1, 2, 1, 2],
        multiValueCharacteristicColumns=["characteristics[disease]"],
        factorDefinitions=[FactorInfo(name="compound", values=["none", "EGF"])],
        multiValueFactorColumns=["compound"],
    )
    text = render_wizard_context(snapshot)
    assert "sample source names (4)" in text
    assert "biological replicates (4, 2 distinct)" in text
    assert "multi-value characteristics" in text
    assert "characteristics[disease]" in text
    assert "factor definitions" in text
    assert "compound" in text
    assert "multi-value factors" in text


def test_render_wizard_context_includes_run_file_mapping_state():
    snapshot = WizardSnapshot(
        sampleCount=2,
        msRunCount=2,
        msRunSummaries=[
            MsRunSummary(name="Run 1", sampleSourceNames=["HeLa_Control_rep1"]),
            MsRunSummary(name="Run 2", sampleSourceNames=["HeLa_Control_rep2"]),
        ],
        dataFileCount=2,
        unassignedFileCount=2,
        unassignedFileNames=[
            "HeLa_Proteome_Control_rep1_pH3.raw",
            "HeLa_Proteome_Control_rep2_pH3.raw",
        ],
        hasFractions=True,
        fractionCount=6,
        technicalReplicates=1,
    )
    text = render_wizard_context(snapshot)
    assert "MS run ↔ samples" in text
    assert "HeLa_Control_rep1" in text
    assert "unassigned raw files" in text
    assert "HeLa_Proteome_Control_rep1_pH3.raw" in text
    assert "hasFractions: True" in text


def test_render_step_focus_setup_includes_procedure():
    text = render_step_focus("setup", None)
    assert SETUP_PROCEDURE.splitlines()[0] in text
    assert "list_sdrf_templates" in text
    assert "validate_template_combination" in text
    assert "search_ontology" in text
    assert "Do NOT call search_ontology" in text
    assert "STOP" in text


def test_setup_procedure_prefers_xml_session_document_before_pdf():
    text = SETUP_PROCEDURE.lower()
    assert "list_documents" in SETUP_PROCEDURE
    assert "parse_pdf_url" in SETUP_PROCEDURE
    assert SETUP_PROCEDURE.index("get_publication_full_text") < SETUP_PROCEDURE.index("parse_pdf_url")
    assert "parse_pdf_url" in text
    assert "get_publication_full_text" in SETUP_PROCEDURE
    assert "session document" in text
    assert "upload" in text
    assert "proposing templates" in text or "propose templates" in text
    # Gate must appear before template listing
    assert SETUP_PROCEDURE.index("list_documents") < SETUP_PROCEDURE.index("list_sdrf_templates")
    assert SETUP_PROCEDURE.index("parse_pdf_url") < SETUP_PROCEDURE.index("list_sdrf_templates")


def test_setup_procedure_no_publication_offers_pride_fallback():
    text = SETUP_PROCEDURE.lower()
    assert "no publication was found" in text or "found:false" in text
    assert "pride metadata alone" in text or "pride only" in text


def test_characteristics_procedure_reuses_evidence_and_limits_lookups():
    text = CHARACTERISTICS_PROCEDURE.lower()
    assert "evidence already gathered" in text
    assert "do not call get_pride_metadata" in text
    assert "at most one lookup per column" in text
    assert "search_ontology" in text
    assert "recommended" in text
    assert "search_specification" in text
    assert "stop" in text
    assert "study factors" in text
    assert "setfactors" in text


def test_render_step_focus_characteristics_warns_when_empty():
    snapshot = WizardSnapshot(currentStep=1, currentStepId="characteristics")
    text = render_step_focus("characteristics", snapshot)
    assert CHARACTERISTICS_PROCEDURE.splitlines()[0] in text
    assert "No characteristics columns are loaded" in text


def test_render_step_focus_characteristics_ok_when_columns_present():
    snapshot = WizardSnapshot(
        currentStep=1,
        currentStepId="characteristics",
        characteristicColumns=[
            CharacteristicColumnInfo(name="characteristics[organism]", requirement="required"),
        ],
    )
    text = render_step_focus("characteristics", snapshot)
    assert "No characteristics columns are loaded" not in text


def test_render_wizard_context_includes_requirement():
    snapshot = WizardSnapshot(
        technologyTemplate="ms-proteomics",
        sampleTemplate="human",
        sampleCount=4,
        characteristicColumns=[
            CharacteristicColumnInfo(name="characteristics[disease]", requirement="required"),
            CharacteristicColumnInfo(name="characteristics[age]", requirement="recommended"),
        ],
    )
    text = render_wizard_context(snapshot)
    assert "characteristics[disease] (required)" in text
    assert "characteristics[age] (recommended)" in text


def test_render_wizard_context_includes_column_ontologies():
    snapshot = WizardSnapshot(
        characteristicColumns=[
            CharacteristicColumnInfo(
                name="characteristics[culture medium]",
                requirement="recommended",
                ontologies=["ncit"],
            ),
        ],
    )
    text = render_wizard_context(snapshot)
    assert "characteristics[culture medium] (recommended, ontology: ncit)" in text


def test_render_wizard_context_accepts_legacy_string_columns():
    snapshot = WizardSnapshot(characteristicColumns=["characteristics[organism]"])
    text = render_wizard_context(snapshot)
    assert "characteristics[organism]" in text


def test_rendered_setup_scopes_counts_and_reconciles_file_coverage():
    text = render_step_focus("setup", WizardSnapshot(sampleCount=98))
    for rule in (
        "CURRENT accession",
        "multiple accessions",
        "MGF-only records may exist",
        "Matching filename stems are candidate links",
        "Equality is valid",
        "omit setSampleCount, preserve the current value",
        "Record blanks/QC/reference pools separately",
        "ONLY when groups contain disjoint",
    ):
        assert rule in text
    for obsolete in (
        "NEVER rawFileCount",
        "never set sampleCount = rawFileCount",
        "explicitly reject conditionCount / rawFileCount",
        "universal definition",
    ):
        assert obsolete not in text


def test_setup_distinguishes_pure_cultures_from_communities():
    assert "Pure cultures of fungi" in SETUP_PROCEDURE
    assert "bacteria" in SETUP_PROCEDURE
    assert "sample=null" in SETUP_PROCEDURE
    assert "argsJson='[null]'" in SETUP_PROCEDURE
    assert "pure isolate originating from soil/water is not a microbial community" in SETUP_PROCEDURE
    for template in ("metaproteomics", "human-gut", "soil", "water"):
        assert template in SETUP_PROCEDURE
