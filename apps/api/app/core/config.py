from pydantic_settings import BaseSettings, SettingsConfigDict


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

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
