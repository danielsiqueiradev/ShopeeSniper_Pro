"""ShopeeSniper Pro — Backend Engine (FastAPI)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import analytics, ingest, official_store


def create_app() -> FastAPI:
    app = FastAPI(
        title="ShopeeSniper Pro — Backend Engine",
        version="1.0.0",
        description=(
            "Inteligência de mercado Shopee: unit economics reverso, "
            "opportunity score, pain miner e integração Open Platform v2."
        ),
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],          # extensão Chrome (chrome-extension://*)
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(ingest.router)
    app.include_router(analytics.router)
    app.include_router(official_store.router)

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "service": "shopee-sniper-pro"}

    return app


app = create_app()
