"use client";

import { useState } from "react";
import { postOpportunityScore, postUnitEconomics } from "@/lib/api";

type UE = {
  net_profit: number; net_margin_pct: number; cmv_teto: number;
  total_fees: number; breakeven_roas: number | string;
};
type Score = { score: number; label: string; velocity_pts: number;
  freshness_pts: number; vulnerability_pts: number };

const brl = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function Home() {
  const [price, setPrice] = useState("49.90");
  const [cost, setCost] = useState("15.00");
  const [ue, setUe] = useState<UE | null>(null);

  const [sold30, setSold30] = useState("300");
  const [ageDays, setAgeDays] = useState("60");
  const [rating, setRating] = useState("4.5");
  const [respRate, setRespRate] = useState("70");
  const [score, setScore] = useState<Score | null>(null);

  async function calcUE() {
    setUe(await postUnitEconomics({
      sale_price: parseFloat(price), supplier_cost: parseFloat(cost),
    }));
  }

  async function calcScore() {
    setScore(await postOpportunityScore({
      sold_30_days: parseInt(sold30), age_days: parseInt(ageDays),
      rating_star: parseFloat(rating), response_rate: parseFloat(respRate),
    }));
  }

  return (
    <main className="container">
      <h1>🎯 ShopeeSniper Pro</h1>
      <p>Deep-dive analítico: unit economics reverso + opportunity score.</p>

      <div className="card">
        <h3>🧮 Unit Economics / CMV Teto</h3>
        <label>Preço de venda: </label>
        <input value={price} onChange={(e) => setPrice(e.target.value)} />
        <label> Custo fornecedor: </label>
        <input value={cost} onChange={(e) => setCost(e.target.value)} />
        {" "}<button onClick={calcUE}>Calcular</button>
        {ue && (
          <table>
            <tbody>
              <tr><td>Lucro líquido</td><td><b>{brl(ue.net_profit)}</b></td></tr>
              <tr><td>Margem líquida</td><td>{ue.net_margin_pct}%</td></tr>
              <tr><td>Taxas totais</td><td>{brl(ue.total_fees)}</td></tr>
              <tr><td>CMV Teto (20% margem)</td><td><b>{brl(ue.cmv_teto)}</b></td></tr>
              <tr><td>Breakeven ROAS</td><td>{String(ue.breakeven_roas)}</td></tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>📊 Opportunity Score</h3>
        <label>Vendidos 30d: </label><input value={sold30} onChange={(e) => setSold30(e.target.value)} />
        <label> Idade (dias): </label><input value={ageDays} onChange={(e) => setAgeDays(e.target.value)} />
        <label> Rating: </label><input value={rating} onChange={(e) => setRating(e.target.value)} />
        <label> Resp. chat %: </label><input value={respRate} onChange={(e) => setRespRate(e.target.value)} />
        {" "}<button onClick={calcScore}>Score</button>
        {score && (
          <p>
            <span className={`badge ${score.label}`}>{score.label.toUpperCase()}</span>
            {"  "}<b>{score.score}/100</b>
            {"  "}(velocidade {score.velocity_pts} + freshness {score.freshness_pts}
            {" "}+ vulnerabilidade {score.vulnerability_pts})
          </p>
        )}
      </div>

      <div className="card">
        <h3>🗄 Dados históricos</h3>
        <p>
          As séries de vendas por data ficam na view{" "}
          <code>vw_sales_by_date_velocity</code> do Supabase. Configure{" "}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> e{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> e estenda esta página com
          gráficos (recomendo <code>recharts</code>).
        </p>
      </div>
    </main>
  );
}
