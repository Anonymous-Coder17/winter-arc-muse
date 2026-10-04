# Google Calendar → Winter Arc: timezone mapping (V4.3.1, planned)

> **Documentation only.** None of the mapping below is implemented in V4.3.1.
> This phase builds the provider abstraction and the offline metadata cache;
> event sync — including all timezone conversion — is a later phase. The app's
> existing local-day-key model (`lib/dates.ts`) is **unchanged** by this phase.

## The app's model (from `lib/dates.ts`)

- Every day the app reasons about is a **local** `YYYY-MM-DD` day key
  (`toDayKey`, `todayKey`).
- `utcToDayKey(iso)` converts an ISO/timestamptz string (UTC on the wire) to
  the user's **local** day key. This is the canonical rule for attributing a
  timestamped row (incidents, sessions, future Google events) to a calendar
  day: **never `slice(0, 10)` a UTC string against a local key.**
- Times are stored **bare** (`"HH:MM"`, no zone) in `start_time` / `end_time`
  columns, interpreted in the user's local timezone (`timeLabel` renders them).

## Intended Google event mapping (future sync phase)

### Timed events (`start.dateTime` / `end.dateTime`)

Google sends e.g. `"2026-10-05T09:30:00+05:30"` — a wall time plus its UTC
offset. The offset makes the instant unambiguous, so the mapping is:

1. `event_date` = `utcToDayKey(start.dateTime)` — the local day the event's
   start falls on in the user's timezone.
2. `start_time` / `end_time` = bare `"HH:MM"` extracted from the event's
   **local** wall time (the user's timezone, not UTC), matching the app's
   bare-time columns.

Rationale: the offset is folded into the instant first, then the app's normal
local-day rules apply. An event at 23:30 IST on Oct 5 stays Oct 5; an event at
00:30 UTC on Oct 6 (06:00 IST) lands on Oct 6.

### All-day events (`start.date` / `end.date`)

Google sends a bare `"2026-10-05"` (no time, no offset). Map directly:

- `event_date` = the `date` string as-is — no conversion, no offset math.
- `start_time` / `end_time` = null (all-day).

`end.date` is **exclusive** in the Google API; the sync phase must decide
whether to expand multi-day all-day events into one row per day or a single
row — see "Deferred decisions" below.

### Calendar `timeZone`

The `timeZone` field on each calendar (IANA name, e.g. `"Asia/Kolkata"`) is
stored per selection row **now** (see `GoogleCalendarInfo.timeZone` and the
`/api/google/selections` contract) for future use. It is metadata only in
this phase: the conversion above keys off the event's own offset and the
user's local timezone, not the calendar's zone. The stored zone exists so the
sync phase can later disambiguate recurring-event expansion and "floating"
times if needed.

## Deferred to the sync phase

- **Multi-day / overnight events.** A timed event spanning midnight (e.g.
  22:00 → 02:00) attributes to its start day under the rule above, but whether
  it should also appear on the second day, be split, or be flagged is an open
  product decision. Same for multi-day all-day events (exclusive `end.date`).
  Do not guess here — decide during sync implementation.
- **Recurring events.** Google expands via `recurrence`/`recurringEventId`;
  the app's day-key model needs an expansion policy first.
- **The user's local timezone source.** This mapping assumes the device's
  local zone is the reference (matching `lib/dates.ts`); if the app ever
  supports an explicit "home timezone" override, the conversion reference
  must be revisited.

## What must NOT change

- The local day-key model itself (`toDayKey` / `utcToDayKey` semantics).
- The plan-vs-reality separation and the no-gamification rules: synced Google
  events are *plans* (schedule), never reality, and never scores.
