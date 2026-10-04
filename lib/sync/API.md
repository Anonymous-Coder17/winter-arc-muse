# V4.2 data-layer migration contract

All page data now flows through the **local-first** layer. Supabase remains the
cloud source of truth; the sync engine replays queued mutations and pulls
deltas in the background.

## Imports

```ts
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
```

`getDb()` throws `"Not signed in."` when no user DB is open. Hooks must
`await engine.whenReady()` before the first `getDb()` (resolves after auth +
initial pull). These modules are **client-only** — never import them from a
server component.

## Reads — `db.list(table, opts)`

```ts
const db = getDb();
await db.list("tasks", {
  gte: { task_date: startKey },   // >=  (also gt / lte / lt)
  lte: { task_date: endKey },
  eq: { is_active: true },        // exact match (null-safe)
  in: { session_id: ids },        // [] → returns [] (no zero-UUID hack needed)
  order: [{ col: "start_time", ascending: true }],
  limit: 500,
});
await db.list("habit_logs", { eq: { habit_id: id, log_date: key } });
await db.get("challenges", id);                    // by PK, or null
await db.getByNaturalKey("habit_logs",
  { index: "habit_id_log_date", cols: ["habit_id", "log_date"] },
  { habit_id, log_date });
await db.count("habits");
```

Rows are `LocalRow<T>` = the Supabase row shape **plus** `_dirty/_deleted/
_local_created_at/_local_updated_at/_sync_error`. Tombstoned rows are excluded
from `list()` by default. `owner` is always populated (except `profiles`,
which uses `id`).

Natural-key index names (see `lib/sync/ports.ts` STORE_DEFS):
`habit_id_log_date`, `limit_id_log_date`, `session_exercise_set`,
`entry_date`, `review_date`, `week_start`, `challenge_id`, `weekday`.

## Writes — all return the local row, apply instantly, queue a mutation

```ts
const created = await db.insert("tasks", { task_date, title }); // id auto (crypto.randomUUID)
await db.update("tasks", id, { state: "done" });                 // patch; throws if missing
await db.upsert("habit_logs",
  { habit_id, log_date, status: "done", value: null },
  { index: "habit_id_log_date", cols: ["habit_id", "log_date"] });
await db.upsert("journal_entries",
  { entry_date, content },
  { index: "entry_date", cols: ["entry_date"] });   // owner auto-injected
await db.increment("limit_logs", existingIdOrUndefined, "minutes_used", 30,
  { limit_id, log_date, minutes_used: 0 }, ["limit_id", "log_date"]);
await db.remove("tasks", id); // tombstone; throws V2.2-style error if children exist
```

Rules:
- **Never pass `id` on insert** unless you need a stable id (the DB generates
  one). Never generate ids with `Math.random` — `db` uses `crypto.randomUUID`.
- **`owner` is auto-injected** from the signed-in user on insert/upsert/
  increment. Do not pass it manually (except `profiles`, where `id` = user id).
- **Never send `updated_at`/`created_at`** — the engine manages them.
- `db.remove` on `workouts/workout_exercises/subjects/topics` throws when
  historical children exist (local mirror of the V2.2 trigger). Catch and show
  the message; suggest archiving instead.
- `profiles` rows: `db.upsert("profiles", { id: userId, display_name })`.

## Refresh pattern

The old pattern (`await supabase…; refresh()`) becomes:

```ts
const tick = useSyncTick();          // bumps after every sync cycle
useEffect(() => {
  let live = true;
  (async () => {
    await engine.whenReady();
    const rows = await getDb().list("tasks", { … });
    if (live) setRows(rows);
  })().catch(setError);
  return () => { live = false; };
}, [startKey, endKey, tick]);
```

Writes: `await db.update(…); ` then **re-read from `db`** (or apply the
returned row to state) — no server round-trip, no `refresh()` needed. The
engine's `kick()` (called automatically by every write) syncs in the background
and `tick` refreshes the UI when the cycle completes.

## Translations of common Supabase patterns

| Old | New |
|---|---|
| `.select("*").eq("a",1).gte("d",s).lte("d",e).order("d")` | `db.list(t,{eq:{a:1},gte:{d:s},lte:{d:e},order:[{col:"d",ascending:true}]})` |
| `.select("*").eq("id",id).maybeSingle()` | `db.get(t,id)` |
| `.select("entry_date")` (column subset) | `db.list` full rows; map client-side |
| `.insert(row).select().single()` | `db.insert(t,row)` (returns row incl. id) |
| `.update(patch).eq("id",id)` | `db.update(t,id,patch)` |
| `.upsert(row,{onConflict:"habit_id,log_date"})` | `db.upsert(t,row,{index:"habit_id_log_date",cols:["habit_id","log_date"]})` |
| `.delete().eq("id",id)` | `db.remove(t,id)` |
| read-then-write counters (`addLimitMinutes`, `logReadingPages`) | `db.increment(…)` (see above) |
| `supabase.auth.getUser()` per load | `await engine.whenReady()` once, then `getDb()` |

## Date handling (unchanged)

Keep using `lib/dates.ts` (`todayKey()`, `toDayKey`, `utcToDayKey`, …).
`date` columns stay local `YYYY-MM-DD` strings; `timestamptz` stays UTC ISO.
Offline-created rows use the device clock — same as today.

## What NOT to do

- Do not import `@/lib/supabase/client` in migrated read/write paths (auth
  pages, server layout gate, and the sync engine itself are the exceptions).
- Do not change hook/component return shapes or props — internals only.
- Do not add toasts, redesign UI, or change analytics calculations.
- `lib/dates.ts`, `lib/analytics.ts`, `lib/training.ts`, `lib/study.ts`,
  `lib/types.ts` stay untouched.
- `components/today/useTodayExtras.ts`: fix the incident window to
  `gte(dayStart)` / `lt(nextDayStart)` (the old `lte(…23:59:59)` dropped the
  last second of the day).
