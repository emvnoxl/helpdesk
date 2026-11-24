# Fortress Oil & Gas Helpdesk

An internal ticketing system for Fortress Ghana. One small Docker container, one SQLite database in a volume. No cloud services needed.

| Who | Where | Signs in with | Sees |
|---|---|---|---|
| Normal users | `/` | Microsoft 365 account (or name + email + 6-digit PIN until that is switched on) | Home, submit a ticket, **My queue**, a simple **Live board** showing what IT is working on and where *they* sit, Help articles |
| Agents | `/agent` | Microsoft 365 account (or email + password until that is switched on); an admin adds them under Staff | their queue, tickets needing triage, every ticket |
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

### Signing in with Microsoft 365
**Admin > System > Sign in with Microsoft 365** walks through it. In short: in Microsoft Entra create an app registration (this organisation only), add the **Web redirect
address** the page shows (it is `<your address>/api/auth/microsoft/callback`, so set the Address first), copy the tenant ID and client ID, create a client secret, and paste
the three into the page. Press **Test sign-in** and sign in with your own account. Only then does **Make Microsoft 365 the only way to sign in** unlock.

- **Normal users** click "Sign in with Microsoft". The account is created from their Microsoft profile (name, job title, department); if they already had one (a PIN, or from an email), it is linked to it by email, so their tickets stay. No PIN, no typing.
- **Agents and admins** sign in the same way at `/agent` and `/admin`, but must already exist under **Staff** (an admin adds them by email). Anyone else is told to ask an admin.
- When it is "the only way": names and PINs stop working, agents can't use passwords, and **admins keep a local password** at `/admin` ("Use a local admin password instead") as the way back in if Microsoft or the tenant is unavailable. `docker compose exec helpdesk node dist-server/index.js reset-admin you@yourcompany.com` still works too.
- Multi-factor sign-in, password policy and lock-outs are Microsoft's, so they apply here automatically (conditional access too).
- If someone's email changes in Microsoft 365 their account follows (it is matched by Microsoft's stable ID). A Microsoft account whose email belongs to a different helpdesk account is refused.
- It only needs the delegated **User.Read** permission. If email is already sent through Microsoft 365 you can tick "use the same app registration" and just add the redirect address to that app.
- The sign-in uses the standard authorization-code flow with PKCE from the server. The ID token comes straight from Microsoft's token endpoint over TLS (authenticated with your client secret), so its claims (issuer, audience, tenant, nonce, expiry) are checked rather than its signature, as the OpenID Connect specification allows.
- Not yet tried against a real tenant: please test with your own account first (that is what the Test button is for).

### Setting up the address and email (no file editing)
**Admin > System** has the **Address** and **Email settings** forms: the helpdesk's web address, other addresses it answers on, whether a reverse proxy provides the
https, and how email is sent (SMTP with a server, port and login, or Microsoft 365 with a tenant ID, client ID and secret; there is a one-click
Microsoft 365 SMTP preset). What you save there **overrides the same lines in `.env`** immediately, with no restart, and is kept in the database (so it is in your backups).
The SMTP password and the Graph secret are stored encrypted and are never shown again; leave the box empty to keep the saved one.
An https address is only accepted when you are already using the helpdesk over https (otherwise you would be signed out and locked out).
The `.env` lines still work as the starting point, and are used until you save something on that page.

### Email notifications
Set up in **Admin > System** (above), or put **one** of these in `.env`: SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, ...) or Microsoft Graph (`GRAPH_*`). With neither set, no emails are sent.
`MAIL_LOG_ONLY=1` prints them to the log instead, which is handy for a trial. **Admin > System > Email** shows whether it is working, how many are
waiting, the last error if a send failed (it is retried automatically), and has a **Send a test email** button: use it first.

- **Requesters** are emailed when their ticket is received (raised on the web or by email), when IT replies (with the reply text), when it is assigned
  and when its status changes ("resolved" tells them to say so if it is not fixed).
- **IT staff** are emailed when something needs them: a new ticket, one assigned to them, a requester writing on their ticket (or any unassigned one),
  an internal note, a late ticket or a call request. They get an email only if they have **not already seen it in the helpdesk** after
  `STAFF_EMAIL_DELAY_SECONDS` (default 120), and several things at once arrive as one email.
- Every email has the ticket and an **Open** button that goes straight to it (needs `APP_URL`; requesters land in the normal app, staff in their portal; if they are
  not signed in, they sign in first).
- Anyone can switch their emails off: **Your account** for requesters, **Account** in the agent and admin portals.

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
Everything lives in the `helpdesk-data` volume (`/data`): `helpdesk.db` (tickets, users), `uploads/` (attached files) and `session.secret`.

**Automatic.** Every day after `BACKUP_HOUR` (default 02:00 UTC, which is Ghana time) the helpdesk copies its database while it runs, compresses it
(`helpdesk-20261124-0200.db.gz`) and keeps the newest `BACKUP_KEEP` (default 14). It also keeps a copy of the uploaded files next to them. **Admin > System**
shows when the last good backup was, lets you press **Back up now** and **download** any of them, and the admins get a bell alert if backups stop working for
a day and a half.

By default the copies go to a folder inside the data volume. That protects you from a bad update or a deleted ticket, but **not from losing the disk**.
For real safety send them elsewhere: mount another disk or a NAS share into the container (the commented `volumes` line in `docker-compose.yml`) and set
`BACKUP_DIR=/backups` in `.env`. Download a copy now and then too.

**Restoring** is manual on purpose:
1. `docker compose stop helpdesk`
2. Unzip the backup (`gunzip`, or 7-Zip on Windows) and replace `helpdesk.db` in the data volume with it. Delete `helpdesk.db-wal` and `helpdesk.db-shm` if they exist.
3. Copy the backup's `uploads` folder over the data volume's `uploads` folder.
4. `docker compose start helpdesk`

### Upgrading
```bash
git pull   # or copy the new files
docker compose up -d --build
```
Data is in the volume, so it's kept. Database changes are applied automatically at start-up (see `migrations/`).

**People are told.** Each build has a version (the git commit; Admin > System shows it). When you stop the container, every open screen switches to
"The helpdesk is being updated" and reloads itself as soon as the new version answers, so nobody sits in front of a broken page. For a polite warning
beforehand, open **Admin > System > Announce an update**, choose "in 10 minutes" and every open screen shows a countdown banner. A tab that stays open
across an update shows "A new version is ready, Reload". When the helpdesk starts on a new version, every admin gets a bell notification and the
activity log gets a line. (The office display at `/admin#tv` reloads itself.)
Optional: `BUILD_ID=$(git rev-parse --short HEAD) docker compose up -d --build` puts the commit in the version; without it the version is the build time.

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
- **Computer details.** When someone raises a ticket, IT sees which computer it came from, in the ticket and under Admin > People: system, processor, memory, screen and graphics, drawn as a small picture. A browser can't see the make, model, serial number or disks, so each person can also run a one-off hardware report from **Your account > This computer > Send hardware details to IT** (Windows only: a double-click file, or a PowerShell command). The report reads specifications only (no files, passwords or browsing) and the link works for 24 hours. The file knows the address the person had open in their browser, so it keeps working when the helpdesk's IP or name changes; `ALT_URLS` in `.env` lists more addresses for it to try (for example both the name and the NAS's IP) and, if none answers, it shows every address it tried. Serial numbers and network addresses are visible to IT staff only.

