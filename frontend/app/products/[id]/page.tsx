"use client";

import { useEffect, useState } from "react";
import { api, type PainSummary, type SalesPoint } from "@/lib/api";
import { SalesChart } from "@/components/SalesChart";

export default function ProductPage({ params }: { params: { id: string } }) {
  const [history, setHistory] = useState<SalesPoint[]>([]);
  const [pains, setPains] = useState<PainSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.salesHistory(params.id).then(setHistory).catch((e) => setError(e.message));
    api.painPoints(params.id).then(setPains).catch(() => setPains(null));
  }, [params.id]);

  const latest = history[history.length - 1];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-4">
        <h1 className="text-xl font-bold">Produto</h1>
        {latest && (
          <span className="text-slate-400 text-sm">
            último snapshot {latest.snapshot_date} · ★{latest.rating_star ?? "?"}
            · acumulado {latest.historical_sold.toLocaleString("pt-BR")} vendas
          </span>
        )}
      </div>

      {error && <div className="text-rose-400 text-sm">API: {error}</div>}

      <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm text-slate-400 mb-3">
          Velocidade de vendas × preço (30 dias)
        </h2>
        <SalesChart data={history} />
      </section>

      {pains && (
        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm text-slate-400 mb-3">
            Pain points — {pains.negative_reviews} reviews negativas
            ({(pains.negative_ratio * 100).toFixed(1)}% de {pains.total_reviews})
          </h2>
          <div className="space-y-2">
            {pains.top_pain_points.map((p) => (
              <div key={p.category}>
                <div className="flex justify-between text-sm">
                  <span className="capitalize">{p.category.replace(/_/g, " ")}</span>
                  <span className="text-slate-500">{p.count} · {(p.pct * 100).toFixed(0)}%</span>
                </div>
                <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full bg-rose-500" style={{ width: `${p.pct * 100}%` }} />
                </div>
                {p.samples[0] && (
                  <p className="text-xs text-slate-500 mt-1 italic">“{p.samples[0]}”</p>
                )}
              </div>
            ))}
          </div>
          {pains.improvement_insight && (
            <p className="mt-4 text-sm text-emerald-300">{pains.improvement_insight}</p>
          )}
        </section>
      )}
    </div>
  );
}
