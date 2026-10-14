"use client";

import { useEffect, useState } from "react";
import { api, type Niche, type RadarProduct } from "@/lib/api";
import { RadarTable } from "@/components/RadarTable";

const PAGE_SIZES = [30, 50, 100, 200];

export default function Dashboard() {
  const [products, setProducts] = useState<RadarProduct[]>([]);
  const [topNiches, setTopNiches] = useState<Niche[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [trend, setTrend] = useState("");
  const [sort, setSort] = useState("score");
  const [limit, setLimit] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [showMonitor, setShowMonitor] = useState(false);
  const [monitorUrl, setMonitorUrl] = useState("");
  const [monitorMsg, setMonitorMsg] = useState<string | null>(null);
  const [monitoring, setMonitoring] = useState(false);

  function refresh() {
    api.radar({ min_score: minScore, trend: trend || undefined, sort, limit })
      .then(setProducts)
      .catch((e) => setError(e.message));
  }

  useEffect(refresh, [minScore, trend, sort, limit]);
  useEffect(() => { api.niches().then((n) => setTopNiches(n.slice(0, 5))).catch(() => {}); }, []);

  async function submitMonitor() {
    setMonitoring(true);
    setMonitorMsg(null);
    try {
      const r = await api.monitor(monitorUrl.trim());
      setMonitorMsg(
        r.already_monitored
          ? "Item já estava monitorado."
          : r.first_snapshot
            ? "Monitorando — primeiro snapshot coletado."
            : `Monitorando — ${r.note ?? "dados chegam no próximo ciclo."}`);
      setMonitorUrl("");
      refresh();
    } catch (e) {
      setMonitorMsg(e instanceof Error ? e.message : "erro ao monitorar");
    } finally {
      setMonitoring(false);
    }
  }

  const hot = products.filter((p) => (p.opportunity_score ?? 0) >= 70).length;
  const rising = products.filter((p) => p.trend_label === "rising").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Produtos monitorados" value={products.length} />
        <Kpi label="Oportunidades HOT" value={hot} accent="text-emerald-400" />
        <Kpi label="Em ascensão" value={rising} accent="text-amber-400" />
        <Kpi label="Receita nichos (30d)"
             value={products.reduce((s, p) => s + (Number(p.revenue_est_30d) || 0), 0)
                     .toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })} />
      </div>

      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold">Radar de Oportunidades</h1>
        <button
          onClick={() => setShowMonitor((v) => !v)}
          className="px-3 py-1.5 rounded bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium">
          + Monitorar item
        </button>
        <select value={trend} onChange={(e) => setTrend(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm">
          <option value="">todas tendências</option>
          <option value="rising">↗ subindo</option>
          <option value="stable">→ estável</option>
          <option value="falling">↘ caindo</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm">
          <option value="score">melhores oportunidades</option>
          <option value="sold_30d">mais vendidos 30d</option>
          <option value="name">A–Z</option>
        </select>
        <label className="text-sm text-slate-400 flex items-center gap-2">
          score ≥ {minScore}
          <input type="range" min={0} max={90} step={10} value={minScore}
                 onChange={(e) => setMinScore(Number(e.target.value))} />
        </label>
        <div className="flex items-center gap-1 text-sm text-slate-400 ml-auto">
          {PAGE_SIZES.map((n) => (
            <button key={n} onClick={() => setLimit(n)}
                    className={`px-2 py-1 rounded ${limit === n
                      ? "bg-brand-500 text-white" : "bg-slate-800 hover:bg-slate-700"}`}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {topNiches.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Nichos mais vendidos:</span>
          {topNiches.map((n, i) => (
            <span key={n.niche_id}
                  className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800">
              <span className="text-brand-500 font-semibold mr-1">#{i + 1}</span>
              {n.name}
              {n.total_sold_30d != null && (
                <span className="text-slate-500 ml-1">
                  · {n.total_sold_30d.toLocaleString("pt-BR")} vendas/30d
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {showMonitor && (
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 flex flex-wrap items-center gap-3">
          <input
            type="url"
            value={monitorUrl}
            onChange={(e) => setMonitorUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitMonitor()}
            placeholder="Cole a URL do anúncio Shopee (página do produto ou flash_sale)"
            className="flex-1 min-w-[280px] bg-slate-950 border border-slate-700 rounded
                       px-3 py-2 text-sm text-white focus:border-brand-500 outline-none"
          />
          <button onClick={submitMonitor} disabled={monitoring || !monitorUrl.trim()}
                  className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500
                             disabled:opacity-40 text-sm font-medium">
            {monitoring ? "Monitorando…" : "Monitorar"}
          </button>
          {monitorMsg && <span className="text-sm text-slate-300">{monitorMsg}</span>}
        </div>
      )}

      {error && <div className="text-rose-400 text-sm">API: {error}</div>}
      <RadarTable products={products} />
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs text-slate-500 uppercase">{label}</div>
      <div className={`text-2xl font-bold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}
