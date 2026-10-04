"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { useTheme } from "@/components/theme";
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  SegControl,
} from "@/components/ui";
import type { Appearance, Challenge, Profile } from "@/lib/types";

function ChallengeForm({
  initial,
  onSaved,
}: {
  initial?: Challenge;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "30-Day Transformation");
  const [subtitle, setSubtitle] = useState(initial?.subtitle ?? "");
  const [startDate, setStartDate] = useState(
    initial?.start_date ?? new Date().toISOString().slice(0, 10)
  );
  const [duration, setDuration] = useState(
    initial ? String(initial.duration_days) : "30"
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !Number(duration)) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      if (initial) {
        const { error } = await supabase
          .from("challenges")
          .update({
            title: title.trim(),
            subtitle: subtitle.trim() || null,
            start_date: startDate,
            duration_days: Number(duration),
          })
          .eq("id", initial.id);
        if (error) throw error;
      } else {
        // One active challenge at a time: deactivate any existing ones.
        await supabase
          .from("challenges")
          .update({ is_active: false })
          .eq("owner", user.id)
          .eq("is_active", true);
        const { error } = await supabase.from("challenges").insert({
          owner: user.id,
          title: title.trim(),
          subtitle: subtitle.trim() || null,
          start_date: startDate,
          duration_days: Number(duration),
          is_active: true,
        });
        if (error) throw error;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save challenge.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Title">
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </Field>
      <Field label="Subtitle (optional)">
        <input
          className="input"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          placeholder="Build the person you want to become."
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date">
          <input
            className="input"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
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
      {error && (
        <p className="text-sm text-red-500 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <button className="btn-primary self-end" disabled={busy}>
        {busy ? "Saving…" : initial ? "Save changes" : "Start challenge"}
      </button>
    </form>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { appearance, setAppearance } = useTheme();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [editingChallenge, setEditingChallenge] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) setError("Not signed in.");
          return;
        }
        setEmail(user.email ?? "");
        const [p, c] = await Promise.all([
          supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
          supabase
            .from("challenges")
            .select("*")
            .eq("owner", user.id)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        if (p.error) throw p.error;
        if (c.error) throw c.error;
        setProfile(p.data ?? null);
        setDisplayName(p.data?.display_name ?? "");
        setChallenge(c.data ?? null);
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
  }, [nonce]);

  async function saveProfile() {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, display_name: displayName.trim() || null });
    if (!error) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  async function logout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">Appearance, profile, challenge, and data.</p>
      </div>

      {/* appearance */}
      <section className="surface card-pad" aria-label="Appearance">
        <h2 className="section-title mb-3">Appearance</h2>
        <SegControl<Appearance>
          ariaLabel="Appearance"
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System" },
          ]}
        />
        <p className="text-xs t-faint mt-2">Dark is the default.</p>
      </section>

      {/* profile */}
      <section className="surface card-pad" aria-label="Profile">
        <h2 className="section-title mb-3">Profile</h2>
        <div className="flex flex-col gap-3">
          <Field label="Email">
            <input className="input opacity-60" value={email} disabled readOnly />
          </Field>
          <Field label="Display name">
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="What should we call you?"
            />
          </Field>
          <div className="flex items-center gap-3">
            <button className="btn-secondary" onClick={saveProfile}>
              Save profile
            </button>
            {saved && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Saved.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* challenge */}
      <section className="surface card-pad" aria-label="Challenge">
        <h2 className="section-title mb-3">Challenge</h2>
        {challenge && !editingChallenge ? (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium t-primary">{challenge.title}</p>
              <p className="text-xs t-faint">
                {challenge.start_date} · {challenge.duration_days} days
              </p>
            </div>
            <div>
              <button
                className="btn-secondary"
                onClick={() => setEditingChallenge(true)}
              >
                Edit challenge
              </button>
            </div>
          </div>
        ) : !challenge && !editingChallenge ? (
          <EmptyState
            title="No active challenge"
            body="Your 30-day window starts whenever you say."
            action={
              <button
                className="btn-primary"
                onClick={() => setEditingChallenge(true)}
              >
                Create challenge
              </button>
            }
          />
        ) : (
          <>
            {challenge && (
              <button
                className="btn-ghost mb-3"
                onClick={() => setEditingChallenge(false)}
              >
                ← Back
              </button>
            )}
            <ChallengeForm
              initial={challenge ?? undefined}
              onSaved={() => {
                setEditingChallenge(false);
                setNonce((n) => n + 1);
              }}
            />
          </>
        )}
      </section>

      {/* data */}
      <section className="surface card-pad" aria-label="Data">
        <h2 className="section-title mb-3">Data</h2>
        <p className="text-sm t-secondary mb-4">
          Your data lives in your own Supabase project, protected by row-level
          security. Only you can read or change your rows.
        </p>
        <button className="btn-danger" onClick={logout}>
          Sign out
        </button>
      </section>
    </div>
  );
}
