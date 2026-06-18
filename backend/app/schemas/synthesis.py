"""
Synthesis API schemas (CLAUDE.md §6 step 10).

The synthesis row stores only the model's plain-text/markdown ``content`` plus
token accounting. Two derived fields are computed at serialization time and never
persisted:

  * ``insights`` — parsed out of ``content`` here by ``parse_insights`` (the
    bullet lines), so the frontend gets a clean ``string[]`` without re-parsing
    markdown client-side.
  * ``optimization_score`` — recomputed deterministically from the scoring engine
    by the service on every read (the router injects it). The LLM never produces
    it and it is not a DB column.

``SynthesisGenerateIn`` enforces the ISO-Monday key and ``extra="forbid"`` so the
client can only ever name a week — never smuggle metrics or a user_id (§3.1/§4).
"""
from __future__ import annotations

import re
from datetime import date as dt_date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import AISynthesis

# Bullet markers the mock (and a real markdown completion) may emit: •, -, *,
# en/em dash. The summary line carries no marker and is intentionally excluded.
_BULLET_RE = re.compile(r"^\s*[•–—\-\*]\s+(.+?)\s*$")


def parse_insights(content: str) -> list[str]:
    """Structure the raw synthesis markdown into the discrete bullet insights.

    Walks the stored ``content`` line by line and returns the text of each bullet
    line (marker stripped), in order. Non-bullet lines (the leading summary, blank
    lines) are dropped. Pure and side-effect free so it is safe to run inside
    response serialization on every read."""
    out: list[str] = []
    for line in content.splitlines():
        m = _BULLET_RE.match(line)
        if m:
            text = m.group(1).strip()
            if text:
                out.append(text)
    return out


class SynthesisGenerateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    week_start: dt_date
    force: bool = False

    @field_validator("week_start")
    @classmethod
    def _iso_monday(cls, v: dt_date) -> dt_date:
        if v.isoweekday() != 1:
            raise ValueError("week_start must be an ISO Monday")
        return v


class SynthesisOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    user_id: str
    type: Literal["weekly"]
    week_start: dt_date
    generated_at: datetime
    optimization_score: int = Field(ge=0, le=100)  # deterministic, engine-derived
    insights: list[str]                            # parsed from content bullets
    content: str
    model: str
    tokens_in: int
    tokens_out: int
    cached: bool

    @classmethod
    def from_row(
        cls, row: AISynthesis, *, optimization_score: int, cached: bool
    ) -> "SynthesisOut":
        """Serialize an AISynthesis row, parsing bullet insights out of its
        content and taking the deterministic optimization_score the service
        recomputed for this read."""
        return cls(
            id=row.id,
            user_id=row.user_id,
            type=row.type,  # type: ignore[arg-type]
            week_start=row.week_start,
            generated_at=row.generated_at,
            optimization_score=optimization_score,
            insights=parse_insights(row.content),
            content=row.content,
            model=row.model,
            tokens_in=row.tokens_in,
            tokens_out=row.tokens_out,
            cached=cached,
        )
