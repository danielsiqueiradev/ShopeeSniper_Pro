"use client";

import { useMemo, useState } from "react";

const fmt = (v: number | null) =>
  v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Mesma fórmula do backend (unit_economics.py):
 *   CMV_teto = P·(1 − c − f − t − a − m) − F − E
 *   P_be     = (F + E + CMV) / (1 − c − f − t − a)
 * Cálculo local = feedback instantâneo; POST /api/simulations persiste.
 */
export default function SimulatorPage() {
  const [price, setPrice] = useState(79.9);
  const [margin, setMargin] = useState(20);
  const [commission, setCommission] = useState(14);
  const [freeship, setFreeship] = useState(6);
  const [tax, setTax] = useState(6);
  const [acos, setAcos] = useState(10);
  const [fixedFee, setFixedFee] = useState(4);
  const [extra, setExtra] = useState(0);
  const [cmv, setCmv] = useState<number | "">("");

  const r = useMemo(() => {
    const k = 1 - (commission + freeship + tax + acos) / 100;
    if (k <= 0) return {
      impossible: true, ceiling: null, be: null, label: "impossible",
      profit: null, fees: null, priceForCmv: null,
    };
    const m = margin / 100;
    const ceiling = price * (k - m) - fixedFee - extra;
    const be = cmv !== "" ? (fixedFee + extra + Number(cmv)) / k : null;
    const label =
      ceiling <= 0 ? "unviable" :
      cmv !== "" && Number(cmv) > ceiling ? "tight" : "viable";
    return {
      impossible: false,
      ceiling, be, label,
      profit: price * m,
      fees: price * (1 - k) + fixedFee + extra,
      priceForCmv: cmv !== "" ? (fixedFee + extra + Number(cmv)) / (k - m) : null,
    };
  }, [price, margin, commission, freeship, tax, acos, fixedFee, extra, cmv]);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-bold">Calculadora Reversa de Lucro</h1>

      <div className="grid md:grid-cols-2 gap-6">
        <section className="rounded-lg border border-slate-800 bg-slate-900 p-5 space-y-4">
          <Field label="Preço de venda (R$)" value={price}
                 onChange={(v) => setPrice(num(v))} step={0.1} />
          <Field label="Margem líquida alvo (%)" value={margin}
                 onChange={(v) => setMargin(num(v))} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Comissão (%)" value={commission}
                   onChange={(v) => setCommission(num(v))} />
            <Field label="Frete grátis (%)" value={freeship}
                   onChange={(v) => setFreeship(num(v))} />
            <Field label="Imposto (%)" value={tax}
                   onChange={(v) => setTax(num(v))} />
            <Field label="ACOS (%)" value={acos}
                   onChange={(v) => setAcos(num(v))} />
            <Field label="Taxa fixa (R$)" value={fixedFee}
                   onChange={(v) => setFixedFee(num(v))} step={0.5} />
            <Field label="Extras/unid (R$)" value={extra}
                   onChange={(v) => setExtra(num(v))} step={0.5} />
          </div>
          <Field label="CMV real (opcional, R$)" value={cmv} onChange={setCmv} step={0.1}
                 placeholder="informar p/ breakeven" />
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-5 space-y-4">
          {r.impossible ? (
            <div className="text-rose-400">
              Custos percentuais ≥ 100% — operação inviável em qualquer CMV.
            </div>
          ) : (
            <>
              <Result label="★ CMV TETO (máx. no fornecedor)"
                      value={fmt(r.ceiling)} big
                      tone={r.label === "unviable" ? "text-rose-400" : "text-emerald-400"} />
              <Result label="Lucro líquido no teto" value={fmt(r.profit)} />
              <Result label="Taxas totais/unid" value={fmt(r.fees)} />
              {r.be != null && <Result label="Preço de breakeven" value={fmt(r.be)} />}
              {r.label === "tight" && r.priceForCmv != null && (
                <p className="text-xs text-amber-300">
                  CMV real excede o teto — para manter {margin}% suba o preço
                  para ≥ {fmt(r.priceForCmv)}.
                </p>
              )}
              <span className={`inline-block px-3 py-1 rounded text-sm font-semibold
                ${r.label === "viable" ? "bg-emerald-950 text-emerald-300" :
                  r.label === "tight" ? "bg-amber-950 text-amber-300" :
                  "bg-rose-950 text-rose-300"}`}>
                {r.label.toUpperCase()}
              </span>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const num = (v: number | "") => (v === "" ? 0 : v);

function Field({ label, value, onChange, step = 1, placeholder }: {
  label: string; value: number | "";
  onChange: (v: number | "") => void;
  step?: number; placeholder?: string;
}) {
  return (
    <label className="block text-xs text-slate-400">
      {label}
      <input type="number" step={step} value={value} placeholder={placeholder}
             onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
             className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2
                        text-sm text-white focus:border-brand-500 outline-none" />
    </label>
  );
}

function Result({ label, value, big, tone }: {
  label: string; value: string; big?: boolean; tone?: string;
}) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`${big ? "text-3xl" : "text-lg"} font-bold ${tone ?? ""}`}>
        {value}
      </div>
    </div>
  );
}
