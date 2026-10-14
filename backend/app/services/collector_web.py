"""
WebCollector — provider concreto para coleta de dados públicos de mercado.

Usa os endpoints v4 que a própria aplicação web da Shopee consome
(shopee.com.br/api/v4/...). São dados públicos exibidos em qualquer
página de produto, mas NÃO fazem parte da Open Platform oficial.

⚠️  Considerações operacionais:
  - Rate limit agressivo por IP. Use pool de proxies residenciais em
    produção (SHOPEE_PROXY_URL no .env) e mantenha o rpm baixo (<= 30/min).
  - Anti-bot (403 + captcha) pode ser ativado por volume. Backoff
    exponencial já implementado; monitore crawl_jobs.failed.
  - Preços chegam em micro-unidades (dividir por 1e5).
  - Respeite ToS/LGPD: colete apenas dados públicos, sem PII de compradores.

Para trocar de provider (API parceira, extensão de browser), basta
reimplementar as 4 funções e apontar `services/collector.py` para elas.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass

import httpx

from app.services.collector import CollectorRateLimited, CollectorUnavailable

logger = logging.getLogger(__name__)

BASE_URL = "https://shopee.com.br/api/v4"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Referer": "https://shopee.com.br/",
    "X-API-SOURCE": "pc",
}


@dataclass
class WebCollectorConfig:
    proxy_url: str | None = None       # ex.: "http://user:pass@proxy:port"
    rpm: int = 24                      # token bucket local (conservador)
    timeout: float = 15.0
    max_retries: int = 3


class WebCollector:
    """Provider com rate limit local + retry/backoff + jitter."""

    def __init__(self, config: WebCollectorConfig | None = None):
        self.cfg = config or WebCollectorConfig()
        self._interval = 60.0 / self.cfg.rpm
        self._next_at = 0.0
        self._http = httpx.Client(
            base_url=BASE_URL,
            headers=_HEADERS,
            timeout=self.cfg.timeout,
            proxy=self.cfg.proxy_url,
            follow_redirects=True,
        )

    # ------------------------------------------------------------------
    # HTTP core com throttle + backoff
    # ------------------------------------------------------------------

    def _get(self, path: str, params: dict) -> dict:
        for attempt in range(self.cfg.max_retries + 1):
            # token bucket local
            wait = self._next_at - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._next_at = max(time.monotonic(), self._next_at) + self._interval

            resp = self._http.get(path, params=params)

            if resp.status_code == 200:
                data = resp.json()
                # Shopee retorna {"error": N} dentro de 200 em alguns casos
                if data.get("error") in (None, 0):
                    return data.get("data") or data
                raise CollectorUnavailable(f"shopee error={data['error']}")

            if resp.status_code in (403, 429):
                retry_after = int(resp.headers.get("Retry-After", 0)) or (
                    60 * (attempt + 1) + random.randint(0, 30))
                if attempt == self.cfg.max_retries:
                    raise CollectorRateLimited(retry_after)
                logger.warning("%s %s -> HTTP %s, backoff %ss",
                               path, params, resp.status_code, retry_after)
                time.sleep(min(retry_after, 120))
                continue

            if resp.status_code >= 500 and attempt < self.cfg.max_retries:
                time.sleep(2 ** attempt + random.random())
                continue

            raise CollectorUnavailable(f"HTTP {resp.status_code} em {path}")

        raise CollectorUnavailable("max_retries exceeded")

    # ------------------------------------------------------------------
    # Contrato do provider (mesmo shape de collector.py)
    # ------------------------------------------------------------------

    def fetch_public_item(self, item_id: int, shop_id: int) -> dict:
        data = self._get("/item/get", {"itemid": item_id, "shopid": shop_id})
        rating = data.get("item_rating", {}) or {}
        return {
            "price": (data.get("price") or 0) / 1e5,
            "price_before_discount": (data.get("price_before_discount")
                                      or data.get("price") or 0) / 1e5,
            "stock": data.get("stock"),
            "historical_sold": data.get("historical_sold")
                               or data.get("sold") or 0,
            "liked_count": data.get("liked_count"),
            "comment_count": data.get("cmt_count"),
            "rating_star": rating.get("rating_star"),
            "rating_count": (rating.get("rating_count") or [0])[0]
                            if isinstance(rating.get("rating_count"), list)
                            else rating.get("rating_count"),
            "name": data.get("name"),
            "image_url": f"https://cf.shopee.com.br/file/{data.get('image')}"
                         if data.get("image") else None,
        }

    def fetch_item_ratings(self, item_id: int, shop_id: int,
                           filter_stars: tuple[int, ...] = (1, 2, 3),
                           limit: int = 200) -> list[dict]:
        """Coleta reviews por estrela (filter param: 1-5, 0=todos, 6=com foto)."""
        out: list[dict] = []
        for star in filter_stars:
            offset = 0
            while len(out) < limit:
                page = min(20, limit - len(out))
                if page <= 0:
                    break
                data = self._get("/item/get_ratings", {
                    "itemid": item_id, "shopid": shop_id,
                    "offset": offset, "limit": page,
                    "filter": star, "type": 0,
                })
                ratings = data.get("ratings") or []
                if not ratings:
                    break
                for r in ratings:
                    out.append({
                        "review_id": f"{r.get('orderid')}_{r.get('itemid')}",
                        "rating": r.get("rating_star"),
                        "comment": r.get("comment"),
                        "ctime": r.get("ctime"),
                    })
                offset += len(ratings)
                if len(ratings) < page:
                    break
        return out[:limit]

    def fetch_shop_info(self, shop_id: int) -> dict:
        data = self._get("/shop/get_shop_detail", {"shopid": shop_id})
        d = data.get("data", data)
        return {
            "name": d.get("name"),
            "username": d.get("account", {}).get("username")
                        if isinstance(d.get("account"), dict) else d.get("username"),
            "location": d.get("location") or d.get("shop_location"),
            "is_official": bool(d.get("is_official_shop")),
            "rating_star": d.get("rating_star"),
            "response_rate": (d.get("response_rate") or 0) / 100 * 100,
            "response_time_s": d.get("response_time"),
            "ship_prep_days": (d.get("preparation_time") or 0) / 86400
                              if (d.get("preparation_time") or 0) > 10 else
                              d.get("preparation_time"),
            "follower_count": d.get("follower_count"),
            "product_count": d.get("item_count") or d.get("total_items"),
        }

    def resolve_item_shop(self, item_id: int,
                          promotion_id: int | None = None,
                          source_url: str | None = None) -> int | None:
        """
        Resolve o shop_id de um item quando a URL de origem não o traz.

        Estratégias:
          1. source_url (link curto shope.ee ou redirect) — segue redirects
             e extrai -i.shop.item do URL final
          2. flash_sale — pagina flash_sale_get_items até achar o itemid
        """
        import re

        if source_url:
            final = self.resolve_redirect(source_url)
            if final:
                m = re.search(r"-i\.(\d+)\.(\d+)", final)
                if m:
                    return int(m.group(1))

        if promotion_id:
            for offset in range(0, 660, 60):
                try:
                    data = self._get("/flash_sale/flash_sale_get_items", {
                        "limit": 60, "offset": offset, "order": "",
                        "promotionid": promotion_id, "shopid": 0,
                        "sort_soldout": "true", "version": 2,
                        "with_dp_items": "true", "need_personalize": "false",
                    })
                except Exception:
                    break
                items = data.get("items") or []
                for it in items:
                    if it.get("itemid") == item_id:
                        return it.get("shopid")
                if len(items) < 60:
                    break
        return None

    def resolve_redirect(self, url: str) -> str | None:
        """Segue redirects de um link curto e devolve a URL final."""
        try:
            resp = self._http.get(url)
            return str(resp.url)
        except Exception:
            return None

    def search_niche(self, keyword: str, sort: str = "sales",
                     limit: int = 50) -> list[dict]:
        """Busca pública por keyword -> top anúncios do nicho (discovery)."""
        sort_map = {"sales": "sales", "relevance": "relevancy", "ctime": "ctime"}
        out: list[dict] = []
        offset = 0
        while len(out) < limit:
            page = min(50, limit - len(out))
            data = self._get("/search/search_items", {
                "by": sort_map.get(sort, "sales"),
                "keyword": keyword,
                "limit": page,
                "newest": offset,
                "order": "desc",
                "page_type": "search",
                "version": 2,
            })
            items = data.get("items") or []
            if not items:
                break
            for it in items:
                b = it.get("item_basic", it)
                out.append({
                    "item_id": b.get("itemid"),
                    "shop_id": b.get("shopid"),
                    "name": b.get("name"),
                    "price": (b.get("price") or 0) / 1e5,
                    "historical_sold": b.get("historical_sold") or b.get("sold"),
                    "image_url": f"https://cf.shopee.com.br/file/{b.get('image')}"
                                 if b.get("image") else None,
                })
            offset += len(items)
            if len(items) < page:
                break
        return out[:limit]


# --------------------------------------------------------------------------
# Wiring — provider concreto injetado no contrato de collector.py
# --------------------------------------------------------------------------

def bind() -> "WebCollector":
    """Instancia o collector e injeta como provider do módulo collector."""
    import os
    from app.services import collector

    wc = WebCollector(WebCollectorConfig(proxy_url=os.getenv("SHOPEE_PROXY_URL")))
    collector.fetch_public_item = wc.fetch_public_item
    collector.fetch_item_ratings = wc.fetch_item_ratings
    collector.fetch_shop_info = wc.fetch_shop_info
    collector.search_niche = wc.search_niche
    return wc
