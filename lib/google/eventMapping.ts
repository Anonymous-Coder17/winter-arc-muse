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
}

/** Google events.insert / events.update request body (timed events). */
export interface GoogleEventBody {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

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
 * timed events in `timeZone` (an IANA zone). All-day events become
 * 00:00–23:59 on their date. If the converted end is not after the start,
 * the end is clamped to start+30min on the same day (never spills past
 * midnight), which also guarantees the calendar_events
 * CHECK (start_time < end_time).
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
    return {
      title,
      event_date: g.start?.date ?? todayKeyUtc(),
      start_time: "00:00",
      end_time: "23:59",
      notes,
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
      };
    }
    return {
      title,
      event_date: s.date,
      start_time: s.time,
      end_time: e.time,
      notes,
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
  };
}

function withSeconds(t: string): string {
  const parts = t.split(":");
  const hh = (parts[0] ?? "00").padStart(2, "0");
  const mm = (parts[1] ?? "00").padStart(2, "0");
  const ss = (parts[2] ?? "00").slice(0, 2).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Build a Google events.insert/update body for a local timed event.
 * Produces local wall-clock "YYYY-MM-DDTHH:MM:SS" plus the IANA timeZone,
 * which is how Google interprets the event (respects the zone's DST rules).
 */
export function localEventToGoogle(
  e: {
    title: string;
    event_date: string;
    start_time: string;
    end_time: string;
    notes: string | null;
  },
  timeZone: string
): GoogleEventBody {
  const body: GoogleEventBody = {
    summary: e.title,
    start: {
      dateTime: `${e.event_date}T${withSeconds(e.start_time)}`,
      timeZone,
    },
    end: {
      dateTime: `${e.event_date}T${withSeconds(e.end_time)}`,
      timeZone,
    },
  };
  if (e.notes) body.description = e.notes;
  return body;
}
