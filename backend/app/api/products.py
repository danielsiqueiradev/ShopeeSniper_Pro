"""Endpoints de produtos — radar, série temporal de vendas, pain points."""

import re
import uuid
from dataclasses import dataclass
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import models as m

router = APIRouter()

_quick_collector = None


def _get_collector():
    """Singleton lazy do WebCollector em modo interativo (timeout curto,
    sem retries longos) — o processo da API não passa pelo bind() do worker."""
    global _quick_collector
    if _quick_collector is None:
        from app.services.collector_web import WebCollector, WebCollectorConfig
        _quick_collector = WebCollector(
            WebCollectorConfig(timeout=6.0, max_retries=0))
    return _quick_collector


def _quick_fetch(item_id: int, shop_id: int) -> dict:
    """Tentativa única e rápida de enriquecer o cadastro — o pipeline
    diário faz a coleta completa depois."""
    return _get_collector().fetch_public_item(item_id, shop_id)


# Formatos aceitos:
#   https://shopee.com.br/Nome-Produto-i.123456.7890123       (shop+item)
#   https://shopee.com.br/product/123456/7890123              (shop+item)
#   https://shopee.com.br/...?itemid=7890123&shopid=123456    (shop+item)
#   https://shopee.com.br/flash_sale?fromItem=789&promotionId=N  (item só)
_PATTERNS_FULL = [
    re.compile(r"-i\.(\d+)\.(\d+)"),                        # grupo1=shop, grupo2=item
    re.compile(r"/product/(\d+)/(\d+)"),
    re.compile(r"itemid=(\d+).*?shopid=(\d+)"),             # grupo1=item, grupo2=shop
]
_RX_FROM_ITEM = re.compile(r"fromItem=(\d+)")
_RX_PROMOTION = re.compile(r"promotionId=(\d+)")


@dataclass
class ParsedRef:
    shop_id: int | None
    item_id: int | None
    promotion_id: int | None = None


def parse_shopee_url(url: str) -> ParsedRef | None:
    """Extrai referências de uma URL da Shopee. None se nada reconhecido."""
    for rx in _PATTERNS_FULL:
        m_ = rx.search(url)
        if m_:
            a, b = int(m_.group(1)), int(m_.group(2))
            shop, item = (b, a) if "itemid" in rx.pattern else (a, b)
            return ParsedRef(shop_id=shop, item_id=item)

    # flash_sale / entry links: só item_id (shop resolvido depois)
    m_item = _RX_FROM_ITEM.search(url)
    if m_item:
        promo = _RX_PROMOTION.search(url)
        return ParsedRef(
            shop_id=None, item_id=int(m_item.group(1)),
            promotion_id=int(promo.group(1)) if promo else None)
    return None


class MonitorIn(BaseModel):
    url: str | None = None
    item_id: int | None = None
    shop_id: int | None = None
    niche_id: uuid.UUID | None = None


@router.post("/monitor")
def monitor_product(body: MonitorIn, db: Session = Depends(get_db)):
    """Registra um anúncio específico para monitoramento diário."""
    if body.url:
        parsed = parse_shopee_url(body.url)
        if parsed is None:
            # Link curto (shope.ee) ou formato desconhecido — segue
            # o redirect e tenta de novo com a URL final
            try:
                final_url = _get_collector().resolve_redirect(body.url)
                parsed = parse_shopee_url(final_url) if final_url else None
            except Exception:
                pass
        if not parsed or parsed.item_id is None:
            raise HTTPException(
                400, "URL inválida. Aceito: página do produto "
                     "(…-i.<shopid>.<itemid>), /product/<shopid>/<itemid>, "
                     "link curto ou flash_sale (?fromItem=…&promotionId=…)")
        shop_id, item_id, promotion_id = (
            parsed.shop_id, parsed.item_id, parsed.promotion_id)
    elif body.item_id and body.shop_id:
        shop_id, item_id, promotion_id = body.shop_id, body.item_id, None
    else:
        raise HTTPException(400, "Informe url ou (item_id + shop_id)")

    # URL sem shop_id (flash_sale, link curto) -> resolve pelo collector
    if shop_id is None:
        try:
            shop_id = _get_collector().resolve_item_shop(
                item_id, promotion_id, source_url=body.url)
        except Exception:
            shop_id = None
        if shop_id is None:
            raise HTTPException(
                422, "Item identificado mas a loja não foi resolvida "
                     "automaticamente. Abra o anúncio e cole a URL da "
                     "página do produto (formato …-i.<shopid>.<itemid>).")

    shop = db.scalar(select(m.CompetitorShop)
                     .where(m.CompetitorShop.shop_id == shop_id))
    if not shop:
        shop = m.CompetitorShop(shop_id=shop_id, name=f"shop_{shop_id}")
        db.add(shop)

    product = db.scalar(select(m.MonitoredProduct).where(
        m.MonitoredProduct.item_id == item_id,
        m.MonitoredProduct.shop_id == shop_id))
    already = product is not None
    if not product:
        product = m.MonitoredProduct(
            item_id=item_id, shop_id=shop_id,
            name=f"item_{item_id}",
            product_url=f"https://shopee.com.br/product/{shop_id}/{item_id}",
            niche_id=body.niche_id)
        db.add(product)
    product.monitoring = True
    if body.niche_id:
        product.niche_id = body.niche_id
    db.flush()

    # Primeira coleta best-effort (timeout ~6s, sem retry) — se o collector
    # estiver indisponível, o worker diário preenche no próximo ciclo.
    first_snapshot = False
    try:
        item = _quick_fetch(item_id, shop_id)
        product.name = item.get("name") or product.name
        product.image_url = item.get("image_url")
        db.merge(m.ProductDailySnapshot(
            product_id=product.id, snapshot_date=date.today(),
            price=item["price"],
            price_before_discount=item.get("price_before_discount"),
            stock=item.get("stock"),
            historical_sold=item["historical_sold"],
            liked_count=item.get("liked_count"),
            comment_count=item.get("comment_count"),
            rating_star=item.get("rating_star"),
            rating_count=item.get("rating_count")))
        first_snapshot = True
    except Exception:
        pass

    db.commit()
    return {
        "product_id": str(product.id),
        "item_id": item_id,
        "shop_id": shop_id,
        "product_url": product.product_url,
        "already_monitored": already,
        "first_snapshot": first_snapshot,
        "note": None if first_snapshot else
                "registrado — dados serão coletados no próximo ciclo do worker",
    }


@router.get("/radar")
def opportunity_radar(
    niche_id: uuid.UUID | None = None,
    min_score: float = Query(0, ge=0, le=100),
    trend: str | None = Query(None, pattern="^(rising|stable|falling)$"),
    sort: str = Query("name", pattern="^(name|score|sold_30d)$"),
    limit: int = Query(50, le=200),
    db: Session = Depends(get_db),
):
    """Radar de Oportunidades — ordenação alfabética por padrão,
    ou por score/vendas via ?sort=."""
    order = {
        "name": "LOWER(name) ASC",
        "score": "opportunity_score DESC NULLS LAST",
        "sold_30d": "sold_last_30d DESC NULLS LAST",
    }[sort]
    rows = db.execute(text(f"""
        SELECT * FROM v_product_radar
        WHERE (CAST(:nid AS uuid) IS NULL OR niche_id = CAST(:nid AS uuid))
          AND COALESCE(opportunity_score, 0) >= :min_score
          AND (CAST(:trend AS text) IS NULL OR trend_label = CAST(:trend AS text))
        ORDER BY {order}
        LIMIT :lim
    """), {"nid": str(niche_id) if niche_id else None,
           "min_score": min_score, "trend": trend, "lim": limit}).mappings()
    return [dict(r) for r in rows]


@router.get("/{product_id}/sales-history")
def sales_history(product_id: uuid.UUID, days: int = Query(30, le=365),
                  db: Session = Depends(get_db)):
    """
    Série temporal diária para o gráfico de velocidade:
    vendas acumuladas + delta do dia + preço (detecta guerra de preço).
    """
    rows = db.execute(text("""
        SELECT snapshot_date, historical_sold, sold_delta_1d, price, stock,
               rating_star, rating_count
        FROM product_daily_snapshots
        WHERE product_id = :pid
        ORDER BY snapshot_date DESC
        LIMIT :days
    """), {"pid": str(product_id), "days": days}).mappings().all()
    if not rows:
        raise HTTPException(404, "produto sem snapshots")
    return [dict(r) for r in reversed(rows)]


@router.get("/{product_id}/pain-points")
def pain_points(product_id: uuid.UUID, db: Session = Depends(get_db)):
    """Top motivos de insatisfação do concorrente — insumo de copywriting."""
    row = db.execute(text("""
        SELECT total_reviews, negative_reviews, negative_ratio,
               top_pain_points, improvement_insight
        FROM product_reviews_summary WHERE product_id = :pid
    """), {"pid": str(product_id)}).mappings().first()
    if not row:
        raise HTTPException(404, "reviews ainda não coletadas para este produto")
    return dict(row)
