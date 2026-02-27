from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def normalize_database_url(database_url: str) -> str:
    """Normalize PostgreSQL SQLAlchemy URLs to the psycopg v3 driver.
    Render-provisioned DATABASE_URL values often arrive as `postgres://...`
    or `postgresql://...` and SQLAlchemy interprets those as the legacy
    psycopg2 dialect. This app ships psycopg v3, so we normalize to
    `postgresql+psycopg://...` to avoid runtime import errors.
    """
    if database_url.startswith("postgresql+psycopg2://"):
        return database_url.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+psycopg://", 1)
    return database_url


class Settings(BaseSettings):
    # V1 Build Scope: core infrastructure env vars are required for Render deployment.
    app_name: str = "Dispatch Delivery API"
    api_prefix: str = "/api/v1"
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/dispatch"
    redis_url: str = "redis://localhost:6379/0"
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    jwt_exp_minutes: int = 60
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from_number: str = ""
    stripe_api_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_publishable_key: str = ""
    r2_endpoint_url: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = ""
    r2_public_url: str = ""

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalize_database_url(cls, value: str) -> str:
        return normalize_database_url(value)

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
