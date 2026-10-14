"use client";

import { useEffect, useState } from "react";
import { api, type RadarProduct } from "@/lib/api";
import { RadarTable } from "@/components/RadarTable";

export default function Dashboard() {
  const [products, setProducts] = useState<RadarProduct[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [trend, setTrend] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.radar({ min_score: minScore, trend: trend || undefined })
      .then(setProducts)
      .catch((e) => setError(e.message));
  }, [minScore, trend]);

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
        <select value={trend} onChange={(e) => setTrend(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm">
          <option value="">todas tendências</option>
          <option value="rising">↗ subindo</option>
          <option value="stable">→ estável</option>
          <option value="falling">↘ caindo</option>
        </select>
        <label className="text-sm text-slate-400 flex items-center gap-2">
          score ≥ {minScore}
          <input type="range" min={0} max={90} step={10} value={minScore}
                 onChange={(e) => setMinScore(Number(e.target.value))} />
        </label>
      </div>

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
