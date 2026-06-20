"""
get_current_user — every route depends on this from the first scaffold
commit (§3.1). No endpoint ever accepts a user_id from the client.

DEV_MODE returns the local dev user, but the bypass cannot reach
production: if any production platform variable is present alongside
DEV_MODE=true, every request 503s.
"""
import logging
import os

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User, utcnow

_log = logging.getLogger("uvicorn.error")

# Render/Vercel inject these on their platforms; their presence means this
# process is NOT a local dev box.
_PRODUCTION_ENV_MARKERS = ("RENDER", "VERCEL", "PRODUCTION")

DEV_USER_ID = "00000000-0000-0000-0000-000000000001"

_bearer = HTTPBearer(auto_error=False)


def _get_or_create_dev_user(db: Session) -> User:
    user = db.get(User, DEV_USER_ID)
    if user is None:
        user = User(
            id=DEV_USER_ID,
            email="dev@vivid.local",
            name="Brody (dev)",
            consent_timestamp=utcnow(),
        )
        db.add(user)
        db.commit()
    return user


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    settings = get_settings()

    if settings.dev_mode:
        if any(os.environ.get(marker) for marker in _PRODUCTION_ENV_MARKERS):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="DEV_MODE is enabled in a production environment.",
            )
        return _get_or_create_dev_user(db)

    if credentials is None:
        # TEMP DIAGNOSTIC (remove after auth is confirmed): the request reached
        # the app but carried no bearer token. If you NEVER see any AUTH line for
        # a failing request, the CORS preflight is being rejected upstream and the
        # GET never arrives — fix the origin, not the token.
        _log.warning("AUTH: request had no bearer token")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token."
        )
    if not settings.supabase_jwt_secret:
        _log.error("AUTH: SUPABASE_JWT_SECRET is empty — cannot verify tokens")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth is not configured.",
        )

    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.PyJWTError as exc:
        # TEMP DIAGNOSTIC: names the exact reason — a signature error means the
        # JWT secret is wrong or the project uses asymmetric (ES256/RS256) keys
        # this HS256 path can't verify; an audience error means aud != authenticated.
        _log.warning("AUTH: token rejected (%s): %s", type(exc).__name__, exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token."
        )

    sub = payload.get("sub")
    user = db.get(User, sub)
    # TEMP DIAGNOSTIC: token verified — was the user provisioned in public.users?
    # user_found=False means migration 0008's signup trigger didn't create the row.
    _log.info("AUTH: token ok sub=%s user_found=%s", sub, user is not None)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user."
        )
    return user
