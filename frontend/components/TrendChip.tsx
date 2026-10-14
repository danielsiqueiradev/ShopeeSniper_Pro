const MAP: Record<string, { icon: string; cls: string; label: string }> = {
  rising:            { icon: "↗", cls: "text-emerald-400 bg-emerald-950", label: "subindo" },
  stable:            { icon: "→", cls: "text-slate-300 bg-slate-800",     label: "estável" },
  falling:           { icon: "↘", cls: "text-rose-400 bg-rose-950",       label: "caindo" },
  insufficient_data: { icon: "·", cls: "text-slate-500 bg-slate-800",     label: "sem dados" },
};

export function TrendChip({ label, ratio }: { label: string | null; ratio: number | null }) {
  const t = MAP[label ?? "insufficient_data"] ?? MAP.insufficient_data;
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${t.cls}`}
          title={ratio != null ? `razão 7d/30d = ${ratio.toFixed(2)}` : ""}>
      {t.icon} {t.label}
    </span>
  );
}
