/* Things the address bar carries into the app once, which are then taken out of it so a refresh does not repeat them:
     ?t=42            a link in an email opens straight on ticket 42 (https://helpdesk.example/?t=42, staff: /agent?t=42 or /admin?t=42).
                      If the person is not signed in yet, the sign-in screen comes first and the ticket opens right after.
     ?login_error=x   coming back from Microsoft sign-in with a problem (shown on the sign-in screen)
     ?welcome=1       coming back from Microsoft sign-in with a brand-new account (starts the first-time setup) */
const takeParam = (name: string): string | null => {
  try {
    const p = new URLSearchParams(location.search);
    const v = p.get(name);
    if (v === null) return null;
    p.delete(name);
    const rest = p.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    return v;
  } catch {
    return null;
  }
};

export const deepLinkTicket: number | null = (() => {
  const n = Number(takeParam("t"));
  return Number.isInteger(n) && n > 0 ? n : null;
})();
export const loginError: string | null = takeParam("login_error");
export const welcomeFlag: boolean = takeParam("welcome") === "1";
