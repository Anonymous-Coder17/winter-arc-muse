"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { engine } from "@/lib/sync/engine";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { LoadingBlock } from "@/components/ui";

// First-run route, outside the (app) group so the onboarding gate in
// AppShell never redirects it back to itself.
//
// - Not signed in: middleware sends the user to /login before this renders.
// - Already has a challenge (returning or pre-V4.7 user): straight to /calendar.
// - Otherwise: the onboarding flow.
export default function OnboardingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    engine.start();
    (async () => {
      try {
        await engine.whenReady();
        if (cancelled) return;
        if (await hasCompletedOnboarding()) {
          router.replace("/calendar");
          return;
        }
        setReady(true);
      } catch {
        // If the readiness check itself fails, show the flow anyway —
        // the flow surfaces its own errors and never fabricates state.
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="min-h-dvh app-bg">
      {ready ? (
        <OnboardingFlow />
      ) : (
        <div className="mx-auto w-full max-w-xl px-4 py-12">
          <LoadingBlock label="Checking your setup…" />
        </div>
      )}
    </div>
  );
}
