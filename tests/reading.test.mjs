// V4.4 reading regression tests: books CRUD (create/edit/archive/restore),
// per-book reading logging, additive same-device collapse, and the
// reading-log correction guard. Deterministic: MemoryPort + MemoryRemote via
// engine.testInject (same seam as sync.test.mjs).
// Run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const USER = "11111111-1111-1111-1111-111111111111";

let ports, remote2, engine2, journal;

async function load() {
  if (ports) return;
  ports = await import("../lib/sync/ports.ts");
  remote2 = await import("../lib/sync/remote.ts");
  engine2 = await import("../lib/sync/engine.ts");
  journal = await import("../lib/journal.ts");
}

/** Fresh isolated local DB for the test user. Remote starts offline so the
 *  engine never flushes the queue mid-test unless a test opts in. */
function setup() {
  const port = new ports.MemoryPort();
  const remote = new remote2.MemoryRemote();
  remote.offline = true;
  engine2.engine.testReset();
  engine2.engine.testInject(port, remote, USER);
  return { port, remote };
}

beforeEach(async () => {
  await load();
});

function cleanRow(row) {
  return {
    ...row,
    _dirty: 0,
    _deleted: 0,
    _local_created_at: "2026-01-01T00:00:00.000Z",
    _local_updated_at: "2026-01-01T00:00:00.000Z",
    _sync_error: null,
  };
}

// ------------------------------------------------------------------ books ---

test("createBook: trims the name and stores author/total pages", async () => {
  setup();
  const b = await journal.createBook("  Atomic Habits  ", "James Clear", 320);
  assert.equal(b.name, "Atomic Habits");
  assert.equal(b.author, "James Clear");
  assert.equal(b.total_pages, 320);
  assert.equal(b.is_active, true);
  assert.equal(b.owner, USER);
});

test("createBook: blank name throws a friendly error", async () => {
  setup();
  await assert.rejects(journal.createBook("   "), /Give the book a name/);
  await assert.rejects(journal.createBook(""), /Give the book a name/);
});

test("createBook: non-positive total pages becomes null", async () => {
  setup();
  const a = await journal.createBook("No Total");
  const b = await journal.createBook("Zero Total", undefined, 0);
  const c = await journal.createBook("Negative Total", undefined, -5);
  assert.equal(a.total_pages, null);
  assert.equal(b.total_pages, null);
  assert.equal(c.total_pages, null);
});

test("createBook: sort_order increments per book", async () => {
  setup();
  const a = await journal.createBook("First");
  const b = await journal.createBook("Second");
  assert.ok(b.sort_order > a.sort_order, "sort_order should increase");
  const books = await journal.getBooks();
  assert.deepEqual(
    books.map((x) => x.name),
    ["First", "Second"]
  );
});

test("updateBook: patches name, author, total_pages", async () => {
  setup();
  const b = await journal.createBook("Old Name", "Old Author", 100);
  const updated = await journal.updateBook(b.id, {
    name: "New Name",
    author: "New Author",
    total_pages: 200,
  });
  assert.equal(updated.name, "New Name");
  assert.equal(updated.author, "New Author");
  assert.equal(updated.total_pages, 200);
});

test("archiveBook/restoreBook: archive hides, restore brings back, history intact", async () => {
  const { port } = setup();
  const b = await journal.createBook("Archivable");
  await journal.logReadingPages("2026-10-04", 12, b.id);

  await journal.archiveBook(b.id);
  assert.deepEqual(
    (await journal.getBooks()).map((x) => x.id),
    [],
    "archived book hidden from getBooks"
  );
  const archived = await journal.getArchivedBooks();
  assert.deepEqual(
    archived.map((x) => x.id),
    [b.id]
  );

  // History survives archiving: the reading log row is untouched.
  const logs = await journal.getReadingLogs("2026-10-04", "2026-10-04");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].book_id, b.id);
  assert.equal(logs[0].pages, 12);

  await journal.restoreBook(b.id);
  assert.deepEqual((await journal.getBooks()).map((x) => x.id), [b.id]);
  assert.deepEqual(await journal.getArchivedBooks(), []);
  void port;
});

// ------------------------------------------------------------ reading logs ---

test("logReadingPages: stores book_id; same (date, book) collapses additively", async () => {
  setup();
  const a = await journal.createBook("Book A");
  const b = await journal.createBook("Book B");

  await journal.logReadingPages("2026-10-04", 10, a.id);
  await journal.logReadingPages("2026-10-04", 5, a.id);
  await journal.logReadingPages("2026-10-04", 7, b.id);
  await journal.logReadingPages("2026-10-04", 3, null);

  const logs = await journal.getReadingLogs("2026-10-04", "2026-10-04");
  assert.equal(logs.length, 3, "same-device same (date, book) collapses to one row");
  const byBook = new Map(logs.map((r) => [r.book_id, r.pages]));
  assert.equal(byBook.get(a.id), 15);
  assert.equal(byBook.get(b.id), 7);
  assert.equal(byBook.get(null), 3);
});

test("logReadingPages: rejects non-positive pages", async () => {
  setup();
  await assert.rejects(journal.logReadingPages("2026-10-04", 0, null), /positive/);
  await assert.rejects(journal.logReadingPages("2026-10-04", -5, null), /positive/);
});

test("reading aggregation contract: multiple rows per (date, book) sum correctly", async () => {
  // Cross-device duplicates are legal rows (no natural unique key on
  // reading_logs); every consumer must SUM, never assume one row.
  const { port } = setup();
  const b = await journal.createBook("Shared Book");
  const mk = (pages, id) =>
    cleanRow({
      id,
      owner: USER,
      book_id: b.id,
      log_date: "2026-10-04",
      pages,
      note: null,
    });
  await port.put("reading_logs", mk(10, "row-1"));
  await port.put("reading_logs", mk(5, "row-2"));

  const logs = await journal.getReadingLogs("2026-10-04", "2026-10-04");
  assert.equal(logs.length, 2);
  const total = logs.reduce((s, r) => s + r.pages, 0);
  assert.equal(total, 15, "UI must sum rows per (date, book)");
});

// ------------------------------------------------------- log corrections ---

test("updateReadingLogPages: sets an absolute value", async () => {
  const { port } = setup();
  await port.put(
    "reading_logs",
    cleanRow({
      id: "log-1",
      owner: USER,
      book_id: null,
      log_date: "2026-10-04",
      pages: 20,
      note: null,
    })
  );
  await journal.updateReadingLogPages("log-1", 12);
  const row = await port.get("reading_logs", "log-1");
  assert.equal(row.pages, 12);
});

test("updateReadingLogPages: validates pages as integer >= 0", async () => {
  setup();
  await assert.rejects(journal.updateReadingLogPages("x", -1), /whole number/);
  await assert.rejects(journal.updateReadingLogPages("x", 2.5), /whole number/);
  await assert.rejects(journal.updateReadingLogPages("nope", 5), /Record not found/);
});

test("updateReadingLogPages: refuses while a mutation is queued for the row", async () => {
  const { port } = setup();
  await port.put(
    "reading_logs",
    cleanRow({
      id: "log-2",
      owner: USER,
      book_id: null,
      log_date: "2026-10-04",
      pages: 20,
      note: null,
    })
  );
  // Simulate an unflushed queued increment for the same row.
  await port.put("_mutations", {
    mutation_id: "m-1",
    owner_id: USER,
    entity: "reading_logs",
    op: "increment",
    record_id: "log-2",
    payload: {},
    natural_key_cols: null,
    field: "pages",
    delta: 5,
    base: 20,
    created_at: "2026-10-04T00:00:00.000Z",
    retry_count: 0,
    last_error: null,
    status: "pending",
    next_retry_at: null,
    tolerance: null,
  });
  await assert.rejects(
    journal.updateReadingLogPages("log-2", 12),
    /Sync in progress/
  );
  // The row itself is untouched by the refused edit.
  const row = await port.get("reading_logs", "log-2");
  assert.equal(row.pages, 20);
});
