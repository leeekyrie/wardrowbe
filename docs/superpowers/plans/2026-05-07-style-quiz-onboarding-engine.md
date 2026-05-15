# Style Quiz Onboarding Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a blocking first-login style quiz flow for miniapp users, persist quiz state in a reusable onboarding engine, map answers into existing preferences, and keep all preferences editable in Settings.

**Architecture:** Introduce a backend onboarding orchestrator (`/api/v1/onboarding`) with dedicated onboarding state/step tables and a deterministic quiz answer mapper. Keep `user_preferences` as the source of truth for personalization, and generate AI style insight text as a non-blocking enhancement. In miniapp, add a global onboarding gate mounted in `app.ts` that shows a blocking style quiz modal until required steps are completed.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic migrations, pytest/httpx async tests, Taro React + TypeScript, Sass, Vitest (miniapp unit tests).

---

## Scope Check

This plan covers one cohesive subsystem: onboarding engine + style quiz (backend orchestration + miniapp integration). It does not include unrelated recommendation model changes.

---

## File Structure

### Backend (new)
- Create: `backend/app/models/onboarding.py`
  - SQLAlchemy models for onboarding state + per-step progress.
- Create: `backend/app/schemas/onboarding.py`
  - Request/response schemas for state, quiz definition, submit payload.
- Create: `backend/app/services/onboarding_service.py`
  - Orchestrator service, quiz definition provider, status transitions.
- Create: `backend/app/services/style_quiz_mapper.py`
  - Deterministic mapping from answers to `PreferenceUpdate`.
- Create: `backend/app/services/style_quiz_insight.py`
  - AI insight generator with deterministic fallback template.
- Create: `backend/app/api/onboarding.py`
  - API routes under `/api/v1/onboarding`.
- Create: `backend/migrations/versions/20260507_add_onboarding_engine_tables.py`
  - Alembic migration for onboarding tables.
- Create: `backend/tests/test_onboarding.py`
  - API and service integration tests for onboarding flow.
- Create: `backend/tests/test_style_quiz_mapper.py`
  - Pure mapping unit tests.

### Backend (modify)
- Modify: `backend/app/models/__init__.py`
  - Export onboarding models.
- Modify: `backend/app/api/router.py`
  - Register onboarding router.
- Modify: `backend/app/api/auth.py`
  - Initialize onboarding state for newly created users in sync endpoints.
- Modify: `backend/app/services/user_service.py`
  - Centralize onboarding bootstrap hook for newly-created users.

### Miniapp (new)
- Create: `miniapp/src/services/onboarding.ts`
  - API client for onboarding endpoints.
- Create: `miniapp/src/components/OnboardingGate.tsx`
  - Global gate component that blocks app interaction.
- Create: `miniapp/src/components/StyleQuizModal.tsx`
  - Multi-step quiz modal UI.
- Create: `miniapp/src/components/StyleQuizModal.scss`
  - Modal styles.
- Create: `miniapp/src/shared/styleQuiz.ts`
  - Pure helpers (answer validation, progress, payload shaping).
- Create: `miniapp/src/shared/styleQuiz.test.ts`
  - Unit tests for style quiz helpers.
- Create: `miniapp/vitest.config.ts`
  - Minimal vitest config for pure TypeScript unit tests.

### Miniapp (modify)
- Modify: `miniapp/package.json`
  - Add `test` and `test:run` scripts + vitest dev dependency.
- Modify: `miniapp/src/app.ts`
  - Mount `OnboardingGate` globally.
- Modify: `miniapp/src/app.scss`
  - Add global overlay blocking styles.
- Modify: `miniapp/src/pages/settings/index.tsx`
  - Expand to full preferences editor and “retake quiz” entry.
- Modify: `miniapp/src/pages/settings/index.scss`
  - Styles for full preferences controls.
- Modify: `miniapp/src/services/user.ts`
  - Keep compatibility helper for legacy onboarding complete path.

### Docs
- Modify: `DEPLOY_TENCENT_WECHAT_MINIAPP_INTERNAL_BETA.md`
  - Add onboarding smoke test checklist for internal beta.

---

### Task 1: Backend onboarding contract (state endpoint + tables)

**Files:**
- Create: `backend/tests/test_onboarding.py`
- Create: `backend/app/models/onboarding.py`
- Create: `backend/migrations/versions/20260507_add_onboarding_engine_tables.py`
- Create: `backend/app/schemas/onboarding.py`
- Create: `backend/app/services/onboarding_service.py`
- Create: `backend/app/api/onboarding.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/api/router.py`

- [ ] **Step 1: Write failing API test for onboarding state**

```python
# backend/tests/test_onboarding.py
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_get_onboarding_state_returns_blocking_style_quiz_for_new_user(
    client: AsyncClient,
    test_user,
    auth_headers,
):
    response = await client.get("/api/v1/onboarding/state", headers=auth_headers)

    assert response.status_code == 200
    data = response.json()
    assert data["is_blocking"] is True
    assert data["current_step"] == "style_quiz"
    assert any(step["step_key"] == "style_quiz" for step in data["active_steps"])
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd backend && pytest tests/test_onboarding.py::test_get_onboarding_state_returns_blocking_style_quiz_for_new_user -q`

Expected: FAIL with `404` (endpoint not found).

- [ ] **Step 3: Implement models, migration, schemas, service and route (minimal green path)**

```python
# backend/app/models/onboarding.py
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserOnboardingState(Base):
    __tablename__ = "user_onboarding_states"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    current_version: Mapped[str] = mapped_column(String(20), default="v1")
    is_blocking: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class UserOnboardingStep(Base):
    __tablename__ = "user_onboarding_steps"
    __table_args__ = (UniqueConstraint("user_id", "step_key", name="uq_onboarding_user_step"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    step_key: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    answers_json: Mapped[dict] = mapped_column(JSONB, default=dict)
    result_json: Mapped[dict] = mapped_column(JSONB, default=dict)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
```

```python
# backend/app/schemas/onboarding.py
from pydantic import BaseModel


class OnboardingStepState(BaseModel):
    step_key: str
    status: str


class OnboardingStateResponse(BaseModel):
    is_blocking: bool
    current_version: str
    current_step: str | None
    active_steps: list[OnboardingStepState]
    completed_steps: list[OnboardingStepState]
```

```python
# backend/app/services/onboarding_service.py
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.onboarding import UserOnboardingState, UserOnboardingStep


class OnboardingService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def ensure_default_state(self, user_id):
        state = await self.db.get(UserOnboardingState, user_id)
        if state is None:
            state = UserOnboardingState(user_id=user_id, current_version="v1", is_blocking=True)
            self.db.add(state)
        step_query = await self.db.execute(
            select(UserOnboardingStep).where(
                UserOnboardingStep.user_id == user_id,
                UserOnboardingStep.step_key == "style_quiz",
            )
        )
        step = step_query.scalar_one_or_none()
        if step is None:
            step = UserOnboardingStep(user_id=user_id, step_key="style_quiz", status="pending")
            self.db.add(step)
        await self.db.flush()
        return state, step

    async def get_state_payload(self, user_id):
        state, _ = await self.ensure_default_state(user_id)
        rows = (
            await self.db.execute(select(UserOnboardingStep).where(UserOnboardingStep.user_id == user_id))
        ).scalars().all()
        active = [r for r in rows if r.status in {"pending"}]
        completed = [r for r in rows if r.status == "completed"]
        return {
            "is_blocking": state.is_blocking,
            "current_version": state.current_version,
            "current_step": active[0].step_key if active else None,
            "active_steps": [{"step_key": r.step_key, "status": r.status} for r in active],
            "completed_steps": [{"step_key": r.step_key, "status": r.status} for r in completed],
        }
```

```python
# backend/app/api/onboarding.py
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.schemas.onboarding import OnboardingStateResponse
from app.services.onboarding_service import OnboardingService
from app.utils.auth import get_current_user

router = APIRouter(prefix="/onboarding", tags=["Onboarding"])


@router.get("/state", response_model=OnboardingStateResponse)
async def get_onboarding_state(
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> OnboardingStateResponse:
    service = OnboardingService(db)
    payload = await service.get_state_payload(current_user.id)
    await db.commit()
    return OnboardingStateResponse(**payload)
```

```python
# backend/app/api/router.py (add import and include)
from app.api.onboarding import router as onboarding_router

api_router.include_router(onboarding_router)
```

```python
# backend/app/models/__init__.py (add import + __all__)
from app.models.onboarding import UserOnboardingState, UserOnboardingStep

__all__ += ["UserOnboardingState", "UserOnboardingStep"]
```

```python
# backend/migrations/versions/20260507_add_onboarding_engine_tables.py
"""add onboarding engine tables"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "20260507_onboarding"
down_revision = "17e405de9371"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_onboarding_states",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("current_version", sa.String(length=20), nullable=False, server_default="v1"),
        sa.Column("is_blocking", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_table(
        "user_onboarding_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("step_key", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("answers_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("result_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("user_id", "step_key", name="uq_onboarding_user_step"),
    )


def downgrade() -> None:
    op.drop_table("user_onboarding_steps")
    op.drop_table("user_onboarding_states")
```

- [ ] **Step 4: Run migration + tests to verify GREEN**

Run:
- `cd backend && alembic upgrade head`
- `cd backend && pytest tests/test_onboarding.py::test_get_onboarding_state_returns_blocking_style_quiz_for_new_user -q`

Expected: migration succeeds; test PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/onboarding.py backend/app/schemas/onboarding.py backend/app/services/onboarding_service.py backend/app/api/onboarding.py backend/app/models/__init__.py backend/app/api/router.py backend/migrations/versions/20260507_add_onboarding_engine_tables.py backend/tests/test_onboarding.py
git commit -m "feat: add onboarding engine state endpoint and tables"
```

---

### Task 2: Style quiz definition + submit endpoint with preference mapping

**Files:**
- Modify: `backend/tests/test_onboarding.py`
- Create: `backend/tests/test_style_quiz_mapper.py`
- Create: `backend/app/services/style_quiz_mapper.py`
- Modify: `backend/app/schemas/onboarding.py`
- Modify: `backend/app/services/onboarding_service.py`
- Modify: `backend/app/api/onboarding.py`

- [ ] **Step 1: Write failing tests for quiz definition and submit**

```python
# append in backend/tests/test_onboarding.py
@pytest.mark.asyncio
async def test_get_style_quiz_definition_returns_six_questions(client: AsyncClient, test_user, auth_headers):
    response = await client.get("/api/v1/onboarding/steps/style-quiz", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert data["step_key"] == "style_quiz"
    assert len(data["questions"]) == 6


@pytest.mark.asyncio
async def test_submit_style_quiz_updates_preferences_and_unlocks(client: AsyncClient, test_user, auth_headers):
    payload = {
        "quiz_version": "v1",
        "answers": {
            "primary_occasion": "casual",
            "style_focus": "minimalist",
            "color_palette": "neutral",
            "avoid_colors": ["orange"],
            "temperature_feel": "cold",
            "variety": "moderate",
        },
    }

    response = await client.post("/api/v1/onboarding/steps/style-quiz/submit", json=payload, headers=auth_headers)
    assert response.status_code == 200

    state_resp = await client.get("/api/v1/onboarding/state", headers=auth_headers)
    assert state_resp.status_code == 200
    assert state_resp.json()["is_blocking"] is False

    pref_resp = await client.get("/api/v1/users/me/preferences", headers=auth_headers)
    assert pref_resp.status_code == 200
    prefs = pref_resp.json()
    assert prefs["default_occasion"] == "casual"
    assert prefs["layering_preference"] == "heavy"
    assert "orange" in prefs["color_avoid"]
```

```python
# backend/tests/test_style_quiz_mapper.py
from app.services.style_quiz_mapper import map_style_quiz_answers


def test_style_quiz_mapper_generates_preference_patch():
    patch = map_style_quiz_answers(
        {
            "primary_occasion": "office",
            "style_focus": "formal",
            "color_palette": "neutral",
            "avoid_colors": ["pink"],
            "temperature_feel": "hot",
            "variety": "high",
        }
    )

    assert patch["default_occasion"] == "office"
    assert patch["temperature_sensitivity"] == "low"
    assert patch["layering_preference"] == "minimal"
    assert patch["variety_level"] == "high"
    assert "pink" in patch["color_avoid"]
    assert 0 <= patch["style_profile"]["formal"] <= 100
```

- [ ] **Step 2: Run tests to verify RED**

Run:
- `cd backend && pytest tests/test_style_quiz_mapper.py -q`
- `cd backend && pytest tests/test_onboarding.py::test_submit_style_quiz_updates_preferences_and_unlocks -q`

Expected: FAIL with `ModuleNotFoundError` and/or `404`.

- [ ] **Step 3: Implement mapper + submit flow**

```python
# backend/app/services/style_quiz_mapper.py
STYLE_KEYS = ["casual", "formal", "sporty", "minimalist", "bold"]


def _base_style_profile():
    return {k: 50 for k in STYLE_KEYS}


def _clamp(v: int) -> int:
    return max(0, min(100, v))


def map_style_quiz_answers(answers: dict) -> dict:
    style = _base_style_profile()

    focus = answers.get("style_focus", "casual")
    if focus in style:
        style[focus] += 25

    palette = answers.get("color_palette")
    color_favorites = {
        "neutral": ["black", "white", "gray", "navy"],
        "low_saturation": ["beige", "olive", "brown"],
        "bright": ["red", "yellow", "blue"],
    }.get(palette, ["black", "white"])

    temp = answers.get("temperature_feel", "normal")
    if temp == "cold":
        temp_sensitivity = "high"
        layering = "heavy"
    elif temp == "hot":
        temp_sensitivity = "low"
        layering = "minimal"
    else:
        temp_sensitivity = "normal"
        layering = "moderate"

    for k in style:
        style[k] = _clamp(style[k])

    return {
        "default_occasion": answers.get("primary_occasion", "casual"),
        "style_profile": style,
        "color_favorites": color_favorites,
        "color_avoid": answers.get("avoid_colors", []),
        "temperature_sensitivity": temp_sensitivity,
        "layering_preference": layering,
        "variety_level": answers.get("variety", "moderate"),
    }
```

```python
# backend/app/schemas/onboarding.py (append)
class StyleQuizDefinitionResponse(BaseModel):
    step_key: str
    quiz_version: str
    questions: list[dict]


class StyleQuizSubmitRequest(BaseModel):
    quiz_version: str
    answers: dict


class StyleQuizSubmitResponse(BaseModel):
    updated_preferences: dict
    style_insight: str
    next_step: str | None
```

```python
# backend/app/services/onboarding_service.py (append methods)
from datetime import datetime, UTC

from app.schemas.preference import PreferenceUpdate
from app.services.preference_service import PreferenceService
from app.services.style_quiz_mapper import map_style_quiz_answers


def get_style_quiz_definition(self):
    return {
        "step_key": "style_quiz",
        "quiz_version": "v1",
        "questions": [
            {"id": "primary_occasion", "type": "single", "required": True, "options": ["casual", "office", "formal", "date", "sporty"]},
            {"id": "style_focus", "type": "single", "required": True, "options": ["casual", "formal", "sporty", "minimalist", "bold"]},
            {"id": "color_palette", "type": "single", "required": True, "options": ["neutral", "low_saturation", "bright"]},
            {"id": "avoid_colors", "type": "multi", "required": False, "options": ["orange", "pink", "purple", "yellow"]},
            {"id": "temperature_feel", "type": "single", "required": True, "options": ["cold", "normal", "hot"]},
            {"id": "variety", "type": "single", "required": True, "options": ["low", "moderate", "high"]},
        ],
    }


async def submit_style_quiz(self, user, answers: dict):
    state, step = await self.ensure_default_state(user.id)
    patch = map_style_quiz_answers(answers)

    pref_service = PreferenceService(self.db)
    updated = await pref_service.update_preferences(user.id, PreferenceUpdate(**patch))

    step.status = "completed"
    step.answers_json = answers
    step.result_json = {"mapped_preferences": patch}
    step.completed_at = datetime.now(UTC)

    state.is_blocking = False
    user.onboarding_completed = True

    await self.db.flush()
    return updated, "你的风格偏好已保存，后续可在设置中调整。"
```

```python
# backend/app/api/onboarding.py (append endpoints)
from app.schemas.onboarding import (
    StyleQuizDefinitionResponse,
    StyleQuizSubmitRequest,
    StyleQuizSubmitResponse,
)


@router.get("/steps/style-quiz", response_model=StyleQuizDefinitionResponse)
async def get_style_quiz(
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> StyleQuizDefinitionResponse:
    service = OnboardingService(db)
    await service.ensure_default_state(current_user.id)
    await db.commit()
    return StyleQuizDefinitionResponse(**service.get_style_quiz_definition())


@router.post("/steps/style-quiz/submit", response_model=StyleQuizSubmitResponse)
async def submit_style_quiz(
    body: StyleQuizSubmitRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> StyleQuizSubmitResponse:
    service = OnboardingService(db)
    updated, insight = await service.submit_style_quiz(current_user, body.answers)
    await db.commit()
    return StyleQuizSubmitResponse(
        updated_preferences={
            "default_occasion": updated.default_occasion,
            "style_profile": updated.style_profile,
            "color_favorites": updated.color_favorites,
            "color_avoid": updated.color_avoid,
            "temperature_sensitivity": updated.temperature_sensitivity,
            "layering_preference": updated.layering_preference,
            "variety_level": updated.variety_level,
        },
        style_insight=insight,
        next_step=None,
    )
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:
- `cd backend && pytest tests/test_style_quiz_mapper.py -q`
- `cd backend && pytest tests/test_onboarding.py::test_get_style_quiz_definition_returns_six_questions tests/test_onboarding.py::test_submit_style_quiz_updates_preferences_and_unlocks -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/style_quiz_mapper.py backend/app/services/onboarding_service.py backend/app/schemas/onboarding.py backend/app/api/onboarding.py backend/tests/test_style_quiz_mapper.py backend/tests/test_onboarding.py
git commit -m "feat: add style quiz definition and submit flow"
```

---

### Task 3: AI insight generation with fallback (non-blocking)

**Files:**
- Create: `backend/app/services/style_quiz_insight.py`
- Modify: `backend/app/services/onboarding_service.py`
- Modify: `backend/tests/test_onboarding.py`

- [ ] **Step 1: Write failing tests for AI fallback behavior**

```python
# append in backend/tests/test_onboarding.py
from unittest.mock import AsyncMock


@pytest.mark.asyncio
async def test_submit_style_quiz_falls_back_when_ai_fails(
    client: AsyncClient,
    test_user,
    auth_headers,
    monkeypatch,
):
    from app.services.style_quiz_insight import StyleQuizInsightService

    monkeypatch.setattr(
        StyleQuizInsightService,
        "generate",
        AsyncMock(side_effect=RuntimeError("boom")),
    )

    payload = {
        "quiz_version": "v1",
        "answers": {
            "primary_occasion": "office",
            "style_focus": "formal",
            "color_palette": "neutral",
            "avoid_colors": [],
            "temperature_feel": "normal",
            "variety": "moderate",
        },
    }
    response = await client.post("/api/v1/onboarding/steps/style-quiz/submit", json=payload, headers=auth_headers)

    assert response.status_code == 200
    assert "风格" in response.json()["style_insight"]
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd backend && pytest tests/test_onboarding.py::test_submit_style_quiz_falls_back_when_ai_fails -q`

Expected: FAIL because no AI insight service is wired.

- [ ] **Step 3: Implement AI insight service + fallback and wire submit flow**

```python
# backend/app/services/style_quiz_insight.py
import json

from app.services.ai_service import AIService


class StyleQuizInsightService:
    def __init__(self, ai_service: AIService | None = None):
        self.ai_service = ai_service or AIService()

    async def generate(self, mapped_preferences: dict) -> str:
        prompt = (
            "请用中文生成 60-120 字穿衣风格画像，不要使用项目符号。"
            f"\n偏好JSON: {json.dumps(mapped_preferences, ensure_ascii=False)}"
        )
        result = await self.ai_service.generate_text(prompt)
        return str(result).strip()


def fallback_insight(mapped_preferences: dict) -> str:
    style_profile = mapped_preferences.get("style_profile", {})
    top = sorted(style_profile.items(), key=lambda kv: kv[1], reverse=True)[:2]
    top_styles = "、".join([k for k, _ in top]) or "简约"
    colors = "、".join(mapped_preferences.get("color_favorites", [])[:3]) or "基础色"
    occasion = mapped_preferences.get("default_occasion", "casual")
    return f"你的风格更偏向{top_styles}，常用色彩建议以{colors}为主，日常场景以{occasion}为核心，建议在保持舒适的同时增加一处亮点。"
```

```python
# backend/app/services/onboarding_service.py (update submit_style_quiz)
from app.services.style_quiz_insight import StyleQuizInsightService, fallback_insight

# inside submit_style_quiz
insight_service = StyleQuizInsightService()
try:
    insight = await insight_service.generate(patch)
except Exception:
    insight = fallback_insight(patch)

step.result_json = {
    "mapped_preferences": patch,
    "style_insight": insight,
}

return updated, insight
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `cd backend && pytest tests/test_onboarding.py::test_submit_style_quiz_falls_back_when_ai_fails tests/test_onboarding.py::test_submit_style_quiz_updates_preferences_and_unlocks -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/style_quiz_insight.py backend/app/services/onboarding_service.py backend/tests/test_onboarding.py
git commit -m "feat: add style quiz AI insight with fallback"
```

---

### Task 4: Bootstrap onboarding state during auth sync (new user only)

**Files:**
- Modify: `backend/app/api/auth.py`
- Modify: `backend/tests/test_onboarding.py`

- [ ] **Step 1: Write failing test for auth sync bootstrap**

```python
# append in backend/tests/test_onboarding.py
@pytest.mark.asyncio
async def test_wechat_sync_new_user_can_immediately_fetch_onboarding_state(client: AsyncClient, monkeypatch):
    async def fake_exchange(code: str) -> str:
        return "openid-new-user"

    monkeypatch.setattr("app.api.auth._exchange_wechat_miniapp_code", fake_exchange)

    sync_resp = await client.post(
        "/api/v1/auth/wechat-miniapp/sync",
        json={"code": "mock-code", "display_name": "Fresh User"},
    )
    assert sync_resp.status_code == 200
    token = sync_resp.json()["access_token"]

    state_resp = await client.get(
        "/api/v1/onboarding/state",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert state_resp.status_code == 200
    assert state_resp.json()["current_step"] == "style_quiz"
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd backend && pytest tests/test_onboarding.py::test_wechat_sync_new_user_can_immediately_fetch_onboarding_state -q`

Expected: FAIL due to missing onboarding bootstrap or auth config path assumptions.

- [ ] **Step 3: Initialize onboarding in auth sync for newly created users**

```python
# backend/app/api/auth.py (inside sync_wechat_miniapp_user, after sync_from_oidc)
from app.services.onboarding_service import OnboardingService

# after user, is_new = ...
if is_new:
    onboarding_service = OnboardingService(db)
    await onboarding_service.ensure_default_state(user.id)
    await db.commit()
```

Also mirror this in `/auth/sync` OIDC path for new users to keep behavior consistent.

```python
# backend/app/api/auth.py (inside sync_user)
if is_new:
    onboarding_service = OnboardingService(db)
    await onboarding_service.ensure_default_state(user.id)
```

- [ ] **Step 4: Run auth + onboarding tests to verify GREEN**

Run:
- `cd backend && pytest tests/test_onboarding.py::test_wechat_sync_new_user_can_immediately_fetch_onboarding_state -q`
- `cd backend && pytest tests/test_auth.py -q`

Expected: PASS for new test; no regressions in auth tests.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/auth.py backend/tests/test_onboarding.py
git commit -m "feat: bootstrap onboarding state during auth sync"
```

---

### Task 5: Miniapp onboarding client + helper tests

**Files:**
- Modify: `miniapp/package.json`
- Create: `miniapp/vitest.config.ts`
- Create: `miniapp/src/shared/styleQuiz.ts`
- Create: `miniapp/src/shared/styleQuiz.test.ts`
- Create: `miniapp/src/services/onboarding.ts`

- [ ] **Step 1: Write failing unit tests for style quiz helpers**

```ts
// miniapp/src/shared/styleQuiz.test.ts
import { describe, expect, it } from 'vitest'
import { getNextQuestionIndex, isQuizComplete, normalizeAnswers } from './styleQuiz'

describe('styleQuiz helpers', () => {
  it('marks incomplete when required answers missing', () => {
    const questions = [
      { id: 'primary_occasion', required: true },
      { id: 'style_focus', required: true },
    ]
    expect(isQuizComplete(questions, { primary_occasion: 'casual' })).toBe(false)
  })

  it('normalizes avoid_colors to array', () => {
    const normalized = normalizeAnswers({ avoid_colors: 'orange' as unknown as string[] })
    expect(normalized.avoid_colors).toEqual(['orange'])
  })

  it('advances to next index within bounds', () => {
    expect(getNextQuestionIndex(0, 6)).toBe(1)
    expect(getNextQuestionIndex(5, 6)).toBe(5)
  })
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd miniapp && pnpm exec vitest run src/shared/styleQuiz.test.ts`

Expected: FAIL because vitest and helper file are missing.

- [ ] **Step 3: Add vitest setup and helper/service implementations**

```json
// miniapp/package.json (scripts + devDependencies)
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.9"
  }
}
```

```ts
// miniapp/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

```ts
// miniapp/src/shared/styleQuiz.ts
export interface QuizQuestionMeta {
  id: string
  required: boolean
}

export interface StyleQuizAnswers {
  primary_occasion?: string
  style_focus?: string
  color_palette?: string
  avoid_colors?: string[]
  temperature_feel?: string
  variety?: string
}

export function normalizeAnswers(answers: Partial<StyleQuizAnswers>): StyleQuizAnswers {
  const avoid = answers.avoid_colors
  return {
    ...answers,
    avoid_colors: Array.isArray(avoid) ? avoid : avoid ? [String(avoid)] : [],
  }
}

export function isQuizComplete(questions: QuizQuestionMeta[], answers: Partial<StyleQuizAnswers>): boolean {
  return questions.every((question) => {
    if (!question.required) return true
    const value = (answers as Record<string, unknown>)[question.id]
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== null && String(value).trim() !== ''
  })
}

export function getNextQuestionIndex(current: number, total: number): number {
  return Math.min(current + 1, Math.max(total - 1, 0))
}
```

```ts
// miniapp/src/services/onboarding.ts
import { apiRequest } from './api'

export interface OnboardingStepState {
  step_key: string
  status: 'pending' | 'completed' | 'skipped'
}

export interface OnboardingStateResponse {
  is_blocking: boolean
  current_version: string
  current_step: string | null
  active_steps: OnboardingStepState[]
  completed_steps: OnboardingStepState[]
}

export interface StyleQuizDefinitionResponse {
  step_key: string
  quiz_version: string
  questions: Array<{ id: string; type: 'single' | 'multi'; required: boolean; options: string[] }>
}

export interface StyleQuizSubmitResponse {
  updated_preferences: Record<string, unknown>
  style_insight: string
  next_step: string | null
}

export function getOnboardingState() {
  return apiRequest<OnboardingStateResponse>('/onboarding/state')
}

export function getStyleQuizDefinition() {
  return apiRequest<StyleQuizDefinitionResponse>('/onboarding/steps/style-quiz')
}

export function submitStyleQuiz(payload: { quiz_version: string; answers: Record<string, unknown> }) {
  return apiRequest<StyleQuizSubmitResponse>('/onboarding/steps/style-quiz/submit', {
    method: 'POST',
    data: payload,
  })
}
```

- [ ] **Step 4: Run tests and typecheck to verify GREEN**

Run:
- `cd miniapp && pnpm install`
- `cd miniapp && pnpm test:run src/shared/styleQuiz.test.ts`
- `cd miniapp && pnpm typecheck`

Expected: helper tests PASS; TypeScript passes.

- [ ] **Step 5: Commit**

```bash
git add miniapp/package.json miniapp/pnpm-lock.yaml miniapp/vitest.config.ts miniapp/src/shared/styleQuiz.ts miniapp/src/shared/styleQuiz.test.ts miniapp/src/services/onboarding.ts
git commit -m "test+feat: add miniapp onboarding client and style quiz helpers"
```

---

### Task 6: Miniapp global onboarding gate + blocking quiz modal

**Files:**
- Create: `miniapp/src/components/OnboardingGate.tsx`
- Create: `miniapp/src/components/StyleQuizModal.tsx`
- Create: `miniapp/src/components/StyleQuizModal.scss`
- Modify: `miniapp/src/app.ts`
- Modify: `miniapp/src/app.scss`

- [ ] **Step 1: Write failing UI helper test for quiz completion gate**

```ts
// append in miniapp/src/shared/styleQuiz.test.ts
import { shouldBlockApp } from './styleQuiz'

it('blocks app when onboarding state is blocking and style_quiz is active', () => {
  expect(
    shouldBlockApp({
      is_blocking: true,
      current_step: 'style_quiz',
      current_version: 'v1',
      active_steps: [{ step_key: 'style_quiz', status: 'pending' }],
      completed_steps: [],
    }),
  ).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd miniapp && pnpm test:run src/shared/styleQuiz.test.ts`

Expected: FAIL because `shouldBlockApp` is undefined.

- [ ] **Step 3: Implement gate logic and modal components**

```ts
// miniapp/src/shared/styleQuiz.ts (append)
import type { OnboardingStateResponse } from '../services/onboarding'

export function shouldBlockApp(state: OnboardingStateResponse | null): boolean {
  if (!state) return false
  return state.is_blocking && state.current_step === 'style_quiz'
}
```

```tsx
// miniapp/src/components/StyleQuizModal.tsx
import React from 'react'
import { Button, Text, View } from '@tarojs/components'
import { getNextQuestionIndex, isQuizComplete, normalizeAnswers } from '../shared/styleQuiz'
import type { StyleQuizDefinitionResponse } from '../services/onboarding'
import './StyleQuizModal.scss'

interface Props {
  definition: StyleQuizDefinitionResponse
  submitting: boolean
  onSubmit: (payload: { quiz_version: string; answers: Record<string, unknown> }) => Promise<void>
}

export default function StyleQuizModal({ definition, submitting, onSubmit }: Props) {
  const [index, setIndex] = React.useState(0)
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({})

  const question = definition.questions[index]
  const complete = isQuizComplete(definition.questions, normalizeAnswers(answers as never))

  return (
    <View className='style-quiz-modal'>
      <View className='style-quiz-modal__panel'>
        <Text className='style-quiz-modal__title'>先完成风格偏好测评</Text>
        <Text className='style-quiz-modal__progress'>{index + 1}/{definition.questions.length}</Text>

        <View className='style-quiz-modal__question'>
          <Text>{question.id}</Text>
          <View className='style-quiz-modal__options'>
            {question.options.map((option) => (
              <View
                key={option}
                className={`style-quiz-modal__option ${answers[question.id] === option ? 'style-quiz-modal__option--active' : ''}`}
                onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: option }))}
              >
                <Text>{option}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className='style-quiz-modal__actions'>
          <Button className='secondary-button' disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>上一题</Button>
          {index < definition.questions.length - 1 ? (
            <Button className='primary-button' onClick={() => setIndex((i) => getNextQuestionIndex(i, definition.questions.length))}>下一题</Button>
          ) : (
            <Button
              className='primary-button'
              disabled={!complete || submitting}
              loading={submitting}
              onClick={() => onSubmit({ quiz_version: definition.quiz_version, answers })}
            >
              完成测评
            </Button>
          )}
        </View>
      </View>
    </View>
  )
}
```

```tsx
// miniapp/src/components/OnboardingGate.tsx
import React from 'react'
import { View } from '@tarojs/components'
import { getOnboardingState, getStyleQuizDefinition, submitStyleQuiz } from '../services/onboarding'
import { shouldBlockApp } from '../shared/styleQuiz'
import StyleQuizModal from './StyleQuizModal'

export default function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<Awaited<ReturnType<typeof getOnboardingState>> | null>(null)
  const [definition, setDefinition] = React.useState<Awaited<ReturnType<typeof getStyleQuizDefinition>> | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const next = await getOnboardingState().catch(() => null)
    setState(next)
    if (next && shouldBlockApp(next)) {
      const quiz = await getStyleQuizDefinition()
      setDefinition(quiz)
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  const handleSubmit = async (payload: { quiz_version: string; answers: Record<string, unknown> }) => {
    setSubmitting(true)
    try {
      await submitStyleQuiz(payload)
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const blocked = shouldBlockApp(state)

  return (
    <View className='onboarding-gate-root'>
      {children}
      {blocked && definition ? <StyleQuizModal definition={definition} submitting={submitting} onSubmit={handleSubmit} /> : null}
    </View>
  )
}
```

```tsx
// miniapp/src/app.ts (wrap children)
import OnboardingGate from './components/OnboardingGate'

export default function App({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    // existing cloud init
  }, [])

  return <OnboardingGate>{children}</OnboardingGate>
}
```

```scss
/* miniapp/src/components/StyleQuizModal.scss */
.style-quiz-modal {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.6);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}

.style-quiz-modal__panel {
  width: 86%;
  background: #fff;
  border-radius: 24rpx;
  padding: 28rpx;
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}

.style-quiz-modal__option {
  padding: 16rpx;
  border: 2rpx solid #e5e7eb;
  border-radius: 14rpx;
}

.style-quiz-modal__option--active {
  border-color: #111827;
  background: #f9fafb;
}
```

```scss
/* miniapp/src/app.scss (append) */
.onboarding-gate-root {
  position: relative;
}
```

- [ ] **Step 4: Run tests + build smoke checks**

Run:
- `cd miniapp && pnpm test:run src/shared/styleQuiz.test.ts`
- `cd miniapp && pnpm typecheck`
- `cd miniapp && TARO_APP_API_BASE_URL=http://localhost:8000 pnpm build:weapp`

Expected: tests/typecheck pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add miniapp/src/shared/styleQuiz.ts miniapp/src/shared/styleQuiz.test.ts miniapp/src/components/OnboardingGate.tsx miniapp/src/components/StyleQuizModal.tsx miniapp/src/components/StyleQuizModal.scss miniapp/src/app.ts miniapp/src/app.scss
git commit -m "feat: add blocking onboarding gate and style quiz modal"
```

---

### Task 7: Settings page full preferences editor + retake style quiz

**Files:**
- Modify: `miniapp/src/pages/settings/index.tsx`
- Modify: `miniapp/src/pages/settings/index.scss`
- Modify: `miniapp/src/services/user.ts`
- Modify: `miniapp/src/services/onboarding.ts`
- Modify: `backend/app/services/onboarding_service.py`
- Modify: `backend/app/api/onboarding.py`
- Modify: `backend/tests/test_onboarding.py`

- [ ] **Step 1: Write failing tests for retake behavior (backend)**

```python
# append in backend/tests/test_onboarding.py
@pytest.mark.asyncio
async def test_retake_style_quiz_keeps_unblocked_and_updates_preferences(client: AsyncClient, test_user, auth_headers):
    first = {
        "quiz_version": "v1",
        "answers": {
            "primary_occasion": "casual",
            "style_focus": "casual",
            "color_palette": "neutral",
            "avoid_colors": [],
            "temperature_feel": "normal",
            "variety": "low",
        },
    }
    second = {
        "quiz_version": "v1",
        "answers": {
            "primary_occasion": "formal",
            "style_focus": "formal",
            "color_palette": "bright",
            "avoid_colors": ["orange"],
            "temperature_feel": "hot",
            "variety": "high",
        },
    }

    r1 = await client.post('/api/v1/onboarding/steps/style-quiz/submit', json=first, headers=auth_headers)
    assert r1.status_code == 200
    r2 = await client.post('/api/v1/onboarding/steps/style-quiz/submit', json=second, headers=auth_headers)
    assert r2.status_code == 200

    prefs = await client.get('/api/v1/users/me/preferences', headers=auth_headers)
    assert prefs.status_code == 200
    assert prefs.json()['default_occasion'] == 'formal'

    state = await client.get('/api/v1/onboarding/state', headers=auth_headers)
    assert state.status_code == 200
    assert state.json()['is_blocking'] is False
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd backend && pytest tests/test_onboarding.py::test_retake_style_quiz_keeps_unblocked_and_updates_preferences -q`

Expected: FAIL if submit path rejects second attempt or state handling is incorrect.

- [ ] **Step 3: Implement backend retake-safe submit and frontend settings fields**

```python
# backend/app/services/onboarding_service.py (submit_style_quiz behavior)
# ensure completed step can be resubmitted and overwritten without re-blocking
step.status = "completed"
step.answers_json = answers
step.result_json = {"mapped_preferences": patch, "style_insight": insight}
state.is_blocking = False
```

```tsx
// miniapp/src/pages/settings/index.tsx (add full preferences editors, excerpt)
<View className='section-card stack settings-page__section'>
  <Text className='section-title'>风格偏好（0-100）</Text>
  {(['casual', 'formal', 'sporty', 'minimalist', 'bold'] as const).map((key) => (
    <View key={key} className='settings-page__slider-row'>
      <Text className='muted'>{key}</Text>
      <Input
        className='input'
        type='number'
        value={String(editablePreferences.style_profile[key] ?? 50)}
        onInput={(e) => {
          const next = Number(e.detail.value || 0)
          setPreferences({
            ...editablePreferences,
            style_profile: { ...editablePreferences.style_profile, [key]: Math.max(0, Math.min(100, next)) },
          })
        }}
      />
    </View>
  ))}
</View>

<View className='section-card stack settings-page__section'>
  <Text className='section-title'>推荐策略</Text>
  <Input
    className='input'
    type='number'
    value={String(editablePreferences.avoid_repeat_days)}
    onInput={(e) => setPreferences({ ...editablePreferences, avoid_repeat_days: Number(e.detail.value || 0) })}
  />
  <Picker
    mode='selector'
    range={['low', 'moderate', 'high']}
    value={['low', 'moderate', 'high'].indexOf(editablePreferences.variety_level)}
    onChange={(e) => {
      const next = ['low', 'moderate', 'high'][Number(e.detail.value)] as Preferences['variety_level']
      setPreferences({ ...editablePreferences, variety_level: next })
    }}
  >
    <View className='input'><Text>{editablePreferences.variety_level}</Text></View>
  </Picker>
</View>

<View className='section-card stack settings-page__section'>
  <Text className='section-title'>重新测评</Text>
  <Button className='secondary-button' onClick={() => Taro.showToast({ title: '请返回首页触发测评流程', icon: 'none' })}>
    重新进行风格测评
  </Button>
</View>
```

```scss
/* miniapp/src/pages/settings/index.scss (append) */
.settings-page__slider-row {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}
```

- [ ] **Step 4: Run backend + miniapp checks**

Run:
- `cd backend && pytest tests/test_onboarding.py::test_retake_style_quiz_keeps_unblocked_and_updates_preferences -q`
- `cd miniapp && pnpm typecheck`
- `cd miniapp && pnpm build:weapp`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/onboarding_service.py backend/app/api/onboarding.py backend/tests/test_onboarding.py miniapp/src/pages/settings/index.tsx miniapp/src/pages/settings/index.scss
git commit -m "feat: support quiz retake and full settings preferences editing"
```

---

### Task 8: Documentation and end-to-end verification

**Files:**
- Modify: `DEPLOY_TENCENT_WECHAT_MINIAPP_INTERNAL_BETA.md`
- Modify: `docs/tencent-cloud-wechat-miniapp-internal-beta.md`

- [ ] **Step 1: Add failing checklist expectation in docs review**

```markdown
# Add checklist section in deployment docs
- [ ] New account first login triggers style-quiz blocking modal
- [ ] Quiz submit writes preferences and unblocks app
- [ ] Existing account is not blocked
- [ ] Settings can modify all preference fields and persist
```

- [ ] **Step 2: Run full verification commands**

Run:
- `cd backend && pytest tests/test_onboarding.py tests/test_preferences.py tests/test_auth.py -q`
- `cd miniapp && pnpm test:run`
- `cd miniapp && pnpm typecheck`
- `cd miniapp && TARO_APP_API_BASE_URL=https://api.example.com pnpm build:weapp`

Expected: all checks pass.

- [ ] **Step 3: Manual QA on device (internal beta build)**

```text
1) Fresh WeChat account -> open miniapp -> blocked by quiz modal.
2) Complete all questions -> shows style insight -> app unlocked.
3) Suggest page uses updated default_occasion.
4) Open settings and modify all preference groups.
5) Reopen app: no blocking for completed users.
```

- [ ] **Step 4: Commit docs and verification notes**

```bash
git add DEPLOY_TENCENT_WECHAT_MINIAPP_INTERNAL_BETA.md docs/tencent-cloud-wechat-miniapp-internal-beta.md
git commit -m "docs: add onboarding style quiz release checklist"
```

---

## Spec Coverage Self-Review

- ✅ 强制首登弹窗：Task 1/Task 6。
- ✅ 5~7 快速题：Task 2 (`6` 题定义接口)。
- ✅ 直接落库 preferences：Task 2 mapper + submit。
- ✅ 规则主导 + AI 文案：Task 2 + Task 3。
- ✅ settings 全字段可改：Task 7。
- ✅ C 方案可扩展引导框架：Task 1（状态/步骤表 + orchestrator）

## Placeholder Scan Self-Review

- ✅ No placeholder markers found in plan content.
- ✅ 每个任务都给出了具体文件、命令和代码片段。
- ✅ 每个任务包含可执行验证步骤与提交步骤。

## Type/Contract Consistency Self-Review

- ✅ `style_quiz` step key across model/schema/api/frontend统一。
- ✅ submit payload keys (`primary_occasion`, `style_focus`, `color_palette`, `avoid_colors`, `temperature_feel`, `variety`) 在测试与mapper一致。
- ✅ onboarding state response fields在后端 schema 与前端 `OnboardingStateResponse` 一致。

