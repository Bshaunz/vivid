"""Environment-driven settings. All secrets live in env vars (§3.2)."""
from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    dev_mode: bool = False
    database_url: str = "sqlite:///./vivid_dev.db"
    # The prod CORS origin. Accept BOTH the canonical FRONTEND_ORIGIN and the
    # common FRONTEND_URL misspelling so a single dashboard typo can't silently
    # fall back to the localhost default and 400 every preflight (extra="ignore"
    # would otherwise drop an unrecognized name). FRONTEND_ORIGIN wins if both set.
    frontend_origin: str = Field(
        default="http://localhost:5173",
        validation_alias=AliasChoices("FRONTEND_ORIGIN", "FRONTEND_URL"),
    )
    # Prod regex for origins that vary per deploy — Vercel rotates the URL
    # (vivid-mocha, vivid-git-<branch>, vivid-<hash>…). An origin is allowed if
    # it matches the exact FRONTEND_ORIGIN list OR this pattern. Defaults to THIS
    # project's Vercel domains so prod CORS works the moment this code deploys,
    # with no env var to set. Override FRONTEND_ORIGIN_REGEX to change it.
    frontend_origin_regex: str = r"https://vivid[a-z0-9-]*\.vercel\.app"

    supabase_jwt_secret: str = ""
    # Project base URL, e.g. https://<ref>.supabase.co — used to fetch the JWKS
    # for verifying ASYMMETRIC (ES256/RS256) tokens, which newer Supabase
    # projects issue. Same value as the frontend's VITE_SUPABASE_URL. Optional:
    # when blank, only the legacy HS256 shared-secret path is available.
    supabase_url: str = ""

    anthropic_api_key: str = ""
    synthesis_prompt_path: str = ""
    # Real-client knobs (dormant under the mock; mock reports MOCK_MODEL itself).
    synthesis_model: str = "claude-opus-4-8"
    synthesis_max_tokens: int = 1500

    max_monthly_tokens: int = 2_000_000
    daily_token_budget_per_user: int = 60_000

    @property
    def cors_origins(self) -> list[str]:
        """Production allow-list. Supports a comma-separated FRONTEND_ORIGIN so
        the Vercel app + any preview domains can be listed explicitly — never a
        wildcard in prod (§3.1)."""
        return [o.strip().rstrip("/") for o in self.frontend_origin.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
