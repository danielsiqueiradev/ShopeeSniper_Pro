from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/shopeeprofit"
    redis_url: str = "redis://localhost:6379/0"

    # Shopee Open Platform v2
    shopee_partner_id: int = 0
    shopee_partner_key: str = ""
    shopee_env: str = "prod"                      # prod | test
    shopee_redirect_url: str = "https://app.shopeeprofit.ai/auth/callback"
    shopee_proxy_url: str | None = None
    # Cookies da sessão logada no browser (collector passa como usuário real)
    shopee_cookies: str = ""

    # Fee defaults — calculadora reversa (override por simulação)
    default_commission_pct: float = 14.0
    default_freeship_pct: float = 6.0
    default_fixed_fee: float = 4.0
    default_tax_pct: float = 6.0

    jwt_secret: str = "change-me"
    jwt_expires_min: int = 60 * 24


settings = Settings()
