"""Ask Jev (TypeSafe's classifier) typed questions for the X-ray. Runs inside the private
environment `capcutctl xray jev-setup` builds, never the CLI's own Python.

stdin:  {"model": "typesafe:jev-latest", "beats": [{"id", "state"}], "triage": [{"id", "state"}]}
stdout: {"beats": {id: {"answer", "confidence"}}, "triage": {id: {"answer", "confidence"}}, "errors": [...]}

Jev's confidences are reported as given. They are known to be over-sharp, so callers use
them to rank, never as odds, and never turn an answer into a FAIL on its own.
"""
import asyncio
import json
import sys
from enum import StrEnum

from pydantic import BaseModel, Field
from pydantic_ai import Agent


class Support(StrEnum):
    supported = "supported"
    """The text on screen shows or names what the speaker is talking about."""
    contradicted = "contradicted"
    """The text on screen shows something different from what the speaker says, such as another number, name or result."""
    unrelated = "unrelated"
    """The text on screen is about something else than what is being said."""
    insufficient_evidence = "insufficient_evidence"
    """There is too little screen text to tell either way."""


class BeatJudgement(BaseModel):
    support: Support = Field(description="In this moment of a short video, does the text visible on screen "
                                         "support what the speaker is saying?")


class Noticeable(StrEnum):
    likely = "likely"
    """Most viewers watching on a phone would notice it."""
    possible = "possible"
    """An attentive viewer might notice it."""
    unlikely = "unlikely"
    """A viewer would almost certainly not notice it."""
    insufficient_evidence = "insufficient_evidence"
    """The description is not enough to tell."""


class Triage(BaseModel):
    noticeable: Noticeable = Field(description="This is a possible problem found in a finished short vertical video. "
                                               "Would a viewer watching it once on a phone notice it?")


async def ask(agent, item, field, sem):
    async with sem:
        result = await agent.run(item["state"])
        value = getattr(result.output, field)
        conf = (result.response.provider_details or {}).get("confidence", {}).get(field)
        return item["id"], {"answer": value.value, "confidence": conf}


async def main():
    req = json.load(sys.stdin)
    model = req.get("model", "typesafe:jev-latest")
    sem = asyncio.Semaphore(8)
    out = {"beats": {}, "triage": {}, "errors": []}
    jobs = []
    for key, schema, field in (("beats", BeatJudgement, "support"), ("triage", Triage, "noticeable")):
        if req.get(key):
            agent = Agent(model, output_type=schema, model_settings={"timeout": 20})
            jobs += [(key, ask(agent, item, field, sem)) for item in req[key]]
    results = await asyncio.gather(*(j for _, j in jobs), return_exceptions=True)
    for (key, _), res in zip(jobs, results, strict=True):
        if isinstance(res, Exception):
            out["errors"].append(f"{key}: {type(res).__name__}: {str(res)[:200]}")
        else:
            out[key][res[0]] = res[1]
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    asyncio.run(main())
