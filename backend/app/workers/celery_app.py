"""
Celery app — orquestração das filas de coleta.

Filas:
  - snapshots : 1 tarefa por produto/dia (alto volume, alta prioridade)
  - reviews   : coleta de avaliações (médio volume)
  - aggregate : recálculo de velocity/score/stats de nicho (pós-ingestão)
  - internal  : sync de pedidos/ads da loja do usuário via Open Platform

Beat schedule: cron diário às 03:00 UTC (00:00 BRT) dispara o fan-out.
"""

from celery import Celery
from celery.schedules import crontab

from app.config import settings

celery_app = Celery(
    "shopeeprofit",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_routes={
        "app.workers.tasks.snapshot_product": {"queue": "snapshots"},
        "app.workers.tasks.collect_reviews": {"queue": "reviews"},
        "app.workers.tasks.sync_internal_shop": {"queue": "internal"},
        "app.workers.tasks.recompute_*": {"queue": "aggregate"},
    },
    task_acks_late=True,                    # re-enfileira se worker morrer no meio
    worker_prefetch_multiplier=1,           # distribui 1 tarefa por vez (rate limit)
    task_default_retry_delay=60,
    broker_transport_options={"visibility_timeout": 3600},
    timezone="America/Sao_Paulo",
)

celery_app.conf.beat_schedule = {
    # Fan-out diário dos snapshots de todos os produtos monitorados
    "daily-snapshot-fanout": {
        "task": "app.workers.tasks.daily_snapshot_fanout",
        "schedule": crontab(hour=3, minute=0),   # 03:00 — pós-fechamento do dia Shopee
    },
    # Recálculo dos agregados 30 min após o início da coleta
    "daily-aggregation": {
        "task": "app.workers.tasks.recompute_all_metrics",
        "schedule": crontab(hour=4, minute=30),
    },
    # Sync da loja própria (pedidos + ads + escrow) a cada 6h
    "internal-shop-sync": {
        "task": "app.workers.tasks.sync_all_internal_shops",
        "schedule": crontab(minute=15, hour="*/6"),
    },
    # Coleta de reviews negativas dos top produtos — semanal
    "weekly-review-mining": {
        "task": "app.workers.tasks.review_mining_fanout",
        "schedule": crontab(hour=5, minute=0, day_of_week="mon"),
    },
}
