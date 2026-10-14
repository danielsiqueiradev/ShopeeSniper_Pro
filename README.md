# ShopeeSniper Pro

Inteligência de mercado open-source pra Shopee BR — o "Avantpro/Shopdora
grátis": extensão Chrome que intercepta passivamente os dados internos da
Shopee (zero proxy, zero anti-bot) + backend FastAPI com unit economics
reverso, opportunity score e pain miner + snapshots históricos no Supabase.

## Estrutura

```
database/
  migrations/001_supabase_schema.sql   # tabelas, view LAG, RPC de ingest
  seed_test_data.sql                   # dados de exemplo
apps/
  avantpro-clone-ext/                  # extensão Chrome MV3 (vanilla JS)
  backend-engine/                      # FastAPI + testes pytest
  web-dashboard/                       # Next.js (scaffold)
```

## 1) Supabase (banco)

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, rode `database/migrations/001_supabase_schema.sql`.
3. (Opcional) Rode `database/seed_test_data.sql` pra ver dados de exemplo.
4. Anote `SUPABASE_URL` e a `service_role` key (Settings → API).

O coração é `product_daily_snapshots` (`UNIQUE(item_id, snapshot_date)`) +
a view `vw_sales_by_date_velocity`, que usa `LAG(historical_sold)` pra
derivar **vendas exatas por dia** — a Shopee só expõe o acumulado.

## 2) Backend (FastAPI)

```bash
cd apps/backend-engine
python -m venv .venv && .venv\Scripts\activate     # Windows
pip install -r requirements.txt
copy .env.example .env                              # edite as chaves
uvicorn app.main:app --reload --port 8000
```

Docs interativas: http://localhost:8000/docs

### Endpoints principais

| Método | Rota | O que faz |
|---|---|---|
| POST | `/ingest/payload` | Recebe payload da extensão, normaliza (÷100000) e faz upsert no Supabase via RPC |
| POST | `/analytics/unit-economics` | Lucro líquido, taxas detalhadas, breakeven ROAS, **CMV Teto** |
| POST | `/analytics/opportunity-score` | Score 0–100 (velocidade + freshness + vulnerabilidade) |
| POST | `/analytics/sales-by-date` | Deltas diários de uma série de snapshots |
| POST | `/analytics/pain-miner` | Categoriza reviews 1–3★ e gera checklist de fornecedor |
| GET  | `/official/orders` | Pedidos da sua loja (Open Platform v2, precisa de credenciais) |
| GET  | `/official/orders/{sn}/escrow` | Auditoria das taxas reais descontadas |

### Testes

```bash
cd apps/backend-engine
python -m pytest -q        # 59 testes — taxas, CMV teto, LAG, score, HMAC
```

## 3) Extensão Chrome

1. Abra `chrome://extensions` → ative **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione `apps/avantpro-clone-ext/`.
3. Navegue na `shopee.com.br` normalmente:
   - **Busca**: barra superior com volume 30d, receita 30d, ticket médio,
     filtros 🔥 Rising Stars / 🎯 Weak Sellers e 📥 Export CSV.
   - **Cards**: badge com data de criação, velocidade, receita 30d,
     margem pós-Shopee e **CMV Teto pra 20% de lucro**.
   - **PDP**: drawer lateral com tabela de variações/SKUs, card de
     vulnerabilidade do vendedor, pain miner de reviews negativas e
     download de mídia sem marca d'água.

O interceptor roda em `world: MAIN` (document_start) e só **lê** respostas
de `/api/v4/...` — nunca modifica requests. Configs opcionais em
`chrome.storage.local`: `backendUrl`, `supabaseUrl`, `supabaseKey`.

## 4) Dashboard web

```bash
cd apps/web-dashboard
npm install
npm run dev        # http://localhost:3000
```

## Taxas padrão (editáveis via .env)

| Taxa | Valor |
|---|---|
| Comissão | 14% (teto R$ 100/item) |
| Frete grátis | +6% |
| Taxa fixa | R$ 4,00/item (metade do preço se < R$ 8) |
| Imposto (Simples) | 6% |
| Ads (ACOS est.) | 8% |

> ⚠️ Uso educacional. Interceptar dados exibidos no seu próprio navegador
> é a técnica padrão dessas ferramentas, mas respeite os Termos da Shopee
> e não revenda dados. Credenciais oficiais (partner_id/key) só vêm do
> programa de desenvolvedores da Shopee Open Platform.
