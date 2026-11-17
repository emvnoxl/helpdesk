/* One small icon per ticket category (matched by name, so a category added later falls back to "other").
   Shared by the new-ticket form and the Help page. */
export const CATEGORY_ICONS: Record<string, string> = {
  Network: "M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a14 14 0 0 1 20 0",
  Hardware: "M4 6h16v10H4zM2 20h20M9 16v4M15 16v4",
  "Microsoft 365": "M4 7l8 5 8-5M4 7v10h16V7M4 7l8-4 8 4",
  "Accounts & Access": "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0",
  Printing: "M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z",
  "AV / Production": "M3 6h14v12H3zM17 10l4-2v8l-4-2",
  "CCTV / Security": "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3ZM9 12l2 2 4-4",
  Software: "M3 5h18v14H3zM3 9h18M7 7h.01M10 7h.01",
  Other: "M5 12h.01M12 12h.01M19 12h.01",
  // Help-page filters that aren't categories
  All: "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v6H4zM13 14h7v6h-7z",
  Videos: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM10 8.5l6 3.5-6 3.5z",
};

export const CategoryIcon = ({ name, size = 22 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={CATEGORY_ICONS[name] ?? CATEGORY_ICONS.Other} />
  </svg>
);
