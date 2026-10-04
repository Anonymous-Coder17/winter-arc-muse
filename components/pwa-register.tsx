"use client";

import { useEffect } from "react";

// Registers the V4.1 service worker foundation. Production-only: registering
// during development would serve stale bundles while iterating.
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // The service worker is progressive enhancement; the app works
        // fully without it.
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
