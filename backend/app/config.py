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

    max_monthly_tokens: int = 2_000_000
    daily_token_budget_per_user: int = 60_000


@lru_cache
def get_settings() -> Settings:
    return Settings()
