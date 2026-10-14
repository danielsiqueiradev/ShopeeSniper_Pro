from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, niches, products, simulations

app = FastAPI(
    title="ShopeeProfit AI",
    description="Inteligência de mercado, velocity de vendas e unit economics para sellers Shopee.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(niches.router, prefix="/api/niches", tags=["niches"])
app.include_router(products.router, prefix="/api/products", tags=["products"])
app.include_router(simulations.router, prefix="/api/simulations", tags=["simulations"])


@app.get("/health")
def health():
    return {"status": "ok"}
