"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDb } from "@/lib/sync/write";
import { engine } from "@/lib/sync/engine";
import { useSyncTick } from "@/components/sync/status";
import { seedDefaultsIfEmpty } from "@/lib/seed";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
  SegControl,
  StateDot,
} from "@/components/ui";
import { HabitForm } from "@/components/habits/HabitForm";
import {
  AbstinenceRuleForm,
  UsageLimitForm,
} from "@/components/habits/configForms";
import { toggleHabitDone, markHabitNotDone } from "@/lib/habits";
import { formatLong, timeLabel, todayKey } from "@/lib/dates";
import type {
  AbstinenceRule,
  Habit,
  HabitLog,
  UsageLimit,
} from "@/lib/types";

type Tab = "habits" | "abstinence" | "limits";

export default function HabitsPage() {
  const [tab, setTab] = useState<Tab>("habits");
  const [habits, setHabits] = useState<Habit[]>([]);
  const [logs, setLogs] = useState<HabitLog[]>([]);
  const [rules, setRules] = useState<AbstinenceRule[]>([]);
  const [limits, setLimits] = useState<UsageLimit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | { kind: "habit"; initial?: Habit }
    | { kind: "rule"; initial?: AbstinenceRule }
    | { kind: "limit"; initial?: UsageLimit }
    | null
  >(null);
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
        const db = getDb();
        await seedDefaultsIfEmpty();
        const today = todayKey();
        const [h, l, r, lim] = await Promise.all([
          db.list<Habit>("habits", {
            order: [
              { col: "sort_order", ascending: true },
              { col: "name", ascending: true },
            ],
          }),
          db.list<HabitLog>("habit_logs", { eq: { log_date: today } }),
          db.list<AbstinenceRule>("abstinence_rules", {
            order: [{ col: "name", ascending: true }],
          }),
          db.list<UsageLimit>("usage_limits", {
            order: [{ col: "name", ascending: true }],
          }),
        ]);
        if (cancelled) return;
        setHabits(h);
        setLogs(l);
        setRules(r);
        setLimits(lim);
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

  const logFor = useCallback(
    (habitId: string) => logs.find((x) => x.habit_id === habitId),
    [logs]
  );

  const trackingLabel = useMemo(
    () => ({
      completion: "Completion",
      count: "Count",
      duration: "Duration",
    }),
    []
  );

  async function onToggle(habit: Habit) {
    const done = logFor(habit.id)?.status === "done";
    await toggleHabitDone(habit, todayKey(), done);
    refresh();
  }

  async function onMarkNotDone(habit: Habit) {
    await markHabitNotDone(habit, todayKey());
    refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Habits</h1>
          <p className="page-sub">
            Routines, abstinence, and limits — all editable.
          </p>
        </div>
      </div>

      <SegControl<Tab>
        ariaLabel="Habits sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: "habits", label: "Habits" },
          { value: "abstinence", label: "Abstinence" },
          { value: "limits", label: "Limits" },
        ]}
      />

      {tab === "habits" && (
        <>
          <div className="flex justify-end">
            <button
              className="btn-primary"
              onClick={() => setModal({ kind: "habit" })}
            >
              + New habit
            </button>
          </div>
          {habits.length === 0 ? (
            <EmptyState
              title="No habits yet"
              body="Start with something small — Meditation is a good first one."
              action={
                <button
                  className="btn-primary"
                  onClick={() => setModal({ kind: "habit" })}
                >
                  Create your first habit
                </button>
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              {habits.map((h) => {
                const log = logFor(h.id);
                const done = log?.status === "done";
                return (
                  <div key={h.id} className="surface card-pad">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => onToggle(h)}
                        aria-label={
                          done ? `Unmark ${h.name}` : `Mark ${h.name} done today`
                        }
                        className={`w-8 h-8 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors touch-manipulation ${
                          done
                            ? "bg-emerald-500 border-emerald-500 text-white"
                            : "hairline t-faint hover:border-emerald-500"
                        }`}
                      >
                        {done && <span>✓</span>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium t-primary">{h.name}</p>
                        <p className="text-xs t-faint">
                          {trackingLabel[h.tracking]} · {h.frequency}
                          {h.frequency === "weekly" && h.weekly_target
                            ? ` · ${h.weekly_target}×/week`
                            : ""}
                          {h.preferred_time
                            ? ` · ${timeLabel(h.preferred_time)}`
                            : ""}
                          {!h.is_active ? " · paused" : ""}
                          {log?.status === "not_done" ? " · not done today" : ""}
                          {log?.value != null && h.tracking !== "completion"
                            ? ` · today: ${log.value}`
                            : ""}
                        </p>
                        {h.description && (
                          <p className="text-xs t-secondary mt-0.5">
                            {h.description}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {!done && (
                          <button
                            className="btn-ghost !min-h-[36px] !px-2.5 text-xs"
                            onClick={() => onMarkNotDone(h)}
                            title="Record as not done (day passed)"
                          >
                            Missed
                          </button>
                        )}
                        <button
                          className="btn-ghost !min-h-[36px] !px-2.5 text-xs"
                          onClick={() => setModal({ kind: "habit", initial: h })}
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "abstinence" && (
        <>
          <div className="flex justify-end">
            <button
              className="btn-primary"
              onClick={() => setModal({ kind: "rule" })}
            >
              + New rule
            </button>
          </div>
          <p className="text-xs t-faint">
            Category A — behaviors to abstain from completely. Incidents are
            recorded on the Today view and never reset your challenge.
          </p>
          {rules.length === 0 ? (
            <EmptyState
              title="No abstinence rules"
              body="Name the behaviors you're leaving behind for these 30 days."
              action={
                <button
                  className="btn-primary"
                  onClick={() => setModal({ kind: "rule" })}
                >
                  Add your first rule
                </button>
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              {rules.map((r) => (
                <div
                  key={r.id}
                  className="surface card-pad flex items-center gap-3"
                >
                  <StateDot tone={r.is_active ? "ok" : "idle"} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium t-primary">{r.name}</p>
                    <p className="text-xs t-faint">
                      since {formatLong(r.start_date)}
                      {!r.is_active ? " · paused" : ""}
                    </p>
                  </div>
                  <button
                    className="btn-ghost !min-h-[36px] !px-2.5 text-xs"
                    onClick={() => setModal({ kind: "rule", initial: r })}
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "limits" && (
        <>
          <div className="flex justify-end">
            <button
              className="btn-primary"
              onClick={() => setModal({ kind: "limit" })}
            >
              + New limit
            </button>
          </div>
          <p className="text-xs t-faint">
            Category B — allowed, but capped per day. Usage is logged on the
            Today view.
          </p>
          {limits.length === 0 ? (
            <EmptyState
              title="No usage limits"
              body="Set daily minute caps for the things you want to keep, not quit."
              action={
                <button
                  className="btn-primary"
                  onClick={() => setModal({ kind: "limit" })}
                >
                  Add your first limit
                </button>
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              {limits.map((l) => (
                <div
                  key={l.id}
                  className="surface card-pad flex items-center gap-3"
                >
                  <StateDot tone={l.is_active ? "ok" : "idle"} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium t-primary">{l.name}</p>
                    <p className="text-xs t-faint tabular-nums">
                      {l.daily_limit_min} min/day
                      {!l.is_active ? " · paused" : ""}
                    </p>
                  </div>
                  <button
                    className="btn-ghost !min-h-[36px] !px-2.5 text-xs"
                    onClick={() => setModal({ kind: "limit", initial: l })}
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {modal?.kind === "habit" && (
        <Modal
          title={modal.initial ? "Edit habit" : "New habit"}
          onClose={() => setModal(null)}
        >
          <HabitForm
            initial={modal.initial}
            onSaved={() => {
              setModal(null);
              refresh();
            }}
            onDeleted={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {modal?.kind === "rule" && (
        <Modal
          title={modal.initial ? "Edit abstinence rule" : "New abstinence rule"}
          onClose={() => setModal(null)}
        >
          <AbstinenceRuleForm
            initial={modal.initial}
            onSaved={() => {
              setModal(null);
              refresh();
            }}
            onDeleted={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
      {modal?.kind === "limit" && (
        <Modal
          title={modal.initial ? "Edit usage limit" : "New usage limit"}
          onClose={() => setModal(null)}
        >
          <UsageLimitForm
            initial={modal.initial}
            onSaved={() => {
              setModal(null);
              refresh();
            }}
            onDeleted={() => {
              setModal(null);
              refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
