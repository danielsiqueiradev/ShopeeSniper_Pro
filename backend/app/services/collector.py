"""
Collector — interface do módulo de inteligência de mercado.

A Shopee NÃO expõe busca pública de produtos via Open Platform v2 (a API
oficial só opera sobre lojas autenticadas). Para dados de mercado (vendas
acumuladas, ratings, dados do shop), as opções reais são:

  1. Collector próprio sobre endpoints públicos da web/app (ToS sensível —
     usar com proxies rotativos, baixa frequência, apenas dados públicos);
  2. APIs parceiras/terceirizadas de dados de marketplace;
  3. Extensão de browser operada pelo próprio usuário (dados da sessão dele).

Este módulo define o CONTRATO. Implemente `fetch_public_item` /
`fetch_item_ratings` / `fetch_shop_info` no provider escolhido.
"""

from __future__ import annotations


class CollectorRateLimited(Exception):
    def __init__(self, retry_after: int | None = None):
        self.retry_after = retry_after
        super().__init__(f"rate limited, retry_after={retry_after}")


class CollectorUnavailable(Exception):
    pass


def fetch_public_item(item_id: int, shop_id: int) -> dict:
    """
    Retorna o estado atual do anúncio:
        {price, price_before_discount, stock, historical_sold,
         liked_count, comment_count, rating_star, rating_count}
    """
    raise NotImplementedError("configure um provider de coleta (ver docstring)")


def fetch_item_ratings(item_id: int, shop_id: int,
                       filter_stars: tuple[int, ...] = (1, 2, 3),
                       limit: int = 200) -> list[dict]:
    """Retorna [{review_id, rating, comment, ctime}] filtrado por estrelas."""
    raise NotImplementedError


def fetch_shop_info(shop_id: int) -> dict:
    """
    Retorna dados do seller:
        {name, username, location, is_official, rating_star, response_rate,
         response_time_s, ship_prep_days, follower_count, product_count}
    """
    raise NotImplementedError


def search_niche(keyword: str, sort: str = "sales", limit: int = 50) -> list[dict]:
    """Descoberta: busca por keyword ordenada por vendas -> top anúncios do nicho."""
    raise NotImplementedError
