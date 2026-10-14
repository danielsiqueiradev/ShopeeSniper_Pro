const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

export async function postUnitEconomics(body: {
  sale_price: number;
  supplier_cost: number;
  quantity?: number;
  target_margin_pct?: number;
}) {
  const r = await fetch(`${BACKEND}/analytics/unit-economics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Backend ${r.status}`);
  return r.json();
}

export async function postOpportunityScore(body: Record<string, unknown>) {
  const r = await fetch(`${BACKEND}/analytics/opportunity-score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Backend ${r.status}`);
  return r.json();
}

export function supabaseRest(path: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key ?? "", Authorization: `Bearer ${key}` },
  });
}
