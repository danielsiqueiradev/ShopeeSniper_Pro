"use client";

import type { RadarProduct } from "@/lib/api";
import { shopeeUrl } from "@/lib/api";
import { ScoreBadge } from "./ScoreBadge";
import { TrendChip } from "./TrendChip";
import Link from "next/link";

const fmtBRL = (v: number | null) =>
  v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function RadarTable({ products }: { products: RadarProduct[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full text-sm">
        <thead className="bg-slate-900 text-slate-400 text-xs uppercase">
          <tr>
            <th className="px-4 py-3 text-left">Produto</th>
            <th className="px-4 py-3 text-right">Vendas 24h / 30d</th>
            <th className="px-4 py-3 text-left">Tendência</th>
            <th className="px-4 py-3 text-right">Receita est. 30d</th>
            <th className="px-4 py-3 text-left">Seller</th>
            <th className="px-4 py-3 text-left">Score</th>
            <th className="px-4 py-3 text-right">Ações</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.product_id}
                onClick={() => window.open(shopeeUrl(p.shop_id, p.item_id), "_blank")}
                className="border-t border-slate-800 hover:bg-slate-900 cursor-pointer">
              <td className="px-4 py-3">
                <div className="flex items-center gap-3 max-w-[340px]">
                  {p.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image_url} alt="" className="w-10 h-10 rounded object-cover" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-xs text-slate-500">
                      {p.niche_name} · {fmtBRL(Number(p.price))}
                    </div>
                  </div>
                </div>
              </td>
              <td className="px-4 py-3 text-right font-mono">
                <span className="text-emerald-400">{p.sold_last_24h ?? "—"}</span>
                <span className="text-slate-500"> / {p.sold_last_30d ?? "—"}</span>
              </td>
              <td className="px-4 py-3">
                <TrendChip label={p.trend_label} ratio={p.trend_ratio_7v30} />
              </td>
              <td className="px-4 py-3 text-right">{fmtBRL(Number(p.revenue_est_30d) || 0)}</td>
              <td className="px-4 py-3">
                <div className="text-xs">
                  <div>{p.shop_name}</div>
                  <div className="text-slate-500">
                    ★{p.shop_rating ?? "?"}
                    {p.shop_response_rate != null && ` · chat ${p.shop_response_rate}%`}
                    {p.shop_is_vulnerable && (
                      <span className="ml-1 text-amber-400" title="seller vulnerável">⚠</span>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-4 py-3"><ScoreBadge score={p.opportunity_score} /></td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                <Link href={`/products/${p.product_id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-sky-400 hover:text-sky-300 mr-3">
                  Análise
                </Link>
                <a href={shopeeUrl(p.shop_id, p.item_id)}
                   target="_blank" rel="noopener noreferrer"
                   onClick={(e) => e.stopPropagation()}
                   className="text-xs text-brand-500 hover:text-brand-600">
                  Shopee ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {products.length === 0 && (
        <div className="p-10 text-center text-slate-500">
          Nenhum produto monitorado ainda — os workers precisam rodar ao menos 1 snapshot.
        </div>
      )}
    </div>
  );
}
