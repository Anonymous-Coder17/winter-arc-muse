"use client";

// Tiny inline SVG charts. One chart at a time, no libraries, calm palette.

export interface ChartPoint {
  date: string;
  value: number | null;
  label?: string;
}

/** Line chart over a continuous metric. Nulls break the line (unrecorded). */
export function Sparkline({
  points,
  height = 72,
}: {
  points: ChartPoint[];
  height?: number;
}) {
  const W = 300;
  const H = height;
  const PAD = 10;
  const known = points
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.value !== null) as (ChartPoint & {
    value: number;
    i: number;
  })[];
  if (known.length < 2) {
    return (
      <p className="text-xs t-faint py-4">
        Not enough points for a chart yet — keep recording.
      </p>
    );
  }
  const vals = known.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min === 0 ? 1 : max - min;
  const x = (i: number) =>
    PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);

  // segments of consecutive recorded points (a gap = unrecorded)
  const segments: string[] = [];
  let cur: string[] = [];
  let prevI = -2;
  for (const p of known) {
    if (p.i !== prevI + 1 && cur.length > 0) {
      segments.push(cur.join(" "));
      cur = [];
    }
    cur.push(`${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`);
    prevI = p.i;
  }
  if (cur.length > 0) segments.push(cur.join(" "));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: H }}
      role="img"
      aria-label="Trend line"
    >
      {segments.map((pts, si) => (
        <polyline
          key={si}
          points={pts}
          fill="none"
          stroke="#7C8CF8"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {known.map((p) => (
        <circle
          key={p.i}
          cx={x(p.i)}
          cy={y(p.value)}
          r="3"
          fill="#7C8CF8"
          stroke="#0B0D10"
          strokeWidth="1"
        >
          <title>{`${p.label || p.date}: ${p.value}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
}

/** Vertical bars for a trend (study minutes, pages…). Zero is a real bar. */
export function TrendBars({
  items,
  height = 110,
  formatValue,
}: {
  items: BarItem[];
  height?: number;
  formatValue?: (v: number) => string;
}) {
  if (items.length === 0) return null;
  const W = Math.max(300, items.length * 24);
  const H = height;
  const PAD_B = 22;
  const PAD_T = 8;
  const max = Math.max(1, ...items.map((i) => i.value));
  const slot = W / items.length;
  const bw = Math.min(28, slot * 0.55);
  const y = (v: number) =>
    PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);
  const showEvery = items.length > 12 ? Math.ceil(items.length / 6) : 1;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label="Trend bars"
      >
        {items.map((it, i) => {
          const bh = Math.max(it.value > 0 ? 3 : 1, H - PAD_B - y(it.value));
          return (
            <g key={it.key}>
              <rect
                x={slot * i + (slot - bw) / 2}
                y={H - PAD_B - bh}
                width={bw}
                height={bh}
                rx={3}
                fill={it.value > 0 ? "#7C8CF8" : "#7C8CF8"}
                opacity={it.value > 0 ? 0.85 : 0.25}
              >
                <title>{`${it.label}: ${formatValue ? formatValue(it.value) : it.value}`}</title>
              </rect>
              {i % showEvery === 0 && (
                <text
                  x={slot * i + slot / 2}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize="9"
                  fill="currentColor"
                  className="t-faint"
                >
                  {it.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Simple ratio bar (consistency %, compliance %). A ratio, not a score. */
export function RatioBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div
      className="h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"
      role="img"
      aria-label={`${clamped} percent`}
    >
      <div
        className="h-full rounded-full bg-[#7C8CF8]"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
