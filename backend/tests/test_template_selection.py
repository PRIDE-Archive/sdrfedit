"""Generic samples and community templates must remain selectable by the assistant."""
import json
from unittest.mock import AsyncMock

import pytest

from app.tools import templates
from app.template_catalog import CatalogSnapshot
from app.llm.setup_gate import SetupGate
from app.session import SessionStore
from app.llm.agent import _parse_actions


def action(op, args):
    payload = {"actions": [{"op": op, "argsJson": json.dumps(args)}]}
    return _parse_actions(json.dumps(payload), "setup")


@pytest.fixture
def catalogue(monkeypatch):
    entries = {
        "ms-proteomics": {"layer": "technology", "usable_alone": True},
        "dependent-tech": {"layer": "technology", "usable_alone": False},
        **{name: {"layer": "sample"} for name in
           ["human", "metaproteomics", "human-gut", "soil", "water"]},
    }
    monkeypatch.setattr(templates, "_load_manifest", AsyncMock(return_value={"templates": entries}))
    definitions = {f'{name}@1.0.0': dict(name=name, version='1.0.0', columns=[], **entry) for name, entry in entries.items()}
    manifest = {'templates': {name: dict(latest='1.0.0', versions=['1.0.0'], **entry) for name, entry in entries.items()}}
    snap = CatalogSnapshot(dict(snapshotId='a' * 40 + ':1', commitSha='a' * 40, manifest=manifest, definitions=definitions))
    monkeypatch.setattr(templates, '_snapshot', AsyncMock(return_value=snap))
    return entries


@pytest.mark.parametrize("sample", [None, "metaproteomics", "human-gut", "soil", "water"])
async def test_generic_and_community_combinations(catalogue, sample):
    result = await templates.validate_combination("ms-proteomics", sample)
    assert result["valid"], result["errors"]


async def test_dependent_technology_cannot_stand_alone(catalogue):
    result = await templates.validate_combination("dependent-tech", None)
    assert not result["valid"]


@pytest.mark.parametrize("sample", ["fungi", "ms-proteomics"])
async def test_unknown_or_wrong_layer_still_rejected(catalogue, sample):
    assert not (await templates.validate_combination("ms-proteomics", sample))["valid"]


async def test_clear_sample_survives_parser_and_setup_gate(catalogue):
    actions, rejected, _ = action("setSampleTemplate", [None])
    assert actions and not rejected
    gate = SetupGate(SessionStore(), "generic", "PXD1", pride_only=True)
    gate.observe("get_pride_metadata", {"accession": "PXD1"})
    kept, rejected = await gate.filter(actions)
    assert not rejected
    assert kept[0].args == [None]


@pytest.mark.parametrize("op,args", [
    ("setTechnologyTemplate", [None]),
    ("setSampleTemplate", []),
    ("setSampleTemplate", [""]),
    ("setSampleTemplate", [None, "human"]),
])
def test_invalid_template_arguments_remain_rejected(op, args):
    actions, rejected, _ = action(op, args)
    assert not actions and rejected
