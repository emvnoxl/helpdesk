import { useState } from "react";
import { Dashboard } from "./Dashboard";
import { PortalFrame } from "./PortalFrame";
import { PasswordChangeScreen, StaffLogin } from "./StaffLogin";
import { StaffConsole } from "./StaffConsole";
import { TicketView } from "./TicketView";
import { btnGhost } from "./ui";
import { useStaff } from "./useStaff";

/* /admin: the admins' own place, with its own sign-in. It also holds the full Live board, which exists nowhere else.
   The header's "Live board" button opens it in its own browser tab (/admin#board), so the admin panel stays exactly as it was.
   /admin#tv opens the Live board straight away in office-display mode (long session, no Back button). */
const BOARD_TAB = "fortress-live-board"; // one named tab: pressing the button again brings the same board forward

export function AdminPortal() {
  const display = location.hash === "#tv";
  const boardTab = location.hash === "#board";
  const { state, refresh, signOut } = useStaff();
  const [view, setView] = useState<"console" | "board">(display || boardTab ? "board" : "console");
  const [ticket, setTicket] = useState<number | null>(null);

  if (state.status === "loading") return <div className="min-h-screen bg-ink" />;
  if (state.status === "out" || state.user.role !== "admin") return <StaffLogin portal="admin" display={display} onDone={() => void refresh()} />;
  const user = state.user;
  if (user.must_change_password) return <PasswordChangeScreen name={user.name} onDone={() => void refresh()} />;

  // The full Live board: Fullscreen and the office-display mode live here only.
  if (view === "board") {
    return (
      <div className="page-in">
        <Dashboard
          kiosk={display}
          canFullscreen
          backLabel={boardTab ? "Close tab" : "Back"}
          onBack={() => {
            if (!boardTab) return setView("console");
            window.close(); // works because the admin panel opened this tab; otherwise fall back to the panel itself
            window.setTimeout(() => location.assign("/admin"), 200);
          }}
          onExpired={() => void refresh()}
        />
      </div>
    );
  }

  return (
    <PortalFrame
      portal="admin"
      user={user}
      onOpenTicket={setTicket}
      viewing={ticket}
      onChanged={() => void refresh()}
      onSignOut={() => void signOut()}
      headerExtra={
        <button
          className="flex items-center gap-2 rounded-lg bg-brand-green px-3.5 py-2 font-bold text-ink hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          title="Opens the live board in a new tab"
          onClick={() => { const w = window.open("/admin#board", BOARD_TAB); w ? w.focus() : setView("board"); }} // popups blocked: show it here instead
        >
          <span className="now-dot" style={{ background: "#0b0b0b", width: 7, height: 7 }} />Live board
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
        </button>
      }
    >
      {ticket !== null ? (
        <div className="page-in" key={`t${ticket}`}>
          <button className={btnGhost + " mb-3"} onClick={() => setTicket(null)}>← Back to the dashboard</button>
          <TicketView id={ticket} role="admin" base="/staff/tickets" />
        </div>
      ) : null}
      {/* Kept mounted (just hidden) while a ticket is open, so tabs and scroll are where you left them. */}
      <div className={ticket !== null ? "hidden" : ""}>
        <StaffConsole role="admin" meId={user.id} open={setTicket} onExpired={() => void refresh()} />
      </div>
    </PortalFrame>
  );
}
