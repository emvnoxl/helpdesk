import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/* App-wide light / dark mode.
   - The choice is remembered in this browser; with no choice yet it follows the device setting (the office display
     at /admin#tv starts dark).
   - It is applied as a class on <html> (theme-light / theme-dark). Every colour in the app comes from CSS variables
     keyed off that class, so one switch re-themes everything.
   - Switching cross-fades the colours (see html.theme-fade in index.css) instead of snapping. */

export type Mode = "light" | "dark";
const KEY = "fortress-helpdesk:theme";

const stored = (): Mode | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
};
const system = (): Mode => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const isDisplay = () => location.pathname.replace(/\/+$/, "").toLowerCase() === "/admin" && location.hash === "#tv";
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let fadeTimer: number | undefined;
function apply(mode: Mode, animate: boolean) {
  const root = document.documentElement;
  if (animate && !reducedMotion()) {
    root.classList.add("theme-fade");
    window.clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => root.classList.remove("theme-fade"), 480);
  }
  root.classList.toggle("theme-dark", mode === "dark");
  root.classList.toggle("theme-light", mode === "light");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", mode === "dark" ? "#0e0e0d" : "#ffffff");
}

interface ThemeCtx {
  mode: Mode;
  toggle: () => void;
  set: (m: Mode) => void;
}
const Ctx = createContext<ThemeCtx>({ mode: "light", toggle() {}, set() {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(() => stored() ?? (isDisplay() ? "dark" : system()));

  useEffect(() => apply(mode, false), []); // theme-init.js already did this; keeps the two in step

  const set = useCallback((next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* the choice just won't be remembered */
    }
    apply(next, true);
  }, []);
  const toggle = useCallback(() => set(document.documentElement.classList.contains("theme-dark") ? "light" : "dark"), [set]);

  // Until the person makes a choice, follow the device's own light/dark setting live.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => {
      if (stored() === null && !isDisplay()) {
        const next = mq.matches ? "dark" : "light";
        setMode(next);
        apply(next, true);
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const value = useMemo(() => ({ mode, toggle, set }), [mode, toggle, set]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
