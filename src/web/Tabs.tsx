import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
}

/**
 * Tabs with a single indicator that slides to the active tab (instead of each tab snapping).
 *  - variant "underline": a thin brand-green bar under the active tab (site navigation)
 *  - variant "pill": a dark pill that glides behind the active tab (panel tabs)
 * The indicator is measured from the real buttons, so it follows font loading and window resizes.
 */
export function SlidingTabs<T extends string>({
  tabs,
  value,
  onChange,
  variant = "underline",
  mode = "tabs",
  label,
  className = "",
}: {
  tabs: TabDef<T>[];
  value: T | undefined;
  onChange: (id: T) => void;
  variant?: "underline" | "pill";
  mode?: "tabs" | "nav";
  label: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [pos, setPos] = useState({ left: 0, width: 0, height: 0, top: 0, visible: false });
  const [settled, setSettled] = useState(false); // no sliding on the very first paint

  const measure = () => {
    const el = value ? refs.current.get(value) : undefined;
    if (!el) return setPos((p) => (p.visible ? { ...p, visible: false } : p));
    setPos({ left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight, top: el.offsetTop, visible: true });
  };

  useLayoutEffect(measure, [value, tabs.map((t) => t.id).join("|")]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSettled(true));
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    void document.fonts?.ready.then(measure);
    return () => { cancelAnimationFrame(id); ro.disconnect(); };
  }, [value]);

  // Keep the active tab in view when the row scrolls sideways on a phone.
  useEffect(() => {
    if (!value) return;
    const el = refs.current.get(value);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: settled ? "smooth" : "auto" });
  }, [value, settled]);

  const pill = variant === "pill";
  const Box = mode === "nav" ? "nav" : "div"; // site navigation is a real <nav> landmark
  return (
    <Box
      ref={box as React.RefObject<HTMLDivElement>}
      role={mode === "tabs" ? "tablist" : undefined}
      aria-label={label}
      className={`relative ${pill ? "inline-flex flex-wrap gap-1" : "flex gap-1 overflow-x-auto"} ${className}`}
    >
      <span
        aria-hidden
        className={`tab-indicator pointer-events-none absolute ${pill ? "rounded-full bg-ink dark:bg-fg" : "bottom-0 h-[3px] rounded-full bg-brand-green"}`}
        style={{
          left: pos.left,
          width: pos.width,
          ...(pill ? { top: pos.top, height: pos.height } : {}),
          opacity: pos.visible ? 1 : 0,
          transition: settled ? undefined : "none",
        }}
      />
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { if (el) refs.current.set(t.id, el); else refs.current.delete(t.id); }}
            role={mode === "tabs" ? "tab" : undefined}
            aria-selected={mode === "tabs" ? on : undefined}
            aria-current={mode === "nav" && on ? "page" : undefined}
            onClick={() => onChange(t.id)}
            className={`relative z-10 whitespace-nowrap text-sm font-semibold transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${
              pill
                ? `rounded-full px-4 py-2 ${on ? "text-white dark:text-ink" : "text-neutral-700 hover:text-fg"}`
                : `px-3 py-2.5 ${on ? "text-fg" : "text-neutral-500 hover:text-fg"}`
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </Box>
  );
}
