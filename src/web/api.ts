/** Error from the API. `data` is the parsed JSON body (e.g. attempts_left, locked_until). */
export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any = {}) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch("/api" + path, {
    ...init,
    headers: init?.json ? { "Content-Type": "application/json" } : undefined,
    body: init?.json ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as any).error || `HTTP ${res.status}`, res.status, data);
  }
  return res.json();
}

export const fmt = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "—");
