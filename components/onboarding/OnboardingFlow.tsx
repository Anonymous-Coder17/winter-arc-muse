"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { engine } from "@/lib/sync/engine";
import {
  applyOnboardingConfig,
  getOnboardingConfig,
  ensureOnboardingChallenge,
  type OnboardingConfig,
} from "@/lib/onboarding";
import { CHALLENGE_PHASES } from "@/lib/phases";
import { formatLong, todayKey } from "@/lib/dates";
import { ErrorState, Field, LoadingBlock } from "@/components/ui";

const STEPS = [
  "Welcome",
  "Challenge dates",
  "The four phases",
  "Daily systems",
  "Distractions & limits",
  "Review & start",
] as const;

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-center gap-3 rounded-xl px-3 py-2.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors min-h-[48px]"
    >
      <input
        id={id}
        type="checkbox"
        className="h-5 w-5 shrink-0 accent-[#5A6AE0]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium t-primary">{label}</span>
        {hint && <span className="block text-xs t-secondary">{hint}</span>}
      </span>
    </label>
  );
}

export function OnboardingFlow() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [startDate, setStartDate] = useState(todayKey());
  const [duration, setDuration] = useState("30");

  const [config, setConfig] = useState<OnboardingConfig | null>(null);
  const [habitEnabled, setHabitEnabled] = useState<Record<string, boolean>>({});
  const [newHabitName, setNewHabitName] = useState("");
  const [newHabits, setNewHabits] = useState<string[]>([]);
  const [ruleEnabled, setRuleEnabled] = useState<Record<string, boolean>>({});
  const [limitMinutes, setLimitMinutes] = useState<Record<string, number>>({});
  const [bookName, setBookName] = useState("");
  const [bookAuthor, setBookAuthor] = useState("");
  const [bookTotalPages, setBookTotalPages] = useState("");

  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await engine.whenReady();
        if (cancelled) return;
        const cfg = await getOnboardingConfig();
        if (cancelled) return;
        setConfig(cfg);
        setHabitEnabled(Object.fromEntries(cfg.habits.map((h) => [h.id, h.is_active])));
        setRuleEnabled(Object.fromEntries(cfg.rules.map((r) => [r.id, r.is_active])));
        setLimitMinutes(Object.fromEntries(cfg.limits.map((l) => [l.id, l.daily_limit_min])));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Could not load setup.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Move keyboard focus to the step heading so screen readers announce it.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step, loading]);

  const durationDays = Math.max(1, Math.min(365, Math.floor(Number(duration) || 30)));
  const isThirtyDay = durationDays === 30;

  function addCustomHabit() {
    const name = newHabitName.trim();
    if (!name) return;
    const exists =
      newHabits.some((h) => h.toLowerCase() === name.toLowerCase()) ||
      (config?.habits.some((h) => h.name.trim().toLowerCase() === name.toLowerCase()) ?? false);
    if (exists) return;
    setNewHabits((prev) => [...prev, name]);
    setNewHabitName("");
  }

  async function onStart() {
    setBusy(true);
    setSubmitError(null);
    try {
      await applyOnboardingConfig({
        habitEnabled,
        newHabits,
        ruleEnabled,
        limitMinutes,
        bookName,
        bookAuthor,
        bookTotalPages,
      });
      await ensureOnboardingChallenge({ startDate, durationDays });
      router.replace("/calendar");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not start your Winter Arc."
      );
      setBusy(false);
    }
  }

  if (loading) return <LoadingBlock label="Preparing your setup…" />;
  if (loadError) return <ErrorState message={loadError} />;

  const enabledHabits =
    config?.habits.filter((h) => habitEnabled[h.id] ?? h.is_active) ?? [];
  const enabledRules =
    config?.rules.filter((r) => ruleEnabled[r.id] ?? r.is_active) ?? [];

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8 md:py-12">
      {/* Step indicator: plain text, never a gamified progress bar. */}
      <p className="text-xs t-secondary mb-2" aria-live="polite">
        Step {step + 1} of {STEPS.length} · {STEPS[step]}
      </p>

      <div aria-live="polite">
        {step === 0 && (
          <section aria-labelledby="ob-welcome">
            <h1
              id="ob-welcome"
              ref={headingRef}
              tabIndex={-1}
              className="text-3xl font-semibold t-primary outline-none"
            >
              Winter Arc
            </h1>
            <p className="mt-2 text-lg t-secondary">
              30 days. One system. Show up every day.
            </p>
            <div className="surface card-pad mt-6">
              <p className="text-sm t-primary leading-relaxed">
                Winter Arc is a personal 30-day system for planning your days,
                training, studying, reading, and reviewing how you actually
                spent your time.
              </p>
              <p className="text-sm t-secondary leading-relaxed mt-3">
                The next few screens set up your challenge dates, daily
                systems, and distraction rules. Nothing here is a test —
                keep what serves you, skip the rest.
              </p>
            </div>
          </section>
        )}

        {step === 1 && (
          <section aria-labelledby="ob-dates">
            <h1
              id="ob-dates"
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold t-primary outline-none"
            >
              When does your Winter Arc begin?
            </h1>
            <div className="surface card-pad mt-6 flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Start date">
                  <input
                    className="input"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value || todayKey())}
                    required
                  />
                </Field>
                <Field label="Duration (days)">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={365}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    required
                  />
                </Field>
              </div>
              {!isThirtyDay && (
                <p className="text-sm t-secondary">
                  The four challenge phases below are designed for the standard
                  30-day challenge.
                </p>
              )}
            </div>
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby="ob-phases">
            <h1
              id="ob-phases"
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold t-primary outline-none"
            >
              The 30-day structure
            </h1>
            <p className="text-sm t-secondary mt-2">
              Four phases give the month a shape. They describe where you are —
              they never score you.
            </p>
            <ol className="mt-6 flex flex-col gap-3">
              {CHALLENGE_PHASES.map((p, i) => (
                <li key={p.key} className="surface card-pad">
                  <p className="text-sm font-semibold t-primary">
                    <span className="t-secondary font-normal mr-2">{i + 1}</span>
                    {p.name}
                    <span className="t-secondary font-normal ml-2">
                      Days {p.startDay}–{p.endDay}
                    </span>
                  </p>
                  <p className="text-sm t-secondary mt-1">{p.description}</p>
                </li>
              ))}
            </ol>
            <div className="surface card-pad mt-4">
              <p className="text-sm t-primary">
                Missing a day does not reset the challenge.
              </p>
              <p className="text-sm t-secondary mt-1">
                A missed day, a bad day, or a relapse is recorded honestly as
                data. Day 12 stays Day 12 — the phase never moves backwards.
              </p>
            </div>
          </section>
        )}

        {step === 3 && (
          <section aria-labelledby="ob-systems">
            <h1
              id="ob-systems"
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold t-primary outline-none"
            >
              Your daily systems
            </h1>
            <p className="text-sm t-secondary mt-2">
              Review what you will track each day. Keep the defaults, turn off
              what does not fit, add your own.
            </p>

            <h2 className="section-title mt-6 mb-2">Habits & routines</h2>
            <div className="surface card-pad flex flex-col gap-1">
              {config?.habits.map((h) => (
                <Toggle
                  key={h.id}
                  id={`ob-habit-${h.id}`}
                  label={h.name}
                  hint={
                    h.frequency === "weekly" && h.weekly_target
                      ? `${h.weekly_target}× per week`
                      : "Daily"
                  }
                  checked={habitEnabled[h.id] ?? h.is_active}
                  onChange={(checked) =>
                    setHabitEnabled((prev) => ({ ...prev, [h.id]: checked }))
                  }
                />
              ))}
              {newHabits.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                >
                  <span className="text-sm t-primary">{name}</span>
                  <span className="text-xs t-secondary">Daily · custom</span>
                  <button
                    type="button"
                    className="ml-auto text-xs t-secondary underline underline-offset-2 min-h-[44px] px-2"
                    onClick={() =>
                      setNewHabits((prev) => prev.filter((h) => h !== name))
                    }
                    aria-label={`Remove custom habit ${name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex gap-2 mt-2">
                <input
                  className="input flex-1"
                  value={newHabitName}
                  onChange={(e) => setNewHabitName(e.target.value)}
                  placeholder="Add a custom habit (optional)"
                  aria-label="New custom habit name"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomHabit();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary shrink-0"
                  onClick={addCustomHabit}
                  disabled={!newHabitName.trim()}
                >
                  Add
                </button>
              </div>
            </div>

            <h2 className="section-title mt-6 mb-2">Training</h2>
            <div className="surface card-pad">
              <p className="text-sm t-secondary leading-relaxed">
                Winter Arc includes the full Training system — workout
                templates, HSPU progression logging, and a weekly schedule.
                It comes with sensible defaults and stays editable under
                Training after setup.
              </p>
            </div>

            <h2 className="section-title mt-6 mb-2">Study</h2>
            <div className="surface card-pad">
              <p className="text-sm t-secondary leading-relaxed">
                Study supports subjects, topics, a timer, and manual entries
                with historical totals. You can set up subjects under Study
                whenever you are ready — nothing is required now.
              </p>
            </div>

            <h2 className="section-title mt-6 mb-2">Reading</h2>
            <div className="surface card-pad flex flex-col gap-3">
              <p className="text-sm t-secondary leading-relaxed">
                Track books and pages per day with per-book history. Add your
                first book now, or skip it — you can add books anytime under
                Books.
              </p>
              <Field label="Book title (optional)">
                <input
                  className="input"
                  value={bookName}
                  onChange={(e) => setBookName(e.target.value)}
                  placeholder="e.g. Deep Work"
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Author (optional)">
                  <input
                    className="input"
                    value={bookAuthor}
                    onChange={(e) => setBookAuthor(e.target.value)}
                    placeholder="e.g. Cal Newport"
                  />
                </Field>
                <Field label="Total pages (optional)">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={bookTotalPages}
                    onChange={(e) => setBookTotalPages(e.target.value)}
                    placeholder="e.g. 304"
                  />
                </Field>
              </div>
            </div>

            <h2 className="section-title mt-6 mb-2">Hifz</h2>
            <div className="surface card-pad">
              <p className="text-sm t-secondary leading-relaxed">
                Hifz tracking is built in. You can start at zero — record
                verses as you memorize them.
              </p>
            </div>
          </section>
        )}

        {step === 4 && (
          <section aria-labelledby="ob-distractions">
            <h1
              id="ob-distractions"
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold t-primary outline-none"
            >
              Distractions & limits
            </h1>
            <p className="text-sm t-secondary mt-2">
              Two kinds of rules. Abstain means zero — a slip is recorded as
              an incident, never as failure. Limits are a daily budget.
            </p>

            <h2 className="section-title mt-6 mb-2">Abstain completely</h2>
            <div className="surface card-pad flex flex-col gap-1">
              {config?.rules.map((r) => (
                <Toggle
                  key={r.id}
                  id={`ob-rule-${r.id}`}
                  label={r.name}
                  checked={ruleEnabled[r.id] ?? r.is_active}
                  onChange={(checked) =>
                    setRuleEnabled((prev) => ({ ...prev, [r.id]: checked }))
                  }
                />
              ))}
              {config && config.rules.length === 0 && (
                <p className="text-sm t-secondary px-3 py-2">
                  No abstinence rules configured.
                </p>
              )}
            </div>

            <h2 className="section-title mt-6 mb-2">Daily limits</h2>
            <div className="surface card-pad flex flex-col gap-4">
              {config?.limits.map((l) => (
                <Field key={l.id} label={`${l.name} — minutes per day`}>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1440}
                    value={limitMinutes[l.id] ?? l.daily_limit_min}
                    onChange={(e) =>
                      setLimitMinutes((prev) => ({
                        ...prev,
                        [l.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                      }))
                    }
                  />
                </Field>
              ))}
              {config && config.limits.length === 0 && (
                <p className="text-sm t-secondary">No usage limits configured.</p>
              )}
            </div>
          </section>
        )}

        {step === 5 && (
          <section aria-labelledby="ob-review">
            <h1
              id="ob-review"
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold t-primary outline-none"
            >
              Your Winter Arc
            </h1>
            <div className="surface card-pad mt-6 flex flex-col gap-4 text-sm">
              <div>
                <p className="label">Start</p>
                <p className="t-primary font-medium">{formatLong(startDate)}</p>
              </div>
              <div>
                <p className="label">Duration</p>
                <p className="t-primary font-medium">
                  {durationDays} days
                  {isThirtyDay ? " · the standard challenge" : ""}
                </p>
              </div>
              {isThirtyDay && (
                <div>
                  <p className="label">Phases</p>
                  <p className="t-primary font-medium">
                    Stabilize → Build → Discipline → Identity
                  </p>
                </div>
              )}
              <div>
                <p className="label">Habits enabled</p>
                <p className="t-primary">
                  {enabledHabits.length === 0
                    ? "None"
                    : enabledHabits.map((h) => h.name).join(", ")}
                  {newHabits.length > 0 && ` (+ ${newHabits.join(", ")})`}
                </p>
              </div>
              <div>
                <p className="label">Abstain</p>
                <p className="t-primary">
                  {enabledRules.length === 0
                    ? "None"
                    : enabledRules.map((r) => r.name).join(", ")}
                </p>
              </div>
              <div>
                <p className="label">Daily limits</p>
                <p className="t-primary">
                  {config?.limits
                    .map((l) => `${l.name}: ${limitMinutes[l.id] ?? l.daily_limit_min} min`)
                    .join(" · ") || "None"}
                </p>
              </div>
              {bookName.trim() && (
                <div>
                  <p className="label">First book</p>
                  <p className="t-primary font-medium">
                    {bookName.trim()}
                    {bookAuthor.trim() ? ` — ${bookAuthor.trim()}` : ""}
                  </p>
                </div>
              )}
            </div>
            {submitError && (
              <p className="text-sm text-red-500 dark:text-red-400 mt-4" role="alert">
                {submitError}
              </p>
            )}
          </section>
        )}
      </div>

      {/* Navigation */}
      <div className="mt-8 flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn-secondary min-h-[48px]"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0 || busy}
        >
          Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="btn-primary min-h-[48px] px-8"
            onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
            disabled={busy}
          >
            Continue
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary min-h-[48px] px-8"
            onClick={onStart}
            disabled={busy}
          >
            {busy ? "Starting…" : "Start Winter Arc"}
          </button>
        )}
      </div>
    </div>
  );
}
