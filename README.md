# Fortress Oil & Gas Helpdesk

An internal ticketing system for Fortress Ghana. One small Docker container, one SQLite database in a volume. No cloud services needed.

| Who | Where | Signs in with | Sees |
|---|---|---|---|
| Normal users | `/` | name + company email + a personal 6-digit PIN | Home, submit a ticket, **My queue**, a simple **Live board** showing what IT is working on and where *they* sit, Help articles |
| Agents | `/agent` | email + password (made by an admin) | their queue, tickets needing triage, every ticket |
| Admins | `/admin` | email + password | all of the above plus the analytics dashboard, the full **Live board** (Fullscreen / office display), and staff accounts |

Nothing in the normal app links to `/agent` or `/admin`.

## Run it with Docker

```bash
cp .env.example .env          # then edit it: at least COMPANY_EMAIL_DOMAIN and ADMIN_EMAIL
docker compose up -d --build
```

Open <http://localhost:3000>. The first admin is created from `ADMIN_EMAIL` on first start. If you left `ADMIN_PASSWORD`
empty, a random one is printed once:

```bash
docker compose logs helpdesk | grep -A3 "Admin account"
```

Sign in at `/admin`; you'll be asked to choose your own password. Then open **Staff** to create your agents. Each gets a
temporary password to hand over, and must choose their own at first sign-in.

### Office display
Sign in at **`/admin#tv`** on the monitor. It opens straight onto the Live board; leave "keep this screen signed in for
12 hours" ticked. Use the Fullscreen button (or F11).

### Email notifications
Requesters are emailed when their ticket's status changes or it gets assigned. Set **one** of these in `.env`:
SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, ...) or Microsoft Graph (`GRAPH_*`). With neither set, notifications are off.
`MAIL_LOG_ONLY=1` prints them to the log instead, which is handy for a trial.

Replies that IT writes on a ticket are emailed to the requester as well.

### Tickets by email
Optional. An email to the helpdesk mailbox raises a ticket in the sender's name; a reply to one of the helpdesk's emails
(`RE: [FG-0042] ...`) is added to that ticket's conversation. Two ways to feed it:

- **Microsoft 365:** set `INBOUND_MAILBOX` to the mailbox address. It is read with the same `GRAPH_*` app registration used
  for sending, which also needs the **Mail.ReadWrite** application permission (admin consent). Unread mail in the Inbox is
  taken in every minute and marked read; nothing is deleted.
- **Anything else:** set `INBOUND_SECRET` and have your mail relay `POST /api/inbound/email` with
  `Authorization: Bearer <secret>` and JSON `{ "from", "name", "subject", "text" or "html", "message_id" }`.

Rules: only addresses on `COMPANY_EMAIL_DOMAIN` are accepted; automatic replies and the helpdesk's own address are ignored;
a reply only joins a ticket if it comes from the person who raised it; email can never act as IT; attachments are not
taken (yet). Someone who has only ever emailed has an account without a PIN and creates one the first time they open the
helpdesk.

### Calls and screen sharing
**Only IT starts calls.** Every ticket has a **Call** button for IT. The person who raised the ticket has **Request a call**
instead (with an optional note, e.g. "easier to show you on screen"): IT is told straight away (the bell, a sound, a banner on
the ticket with **Call now** and **Dismiss**, and a line in the conversation), and rings them when it suits. A request stays open
until they answer, IT dismisses it or they take it back; asking again and again is slowed down (5 an hour). It is a voice call
between the two browsers, and either side can show their screen during it (view only: nobody can control the other computer). Sound and picture travel
directly between the two computers over your network; nothing goes to the internet and nothing is recorded. The ticket keeps a
line for every call (who called, how long, or that it was missed) and the activity log records calls and screen sharing.

- **It needs HTTPS.** Browsers only allow the microphone and screen sharing on `https://` (or `http://localhost`). On plain
  `http://` the button explains that instead of calling. See the next section; an internal certificate is enough.
- **The requester must have the helpdesk open** in a browser tab for it to ring. If they do not, IT is told at once, the requester
  finds a "Missed call" notification, and their request stays open.
- A computer without a microphone can still take a call: it listens and can show its screen.
- Tested in Microsoft Edge (voice and screen sharing between two tabs on one computer). Test it between two real computers before relying on it.
- **Separate networks:** on one office network it just works. If computers cannot reach each other directly (VLANs or sites
  that block computer-to-computer traffic), run a TURN relay such as coturn on your own network and set `TURN_URL`,
  `TURN_USERNAME` and `TURN_PASSWORD`.
- Calls live in the server's memory: restarting the helpdesk ends any call in progress.

### HTTPS and a reverse proxy
Put nginx, Caddy or Traefik in front for HTTPS. Then in `.env` set `APP_URL=https://helpdesk.yourcompany.com` and
`TRUST_PROXY=1`. (Staff sessions use `Secure` cookies once `APP_URL` is https.)

### Backups
Everything lives in the `helpdesk-data` volume (`/data`): `helpdesk.db` (tickets, users), `uploads/` (attached files) and `session.secret`. Copy `uploads/` too when you back up the database.

```bash
# a consistent copy of the database, while the app is running (SQLite will not overwrite an existing file, so clear the old copy first)
docker compose exec helpdesk rm -f /data/backup.db
docker compose exec helpdesk node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/helpdesk.db');d.exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp helpdesk:/data/backup.db ./helpdesk-backup.db
```

### Upgrading
```bash
git pull   # or copy the new files
docker compose up -d --build
```
Data is in the volume, so it's kept. Database changes are applied automatically at start-up (see `migrations/`).

### Locked out?
If no admin can sign in:
```bash
docker compose exec helpdesk node dist-server/index.js reset-admin you@yourcompany.com
```
This creates (or promotes) that admin and prints a new temporary password.

## Develop locally

Needs Node 24+.

```bash
npm install
ADMIN_EMAIL=you@company.com ADMIN_PASSWORD=Temp-Passw0rd-1234 COMPANY_EMAIL_DOMAIN=company.com MAIL_LOG_ONLY=1 npm run dev:server   # API on :3000
npm run dev                                                                                                             # web app with hot reload on :5173
```
Or `npm start` to build and run everything on one port. `npm run typecheck` checks the code and `npm test` runs the test suites
(it builds the server, starts it on a temporary database and runs about 400 checks, plus unit tests for the statistics and
working-hours code; nothing outside the repository is touched).

## Good to know
- **Normal users are not verified by email.** They type a name and a company email and protect the account with a PIN (details
  below). That is a deliberate trade for simplicity, suited to a trusted office network. If you need more, the options are an
  emailed one-time code, Microsoft 365 sign-in or passkeys; the sign-in lives in `src/server/identity.ts`.
- Staff passwords are hashed with scrypt; five wrong tries lock an account for 15 minutes; changing or resetting a password
  signs that person out everywhere.
- The app is one process with a SQLite database, which comfortably handles an IT department's load. It isn't meant to run as
  several copies at once.
- **Light and dark mode** apply to the whole app. The choice is remembered per browser and defaults to the device setting
  (the office display at `/admin#tv` starts dark). Switching cross-fades over about 0.4 s.
- **Deleting a staff account** (Admin > Staff) keeps the ticket history: comments and events stay, shown as "Former team
  member". Their open tickets go back to triage (in-progress ones revert to open). If the person also raised tickets as a
  requester, they are moved to a normal user instead of being removed. You can't delete yourself or the last active admin.
- `LOGIN_RATE_LIMIT` (default 15) caps sign-in attempts per IP per 10 minutes.
- **Notifications.** The bell in the header shows unread messages and updates, with a pop-up and a short sound (switch it off in the bell's
  panel). Agents and admins are alerted to new tickets, messages and assignments; requesters to replies and status changes. Browsers only
  allow sound after you have clicked or typed on the page once. Desktop alerts (when the tab is in the background) need the app to be opened
  on `localhost` or over HTTPS. Notifications are kept for 30 days.
- **Closing tickets.** Agents mark tickets *resolved*; they stay open for replies so a requester can say the problem is back (which reopens the ticket). At the end of the day an admin opens the **Resolved** tab and clicks **Close all** (or closes tickets one by one). Closed tickets can no longer be messaged; only an admin can reopen one.
- **Instant updates.** Boards, lists, the bell and open tickets refresh the moment something changes (a live stream from the server; a slow refresh remains as a fallback). If you put the app behind a reverse proxy, make sure it does not buffer streaming responses (nginx: `proxy_buffering off`).
- **Reports** (Admin > Reports): pick a month, read the numbers and the "Smart analysis", download the tickets as CSV for Excel, or print / save as PDF. The analysis (spikes, trends, recurring problems, slow tickets, workload) is statistics run on your own server; nothing is sent anywhere. Months follow UTC, which is Ghana time.
- **Attachments**: people can add screenshots and files (paste, drop or pick) to a ticket and to messages; stored in the data volume under `uploads/`, so **back that folder up together with `helpdesk.db`**. Limit `MAX_UPLOAD_MB`.
- **Help articles and saved replies** (Library tab for staff, Help tab for everyone): the best matches appear while someone types a ticket's summary. **Response targets** (admin: Library > Response targets) with warnings before and after a ticket is late; the clock stops while a ticket is waiting on the requester. **Feedback**: requesters say whether a resolved ticket was really fixed.
- **Activity log** (Admin > Activity): who did what, when and from which computer: tickets, messages (never their text), sign-ins, failed logins, account changes, exports. Kept for `AUDIT_RETENTION_DAYS` (default 365).
- **First-time setup and Home.** A new account gets a short welcome, a one-minute tour of the app and the optional hardware report; the tour can be replayed from Home. Home asks "What do you need help with?" (what is typed there starts the ticket), shows what IT is doing right now, the person's own tickets and shortcuts. The header shows whether this browser is connected to the helpdesk (tick = online, cross = offline).
- **Checklists and recurring tickets** (Library). Checklists are reusable lists of steps (new starter, leaver, new laptop; admins edit them): start one to raise a ticket with the steps ready to tick off, or add one to any ticket. Recurring tickets (admin) raise themselves daily, weekly, monthly, quarterly or yearly, optionally with an assignee and a checklist.
- **Working hours** (admin: Library > Response targets) make response targets count only the chosen weekdays, hours and holidays. Off by default: the clock then runs 24/7.
- **Computers** (admin tab): every computer that has reported in, grouped by serial number, with plain-language health flags (disk nearly full, Windows 10, not restarted for weeks...) and a CSV export.
- **Live board in its own tab.** The admin panel's Live board button opens the board in a separate browser tab, so the panel stays as it was.
- **Normal-user sign-in** uses a name, company email and a personal **6-digit PIN**. The first person to use an email creates its PIN; any other computer, browser or incognito window must enter it, so typing a colleague's address no longer opens their tickets. A computer that is already signed in stays signed in; untick "Remember me" on shared PCs. Forgotten PINs are reset by an admin under Admin > People. People who had accounts before PINs existed are asked to create one at their next sign-in. Five wrong PINs lock the account for 15 minutes. Passkeys / Windows Hello can be added later once the helpdesk is served over HTTPS on a proper hostname.
- **Computer details.** When someone raises a ticket, IT sees which computer it came from, in the ticket and under Admin > People: system, processor, memory, screen and graphics, drawn as a small picture. A browser can't see the make, model, serial number or disks, so each person can also run a one-off hardware report from **Your account > This computer > Send hardware details to IT** (Windows only: a double-click file, or a PowerShell command). The report reads specifications only (no files, passwords or browsing) and the link works for 24 hours. Serial numbers and network addresses are visible to IT staff only.

