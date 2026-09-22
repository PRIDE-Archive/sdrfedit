"""A scripted OpenAI-compatible endpoint for testing the agent loop offline.

It replays a fixed sequence of tool calls so the whole pipeline (tool dispatch,
citation collection, action validation, SSE framing, and per-step scoping) can
be exercised without an API key or network access to a model provider.

    python scripts/fake_llm_server.py --port 8899

Then point the backend at it:

    LLM_BASE_URL=http://127.0.0.1:8899/v1 LLM_API_KEY=test LLM_MODEL=fake \
      uvicorn app.main:app --port 8000

Progressive dataset scenario
----------------------------
The first turn with a PXD accession gathers evidence and proposes only the
setup-step actions. Later turns whose system prompt focuses on another step
propose only that step's actions (reusing the session evidence cache), so the
backend's focus-step filter and next_step hint can be verified end to end.
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()

FOCUS_RE = re.compile(r'Current focus: step \d+ of \d+, "[^"]+" \((\w[\w-]*)\)')

# Scenario 1a: PXD accession on the setup page → gather evidence, propose setup only.
# Intentionally also emits a protocol action so the backend's focus filter can
# defer it and report it in the tool feedback.
DATASET_SETUP_SCRIPT: list[dict[str, Any]] = [
    {
        "text": "Let me pull the PRIDE record first.",
        "tool_calls": [{"name": "get_pride_metadata", "arguments": {"accession": "PXD000001"}}],
    },
    {
        "text": "Checking the sample-template term.",
        "tool_calls": [
            {
                "name": "search_ontology",
                "arguments": {
                    "query": "Erwinia carotovora",
                    "column": "characteristics[organism]",
                    "limit": 3,
                },
            }
        ],
    },
    {
        "text": "",
        "tool_calls": [
            {
                "name": "propose_wizard_actions",
                "arguments": {
                    "actions": [
                        {
                            "step": "setup",
                            "op": "setTechnologyTemplate",
                            "argsJson": '["ms-proteomics"]',
                            "label": "Technology template: ms-proteomics",
                            "reasoning": "PRIDE lists an Orbitrap instrument and bottom-up proteomics.",
                            "confidence": "high",
                        },
                        {
                            "step": "setup",
                            "op": "setSampleCount",
                            "argsJson": "[6]",
                            "label": "Sample count: 6",
                            "reasoning": "The title says TMT spikes with six reporter ratios.",
                            "confidence": "medium",
                        },
                        {
                            "step": "protocol",
                            "op": "setCleavageAgent",
                            "argsJson": '[{"name":"Trypsin","msAccession":"MS:1001251"}]',
                            "label": "Cleavage agent: Trypsin (deferred)",
                            "reasoning": "Should be deferred until the protocol step.",
                            "confidence": "high",
                        },
                        {
                            "step": "protocol",
                            "op": "notARealOperation",
                            "argsJson": "[]",
                            "label": "Should be rejected server-side",
                            "confidence": "low",
                        },
                    ]
                },
            }
        ],
    },
    {
        "text": (
            "For Experiment Setup I am proposing the MS proteomics technology template "
            "and a sample count of 6, based on the PRIDE record for PXD000001.\n\n"
            "The organism looks like Erwinia carotovora; confirm whether you want a "
            "custom sample template or leave it blank.\n\n"
            "Next I will handle Sample Characteristics once you move on."
        ),
        "tool_calls": [],
    },
]

# Scenario 1b: later step turns reuse cached evidence and propose only that step.
DATASET_STEP_SCRIPTS: dict[str, list[dict[str, Any]]] = {
    "characteristics": [
        {
            "text": "",
            "tool_calls": [
                {
                    "name": "propose_wizard_actions",
                    "arguments": {
                        "actions": [
                            {
                                "step": "characteristics",
                                "op": "addCharacteristicChoice",
                                "argsJson": (
                                    '["characteristics[organism]","Erwinia carotovora",'
                                    '{"id":"NCBITaxon:554","label":"Erwinia carotovora",'
                                    '"ontology":"NCBITAXON"}]'
                                ),
                                "label": "Organism: Erwinia carotovora",
                                "reasoning": "PRIDE organisms list for PXD000001.",
                                "confidence": "high",
                            }
                        ]
                    },
                }
            ],
        },
        {
            "text": (
                "For Sample Characteristics I am adding Erwinia carotovora from the PRIDE "
                "organisms list. Next we will fill in the per-sample values."
            ),
            "tool_calls": [],
        },
    ],
    "protocol": [
        {
            "text": "",
            "tool_calls": [
                {
                    "name": "search_ontology",
                    "arguments": {
                        "query": "Trypsin",
                        "column": "comment[cleavage agent details]",
                        "limit": 3,
                    },
                }
            ],
        },
        {
            "text": "",
            "tool_calls": [
                {
                    "name": "propose_wizard_actions",
                    "arguments": {
                        "actions": [
                            {
                                "step": "protocol",
                                "op": "setCleavageAgent",
                                "argsJson": '[{"name":"Trypsin","msAccession":"MS:1001251"}]',
                                "label": "Cleavage agent: Trypsin",
                                "reasoning": "Verified against the MS ontology.",
                                "confidence": "high",
                            },
                            {
                                "step": "runs-files",
                                "op": "setLabelConfig",
                                "argsJson": '["tmt6"]',
                                "label": "Plex kit: TMT 6-plex (deferred)",
                                "reasoning": "Belongs to Runs & Files, should be deferred.",
                                "confidence": "medium",
                            },
                        ]
                    },
                }
            ],
        },
        {
            "text": (
                "For Instrument & Protocol I am proposing Trypsin (MS:1001251). "
                "The plex kit will wait until you reach Runs & Files."
            ),
            "tool_calls": [],
        },
    ],
    "runs-files": [
        {
            "text": "",
            "tool_calls": [
                {
                    "name": "propose_wizard_actions",
                    "arguments": {
                        "actions": [
                            {
                                "step": "runs-files",
                                "op": "setLabelConfig",
                                "argsJson": '["tmt6"]',
                                "label": "Plex kit: TMT 6-plex",
                                "reasoning": "The title says TMT spikes with six reporter ratios.",
                                "confidence": "medium",
                            }
                        ]
                    },
                }
            ],
        },
        {
            "text": (
                "For Runs & Files I am proposing the TMT 6-plex kit based on the dataset title. "
                "Next we can set the instrument and modifications."
            ),
            "tool_calls": [],
        },
    ],
}

# Scenario 2: specification question → RAG lookup, answer, no proposals.
SPEC_SCRIPT: list[dict[str, Any]] = [
    {
        "text": "",
        "tool_calls": [
            {"name": "search_specification", "arguments": {"query": "reserved words", "k": 3}}
        ],
    },
    {
        "text": (
            "SDRF defines four reserved values: `not available`, `not applicable`, "
            "`anonymized`, and `pooled`. Use them instead of leaving a cell empty "
            "(specification section 5.3)."
        ),
        "tool_calls": [],
    },
]

# Scenario 3: uploaded paper → read the parsed document, then propose for the focus step.
PAPER_SCRIPT: list[dict[str, Any]] = [
    {
        "text": "Checking what you uploaded.",
        "tool_calls": [{"name": "list_documents", "arguments": {}}],
    },
    {
        "text": (
            "I read the methods section. Based on it, the samples are human and were "
            "digested with trypsin."
        ),
        "tool_calls": [
            {
                "name": "propose_wizard_actions",
                "arguments": {
                    "actions": [
                        {
                            "step": "characteristics",
                            "op": "addCharacteristicChoice",
                            "argsJson": '["characteristics[organism]","Homo sapiens",'
                            '{"id":"NCBITaxon:9606","label":"Homo sapiens","ontology":"NCBITAXON"}]',
                            "label": "Organism: Homo sapiens",
                            "reasoning": "Methods section of the uploaded paper.",
                            "confidence": "high",
                        }
                    ]
                },
            }
        ],
    },
    {"text": "Proposed the organism. Upload more detail if you want per-sample values.", "tool_calls": []},
]


def focus_step_of(messages: list[dict]) -> str | None:
    for message in reversed(messages):
        if message.get("role") != "system":
            continue
        match = FOCUS_RE.search(message.get("content") or "")
        if match:
            return match.group(1)
    return None


def pick_script(messages: list[dict]) -> list[dict[str, Any]]:
    last_user = next(
        (m.get("content") or "" for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    lowered = last_user.lower()
    focus = focus_step_of(messages)

    if "uploaded" in lowered or "documentid" in lowered:
        return PAPER_SCRIPT

    if "pxd" in lowered or (focus and "help me with step" in lowered):
        if focus and focus in DATASET_STEP_SCRIPTS and focus != "setup":
            return DATASET_STEP_SCRIPTS[focus]
        return DATASET_SETUP_SCRIPT

    return SPEC_SCRIPT


WRAP_UP = {
    "text": "I ran out of tool calls before finishing. Here is what I gathered so far.",
    "tool_calls": [],
}


@app.post("/v1/chat/completions")
async def completions(request: Request) -> StreamingResponse:
    body = await request.json()
    messages = body.get("messages") or []

    if not body.get("tools"):
        # The backend disables tools for its final wrap-up pass.
        step = WRAP_UP
        turn = 0
    else:
        script = pick_script(messages)
        # Count assistant turns already in the transcript to know which step to replay.
        turn = sum(1 for m in messages if m.get("role") == "assistant")
        step = script[min(turn, len(script) - 1)]

    async def stream():
        for piece in chunk_text(step["text"]):
            yield sse({"choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]})

        for index, call in enumerate(step["tool_calls"]):
            yield sse(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": index,
                                        "id": f"call_{turn}_{index}",
                                        "type": "function",
                                        "function": {
                                            "name": call["name"],
                                            "arguments": json.dumps(call["arguments"]),
                                        },
                                    }
                                ]
                            },
                            "finish_reason": None,
                        }
                    ]
                }
            )

        finish = "tool_calls" if step["tool_calls"] else "stop"
        yield sse({"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


def chunk_text(text: str, size: int = 24) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] if text else []


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8899)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
