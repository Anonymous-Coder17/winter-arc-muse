"use client";

// Books — the reading shelf. Active books with per-book page totals, an
// archived shelf (restore only, never delete), and recent reading history
// grouped by date. No scores, no streaks: just the record.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
import {
  ConfirmInline,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  StateDot,
} from "@/components/ui";
import {
  archiveBook,
  createBook,
  getArchivedBooks,
  getBooks,
  getReadingLogs,
  restoreBook,
  updateBook,
  updateReadingLogPages,
  type Book,
  type ReadingLog,
} from "@/lib/journal";
import { addDays, formatLong, todayKey } from "@/lib/dates";

/** Per-book totals come from this window — a full year, never fabricated. */
const TOTALS_RANGE_DAYS = 365;
/** How many recent days of reading history to show. */
const HISTORY_DAYS = 30;
const NO_BOOK = "No book";

export function BooksPage() {
  const [books, setBooks] = useState<Book[]>([]);
  const [archived, setArchived] = useState<Book[]>([]);
  const [logs, setLogs] = useState<ReadingLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookModal, setBookModal] = useState<{ book?: Book } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Book | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editLog, setEditLog] = useState<{
    date: string;
    bookName: string;
    rows: ReadingLog[];
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const tick = useSyncTick();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        await engine.whenReady();
        const today = todayKey();
        const [b, a, l] = await Promise.all([
          getBooks(),
          getArchivedBooks(),
          getReadingLogs(addDays(today, -(TOTALS_RANGE_DAYS - 1)), today),
        ]);
        if (cancelled) return;
        setBooks(b);
        setArchived(a);
        setLogs(l);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [nonce, tick]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Per-book totals: SUM(pages) across rows — multiple rows per (date, book)
  // are legal (cross-device), so never assume one row.
  const pagesByBook = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of logs) {
      if (row.book_id == null) continue;
      map.set(row.book_id, (map.get(row.book_id) ?? 0) + row.pages);
    }
    return map;
  }, [logs]);

  const bookNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of [...books, ...archived]) map.set(b.id, b.name);
    return map;
  }, [books, archived]);

  // All names (active + archived) for the case-insensitive duplicate check —
  // the DB unique index covers (owner, lower(name)) regardless of is_active.
  const allNames = useMemo(
    () => [...books, ...archived].map((b) => ({ id: b.id, name: b.name })),
    [books, archived]
  );

  const history = useMemo(() => {
    const cutoff = addDays(todayKey(), -(HISTORY_DAYS - 1));
    const byDate = new Map<string, ReadingLog[]>();
    for (const row of logs) {
      if (row.log_date < cutoff) continue;
      const arr = byDate.get(row.log_date) ?? [];
      arr.push(row);
      byDate.set(row.log_date, arr);
    }
    return [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, rows]) => {
        const byBook = new Map<string | null, ReadingLog[]>();
        for (const r of rows) {
          const arr = byBook.get(r.book_id) ?? [];
          arr.push(r);
          byBook.set(r.book_id, arr);
        }
        const groups = [...byBook.entries()]
          .map(([bookId, rs]) => ({
            bookId,
            bookName:
              bookId != null
                ? bookNameById.get(bookId) ?? "Unknown book"
                : NO_BOOK,
            pages: rs.reduce((s, r) => s + r.pages, 0),
            rows: rs,
          }))
          .sort((a, b) => a.bookName.localeCompare(b.bookName));
        return {
          date,
          groups,
          total: rows.reduce((s, r) => s + r.pages, 0),
        };
      });
  }, [logs, bookNameById]);

  async function onArchive(book: Book) {
    try {
      await archiveBook(book.id);
      setArchiveTarget(null);
      setToast(`"${book.name}" archived — its history is preserved.`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive.");
    }
  }

  async function onRestore(book: Book) {
    try {
      await restoreBook(book.id);
      setToast(`"${book.name}" restored.`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore.");
    }
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Books</h1>
          <p className="page-sub">
            Your reading shelf — titles, progress, and history.
          </p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => setBookModal({})}>
          + New book
        </button>
      </div>

      {/* Library */}
      <section aria-labelledby="library-heading">
        <h2 id="library-heading" className="section-title mb-2">
          Library
        </h2>
        {books.length === 0 ? (
          <EmptyState
            title="No books yet"
            body="Add the books you're reading and watch the pages add up."
            action={
              <button className="btn-primary" onClick={() => setBookModal({})}>
                Add your first book
              </button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {books.map((b) => {
              const pages = pagesByBook.get(b.id) ?? 0;
              const hasGoal =
                b.total_pages != null && b.total_pages > 0;
              return (
                <div key={b.id} className="surface card-pad">
                  {archiveTarget?.id === b.id ? (
                    <ConfirmInline
                      message={`Archive "${b.name}"? Its reading history is preserved and you can restore it any time.`}
                      confirmLabel="Archive"
                      onConfirm={() => onArchive(b)}
                      onCancel={() => setArchiveTarget(null)}
                    />
                  ) : (
                    <div className="flex items-start gap-3">
                      <StateDot tone="ok" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium t-primary break-words">
                          {b.name}
                        </p>
                        {b.author && (
                          <p className="text-xs t-faint">{b.author}</p>
                        )}
                        {hasGoal && (
                          <p className="text-xs t-secondary tabular-nums mt-0.5">
                            {pages} / {b.total_pages} pages ·{" "}
                            {Math.round(
                              (pages / (b.total_pages as number)) * 100
                            )}
                            %
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button
                          className="btn-ghost !min-h-[36px] !px-2.5 text-xs"
                          onClick={() => setBookModal({ book: b })}
                          aria-label={`Edit ${b.name}`}
                        >
                          Edit
                        </button>
                        <button
                          className="btn-ghost !min-h-[36px] !px-2.5 text-xs"
                          onClick={() => setArchiveTarget(b)}
                          aria-label={`Archive ${b.name}`}
                        >
                          Archive
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Archived */}
      {archived.length > 0 && (
        <section aria-labelledby="archived-heading">
          <button
            id="archived-heading"
            className="section-title mb-2 flex items-center gap-1 touch-manipulation min-h-[36px]"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((s) => !s)}
          >
            <span aria-hidden>{showArchived ? "▾" : "▸"}</span>
            Archived ({archived.length})
          </button>
          {showArchived && (
            <div className="flex flex-col gap-2">
              {archived.map((b) => (
                <div
                  key={b.id}
                  className="surface card-pad flex items-center gap-3"
                >
                  <StateDot tone="idle" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium t-primary break-words">
                      {b.name}
                    </p>
                    <p className="text-xs t-faint">
                      {b.author ? `${b.author} · ` : ""}Archived — history kept
                    </p>
                  </div>
                  <button
                    className="btn-ghost !min-h-[36px] !px-2.5 text-xs shrink-0"
                    onClick={() => onRestore(b)}
                    aria-label={`Restore ${b.name}`}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Reading history */}
      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="section-title mb-1">
          Reading history
        </h2>
        <p className="text-xs t-faint mb-2">
          Last {HISTORY_DAYS} days with logged reading, newest first.
        </p>
        {history.length === 0 ? (
          <EmptyState
            title="No reading logged yet"
            body="Pages you log will appear here, newest first."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {history.map((day) => (
              <div key={day.date} className="surface card-pad">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium t-primary">
                    {formatLong(day.date)}
                  </p>
                  <p className="text-xs t-secondary tabular-nums shrink-0">
                    {day.total} pages
                  </p>
                </div>
                <ul>
                  {day.groups.map((g) => (
                    <li
                      key={g.bookId ?? NO_BOOK}
                      className="flex items-center gap-2 py-1.5 border-t hairline-t"
                    >
                      <p
                        className="flex-1 min-w-0 text-sm t-primary truncate"
                        title={g.bookName}
                      >
                        {g.bookName}{" "}
                        <span className="t-secondary tabular-nums">
                          · {g.pages} pages
                        </span>
                      </p>
                      <button
                        className="btn-ghost !min-h-[36px] !px-2.5 text-xs shrink-0"
                        onClick={() =>
                          setEditLog({
                            date: day.date,
                            bookName: g.bookName,
                            rows: g.rows,
                          })
                        }
                        aria-label={`Edit ${g.bookName} entry on ${formatLong(day.date)}`}
                      >
                        Edit
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {bookModal && (
        <Modal
          title={bookModal.book ? "Edit book" : "New book"}
          onClose={() => setBookModal(null)}
        >
          <BookForm
            initial={bookModal.book}
            names={allNames}
            onSaved={(message) => {
              setBookModal(null);
              setToast(message);
              refresh();
            }}
            onCancel={() => setBookModal(null)}
          />
        </Modal>
      )}

      {editLog && (
        <Modal
          title="Edit reading entry"
          onClose={() => setEditLog(null)}
        >
          <LogEditForm
            date={editLog.date}
            bookName={editLog.bookName}
            rows={editLog.rows}
            onSaved={() => {
              setEditLog(null);
              setToast("Reading entry updated.");
              refresh();
            }}
            onCancel={() => setEditLog(null)}
          />
        </Modal>
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-24 md:bottom-8 left-1/2 -translate-x-1/2 z-50 surface-elevated card-pad py-3 text-sm t-primary rounded-2xl shadow-lg max-w-[calc(100vw-2rem)]"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit form. Client-side case-insensitive duplicate check (the DB
// unique index covers (owner, lower(name)) including archived books, so we
// check against active + archived before calling createBook/updateBook).
// ---------------------------------------------------------------------------

function BookForm({
  initial,
  names,
  onSaved,
  onCancel,
}: {
  initial?: Book;
  names: { id: string; name: string }[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [author, setAuthor] = useState(initial?.author ?? "");
  const [totalPages, setTotalPages] = useState(
    initial?.total_pages != null ? String(initial.total_pages) : ""
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const cleanName = name.trim();
    if (!cleanName) {
      setFormError("Give the book a name.");
      return;
    }
    const dupe = names.some(
      (n) =>
        n.id !== initial?.id &&
        n.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (dupe) {
      setFormError("A book with this name already exists.");
      return;
    }
    let total: number | undefined;
    if (totalPages.trim()) {
      const n = Number(totalPages.trim());
      if (!Number.isInteger(n) || n < 1) {
        setFormError("Total pages must be a whole number of 1 or more.");
        return;
      }
      total = n;
    }
    setBusy(true);
    try {
      if (initial) {
        await updateBook(initial.id, {
          name: cleanName,
          author: author.trim() || null,
          total_pages: total ?? null,
        });
        onSaved(`"${cleanName}" updated.`);
      } else {
        await createBook(cleanName, author.trim() || undefined, total);
        onSaved(`"${cleanName}" added to your library.`);
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Could not save the book."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Atomic Habits"
          required
          autoFocus
          maxLength={200}
        />
      </Field>
      <Field label="Author (optional)">
        <input
          className="input"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="e.g. James Clear"
          maxLength={200}
        />
      </Field>
      <Field label="Total pages (optional)">
        <input
          className="input tabular-nums"
          value={totalPages}
          onChange={(e) => setTotalPages(e.target.value)}
          placeholder="e.g. 320"
          inputMode="numeric"
        />
      </Field>
      {formError && (
        <p
          className="text-sm text-red-500 dark:text-red-400"
          role="alert"
        >
          {formError}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save" : "Add book"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Reading-entry correction. Each underlying row gets its own input because
// multiple rows per (date, book) are legal — the sum stays honest and each
// row is corrected absolutely via updateReadingLogPages.
// ---------------------------------------------------------------------------

function LogEditForm({
  date,
  bookName,
  rows,
  onSaved,
  onCancel,
}: {
  date: string;
  bookName: string;
  rows: ReadingLog[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, String(r.pages)]))
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const changes: { id: string; pages: number }[] = [];
    for (const row of rows) {
      const raw = (values[row.id] ?? "").trim();
      const n = Number(raw);
      if (raw === "" || !Number.isInteger(n) || n < 0) {
        setFormError("Pages must be a whole number of 0 or more.");
        return;
      }
      if (n !== row.pages) changes.push({ id: row.id, pages: n });
    }
    if (changes.length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      // Sequential: each call guards the per-row pending-mutation queue.
      for (const c of changes) await updateReadingLogPages(c.id, c.pages);
      onSaved();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Could not update the entry."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-sm t-secondary">
        Correct the pages for{" "}
        <span className="t-primary font-medium">{bookName}</span> on{" "}
        {formatLong(date)}. A correction sets the total — it doesn&apos;t add
        to it.
      </p>
      {rows.length > 1 && (
        <p className="text-xs t-faint">
          There are multiple entries for this date (e.g. logged from two
          devices) — edit each one separately.
        </p>
      )}
      {rows.map((r, i) => (
        <Field
          key={r.id}
          label={rows.length > 1 ? `Pages (entry ${i + 1} of ${rows.length})` : "Pages"}
        >
          <input
            className="input tabular-nums"
            value={values[r.id] ?? ""}
            onChange={(e) =>
              setValues((v) => ({ ...v, [r.id]: e.target.value }))
            }
            inputMode="numeric"
          />
        </Field>
      ))}
      {formError && (
        <p
          className="text-sm text-red-500 dark:text-red-400"
          role="alert"
        >
          {formError}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
