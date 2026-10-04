"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Appearance } from "@/lib/types";

const STORAGE_KEY = "winter-arc-appearance";

interface ThemeCtx {
  appearance: Appearance;
  setAppearance: (a: Appearance) => void;
  /** resolved effective theme */
  resolved: "dark" | "light";
}

const Ctx = createContext<ThemeCtx>({
  appearance: "dark",
  setAppearance: () => {},
  resolved: "dark",
});

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}

function resolveAppearance(a: Appearance): "dark" | "light" {
  if (a !== "system") return a;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>("dark");
  const [resolved, setResolved] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      setAppearanceState(stored);
    }
  }, []);

  useEffect(() => {
    const r = resolveAppearance(appearance);
    setResolved(r);
    const root = document.documentElement;
    root.classList.toggle("dark", r === "dark");
    root.style.colorScheme = r;

    if (appearance === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const onChange = () => {
        const next = mq.matches ? "light" : "dark";
        setResolved(next);
        root.classList.toggle("dark", next === "dark");
        root.style.colorScheme = next;
      };
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
  }, [appearance]);

  const setAppearance = useCallback((a: Appearance) => {
    setAppearanceState(a);
    window.localStorage.setItem(STORAGE_KEY, a);
  }, []);

  return (
    <Ctx.Provider value={{ appearance, setAppearance, resolved }}>
      {children}
    </Ctx.Provider>
  );
}
