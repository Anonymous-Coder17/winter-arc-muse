"use client";

import { useMemo } from "react";
import { EmptyState } from "@/components/ui";
import { formatLong, formatShort, utcToDayKey } from "@/lib/dates";
import { RatioBar } from "./charts";
import { limitStats, ruleStats } from "./normalize";
import type { ProgressData, Range } from "./types";

/**
 * Distractions: abstinence and limits are kept deliberately separate —
 * incidents are history, limits are daily budgets. Never mixed.
 */
export function DistractionsTab({
  data,
  range,
}: {
  data: ProgressData;
  range: Range;
}) {
  const rules = useMemo(
    () => ruleStats(data.rules, data.incidents, range),
    [data.rules, data.incidents, range]
  );
  const limits = useMemo(
    () => limitStats(data.limits, data.limitLogs, range),
    [data.limits, data.limitLogs, range]
  );

  const incidents = data.incidents;
  const incidentsByRule = useMemo(() => {
    const m = new Map<string, typeof incidents>();
    for (const i of incidents) {
      const arr = m.get(i.rule_id) ?? [];
      arr.push(i);
      m.set(i.rule_id, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
    }
    return m;
  }, [incidents]);

  return (
    <div className="flex flex-col gap-4">
      {/* abstinence */}
      <section aria-label="Abstinence">
        <h2 className="section-title mb-2">Abstinence</h2>
        {data.rules.length === 0 ? (
          <EmptyState
            title="No abstinence rules"
            body="Add rules from the Today or Habits area to track incidents here."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {rules.map((r) => {
              const timeline = (incidentsByRule.get(r.ruleId) ?? []).filter(
                (i) => {
                  const d = utcToDayKey(i.occurred_at);
                  return d >= range.start && d <= range.end;
                }
              );
              return (
                <div key={r.ruleId} className="surface card-pad">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium t-primary">{r.name}</h3>
                    <p className="text-xs t-secondary tabular-nums whitespace-nowrap">
                      {r.incidents} incident{r.incidents === 1 ? "" : "s"} ·{" "}
                      {r.incidentFreeDays} incident-free days
                    </p>
                  </div>
                  {timeline.length === 0 ? (
                    <p className="text-xs t-faint mt-2">
                      No incidents in this range.
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-col gap-2 border-t hairline-t pt-3">
                      {timeline.map((i) => (
                        <div key={i.id} className="text-sm">
                          <span className="t-primary">
                            {formatShort(utcToDayKey(i.occurred_at))}
                          </span>{" "}
                          <span className="t-faint text-xs">
                            {new Date(i.occurred_at).toLocaleTimeString(
                              undefined,
                              { hour: "numeric", minute: "2-digit" }
                            )}
                          </span>
                          {(i.trigger || i.note) && (
                            <p className="text-xs t-secondary mt-0.5">
                              {[i.trigger, i.note].filter(Boolean).join(" — ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* limits */}
      <section aria-label="Usage limits">
        <h2 className="section-title mb-2">Usage limits</h2>
        {data.limits.length === 0 ? (
          <EmptyState
            title="No usage limits"
            body="Add limits (e.g. YouTube 45 min/day) to see daily compliance here."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {limits.map((l) => (
              <div key={l.limitId} className="surface card-pad">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium t-primary">{l.name}</h3>
                  <p className="text-xs t-secondary tabular-nums whitespace-nowrap">
                    limit {l.dailyLimit}m/day
                  </p>
                </div>
                {l.daysWithData === 0 ? (
                  <p className="text-xs t-faint mt-2">
                    No usage logged in this range.
                  </p>
                ) : (
                  <div className="mt-2">
                    <p className="text-xs t-secondary tabular-nums">
                      avg {l.avgPerDay === null ? "—" : `${Math.round(l.avgPerDay)}m/day`} ·{" "}
                      {l.daysWithin} within · {l.daysOver} over
                    </p>
                    <div className="mt-1.5">
                      <RatioBar pct={l.compliancePct ?? 0} />
                    </div>
                    <p className="text-[11px] t-faint mt-1.5">
                      {l.compliancePct === null
                        ? "No logged days to measure."
                        : `${Math.round(l.compliancePct)}% of logged days within limit.`}{" "}
                      Missing days are unrecorded — not assumed within.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs t-faint">
        Last incident across rules:{" "}
        {data.incidents.length === 0
          ? "none recorded"
          : formatLong(
              utcToDayKey(
                [...data.incidents].sort((a, b) =>
                  a.occurred_at < b.occurred_at ? 1 : -1
                )[0].occurred_at
              )
            )}
        .
      </p>
    </div>
  );
}
