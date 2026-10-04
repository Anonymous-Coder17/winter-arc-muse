"use client";

import { useMemo, useState } from "react";
import { EmptyState, SegControl } from "@/components/ui";
import { formatDuration } from "@/lib/dates";
import { TrendBars } from "./charts";
import {
  studySummary,
  studyTrendItems,
  subjectTotals,
  topicTotals,
} from "./normalize";
import type { ProgressData, Range } from "./types";

type Bucket = "day" | "week";

/** Study: totals, trend, subject → topic drill-down. */
export function StudyTab({
  data,
  range,
}: {
  data: ProgressData;
  range: Range;
}) {
  const [bucket, setBucket] = useState<Bucket>("day");
  const [subjectId, setSubjectId] = useState<string | null>(null);

  const totals = useMemo(
    () => studySummary(data.studySessions, range),
    [data.studySessions, range]
  );
  const trend = useMemo(
    () => studyTrendItems(data.studySessions, range, bucket),
    [data.studySessions, range, bucket]
  );
  const subjects = useMemo(
    () => subjectTotals(data.studySessions, data.subjects, range),
    [data.studySessions, data.subjects, range]
  );
  const topics = useMemo(
    () =>
      subjectId
        ? topicTotals(data.studySessions, data.topics, subjectId, range)
        : [],
    [data.studySessions, data.topics, subjectId, range]
  );

  if (totals.sessionCount === 0) {
    return (
      <EmptyState
        title="No study data yet"
        body="Start a study timer or log a manual session from the Study area — totals and trends will appear here."
      />
    );
  }

  const selectedSubject =
    subjects.find((s) => s.subjectId === subjectId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* totals */}
      <section className="surface card-pad" aria-label="Study totals">
        <h2 className="section-title mb-3">Totals</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            ["Total", formatDuration(totals.totalSeconds)],
            ["Sessions", String(totals.sessionCount)],
            ["Active days", String(totals.activeDays)],
            [
              "Avg / active day",
              totals.avgPerActiveDay === null
                ? "—"
                : formatDuration(totals.avgPerActiveDay),
            ],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border hairline px-3 py-2.5"
            >
              <p className="text-[11px] t-faint">{label}</p>
              <p className="text-base font-medium t-primary tabular-nums mt-0.5">
                {value}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* trend */}
      <section className="surface card-pad" aria-label="Study trend">
        <div className="flex items-center justify-between mb-2">
          <h2 className="section-title">Trend</h2>
          <SegControl<Bucket>
            ariaLabel="Trend bucket"
            value={bucket}
            onChange={setBucket}
            options={[
              { value: "day", label: "Daily" },
              { value: "week", label: "Weekly" },
            ]}
          />
        </div>
        <TrendBars
          items={trend}
          formatValue={(v) => formatDuration(v)}
        />
        <p className="text-[11px] t-faint mt-1">
          Only {bucket === "day" ? "days" : "weeks"} with recorded sessions
          appear — absence from the chart is not a zero.
        </p>
      </section>

      {/* subject → topic drill-down */}
      <section aria-label="By subject">
        <h2 className="section-title mb-2">By subject</h2>
        <div className="flex flex-col gap-3">
          <div
            className="flex gap-1.5 overflow-x-auto pb-1"
            role="tablist"
            aria-label="Subjects"
          >
            {subjects.map((s) => (
              <button
                key={s.subjectId}
                role="tab"
                aria-selected={subjectId === s.subjectId}
                onClick={() =>
                  setSubjectId(subjectId === s.subjectId ? null : s.subjectId)
                }
                className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium min-h-[40px] touch-manipulation border transition-colors ${
                  subjectId === s.subjectId
                    ? "bg-[#5A6AE0]/15 text-[#3D4AC4] dark:text-[#C3CCFF] border-[#5A6AE0]/30"
                    : "t-secondary border-transparent hover:t-primary"
                }`}
              >
                {s.name} · {formatDuration(s.seconds)}
              </button>
            ))}
          </div>
          {selectedSubject && (
            <div className="surface card-pad">
              <h3 className="text-sm font-medium t-primary">
                {selectedSubject.name}
              </h3>
              <p className="text-xs t-secondary tabular-nums mt-0.5">
                {formatDuration(selectedSubject.seconds)} ·{" "}
                {selectedSubject.sessions} session
                {selectedSubject.sessions === 1 ? "" : "s"}
              </p>
              {topics.length === 0 ? (
                <p className="text-xs t-faint mt-3">
                  No topic-level data in this range.
                </p>
              ) : (
                <div className="mt-3 flex flex-col divide-y divide-[#E5E7EB] dark:divide-[#242932]">
                  {topics.map((t) => (
                    <div
                      key={t.topicId}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="text-sm t-primary">{t.name}</span>
                      <span className="text-xs t-secondary tabular-nums">
                        {formatDuration(t.seconds)} · {t.sessions} session
                        {t.sessions === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
