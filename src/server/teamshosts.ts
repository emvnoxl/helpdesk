/** Microsoft's webhook hosts only (Workflows / Power Automate, and the older Office connectors). The helpdesk server fetches this address, so
    anything else is refused: nobody can aim it at an internal service. */
const HOSTS = [/\.logic\.azure\.com$/i, /\.webhook\.office\.com$/i, /\.api\.powerplatform\.com$/i, /\.powerplatform\.com$/i, /^outlook\.office\.com$/i];

export function webhookOk(u: string): boolean {
  if (process.env.TEAMS_ALLOW_ANY === "1") { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } } // tests only
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password && HOSTS.some((h) => h.test(x.hostname)) && (x.port === "" || x.port === "443");
  } catch { return false; }
}
