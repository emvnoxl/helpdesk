import { useState } from "react";
import { PortalFrame } from "./PortalFrame";
import { PasswordChangeScreen, StaffLogin } from "./StaffLogin";
import { StaffConsole } from "./StaffConsole";
import { TicketView } from "./TicketView";
import { btnGhost } from "./ui";
import { useStaff } from "./useStaff";

/** /agent: the agents' own place, with its own sign-in. Their queue, triage and every ticket. */
export function AgentPortal() {
  const { state, refresh, signOut } = useStaff();
  const [ticket, setTicket] = useState<number | null>(null);

  if (state.status === "loading") return <div className="min-h-screen bg-ink" />;
  // Signed out, or signed in as someone else's kind of account (e.g. an admin): show this portal's own login.
  if (state.status === "out" || state.user.role !== "agent") return <StaffLogin portal="agent" onDone={() => void refresh()} />;
  const user = state.user;
  if (user.must_change_password) return <PasswordChangeScreen name={user.name} onDone={() => void refresh()} />;

  return (
    <PortalFrame portal="agent" user={user} onOpenTicket={setTicket} viewing={ticket} onChanged={() => void refresh()} onSignOut={() => void signOut()}>
      {ticket !== null ? (
        <div className="page-in" key={`t${ticket}`}>
          <button className={btnGhost + " mb-3"} onClick={() => setTicket(null)}>← Back</button>
          <TicketView id={ticket} role="agent" base="/staff/tickets" />
        </div>
      ) : null}
      {/* Kept mounted (just hidden) while a ticket is open, so the tab and scroll are where you left them. */}
      <div className={ticket !== null ? "hidden" : ""}>
        <StaffConsole role="agent" meId={user.id} open={setTicket} onExpired={() => void refresh()} />
      </div>
    </PortalFrame>
  );
}
