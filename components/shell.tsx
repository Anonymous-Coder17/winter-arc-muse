"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { engine } from "@/lib/sync/engine";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { ConnectivityBadge } from "@/components/sync/status";
import { LoadingBlock } from "@/components/ui";

/** Inline SVG nav icon: 24px viewBox, 1.5px stroke, currentColor, no deps. */
function NavIcon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-5 w-5 shrink-0"}
    >
      {children}
    </svg>
  );
}

const NAV: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: "/calendar",
    label: "Calendar",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18" />
        <path d="M8 3v4M16 3v4" />
      </>
    ),
  },
  {
    href: "/habits",
    label: "Habits",
    icon: <path d="M4 12.5l5 5L20 6.5" />,
  },
  {
    href: "/training",
    label: "Training",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3.5" />
      </>
    ),
  },
  {
    href: "/study",
    label: "Study",
    icon: (
      <>
        <path d="M4 20l1-4L16.5 4.5a2.12 2.12 0 013 3L8 19l-4 1z" />
        <path d="M14.5 6.5l3 3" />
      </>
    ),
  },
  {
    href: "/books",
    label: "Books",
    icon: (
      <>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      </>
    ),
  },
  {
    href: "/progress",
    label: "Progress",
    icon: (
      <>
        <path d="M23 6l-9.5 9.5-5-5L1 18" />
        <path d="M17 6h6v6" />
      </>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </>
    ),
  },
];

function NavLink({
  href,
  label,
  icon,
  vertical,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  vertical?: boolean;
}) {
  const pathname = usePathname();
  const active =
    pathname === href || (href !== "/calendar" && pathname.startsWith(href));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex items-center gap-3 rounded-xl text-sm font-medium transition-colors touch-manipulation",
        // Mobile: fluid widths (flex-1, no min-width) so 7 items always fit 320px viewports.
        vertical ? "flex-col gap-1 px-1 py-2 flex-1 min-w-0" : "px-4 py-3",
        active
          ? "bg-[#5A6AE0]/15 text-[#3D4AC4] dark:text-[#C3CCFF]"
          : "t-secondary hover:t-primary hover:bg-black/5 dark:hover:bg-white/5",
      ].join(" ")}
    >
      <NavIcon className={vertical ? "h-[18px] w-[18px] shrink-0" : "h-5 w-5 shrink-0"}>
        {icon}
      </NavIcon>
      <span className={vertical ? "text-[10px] whitespace-nowrap" : ""}>{label}</span>
    </Link>
  );
}

export function AppShell({
  children,
}: {
  children: ReactNode;
}) {
  useEffect(() => {
    engine.start();
  }, []);
  return (
    <OnboardingGate>
      <div className="min-h-dvh app-bg">
      {/* Desktop: left navigation */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 flex-col border-r hairline surface-flat px-4 py-6">
        <Link href="/calendar" className="px-2 mb-8">
          <p className="text-lg font-semibold t-primary tracking-tight">
            ❄ Winter Arc
          </p>
          <p className="text-xs t-secondary mt-0.5">30-Day Transformation</p>
        </Link>
        <nav className="flex flex-col gap-1" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink key={n.href} {...n} />
          ))}
        </nav>
        <div className="mt-auto px-2">
          <ConnectivityBadge />
        </div>
      </aside>

      {/* Mobile: compact top header */}
      <header className="md:hidden sticky top-0 z-40 surface-flat border-b hairline-b px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <Link href="/calendar" className="flex items-baseline gap-2">
            <p className="text-base font-semibold t-primary tracking-tight">
              ❄ Winter Arc
            </p>
            <p className="text-[11px] t-secondary">30-Day Transformation</p>
          </Link>
          <ConnectivityBadge />
        </div>
      </header>

      {/* Content */}
      <main className="md:pl-60 pb-28 md:pb-12">
        <div className="mx-auto max-w-3xl px-4 pt-5 sm:pt-8">{children}</div>
      </main>

      {/* Mobile: bottom navigation */}
      <nav
        aria-label="Primary"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 surface-flat border-t hairline-t px-2 pt-1"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex justify-between">
          {NAV.map((n) => (
            <NavLink key={n.href} {...n} vertical />
          ))}
        </div>
      </nav>
    </div>
    </OnboardingGate>
  );
}

/**
 * V4.7 — first-run gate. A user with no challenge has not completed
 * onboarding and is sent to /onboarding; everyone else (including
 * pre-V4.7 users with an existing challenge) enters the app normally.
 *
 * Runs after engine.whenReady() so the check sees post-initial-pull state:
 * a returning user on a fresh device already has their challenges locally
 * and is never misrouted into onboarding. While checking, renders a plain
 * loading state — never the app behind a redirect.
 */
function OnboardingGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await engine.whenReady();
        if (cancelled) return;
        if (!(await hasCompletedOnboarding())) {
          router.replace("/onboarding");
          return;
        }
      } catch {
        // On check failure, fail open into the app: the user keeps their
        // data and can still set up via Settings. Never trap the user.
      }
      if (!cancelled) setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  if (!checked) {
    return (
      <div className="min-h-dvh app-bg">
        <div className="mx-auto max-w-3xl px-4 pt-12">
          <LoadingBlock label="Loading…" />
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
