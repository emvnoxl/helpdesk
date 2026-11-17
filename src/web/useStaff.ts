import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type StaffUser = {
  id: number;
  name: string;
  email: string;
  role: "agent" | "admin";
  must_change_password: boolean;
  expires_at: number | null;
};

type State = { status: "loading" } | { status: "out" } | { status: "in"; user: StaffUser };

/** The signed-in agent/admin, from the server's session cookie. */
export function useStaff() {
  const [state, setState] = useState<State>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      setState({ status: "in", user: await api<StaffUser>("/staff/me") });
    } catch {
      setState({ status: "out" });
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  // Notice when the session times out while the page is open.
  useEffect(() => {
    if (state.status !== "in" || !state.user.expires_at) return;
    const exp = state.user.expires_at;
    const t = setInterval(() => { if (Date.now() / 1000 > exp) void refresh(); }, 15_000);
    return () => clearInterval(t);
  }, [state, refresh]);

  const signOut = useCallback(async () => {
    await api("/staff/logout", { method: "POST", json: {} }).catch(() => {});
    setState({ status: "out" });
  }, []);

  return { state, refresh, signOut };
}

export const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
