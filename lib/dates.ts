// Date helpers. All "day keys" are local YYYY-MM-DD strings so the app
// reasons about calendar days in the user's timezone, not UTC.

export function toDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayKey(): string {
  return toDayKey(new Date());
}

/**
 * Convert an ISO/timestamptz string (always UTC on the wire) to the user's
 * LOCAL day key. Use for attributing timestamped rows (incidents, sessions)
 * to calendar days — never slice(0,10) a UTC string against a local key.
 */
export function utcToDayKey(iso: string): string {
  return toDayKey(new Date(iso));
}

export function addDays(key: string, n: number): string {
  const d = new Date(key + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toDayKey(d);
}

export function parseDayKey(key: string): Date {
  return new Date(key + "T00:00:00");
}

export function formatLong(key: string): string {
  return parseDayKey(key).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function formatShort(key: string): string {
  return parseDayKey(key).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function isToday(key: string): boolean {
  return key === todayKey();
}

/** Monday-first offset of the first of the month (0 = Monday … 6 = Sunday). */
export function monthGridStart(year: number, month: number): Date {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return start;
}

export function weekStartMonday(key: string): string {
  const d = parseDayKey(key);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return toDayKey(d);
}

export function timeLabel(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** 0 = Monday … 6 = Sunday for a local day key. */
export function weekdayIndex(key: string): number {
  return (parseDayKey(key).getDay() + 6) % 7;
}

/** "1h 25m", "42m", "18s" — compact human duration from seconds. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${rest}s`;
}

/** "42:17" or "1:02:33" — timer readout from seconds. */
export function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(rest).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
