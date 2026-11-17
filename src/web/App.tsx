import { AdminPortal } from "./AdminPortal";
import { AgentPortal } from "./AgentPortal";
import { NotifyProvider } from "./notify";
import { ThemeProvider } from "./theme";
import { UserApp } from "./UserApp";

/* Three separate places, each with its own sign-in:
     /        normal users: Home, submit a ticket, my queue, live board   (name + company email)
     /agent   agents: their queue, triage and every ticket                 (email + password)
     /admin   admins: dashboard, full live board, staff accounts           (email + password)
   Nothing in the normal app links to /agent or /admin. */
export function App() {
  const path = location.pathname.replace(/\/+$/, "").toLowerCase();
  const screen = path === "/admin" ? <AdminPortal /> : path === "/agent" ? <AgentPortal /> : <UserApp />;
  return (
    <ThemeProvider>
      <NotifyProvider>{screen}</NotifyProvider>
    </ThemeProvider>
  );
}
