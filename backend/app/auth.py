"""
get_current_user — every route depends on this from the first scaffold
commit (§3.1). No endpoint ever accepts a user_id from the client.

DEV_MODE returns the local dev user, but the bypass cannot reach
production: if any production platform variable is present alongside
DEV_MODE=true, every request 503s.
"""
import logging
import os
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.models import User, utcnow

_log = logging.getLogger("uvicorn.error")

# Supabase access-token audience claim (constant across projects).
_AUDIENCE = "authenticated"
# Asymmetric algorithms newer Supabase projects sign with. Their verification
# key comes from the project's public JWKS — never the shared secret. Binding
# the key SOURCE to the algorithm is what blocks JWT algorithm-confusion attacks.
_ASYMMETRIC_ALGS = ("ES256", "RS256", "EdDSA")

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


class _AuthConfigError(Exception):
    """Server-side auth misconfiguration (missing secret / URL) → 503, not 401:
    the token may be perfectly valid; the server just can't verify it yet."""


@lru_cache(maxsize=4)
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    # One cached client per JWKS URL; PyJWKClient also caches the fetched keys,
    # so Supabase's JWKS endpoint is hit at most once per key rotation, not per
    # request.
    return jwt.PyJWKClient(jwks_url)


def _decode_token(token: str, settings: Settings) -> dict:
    """Verify a Supabase access token, supporting BOTH signing schemes.

    The token header's `alg` selects the path AND the key source:
      • HS256        → the legacy shared secret (SUPABASE_JWT_SECRET).
      • ES256/RS256  → the project's public JWKS (needs SUPABASE_URL set).
    Newer Supabase projects issue asymmetric (ES256) tokens; older ones HS256.
    Either works here without redeploying when a project migrates its keys.
    """
    alg = jwt.get_unverified_header(token).get("alg", "")

    if alg == "HS256":
        if not settings.supabase_jwt_secret:
            raise _AuthConfigError("SUPABASE_JWT_SECRET is empty but received an HS256 token")
        key: object = settings.supabase_jwt_secret
    elif alg in _ASYMMETRIC_ALGS:
        if not settings.supabase_url:
            raise _AuthConfigError(f"SUPABASE_URL is empty but token alg={alg} needs the JWKS")
        jwks_url = settings.supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"
        key = _jwks_client(jwks_url).get_signing_key_from_jwt(token).key
    else:
        raise jwt.InvalidAlgorithmError(f"unsupported token alg {alg!r}")

    # leeway absorbs minor Render↔Supabase clock skew on exp/iat/nbf.
    return jwt.decode(token, key, algorithms=[alg], audience=_AUDIENCE, leeway=30)


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
    try:
        payload = _decode_token(credentials.credentials, settings)
    except _AuthConfigError as exc:
        _log.error("AUTH: not configured — %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth is not configured.",
        )
    except jwt.PyJWTError as exc:
        # TEMP DIAGNOSTIC (Render logs) — the exact decode failure:
        #   InvalidSignatureError → wrong SUPABASE_JWT_SECRET (HS256) / wrong key
        #   InvalidAlgorithmError → token alg unsupported (set SUPABASE_URL for ES256)
        #   ExpiredSignatureError → expired token (refresh / clock skew)
        #   InvalidAudienceError  → aud != "authenticated"
        _log.warning("AUTH: token rejected (%s): %s", type(exc).__name__, exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token."
        )
    except Exception as exc:  # JWKS fetch/parse/network failures
        _log.warning("AUTH: token verification error (%s): %s", type(exc).__name__, exc)
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
