"use client";

import {
  Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import type { SalesPoint } from "@/lib/api";

/**
 * Gráfico de velocidade: barras = vendas do dia (delta), linha = preço.
 * Quedas na linha com barras estáveis = guerra de preço do concorrente.
 */
export function SalesChart({ data }: { data: SalesPoint[] }) {
  const rows = data.map((d) => ({
    date: d.snapshot_date.slice(5),           // MM-DD
    vendas: d.sold_delta_1d,
    preco: Number(d.price),
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <ComposedChart data={rows}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} />
          <YAxis yAxisId="l" tick={{ fill: "#64748b", fontSize: 11 }}
                 label={{ value: "vendas/dia", angle: -90, fill: "#64748b", fontSize: 10 }} />
          <YAxis yAxisId="r" orientation="right" tick={{ fill: "#64748b", fontSize: 11 }}
                 domain={["auto", "auto"]}
                 label={{ value: "R$", angle: 90, fill: "#64748b", fontSize: 10 }} />
          <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155" }} />
          <Bar yAxisId="l" dataKey="vendas" fill="#ee4d2d" radius={[2, 2, 0, 0]} />
          <Line yAxisId="r" dataKey="preco" stroke="#38bdf8" dot={false} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
