"""
get_current_user — every route depends on this from the first scaffold
commit (§3.1). No endpoint ever accepts a user_id from the client.

DEV_MODE returns the local dev user, but the bypass cannot reach
production: if any production platform variable is present alongside
DEV_MODE=true, every request 503s.
"""
import os

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User, utcnow

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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token."
        )
    if not settings.supabase_jwt_secret:
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
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token."
        )

    user = db.get(User, payload["sub"])
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user."
        )
    return user
