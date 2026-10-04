"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { engine } from "@/lib/sync/engine";
import { ConnectivityBadge } from "@/components/sync/status";

const NAV = [
  { href: "/calendar", label: "Calendar", icon: "▦" },
  { href: "/habits", label: "Habits", icon: "✓" },
  { href: "/training", label: "Training", icon: "◉" },
  { href: "/study", label: "Study", icon: "✎" },
  { href: "/books", label: "Books", icon: "▤" },
  { href: "/progress", label: "Progress", icon: "◈" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

function NavLink({
  href,
  label,
  icon,
  vertical,
}: {
  href: string;
  label: string;
  icon: string;
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
        vertical ? "flex-col gap-1 px-1 py-2 min-w-[48px]" : "px-4 py-3",
        active
          ? "bg-[#5A6AE0]/15 text-[#3D4AC4] dark:text-[#C3CCFF]"
          : "t-secondary hover:t-primary hover:bg-black/5 dark:hover:bg-white/5",
      ].join(" ")}
    >
      <span className="text-lg leading-none" aria-hidden>
        {icon}
      </span>
      <span className={vertical ? "text-[11px]" : ""}>{label}</span>
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
  );
}
