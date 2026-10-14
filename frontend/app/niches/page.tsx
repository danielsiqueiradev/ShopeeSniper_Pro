"use client";

import { useEffect, useState } from "react";
import { api, type Niche } from "@/lib/api";

const fmtBRL = (v: number | null) =>
  v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function ConcentrationBadge({ top3 }: { top3: number | null }) {
  if (top3 == null) return null;
  const [cls, label] =
    top3 >= 0.6 ? ["bg-rose-950 text-rose-300", "concentrado — difícil entrar"] :
    top3 >= 0.35 ? ["bg-amber-950 text-amber-300", "moderado"] :
                   ["bg-emerald-950 text-emerald-300", "pulverizado — fácil entrar"];
  return <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{label}</span>;
}

export default function NichesPage() {
  const [niches, setNiches] = useState<Niche[]>([]);

  useEffect(() => { api.niches().then(setNiches).catch(() => {}); }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Nichos monitorados</h1>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {niches.map((n) => (
          <div key={n.niche_id}
               className="rounded-lg border border-slate-800 bg-slate-900 p-5 space-y-3">
            <div className="flex justify-between items-start">
              <h2 className="font-semibold">{n.name}</h2>
              <ConcentrationBadge top3={n.top3_share} />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Ticket pond." value={fmtBRL(n.weighted_avg_ticket)} />
              <Stat label="Vendas 30d" value={n.total_sold_30d?.toLocaleString("pt-BR") ?? "—"} />
              <Stat label="Receita est." value={fmtBRL(n.total_revenue_est)} />
            </div>
            {n.top3_share != null && (
              <div className="text-xs text-slate-500">
                top 3 sellers detêm {(n.top3_share * 100).toFixed(0)}% do volume
              </div>
            )}
          </div>
        ))}
        {niches.length === 0 && (
          <p className="text-slate-500">Nenhum nicho criado — POST /api/niches.</p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
