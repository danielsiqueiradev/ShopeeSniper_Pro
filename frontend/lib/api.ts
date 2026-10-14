const API = "/api";

export interface RadarProduct {
  product_id: string;
  item_id: number;
  shop_id: number;
  name: string;
  image_url: string | null;
  niche_name: string;
  price: number;
  historical_sold: number;
  sold_last_24h: number | null;
  sold_last_7d: number | null;
  sold_last_30d: number | null;
  avg_daily_30d: number | null;
  revenue_est_30d: number | null;
  trend_label: "rising" | "stable" | "falling" | "insufficient_data" | null;
  trend_ratio_7v30: number | null;
  opportunity_score: number | null;
  shop_name: string;
  shop_rating: number | null;
  shop_response_rate: number | null;
  shop_is_vulnerable: boolean | null;
}

export interface SalesPoint {
  snapshot_date: string;
  historical_sold: number;
  sold_delta_1d: number | null;
  price: number;
  stock: number | null;
  rating_star: number | null;
}

export interface PainSummary {
  total_reviews: number;
  negative_reviews: number;
  negative_ratio: number;
  top_pain_points: { category: string; count: number; pct: number; samples: string[] }[];
  improvement_insight: string | null;
}

export interface Niche {
  niche_id: string;
  name: string;
  weighted_avg_ticket: number | null;
  top3_share: number | null;
  total_revenue_est: number | null;
  total_sold_30d: number | null;
}

export interface MonitorResult {
  product_id: string;
  item_id: number;
  shop_id: number;
  product_url: string;
  already_monitored: boolean;
  first_snapshot: boolean;
  note: string | null;
}

/** URL canônica do anúncio na Shopee */
export const shopeeUrl = (shopId: number, itemId: number) =>
  `https://shopee.com.br/product/${shopId}/${itemId}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.detail ?? `${res.status} ${path}`);
  }
  return res.json();
}

export const api = {
  radar: (params?: { min_score?: number; trend?: string }) => {
    const q = new URLSearchParams();
    if (params?.min_score) q.set("min_score", String(params.min_score));
    if (params?.trend) q.set("trend", params.trend);
    return get<RadarProduct[]>(`/products/radar?${q}`);
  },
  salesHistory: (id: string, days = 30) =>
    get<SalesPoint[]>(`/products/${id}/sales-history?days=${days}`),
  painPoints: (id: string) => get<PainSummary>(`/products/${id}/pain-points`),
  niches: () => get<Niche[]>("/niches"),
  monitor: (url: string, nicheId?: string) =>
    post<MonitorResult>("/products/monitor", { url, niche_id: nicheId }),
};
