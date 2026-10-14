export function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="text-slate-500">—</span>;

  const color =
    score >= 70 ? "bg-emerald-500" :
    score >= 45 ? "bg-amber-500" :
    score >= 25 ? "bg-slate-500" : "bg-rose-600";

  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="w-16 h-2 rounded bg-slate-800 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-sm font-semibold">{score.toFixed(0)}</span>
    </div>
  );
}
