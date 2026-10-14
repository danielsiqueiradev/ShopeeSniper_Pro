"""Configuração via variáveis de ambiente (ver .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass

from .services.unit_economics import ShopeeFeeConfig


@dataclass
class Settings:
    # Supabase
    supabase_url: str = ""
    supabase_service_key: str = ""

    # Shopee Open Platform v2 (loja própria)
    shopee_partner_id: int = 0
    shopee_partner_key: str = ""
    shopee_access_token: str = ""
    shopee_shop_id: int = 0

    # taxas (podem ser sobrescritas por env)
    fees: ShopeeFeeConfig = ShopeeFeeConfig()

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_key)

    @property
    def official_configured(self) -> bool:
        return bool(self.shopee_partner_id and self.shopee_partner_key)


def load_settings() -> Settings:
    fees = ShopeeFeeConfig(
        commission_pct=float(os.getenv("FEE_COMMISSION_PCT", 14.0)),
        free_shipping_pct=float(os.getenv("FEE_FREE_SHIPPING_PCT", 6.0)),
        commission_cap=float(os.getenv("FEE_COMMISSION_CAP", 100.0)),
        fixed_fee=float(os.getenv("FEE_FIXED_FEE", 4.0)),
        fixed_fee_threshold=float(os.getenv("FEE_FIXED_THRESHOLD", 8.0)),
        simples_nacional_pct=float(os.getenv("TAX_SIMPLES_PCT", 6.0)),
        ads_pct=float(os.getenv("ADS_PCT", 8.0)),
    )
    return Settings(
        supabase_url=os.getenv("SUPABASE_URL", "").rstrip("/"),
        supabase_service_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
        shopee_partner_id=int(os.getenv("SHOPEE_PARTNER_ID", 0)),
        shopee_partner_key=os.getenv("SHOPEE_PARTNER_KEY", ""),
        shopee_access_token=os.getenv("SHOPEE_ACCESS_TOKEN", ""),
        shopee_shop_id=int(os.getenv("SHOPEE_SHOP_ID", 0)),
        fees=fees,
    )


settings = load_settings()
