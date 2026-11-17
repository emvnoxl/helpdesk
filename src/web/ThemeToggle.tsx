import { useTheme } from "./theme";

const Sun = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
);

/**
 * Light / dark switch. Shows the mode you'd switch TO.
 *  - default : on a normal page
 *  - onDark  : on an always-dark bar (portal header, sign-in screens)
 *  - board   : in the Live board header, which uses the board's own colour variables
 */
export function ThemeToggle({ variant = "default", label = false, className = "" }: { variant?: "default" | "onDark" | "board"; label?: boolean; className?: string }) {
  const { mode, toggle } = useTheme();
  const next = mode === "dark" ? "light" : "dark";
  const look =
    variant === "onDark"
      ? "border-white/25 text-white/85 hover:bg-white/10"
      : variant === "board"
        ? "hover:opacity-80"
        : "border-stone-200 text-neutral-600 hover:bg-stone-100 hover:text-fg";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      style={variant === "board" ? { borderColor: "var(--v-border)", color: "var(--v-ink)" } : undefined}
      className={`flex items-center gap-2 rounded-lg border p-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${look} ${className}`}
    >
      <span key={mode} className="icon-in flex">{mode === "dark" ? <Sun /> : <Moon />}</span>
      {/* Fixed width: "Light" and "Dark" differ, and a width change would shove the clock next to it sideways. */}
      {label && <span className="hidden w-10 text-left lg:inline-block">{mode === "dark" ? "Light" : "Dark"}</span>}
    </button>
  );
}
