"""Ontology column exposure, search feedback, and propose gate."""

from __future__ import annotations

import pytest

from app.llm.agent import _gate_ontology_actions, _record_verified_terms
from app.schemas import CharacteristicColumnInfo, WizardAction, WizardSnapshot
from app.tools.ontology import COLUMN_ONTOLOGIES, ontologies_for
from app.tools.templates import _ontologies_from_validators


def test_culture_medium_maps_to_ncit():
    assert COLUMN_ONTOLOGIES["culture medium"] == ["ncit"]
    assert ontologies_for("characteristics[culture medium]") == ["ncit"]


def test_ontologies_from_validators_parses_yaml_shape():
    column = {
        "name": "characteristics[culture medium]",
        "validators": [
            {
                "validator_name": "ontology",
                "params": {"ontologies": ["ncit"]},
            }
        ],
    }
    assert _ontologies_from_validators(column) == ["ncit"]


@pytest.mark.asyncio
async def test_search_terms_requires_column(monkeypatch):
    from app.tools import ontology

    with pytest.raises(Exception) as exc:
        await ontology.search_terms("RPMI 1640", column=None)
    assert "column" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_search_terms_no_match_returns_ok_false_with_hint(monkeypatch):
    from app.tools import ontology

    async def fake_get_json(*_args, **_kwargs):
        return {"response": {"docs": []}}

    monkeypatch.setattr(ontology, "get_json", fake_get_json)
    result = await ontology.search_terms(
        "RPMI 1640 supplemented with 10% FBS",
        column="characteristics[culture medium]",
    )
    assert result["ok"] is False
    assert result["ontologiesSearched"] == ["ncit"]
    assert "hint" in result
    assert "RPMI 1640" in result["hint"] or "base medium" in result["hint"].lower()


@pytest.mark.asyncio
async def test_search_terms_hit_returns_ok_true(monkeypatch):
    from app.tools import ontology

    async def fake_get_json(*_args, **_kwargs):
        return {
            "response": {
                "docs": [
                    {
                        "obo_id": "NCIT:C178973",
                        "label": "Roswell Park Memorial Institute 1640 Medium",
                        "ontology_prefix": "NCIT",
                        "is_obsolete": False,
                    }
                ]
            }
        }

    monkeypatch.setattr(ontology, "get_json", fake_get_json)
    result = await ontology.search_terms(
        "RPMI 1640",
        column="characteristics[culture medium]",
    )
    assert result["ok"] is True
    assert result["terms"][0]["id"] == "NCIT:C178973"


def test_gate_rejects_free_text_culture_medium():
    snapshot = WizardSnapshot(
        characteristicColumns=[
            CharacteristicColumnInfo(
                name="characteristics[culture medium]",
                requirement="recommended",
                ontologies=["ncit"],
            )
        ]
    )
    actions = [
        WizardAction(
            step="characteristics",
            op="addCharacteristicChoice",
            args=[
                "characteristics[culture medium]",
                "RPMI 1640 supplemented with 10% fetal bovine serum",
            ],
            label="Culture medium recipe",
        )
    ]
    kept, rejected = _gate_ontology_actions(actions, snapshot, set(), set())
    assert kept == []
    assert any("refused free-text" in item for item in rejected)


def test_gate_accepts_verified_ontology_term():
    snapshot = WizardSnapshot(
        characteristicColumns=[
            CharacteristicColumnInfo(
                name="characteristics[culture medium]",
                requirement="recommended",
                ontologies=["ncit"],
            )
        ]
    )
    verified_ids = {"ncit:c178973"}
    verified_labels = {"roswell park memorial institute 1640 medium"}
    actions = [
        WizardAction(
            step="characteristics",
            op="addCharacteristicChoice",
            args=[
                "characteristics[culture medium]",
                "Roswell Park Memorial Institute 1640 Medium",
                {
                    "id": "NCIT:C178973",
                    "label": "Roswell Park Memorial Institute 1640 Medium",
                },
            ],
            label="Culture medium: RPMI 1640",
        )
    ]
    kept, rejected = _gate_ontology_actions(actions, snapshot, verified_ids, verified_labels)
    assert rejected == []
    assert len(kept) == 1
    assert kept[0].args[1] == "Roswell Park Memorial Institute 1640 Medium"


def test_gate_normalizes_short_query_to_ols_label():
    """Model often proposes 'RPMI 1640' while OLS returns the official NCIT name."""
    snapshot = WizardSnapshot(
        characteristicColumns=[
            CharacteristicColumnInfo(
                name="characteristics[culture medium]",
                requirement="recommended",
                ontologies=["ncit"],
            )
        ]
    )
    verified_ids = {"ncit:c178973"}
    actions = [
        WizardAction(
            step="characteristics",
            op="addCharacteristicChoice",
            args=[
                "characteristics[culture medium]",
                "RPMI 1640",
                {
                    "id": "NCIT:C178973",
                    "label": "Roswell Park Memorial Institute 1640 Medium",
                },
            ],
            label="Culture medium: RPMI 1640",
        )
    ]
    kept, rejected = _gate_ontology_actions(actions, snapshot, verified_ids, set())
    assert rejected == []
    assert kept[0].args[1] == "Roswell Park Memorial Institute 1640 Medium"


def test_gate_allows_reserved_without_term():
    snapshot = WizardSnapshot(
        characteristicColumns=[
            CharacteristicColumnInfo(
                name="characteristics[culture medium]",
                requirement="recommended",
                ontologies=["ncit"],
            )
        ]
    )
    actions = [
        WizardAction(
            step="characteristics",
            op="addCharacteristicChoice",
            args=["characteristics[culture medium]", "not available"],
            label="Culture medium unknown",
        )
    ]
    kept, rejected = _gate_ontology_actions(actions, snapshot, set(), set())
    assert rejected == []
    assert len(kept) == 1


def test_gate_allows_pattern_columns_without_ontology():
    snapshot = WizardSnapshot(
        characteristicColumns=[
            CharacteristicColumnInfo(
                name="characteristics[passage number]",
                requirement="recommended",
                ontologies=[],
            )
        ]
    )
    actions = [
        WizardAction(
            step="characteristics",
            op="addCharacteristicChoice",
            args=["characteristics[passage number]", "10"],
            label="Passage 10",
        )
    ]
    kept, rejected = _gate_ontology_actions(actions, snapshot, set(), set())
    assert rejected == []
    assert len(kept) == 1


def test_record_verified_terms_from_search_ontology():
    verified_ids: set[str] = set()
    verified_labels: set[str] = set()
    _record_verified_terms(
        "search_ontology",
        {
            "ok": True,
            "terms": [{"id": "NCIT:C178973", "label": "Roswell Park Memorial Institute 1640 Medium"}],
        },
        verified_ids,
        verified_labels,
    )
    assert "ncit:c178973" in verified_ids
    assert "roswell park memorial institute 1640 medium" in verified_labels


def test_atomic_attribute_edit_verifies_terms_and_normalizes_assignments_together():
    snapshot = WizardSnapshot(sampleCount=3, characteristicColumns=[
        CharacteristicColumnInfo(name="characteristics[organism]", ontologies=["ncbitaxon"]),
    ])
    action = WizardAction(step="samples", op="applyCharacteristicDraft", args=[
        "characteristics[organism]",
        [{"value": "human", "ontologyTerm": {"id": "NCBITaxon:9606", "label": "Homo sapiens"}}],
        "explicit", ["human", "", "human"],
    ])
    kept, rejected = _gate_ontology_actions([action], snapshot, {"ncbitaxon:9606"}, {"homo sapiens"})
    assert not rejected and len(kept) == 1
    assert kept[0].args[1][0]["value"] == "Homo sapiens"
    assert kept[0].args[3] == ["Homo sapiens", "", "Homo sapiens"]
    kept, rejected = _gate_ontology_actions([action], snapshot, set(), set())
    assert not kept and rejected


def test_atomic_attribute_edit_rejects_mismatched_assignments_and_unknown_columns():
    snapshot = WizardSnapshot(sampleCount=2, characteristicColumns=["characteristics[age]"])
    for args in [
        ["characteristics[age]", [{"value": "10 year"}], "explicit", ["10 year"]],
        ["characteristics[age]", [{"value": "10 year"}], "explicit", ["10 year", "20 year"]],
        ["characteristics[age]", [{"value": "10 year"}], "shared", ["10 year", "10 year"]],
        ["characteristics[invented]", [{"value": "10 year"}], "explicit", ["10 year", ""]],
        ["characteristics[age]", [{"value": "10 year"}, {"value": "10 year"}], "explicit", ["10 year", ""]],
    ]:
        action = WizardAction(step="samples", op="applyCharacteristicDraft", args=args)
        kept, rejected = _gate_ontology_actions([action], snapshot, set(), set())
        assert not kept and rejected


def test_atomic_attribute_edit_keeps_unassigned_samples_even_with_one_candidate():
    snapshot = WizardSnapshot(sampleCount=2, characteristicColumns=["characteristics[age]"])
    action = WizardAction(step="samples", op="applyCharacteristicDraft", args=[
        "characteristics[age]", [{"value": "10 year"}], "explicit", ["10 year", ""],
    ])
    kept, rejected = _gate_ontology_actions([action], snapshot, set(), set())
    assert not rejected
    assert kept[0].args[3] == ["10 year", ""]
