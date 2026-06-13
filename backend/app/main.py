from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.auth import get_current_user
from app.config import get_settings
from app.models import User
from app.ratelimit import limiter
from app.routers import logs

settings = get_settings()

app = FastAPI(title="VIVID API", docs_url="/docs" if settings.dev_mode else None)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Exact origin only — never a wildcard (§3.1)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.get("/me")
def me(user: User = Depends(get_current_user)) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "currency": user.currency,
        "unit_pref": user.unit_pref,
        "active_pillars": user.active_pillars,
        "daily_budget": user.daily_budget,
        "bodyweight_goal": user.bodyweight_goal,
    }


app.include_router(logs.router)

# Routers landing in later build steps:
# app.include_router(bodyweight.router)
# app.include_router(weekly_logs.router)
# app.include_router(habits.router)
