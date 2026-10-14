# ShopeeProfit AI

Plataforma de inteligência de mercado, análise preditiva de nichos e gestão de
margem líquida para vendedores de alta performance na Shopee.

## Arquitetura

```
┌───────────────────────┐        ┌─────────────────────────────┐
│  Shopee Open Platform │◄──────►│  Módulo Interno (OAuth2)    │
│  API v2 (HMAC-SHA256) │        │  shopee_client.py           │
└───────────────────────┘        │  → pedidos, escrow, ads     │
                                 └──────────┬──────────────────┘
┌───────────────────────┐                  │
│  Collector (market    │        ┌─────────▼──────────────────┐
│  data provider)       ├───────►│  Celery Workers (Redis)    │
│  collector.py         │        │  snapshots / reviews /     │
└───────────────────────┘        │  aggregate / internal      │
                                 └─────────┬──────────────────┘
                                           │
                                 ┌─────────▼──────────────────┐
                                 │  PostgreSQL (time-series)  │
                                 │  product_daily_snapshots   │
                                 │  product_velocity_metrics  │
                                 └─────────┬──────────────────┘
                                           │
                                 ┌─────────▼──────────────────┐
                                 │  FastAPI  →  Next.js       │
                                 │  /radar /sales-history     │
                                 │  /pain-points /simulations │
                                 └────────────────────────────┘
```

## Como funciona o Sales Velocity Engine

A Shopee só expõe `historical_sold` (acumulado). O sistema grava um snapshot
diário e deriva a velocidade:

```
sold_24h = historical_sold(D0) − historical_sold(D−1)
sold_7d  = historical_sold(D0) − historical_sold(D−7)
trend    = avg_daily(7d) / avg_daily(30d)   →  rising ≥1.15 | falling ≤0.85
```

Edge cases tratados em `velocity_engine.py`: produto sem baseline, reset do
contador da Shopee (delta negativo → clamp 0 + flag), e gaps de coleta
(normalização pelos dias efetivamente decorridos).

## Opportunity Score (0–100)

```
Score = 0.40·Demanda + 0.30·VulnerabilidadeDoSeller + 0.15·(1−Concentração) + 0.15·DorReviews
```

- **Demanda**: `log1p(avg_daily_30d)/log1p(200)·100`, multiplicada por 1.15 se
  `rising`, 0.6 se `falling`.
- **Vulnerabilidade**: rating<4.7 (+30), chat<80% (+25), prep>2d (+20),
  <1k seguidores (+15), não-Mall (+10).
- **Concentração**: `top3_share` invertido (nicho pulverizado → score alto).
- **Dor**: `negative_ratio` (reviews 1–3★) saturando em 15%.

Labels: `hot ≥70 | warm ≥45 | cold ≥25 | avoid <25`.

## Calculadora Reversa (Unit Economics)

```
Receita líquida/unid = P·(1 − c − f − t − a) − F − E − CMV

CMV_TETO  = P·(1 − c − f − t − a − m) − F − E
P_BREAKEVEN = (F + E + CMV) / (1 − c − f − t − a)
```

`c`=comissão, `f`=frete grátis, `t`=imposto, `a`=ACOS, `F`=taxa fixa,
`E`=extras, `m`=margem alvo. Implementado em `unit_economics.py`.

## Wireframe Lógico — Dashboard Principal

Objetivo: **decisão em < 30 segundos**.

```
┌──────────────────────────────────────────────────────────────────┐
│ HEADER: ShopeeProfit AI  |  [Conectar Loja ▾]  [+ Novo Nicho]     │
├──────────────────────────────────────────────────────────────────┤
│ KPI STRIP (4 cards)                                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐    │
│  │ Nichos     │ │ HOT opps   │ │ Receita    │ │ Ticket     │    │
│  │ ativos: 6  │ │ hoje: 14   │ │ nichos 30d │ │ médio pond │    │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│ RADAR DE OPORTUNIDADES  [filtro: nicho ▾] [trend ▾] [score≥50]   │
│ ┌────┬──────────────┬─────────┬─────────┬────────┬───────────┐ │
│ │ 🔥 │ Produto      │ Vendas  │ Trend   │ Seller │ Score     │ │
│ │    │ (thumb+nome) │ 24h/30d │ sparkln │ vulner.│ 0-100 bar │ │
│ ├────┼──────────────┼─────────┼─────────┼────────┼───────────┤ │
│ │ ●  │ Garrafa 2L…  │ 47/980  │ ↗ 1.42  │ ★4.5 ⚠ │ ████░ 82  │ │
│ │ ●  │ Squeeze Inox │ 31/640  │ ↗ 1.28  │ chat72%│ ███░░ 74  │ │
│ │ ○  │ Copo Térmico │ 12/300  │ → 1.01  │ Mall   │ ██░░░ 41  │ │
│ └────┴──────────────┴─────────┴─────────┴────────┴───────────┘ │
├──────────────────────────┬───────────────────────────────────────┤
│ DETALHE DO PRODUTO       │ CALCULADORA REVERSA (sempre visível)   │
│ (clique numa linha)      │ ┌───────────────────────────────────┐ │
│ ┌──────────────────────┐ │ │ Preço alvo   [R$ 79,90    ]       │ │
│ │ Gráfico: vendas/dia  │ │ │ Comissão 14% │ FreteGrátis 6%     │ │
│ │ 30d + preço (2 eixos)│ │ │ Imposto  6%  │ ACOS 10%           │ │
│ │ anotações: price drop│ │ │ Taxa fixa R$4 │ Margem alvo 20%  │ │
│ └──────────────────────┘ │ ├───────────────────────────────────┤ │
│ Pain points (reviews):   │ │ ★ CMV TETO:      R$ 22,36/unid    │ │
│  ▓▓▓▓ tamanho (41%)      │ │   Breakeven:     R$ 58,40         │ │
│  ▓▓ embalagem (22%)      │ │   Lucro líquido: R$ 15,98/unid    │ │
│  ▓ atraso (15%)          │ │   [VIABLE ●]                     │ │
│ → Insight: "Ofereça tabela│ └───────────────────────────────────┘ │
│   de medidas + embalagem │  AÇÕES: [Monitorar] [Ver Seller]      │
│   reforçada no copy"     │  [Salvar Simulação] [Exportar]        │
└──────────────────────────┴───────────────────────────────────────┘
```

**Telas secundárias:**
- `/niches` — cards por nicho: ticket médio ponderado, top3_share com badge
  (`fragmented` = verde, `concentrated` = vermelho), gráfico dispersão
  Preço × Volume dos top 50.
- `/seller/:shop_id` — raio-X do concorrente: rating, response rate, prep,
  seguidores, localização (mapa p/ análise de frete), histórico 30d.
- `/internal` — loja própria: pedidos, conciliação de taxas
  (bruto → escrow líquido), ACOS real de Shopee Ads.
- `/products/:id` — série temporal completa + reviews mineradas.

## Setup

```bash
cd shopeeprofit-ai
cp backend/.env.example backend/.env   # preencher partner_id/key
docker compose up -d postgres redis
docker compose up api worker beat

# Frontend (porta 3000, proxy /api -> :8000)
cd frontend && npm install && npm run dev

# Testes dos engines
cd backend && python -m pytest
```

### Setup local sem Docker (Windows)

```powershell
# .env apontando para Supabase (Postgres) e Upstash (Redis)
python scripts/apply_schema.py                                     # cria tabelas
uvicorn app.main:app --reload                                      # API :8000
celery -A app.workers.celery_app worker --pool=solo -Q snapshots,reviews,internal,aggregate
celery -A app.workers.celery_app beat                              # agendador
```

> `--pool=solo` é obrigatório no Windows (Celery prefork não funciona fora de Unix).

**Collector**: `services/collector_web.py` implementa o provider via endpoints
públicos v4 da web Shopee, com token bucket local, retry em 403/429 e suporte a
`SHOPEE_PROXY_URL`. É boundado automaticamente no import de `workers/tasks.py`.
Para trocar de provider, reimplemente as 4 funções de `collector.py`.

`GET /api/auth/connect-url` → lojista autoriza → `POST /api/auth/callback`
persiste tokens (renovação automática a cada ~4h via `ShopeeClient`).

## Decisões arquiteturais

| Decisão | Motivo |
|---|---|
| Snapshot diário (não tempo real) | `historical_sold` é acumulado — delta diário é a menor unidade confiável |
| Particionamento mensal | Queries de série temporal só varrem a partição necessária; fácil migração p/ TimescaleDB |
| `product_velocity_metrics` pré-computado | Dashboard lê 1 linha/produto; janelas móveis calculadas 1x/dia no worker |
| Generated columns (`trend_label`, `concentration_label`, `is_vulnerable`) | Regras de negócio single-source no banco; índices parciais baratos |
| Collector como interface | Isola o provider de dados de mercado (ToS-sensível) do restante do pipeline |
| Fan-out 1 task/produto + `rate_limit="15/s"` | Backpressure natural no broker; retry isolado por produto |
