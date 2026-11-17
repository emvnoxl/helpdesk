/** CSV for spreadsheets. Cells that start with = + - @ are prefixed with an apostrophe so Excel can't run them as formulas
    (ticket titles and names are typed by anyone). Output starts with a BOM so Excel opens accents correctly. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** ISO-ish UTC timestamp for a unix-seconds value (blank when missing). */
export const isoTime = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) : "");
