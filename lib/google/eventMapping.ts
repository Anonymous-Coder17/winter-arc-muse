// lib/google/eventMapping.ts
//
// Pure converters between Google Calendar API events and the app's local
// calendar_events rows. No server imports, no I/O: unit-testable in plain
// node (deliberately NO `server-only` import — see lib/google/oauthCore.ts).
// Uses only erasable TypeScript syntax (no enums, no parameter properties).

/** Minimal Google Calendar API v3 event date/time shape. */
export interface GoogleApiEventDateTime {
  /** All-day: "YYYY-MM-DD". */
  date?: string;
  /** Timed: RFC3339 instant. */
  dateTime?: string;
  timeZone?: string;
}

/** Minimal Google Calendar API v3 event shape used by the sync engine. */
export interface GoogleApiEvent {
  id?: string;
  summary?: string;
  description?: string;
  start?: GoogleApiEventDateTime;
  end?: GoogleApiEventDateTime;
  etag?: string;
  /** "confirmed" | "tentative" | "cancelled" (with showDeleted=true). */
  status?: string;
  recurrence?: string[];
  timeZone?: string;
}

/** Local calendar_events row draft produced from a Google event. */
export interface LocalEventDraft {
  title: string;
  /** YYYY-MM-DD */
  event_date: string;
  /** HH:MM */
  start_time: string;
  /** HH:MM */
  end_time: string;
  notes: string | null;
  /**
   * True when the Google event is all-day (start.date, no dateTime).
   * The row keeps 00:00–23:59 so the calendar_events
   * CHECK (start_time < end_time) holds; this flag — not the times — is
   * the semantic marker the sync engine uses to round-trip all-day
   * events as start.date/end.date.
   */
  is_all_day: boolean;
  /**
   * Inclusive last date for multi-day all-day events (V4.5, YYYY-MM-DD).
   * Null for single-day events. Google's end.date is exclusive, so a
   * Google span of Oct 10 -> Oct 12 becomes end_date "2026-10-11".
   */
  end_date: string | null;
}

/** Google events.insert / events.update request body (timed events). */
export interface GoogleEventBodyTimed {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

/** Google events.insert / events.update request body (all-day events). */
export interface GoogleEventBodyAllDay {
  summary: string;
  description?: string;
  start: { date: string };
  end: { date: string };
}

/** Google events.insert / events.update request body. */
export type GoogleEventBody = GoogleEventBodyTimed | GoogleEventBodyAllDay;

const TITLE_MAX_CHARS = 200;
const NOTES_MAX_CHARS = 2000;

/** True for all-day Google events (start.date set, no start.dateTime). */
export function isAllDayGoogleEvent(g: GoogleApiEvent): boolean {
  return Boolean(g.start?.date) && !g.start?.dateTime;
}

function partValue(
  parts: Intl.DateTimeFormatPart[],
  type: string
): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/**
 * RFC3339 instant -> wall-clock { date, time } in the given IANA time zone.
 * en-CA + hour12:false yields numeric parts (YYYY-MM-DD, HH:MM).
 */
function wallClockParts(
  dateTime: string,
  timeZone: string
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(dateTime));
  let hour = partValue(parts, "hour");
  // Some engines emit "24" for midnight with hour12:false; normalize.
  if (hour === "24") hour = "00";
  return {
    date: `${partValue(parts, "year")}-${partValue(parts, "month")}-${partValue(parts, "day")}`,
    time: `${hour}:${partValue(parts, "minute")}`,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Parse a "YYYY-MM-DD" day key as a UTC midnight Date. */
function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date as "YYYY-MM-DD" (UTC). */
function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add n days to a "YYYY-MM-DD" day key. */
export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDay(d);
}

/** Whole days from a to b ("YYYY-MM-DD" day keys, b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

function minutesOfDay(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return ((((y * 12 + mo) * 31 + d) * 24 + h) * 60 + mi) | 0;
}

/**
 * Interpret "date"+"time" as wall-clock time in `timeZone` and return the
 * corresponding instant. Iterative refinement through Intl honors the zone's
 * DST rules — no hard-coded offsets. Throws on unparseable input.
 */
export function zonedTimeToUtc(
  date: string,
  time: string,
  timeZone: string
): Date {
  const target = minutesOfDay(date, time);
  let guess = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(guess)) {
    throw new Error(`Invalid date/time: ${date} ${time}`);
  }
  for (let i = 0; i < 4; i++) {
    const p = wallClockParts(new Date(guess).toISOString(), timeZone);
    const diff = target - minutesOfDay(p.date, p.time);
    if (diff === 0) break;
    guess += diff * 60_000;
  }
  return new Date(guess);
}

/**
 * Google's own timezone for the event start — the zone Google uses for the
 * event's wall-clock semantics. This is sync metadata, distinct from the
 * display timezone used to render the event locally. Falls back to the
 * calendar's timezone when the event carries none (Google interprets
 * zone-less events in the calendar's zone).
 */
export function googleStartTimeZone(
  g: GoogleApiEvent,
  calendarTimeZone?: string | null
): string | null {
  return g.start?.timeZone ?? g.timeZone ?? calendarTimeZone ?? null;
}

/**
 * Google's end timezone, returned only when it differs from the start zone
 * (null means "same as start" — the mapping stores NULL in that case).
 */
export function googleEndTimeZone(
  g: GoogleApiEvent,
  startTimeZone: string | null
): string | null {
  const raw = g.end?.timeZone ?? null;
  return raw && raw !== startTimeZone ? raw : null;
}

/**
 * The all-day date range with Google's exclusive-end semantics
 * (start.date = 2026-10-10, end.date = 2026-10-12 means Oct 10 and Oct 11).
 * Returns null for timed events. A missing end.date defaults to a single
 * day (start + 1, exclusive).
 */
export function googleAllDayRange(
  g: GoogleApiEvent
): { startDate: string; endDate: string } | null {
  if (!isAllDayGoogleEvent(g) || !g.start?.date) return null;
  return {
    startDate: g.start.date,
    endDate: g.end?.date ?? addDays(g.start.date, 1),
  };
}

function formatMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function todayKeyUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Convert a Google event to a local calendar_events draft, interpreting
 * timed events in `timeZone` (an IANA zone, used for LOCAL DISPLAY only).
 * The Google event's own timezone is NOT stored in the draft — the sync
 * engine records it separately as mapping metadata so a later push can
 * reconstruct the event with its original Google semantics.
 *
 * All-day events become 00:00–23:59 on their date WITH is_all_day = true;
 * the flag (not the times) carries the all-day semantics. If the converted
 * end is not after the start, the end is clamped to start+30min on the same
 * day (never spills past midnight), which also guarantees the
 * calendar_events CHECK (start_time < end_time).
 */
export function googleEventToLocal(
  g: GoogleApiEvent,
  timeZone: string
): LocalEventDraft {
  const rawTitle =
    g.summary && g.summary.length > 0 ? g.summary : "(No title)";
  const title = truncate(rawTitle, TITLE_MAX_CHARS);
  const notes = g.description ? truncate(g.description, NOTES_MAX_CHARS) : null;

  if (isAllDayGoogleEvent(g)) {
    const startDate = g.start?.date ?? todayKeyUtc();
    // Google's end.date is exclusive; the local model stores the inclusive
    // last date (V4.5), or null for a single day.
    const range = googleAllDayRange(g);
    const endInclusive =
      range && range.endDate > addDays(startDate, 1)
        ? addDays(range.endDate, -1)
        : null;
    return {
      title,
      event_date: startDate,
      start_time: "00:00",
      end_time: "23:59",
      notes,
      is_all_day: true,
      end_date: endInclusive,
    };
  }

  const startIso = g.start?.dateTime;
  const endIso = g.end?.dateTime;
  if (startIso && endIso) {
    const s = wallClockParts(startIso, timeZone);
    const e = wallClockParts(endIso, timeZone);
    if (`${e.date}T${e.time}` <= `${s.date}T${s.time}`) {
      const [sh, sm] = s.time.split(":").map(Number);
      let startMin = sh * 60 + sm;
      let endMin = startMin + 30;
      if (endMin >= 24 * 60) {
        // Event at the very end of the day: pull the start back 30 minutes
        // instead of spilling into tomorrow, so the row stays single-day.
        startMin = 24 * 60 - 31;
        endMin = startMin + 30;
      }
      return {
        title,
        event_date: s.date,
        start_time: formatMinutes(startMin),
        end_time: formatMinutes(endMin),
        notes,
        is_all_day: false,
        end_date: null,
      };
    }
    return {
      title,
      event_date: s.date,
      start_time: s.time,
      end_time: e.time,
      notes,
      is_all_day: false,
      end_date: null,
    };
  }

  // Malformed event (no usable start): fall back to an all-day placeholder
  // rather than dropping the user's event.
  return {
    title,
    event_date: g.start?.date ?? todayKeyUtc(),
    start_time: "00:00",
    end_time: "23:59",
    notes,
    is_all_day: false,
    end_date: null,
  };
}

/**
 * Options for building a Google events.insert/update body from a local event.
 */
export interface LocalToGoogleOptions {
  /**
   * The Google start timezone to express the event in (the preserved Google
   * semantics from the mapping). Defaults to `timeZone`.
   */
  googleStartTimeZone?: string | null;
  /**
   * The Google end timezone when it differs from the start zone
   * (mapping's google_end_timezone). Defaults to the start zone.
   */
  googleEndTimeZone?: string | null;
  /**
   * All-day push: emit start.date/end.date instead of dateTime. The event
   * stays an all-day Google event.
   */
  isAllDay?: boolean;
  /**
   * Original Google all-day range (end exclusive). Used to preserve the
   * duration when the local date was edited: new end = local event_date +
   * (googleEndDate - googleStartDate) days.
   */
  googleStartDate?: string | null;
  googleEndDate?: string | null;
}

/**
 * Build a Google events.insert/update body from a local event.
 *
 * `timeZone` is the zone the local wall-clock (event_date/start_time/
 * end_time) is interpreted in — the same display zone used at import, so a
 * title-only edit round-trips to the identical instant.
 *
 * Timed events: the local wall-clock is converted to an instant, then
 * re-expressed as wall-clock in the preserved Google timezone(s) — the
 * Google event keeps its original zone and wall-clock time; only the title/
 * notes (or a genuine local time edit) change it.
 *
 * All-day events: emits start.date/end.date (never dateTime), preserving
 * Google's exclusive-end semantics and the original multi-day span. For
 * Google-originated events the span comes from the mapping's preserved
 * Google dates; for locally-created all-day events it comes from the
 * row's inclusive end_date (V4.5), defaulting to a single day.
 */
export function localEventToGoogle(
  e: {
    title: string;
    event_date: string;
    start_time: string;
    end_time: string;
    notes: string | null;
    /** Inclusive last date for multi-day all-day events (V4.5). */
    end_date?: string | null;
  },
  timeZone: string,
  opts: LocalToGoogleOptions = {}
): GoogleEventBody {
  const summary = e.title;
  const description = e.notes ? { description: e.notes } : {};

  if (opts.isAllDay) {
    const durationDays =
      opts.googleStartDate && opts.googleEndDate
        ? Math.max(1, diffDays(opts.googleStartDate, opts.googleEndDate))
        : e.end_date && e.end_date > e.event_date
          ? diffDays(e.event_date, e.end_date) + 1
          : 1;
    return {
      summary,
      ...description,
      start: { date: e.event_date },
      end: { date: addDays(e.event_date, durationDays) },
    };
  }

  const startTz = opts.googleStartTimeZone ?? timeZone;
  const endTz = opts.googleEndTimeZone ?? startTz;
  const startUtc = zonedTimeToUtc(e.event_date, e.start_time, timeZone);
  const endUtc = zonedTimeToUtc(e.event_date, e.end_time, timeZone);
  const s = wallClockParts(startUtc.toISOString(), startTz);
  const en = wallClockParts(endUtc.toISOString(), endTz);
  return {
    summary,
    ...description,
    start: { dateTime: `${s.date}T${s.time}:00`, timeZone: startTz },
    end: { dateTime: `${en.date}T${en.time}:00`, timeZone: endTz },
  };
}
