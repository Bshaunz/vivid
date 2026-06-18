"""Environment-driven settings. All secrets live in env vars (§3.2)."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    dev_mode: bool = False
    database_url: str = "sqlite:///./vivid_dev.db"
    frontend_origin: str = "http://localhost:5173"

    supabase_jwt_secret: str = ""

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
        return [o.strip() for o in self.frontend_origin.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
