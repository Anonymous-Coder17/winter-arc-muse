"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      if (data.session) {
        router.replace("/calendar");
        router.refresh();
      } else {
        setSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh app-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <p className="text-2xl font-semibold t-primary tracking-tight">
            ❄ Winter Arc
          </p>
          <p className="text-sm t-secondary mt-2">
            Begin your 30-day transformation.
          </p>
        </div>
        {sent ? (
          <div className="surface card-pad text-center">
            <p className="font-medium t-primary">Check your inbox</p>
            <p className="text-sm t-secondary mt-2">
              We sent a confirmation link to <span className="t-primary">{email}</span>.
              Open it to finish creating your account.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="surface card-pad flex flex-col gap-4">
            <h1 className="text-lg font-semibold t-primary">Create account</h1>
            <Field label="Email">
              <input
                className="input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password">
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 6 characters"
              />
            </Field>
            {error && (
              <p className="text-sm text-red-500 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <button className="btn-primary w-full" disabled={busy} type="submit">
              {busy ? "Creating…" : "Create account"}
            </button>
            <p className="text-sm t-secondary text-center">
              Already have an account?{" "}
              <Link href="/login" className="text-[#5A6AE0] dark:text-[#AAB6FF] font-medium">
                Sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
