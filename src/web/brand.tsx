import { useId } from "react";
import { useTheme } from "./theme";

/** Helpdesk logo: the Fortress Oil & Gas mark with the wordmark beside it, as SVG so it stays sharp at any size.
 *  With no `theme` it follows the app's light/dark mode (white wordmark on dark, navy on light).
 *  Pass `theme` for a logo that sits on an always-dark bar (e.g. the portal header). */
export function Logo({ theme, className = "h-10" }: { theme?: "light" | "dark"; className?: string }) {
  const { mode } = useTheme();
  const t = theme ?? mode;
  return (
    <img
      src={t === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
      alt="Fortress Oil & Gas Helpdesk"
      width={680}
      height={217}
      className={`${className} w-auto select-none`}
      draggable={false}
    />
  );
}

const BUBBLE = "M35 6h14a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H40l-9 7v-7.6C28 36.2 26 33 26 29V15a9 9 0 0 1 9-9z";

/** The mark on its own (two rounded squares behind a red speech bubble with an oil drop), for large decorative use.
 *  `onDark` uses the slightly brighter green and red that read better on a dark background. Every instance gets its own mask id. */
export function BrandMark({ className = "", onDark = false }: { className?: string; onDark?: boolean }) {
  const id = "bm" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg viewBox="-2 -2 120.08 104" className={className} aria-hidden>
      <g transform="translate(-3.518 -9.045) scale(2.01005)">
        <mask id={id} maskUnits="userSpaceOnUse" x="-10" y="-10" width="84" height="84">
          <rect x="-10" y="-10" width="84" height="84" fill="#fff" />
          <path d={BUBBLE} fill="#000" stroke="#000" strokeWidth="3" strokeLinejoin="round" />
        </mask>
        <g mask={`url(#${id})`} fill="none" strokeWidth="4.5">
          <rect x="4" y="24" width="28" height="28" rx="8" stroke={onDark ? "#00B862" : "#00A859"} />
          <rect x="14" y="15" width="28" height="28" rx="8" stroke="#FFB400" />
        </g>
        <path d={BUBBLE} fill={onDark ? "#F23C43" : "#EE3239"} />
        <path d="M42 14.5c-2.6 3.1-4.6 5.8-4.6 8.3a4.6 4.6 0 0 0 9.2 0c0-2.5-2-5.2-4.6-8.3z" fill="#fff" />
      </g>
    </svg>
  );
}
