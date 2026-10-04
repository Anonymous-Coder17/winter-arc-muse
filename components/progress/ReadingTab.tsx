"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui";
import { formatLong, formatShort } from "@/lib/dates";
import { TrendBars } from "./charts";
import { firstFinal, readingData } from "./normalize";
import type { ProgressData, Range } from "./types";

/** Reading: totals, trend, per-book breakdown with history. */
export function ReadingTab({
  data,
  range,
}: {
  data: ProgressData;
  range: Range;
}) {
  const reading = useMemo(
    () => readingData(data.readingLogs, range, data.books),
    [data.readingLogs, data.books, range]
  );
  const halves = useMemo(
    () => firstFinal(reading.raw, range),
    [reading, range]
  );
  // null = nothing chosen yet (defaults to first book); "__none__" = unbooked logs.
  const [bookId, setBookId] = useState<string | null>(null);

  const books = useMemo(
    () => reading.byBook.filter((b) => b.pages > 0),
    [reading.byBook]
  );
  // Default to the first book with data; "__none__" = unbooked logs.
  const effectiveId =
    bookId !== null ? bookId : books.length > 0 ? (books[0].bookId ?? "__none__") : null;
  const selected =
    books.find((b) => (b.bookId ?? "__none__") === effectiveId) ?? null;

  const history = useMemo(() => {
    const selId = selected?.bookId ?? null;
    return data.readingLogs
      .filter(
        (l) =>
          l.log_date >= range.start &&
          l.log_date <= range.end &&
          (selId === null ? l.book_id === null : l.book_id === selId)
      )
      .sort((a, b) => (a.log_date < b.log_date ? 1 : -1));
  }, [data.readingLogs, range, selected]);

  if (reading.recordedDays === 0) {
    return (
      <EmptyState
        title="No reading data yet"
        body="Log pages from the Reading area (per book, or without a book) — totals, trends, and per-book history will appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="surface card-pad" aria-label="Reading totals">
        <h2 className="section-title mb-3">Totals</h2>
        <div className="grid grid-cols-3 gap-2">
          {[
            ["Pages", String(reading.totalPages)],
            ["Recorded days", String(reading.recordedDays)],
            ["Books", String(books.length)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border hairline px-3 py-2.5">
              <p className="text-[11px] t-faint">{label}</p>
              <p className="text-base font-medium t-primary tabular-nums mt-0.5">
                {value}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="surface card-pad" aria-label="Reading trend">
        <h2 className="section-title mb-2">Trend</h2>
        <TrendBars
          items={reading.points.map((p) => ({
            key: p.date,
            label: formatShort(p.date),
            value: p.value ?? 0,
          }))}
          formatValue={(v) => `${v} pages`}
        />
        {halves && (halves.first !== null || halves.final !== null) && (
          <p className="text-xs t-secondary tabular-nums mt-2">
            Avg pages/day — first 7 days{" "}
            {halves.first === null ? "—" : halves.first.toFixed(1)} · last 7
            days {halves.final === null ? "—" : halves.final.toFixed(1)}
          </p>
        )}
      </section>

      <section aria-label="Per book">
        <h2 className="section-title mb-2">Per book</h2>
        <div
          className="flex gap-1.5 overflow-x-auto pb-1"
          role="tablist"
          aria-label="Books"
        >
          {books.map((b) => {
            const id = b.bookId ?? "__none__";
            const active = id === effectiveId;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                onClick={() => setBookId(b.bookId ?? "__none__")}
                className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium min-h-[40px] touch-manipulation border transition-colors ${
                  active
                    ? "bg-[#5A6AE0]/15 text-[#3D4AC4] dark:text-[#C3CCFF] border-[#5A6AE0]/30"
                    : "t-secondary border-transparent hover:t-primary"
                }`}
              >
                {b.name} · {b.pages}p
              </button>
            );
          })}
        </div>
        {selected && (
          <div className="surface card-pad mt-3">
            <h3 className="text-sm font-medium t-primary">{selected.name}</h3>
            <p className="text-xs t-secondary tabular-nums mt-0.5">
              {selected.pages} pages · {selected.days} day
              {selected.days === 1 ? "" : "s"}
            </p>
            {history.length === 0 ? (
              <p className="text-xs t-faint mt-3">No logs in this range.</p>
            ) : (
              <div className="mt-3 flex flex-col divide-y divide-[#E5E7EB] dark:divide-[#242932]">
                {history.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-baseline justify-between gap-3 py-2"
                  >
                    <span className="text-sm t-secondary">
                      {formatLong(l.log_date)}
                    </span>
                    <span className="text-sm t-primary tabular-nums">
                      {l.pages} page{l.pages === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
