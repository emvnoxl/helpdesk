# Fortress Oil & Gas Helpdesk

Custom internal ticketing system for Fortress Ghana (one-person IT dept). Replaces earlier attempts with FreeScout, Zammad,
UVdesk, GLPI. Runs as **one Docker container** with a SQLite database in a volume. **No Cloudflare, no cloud services**
(it used to target Cloudflare Workers + D1; that is gone, so the old free-tier limits no longer apply).

## Requirements
- Requesters submit tickets via a web form and see where their tickets sit.
- Managers/admins need visibility: dashboard with priority listings, overdue, workload, trends, category leaderboard.
- Notify requesters on status/assignee change by email (SMTP or Microsoft Graph).
- Three audiences, each with its own place and sign-in (see below).

## Stack
- Frontend: React + Vite + Tailwind (`src/web`), built to `dist/`, served by the Node server.
- API: Hono on Node (`@hono/node-server`), TypeScript (`src/server`), bundled with esbuild to `dist-server/index.js`.
- DB: SQLite through Node's built-in `node:sqlite` (Node 24+, no native add-ons). `src/server/db.ts` wraps it in the
  `prepare().bind().first()/all()/run()` + `batch()` shape the queries were written in. `schema.sql` creates a fresh DB;
  later changes go in `migrations/NNN_name.sql` (tracked with `PRAGMA user_version`, bump `SCHEMA_VERSION` in `db.ts`).
- Deploy: `Dockerfile` (multi-stage, non-root, healthcheck) + `docker-compose.yml` + `.env.example`; see `README.md`.
- Notifications: an in-process timer (`notifier.ts`) sends ticket_events with `notified = 0` via Graph or SMTP; `MAIL_LOG_ONLY=1` logs instead.

## Audiences and auth (the core design)
| | URL | Sign-in | Cookie | API |
|---|---|---|---|---|
| Normal users (role `requester`) | `/` | name + company email, **no password, not verified** (deliberate) | `fg_user` (180 d, Lax) | `/api/identify`, `/api/me`, `/api/tickets`, `/api/queue`, `/api/board` |
| Agents | `/agent` | email + password | `fg_staff` (2 h, Strict) | `/api/staff/*` |
| Admins | `/admin` | email + password | `fg_staff` (2 h, or 12 h with "keep signed in") | `/api/staff/*` + `/api/admin/*` |

- A requester session is **always** role `requester`, even if the email typed belongs to staff (no privilege escalation by typing an admin's email).
- Each portal accepts only its own role (`portal` is sent to `/api/staff/login`). Login errors are generic; unknown emails look identical to wrong passwords.
- Staff accounts are created by an admin (`/api/admin/users`) with a one-time temporary password (`must_change_password`, forced change screen). Password change/reset/disable bumps `credential_version`, which ends every session of that person immediately.
- Passwords: scrypt (`security.ts`). 5 wrong tries lock the account 15 min. Login/identify are rate-limited per IP (in memory).
- `/api/admin/*` answers **404** to signed-in non-admins (it doesn't look like it exists); no/expired staff session = 401 `signed_out`.
- First admin: from `ADMIN_EMAIL`/`ADMIN_PASSWORD` on first start if no admin exists (random password printed once if empty).
  Recovery: `docker compose exec helpdesk node dist-server/index.js reset-admin <email>`.
- CSRF: `sameOrigin` middleware (Origin must match Host) + SameSite cookies. CSP and other headers via `secureHeaders`.
- `COMPANY_EMAIL_DOMAIN` restricts normal users' emails. Empty = any domain (a warning is logged).
- Sessions are HMAC-signed with `SESSION_SECRET`, or a key generated once and kept in `/data/session.secret`.

## What each audience sees
- **Normal users** (`UserApp.tsx`): exactly Home, Submit a ticket, My queue, Live board, Help. No ticket lists, no priorities of others.
  Header (`UserApp.tsx`, matches the admin one): logo; a profile chip (initials avatar with a green "signed in" dot, name, email on xl screens, opens Account); divider; bell + theme toggle; divider; Sign out
  (an icon on phones). Tabs have icons and short names on phones (Submit / Queue / Board) so all five fit without swiping.
  - *My queue* (`MyQueue.tsx`, `/api/queue`): own open tickets, progress tracker, "#N in line of M".
  - *Live board* (`LiveBoard.tsx`, `/api/board`): three counts, everything being worked on, "Up next" with positions, "Where you sit". Other
    people's tickets are only reference + category, never title/name. The queue ("waiting in line") = status `open`, ordered by
    `priority_rank DESC, created_at ASC`, from one bounded index scan (200 rows).
- **Agents** (`AgentPortal.tsx`): My queue (assigned; current task glows), Needs triage ("Take it" + priority), All tickets, ticket view with controls.
- **Admins** (`AdminPortal.tsx`): the same plus Dashboard (`Insights.tsx`, `/api/admin/insights`), Staff (`UsersPanel.tsx`), Account, and the full
  **Live board** (`Dashboard.tsx`, `/api/admin/board`) with Fullscreen; `/admin#tv` opens it for the office display with a 12 h session.
- Both portals use the **whole screen width**; shared pieces: `PortalFrame`, `StaffConsole`, `StaffLogin`, `useStaff`.

## Behaviour rules
- Requesters never choose priority: every ticket starts `medium`; the server ignores any priority sent on create.
- Agents and admins can set priority. When an **admin** sets it, `priority_locked = 1` and agents get a 403 changing it; only an admin can change/unlock it.
- Ticket requester name/email come from the account (`users`), not from the form. Staff comments use the account name (editable under Account).
- Hide `comments.internal = 1` from requesters on the server, not just the UI.
- Deactivating an agent unassigns their open tickets (back to triage) and ends their session. There is always at least one active admin; admins can't disable/demote themselves.
- Never concatenate user input into SQL. Always use `.bind()`.

## Insights (admin dashboard)
Category leaderboard first (count, share, change vs the previous window, open now, avg fix), busiest-category callout, KPIs with deltas, trend,
backlog age, speed vs target by priority, day-by-hour heatmap, top requesters, repeat-ticket devices, team. 7/30/90-day range.

## UI conventions
- Brand: green `#00a859`, amber `#ffb400`, red `#ee3239`, ink `#0b0b0b`. The logo (Fortress Oil & Gas Helpdesk: a mark of two rounded squares behind a red speech bubble with an oil drop, plus the wordmark) is SVG in `src/web/public/`: `logo-light.svg` for light backgrounds, `logo-dark.svg` (white wordmark) for dark; use `<Logo theme>` from `brand.tsx` (it follows the theme, or pass `theme="dark"` on an always-dark bar). It is 3.1:1 wide, so size it by height: `h-10`-`h-14` in headers, `h-16` on sign-in cards. `<BrandMark onDark>` draws the mark alone for large faded decoration (Home hero, sign-in screens; each instance gets its own mask id). Favicons, `apple-touch-icon.png` and `site.webmanifest` come from the design kit (`favicon.svg`, `.ico`, 16/32/48 png, android-chrome 192/512); `static.ts` serves `.webmanifest`. The source kit lives outside the repo (`Desktop/fortress-helpdesk-logo`, with stacked PNG variants and an app-icon set).
- Motion: `.page-in` (keyed by page), `SlidingTabs`, `.rise-in` + `--i`, `CountUp`. The current task glows: `.glow-now` (steady ring, tint, accent bar,
  breathing halo; only the halo's opacity animates) plus a NOW tag; other in-progress work gets `.glow-soft`. All respects `prefers-reduced-motion`.
- Theme tokens for the board/charts are CSS variables (`.theme-light` / `.theme-dark` in `index.css`); shared pieces in `viz.tsx`.

## Layout
```
src/server/   index.ts (app + static + start) config.ts db.ts security.ts auth.ts identity.ts board.ts tickets.ts
              staff.ts admin.ts dashboard.ts notifier.ts bootstrap.ts static.ts config-route.ts
              sla.ts worktime.ts inbound.ts tasks.ts checklists.ts recurring.ts calls.ts (+ kb, replies, devices, attachments, reports...)
src/web/      App.tsx (router) UserApp.tsx AgentPortal.tsx AdminPortal.tsx + components
schema.sql  migrations/  Dockerfile  docker-compose.yml  .env.example  README.md  tests/api.mjs
```

## Theme, dialogs, account deletion
- **Theme rules (checked by an automated contrast audit during development, not in the repo: it measured text, input and icon contrast on every screen of every audience, light and dark, at desktop/tablet/phone widths)**:
  never hard-code a light or dark surface (`bg-white`, `text-[#0b0b0b]`) on something that sits on a themed page; use `bg-surface` / `text-fg`. **The global `input, select, textarea { color: var(--color-fg) }`
  is unlayered, so it beats Tailwind utility colours on inputs**: give inputs `text-fg` (or a field that already has it) instead of a fixed text colour. Text on the brand-green fill is `text-ink` (white is only 3.1:1);
  green TEXT on a surface is `text-ok` (token flips: #007a3d light, #3ddc8a dark), never `text-green-700` (not remapped in dark) or `text-brand-green` (too pale on white); small red badges use `#d92b33` so white text passes.
  The admin portal's "Live board" button opens `/admin#board` in its own named tab (`window.open(..., "fortress-live-board")`; pressing it again focuses that tab), so the panel stays as it was; that tab's
  button reads "Close tab". `/admin#tv` stays the kiosk mode for the office display.
- App-wide light/dark: `html.theme-dark` overrides the Tailwind colour variables (stone/neutral/red/... scales) plus semantic tokens
  `--color-surface`, `--color-page`, `--color-fg`. Use `bg-surface` / `text-fg` instead of `bg-white` / `text-ink` on themed surfaces.
  `theme.tsx` (`useTheme`) persists to localStorage `fortress-helpdesk:theme`; `public/theme-init.js` sets the class before first paint
  (CSP forbids inline scripts); `html.theme-fade` gives the 380 ms cross-fade (skipped for reduced motion). `ThemeToggle.tsx` everywhere.
- No native `confirm/alert`: use `notify.tsx` (`toast(text, kind, title)`, `confirm({...})`), branded with the stripe, focus trap, Esc.
- The normal-user app is full width like the portals. Grid children need `min-w-0` / `grid-cols-1` to avoid phone overflow.
- Deleting staff (`DELETE /api/admin/users/:id`): history is kept under the placeholder user "Former team member"; unassigned open tickets
  go back to triage (in_progress becomes open); a person with their own requester tickets becomes a requester (`removed_from_team`).
- Ticket page (`TicketView.tsx`, same component for requester/agent/admin): description + details + staff controls on the left, a chat
  on the right (bubbles, day separators, grouped messages, inline status/assignee events, Enter sends / Shift+Enter newline, optimistic
  send, 5 s polling while the tab is visible). Staff get a "Reply to requester | Internal note" switch; `GET .../:id` returns
  `{ticket, comments, events, me}`. Internal notes and priority events are filtered server-side for requesters. No typing/read receipts.
- Ticket page fills the window (no page scroll): `TicketView` measures what is above/below it and sets its own pixel height; the details pane and the
  chat scroll inside themselves, so the message box is always on screen. On phones it shows one pane at a time (Chat | Details tabs).
- Notifications (migration 002, `notifications.ts`, `NotificationBell.tsx`, `sound.ts`): rows are written in `tickets.ts` when a ticket is
  created (all active staff), a message arrives (requester -> assignee, or all staff if unassigned; staff reply -> requester; internal note ->
  assignee only), or status/assignee changes (requester; a new assignee). API: `GET /api/notifications` + `POST .../read` for normal users and the
  same under `/api/staff/notifications`. The bell polls every 6 s (15 s in a background tab), shows a count, a toast (click opens the ticket), a
  Web Audio chime per kind (no audio files; muted via the switch in the panel, stored in localStorage), "(n)" in the tab title and, if allowed
  and on a secure origin, a desktop notification. Messages for the ticket you have open are read automatically and refresh the chat at once
  (`fg:notify` event). Rows are pruned after 30 days. Browsers only play sound after the first click/key on the page.
- Closing: agents set `resolved`; **only an admin can close or reopen** (403 otherwise). A closed ticket rejects all messages (409, UI shows a
  notice instead of the composer). A requester writing on a `resolved` ticket sends it back to `open` (event logged). The **Resolved** tab
  (`ResolvedBoard.tsx`, data in `/staff/overview` as `resolved`) is visible to agents (read-only) and admins (Close per row + "Close all",
  `POST /api/admin/tickets/close-resolved`, which also notifies requesters).
- Up next (client board): the requester's own row uses `.glow-row` (inner ring breathes, accent bar, light sweep, pulsing YOU chip; paints only
  inside the row because the list clips). The Live board clock must not move when the theme toggles: the toggle's label has a fixed width.
- **Instant updates** (`bus.ts`, `web/live.ts`): every mutation calls `changed(ticketId?)`; screens listen on one shared Server-Sent Events stream per
  tab (`/api/stream` for normal users, `/api/staff/stream` for staff; admins also get `audit` events). Events carry no data, only "something changed":
  each screen re-fetches through its own authorised API (debounced 120 ms). Boards, staff lists, the bell and the open ticket use it; each keeps a slow
  poll (30-60 s) as a safety net. The stream closes after 10 min and the browser reconnects, which re-checks the session. Browsers allow ~6 connections
  per site over HTTP/1.1, hence the single shared stream. Behind nginx set `proxy_buffering off` (the server also sends `X-Accel-Buffering: no`).
- **Activity log** (migration 003, `audit.ts`, `activity.ts`, `ActivityLog.tsx`): `audit(c, action, category, summary, {ticketId, who})` after every ticket
  event, message (kind only, never the text), sign-in/out (requesters and staff), failed/locked/throttled logins (category `security`), account change
  and admin action, with IP and a short device name. No passwords, temporary passwords or message bodies, ever. Admin-only (404 to others), live,
  filter/search/CSV, pruned after `AUDIT_RETENTION_DAYS` (365). No foreign keys, so history outlives deleted accounts.
- **Reports** (`reports.ts`, `analytics.ts`, `Reports.tsx`): per UTC month (= Ghana time) KPIs vs the previous month, daily chart, category/priority/team
  tables, heatmap, six-month history, tickets CSV (formula-injection safe), print/PDF. "Smart analysis" is classic statistics and text mining that runs
  on this server (no language model, nothing leaves the box): MAD spike detection, least-squares trend/forecast, TF-IDF + cosine clustering of ticket
  wording for recurring problems, IQR fences for slow tickets, Gini for workload, plus rule-based findings and a plain-English summary. Pure functions in
  `analytics.ts`, unit-tested in `tests/analytics.mjs` (`npm test` runs both suites; it also covers the pure helpers in `worktime.ts`).
- **Normal-user sign-in** (`identity.ts`, `Welcome.tsx`, `Account.tsx`, `PeoplePanel.tsx`; migration 004): name + company email + a **personal 6-digit PIN** (exactly 6 digits, entered in `PinInput.tsx`: one box per digit, auto-submits on the sixth,
  scrypt-hashed in `users.pin_hash`, trivial PINs like 123456/000000/121212 refused). The first person to use an email creates its PIN (`401 pin_setup`, then `new_pin`);
  any computer/browser/incognito window that has not signed in before must enter it (`401 pin_required`, then `pin`). Already signed-in computers stay signed in
  (180-day cookie, or browser-session if "Remember me" is unticked). 5 wrong PINs lock the account 15 min (reuses `failed_attempts`/`locked_until`). Sessions carry
  `session_version`; changing the PIN, "sign out everywhere" or an admin reset bumps it and ends every other session. Accounts from before PINs have no PIN: the next
  person to sign in creates one, and users still signed in see a banner. Admin > People lists normal users and clears a forgotten PIN. After sign-out a used
  computer offers "Continue as <name>" (details in localStorage; "Forget me here" clears them) and still asks for the PIN. There is no hardware identifier a
  browser can read; the PIN is the proof. WebAuthn/passkeys (Windows Hello PIN) would be the next step but need HTTPS on a real hostname (not an IP).
  Everything is in the activity log (never the PIN itself).
- **Computer details** (migration 005, `devices.ts`, `device.ts`, `DeviceCard.tsx`, `ThisComputer.tsx`): each browser keeps a random id in localStorage (that is what
  tells computers and incognito windows apart; a browser cannot read a serial number or MAC). After sign-in `reportDevice()` sends what the browser may know (OS and
  Windows 10/11 via userAgentData, CPU threads, approximate RAM capped at 8 GB, screen, GPU, network type) to `POST /api/devices/report`; tickets store `device_id` from
  the `device_key` sent on create. Full specs (make, model, serial, CPU name, RAM sticks, disks and free space, GPUs, NICs, chassis, last boot) come from an optional
  PowerShell script the person runs once from Account > This computer: `POST /api/devices/inventory-link` returns a 24 h signed token, `GET /api/devices/script.ps1|.cmd?t=`
  serves the script (ASCII, PowerShell 5.1; the .cmd runs the PowerShell stored after a marker line in the same file), and the script posts to `/api/devices/inventory`
  with the token, no cookie. Everything stored goes through `cleanBrowser`/`cleanHardware` (fixed fields, types, lengths). Admin sees it under People (expand a row; `DevicePanel` picks between several computers) and
  staff inside a ticket (`DeviceSummary` + a `DeviceDrawer` side panel rendered through a portal, because the animated page ancestor would trap `position: fixed`). The view (`DeviceView`) is
  a status header, plain-language `healthChecks()` (disk nearly full, little memory, not restarted for 2-4 weeks, Windows 10 out of support, mechanical drive, stale report) and a
  container-query tile grid, so it adapts to any width; requesters never see serials or addresses. The script has been run for real on Windows 11; `tests/api.mjs`
  covers the API with synthetic reports.
- **First-time setup** (`Onboarding.tsx`): `/api/identify` answers `created: true` for a brand-new account and `UserApp` then shows a three-step screen instead of the app
  (welcome, "Tell IT about this computer", done). The computer step is one button: it asks for the inventory link, starts the `.cmd` download by itself and waits (SSE + 3 s poll
  on `/devices/mine`) until the report arrives, then shows the make/model. Non-Windows devices skip that step; everything can be skipped. A localStorage flag
  (`fortress-helpdesk:onboarding` = user id) brings a refresh back to the setup. The `.cmd` closes by itself 5 s after a successful send and pauses only on failure (`$fgOk`).
- `LOGIN_RATE_LIMIT` env (default 15/10 min per IP) for the staff login limiter.
- **Attachments** (migration 006, `attachments.ts`, `Attach.tsx`): screenshots/files on the new-ticket form (uploaded right after the ticket exists, `?for=ticket`, allowed for 30 min after raising)
  and in the chat (uploaded as drafts, linked by `attachment_ids` on the comment POST; a message may be only files). Files live in `DATA_DIR/uploads/<random>` (back them up with the DB);
  the table decides who may fetch: a draft only its uploader, a file on an internal note staff only. Whitelist of extensions + magic-byte check (a renamed .exe is refused), limit `MAX_UPLOAD_MB`
  (default 10, also in `/api/config` so the browser pre-checks), served with OUR content type, `nosniff`, `CSP: sandbox` (site-wide secureHeaders is skipped for `/attachments/:id` because it would
  overwrite that CSP), images inline, everything else as download. CSP `img-src` has `blob:` for upload thumbnails. Paste (Ctrl+V), drag-drop and the paperclip all work. Unsent drafts are pruned after 2 h.
- **Help articles** (`kb.ts`, `Help.tsx`, `Library.tsx`): one router mounted at `/api/kb` (requesters: published only, read + one vote each) and `/api/staff/kb` (staff: drafts, create/edit/delete).
  `rankArticles` in `analytics.ts` (IDF-weighted, title counts triple, prefix matching, "Wi-Fi"→wifi) drives `/kb/suggest` (shown under the Summary field while typing a ticket; "This solved it" clears the form)
  and the Help-page search. Article text is plain text rendered by `KbBody` (## heading, - bullets, 1. steps, **bold**), never as HTML. Five starter articles are seeded once (`settings.kb_seeded`), plus a larger library in `kb-pack.ts` (~25 articles for Windows 11 / Microsoft 365 / printing / network / AV / CCTV / security awareness; added once via
  `settings.kb_pack_1`, skipping titles that already exist). **Videos and links**: a line that is only a YouTube link (watch, youtu.be, shorts, embed) becomes an iframe to `youtube-nocookie.com/embed/<11-char id>` (`youtubeId()` in `Help.tsx`
  keeps only the validated id, so look-alike hosts are never framed) with a "Watch on YouTube" fallback; CSP `frame-src` allows only that host. `[text](https://…)` and bare http(s) links open in a new tab (`noopener`); other schemes
  stay plain text. The editor has an "Add video" box. The four videos in the pack are unreviewed third-party picks: IT should watch them or swap them.
- **Help page layout** (`Help.tsx`, `CategoryIcon.tsx`): full width; category sidebar with counts (+ "Videos" filter, chips on phones), search, sort (hidden while searching: best match first), and a view toggle
  Cards / List / By category (remembered in localStorage `fortress-helpdesk:help-view`). An open article gets a wide reading column and, on 2xl screens, a "More in <category>" rail; picking a category while reading returns to the list.
  `/api/kb` briefs carry `video` (body links to YouTube) and the excerpt is built server-side (`excerpt()` in `kb.ts`: skips headings, joins items with " · ", cuts at a word).
- **Saved replies** (`replies.ts`, `Replies.tsx`): `/api/staff/replies`; team replies (owner NULL, admin-managed) + personal ones. Composer button or "/" in an empty box opens a searchable picker; `{name}` `{ref}` `{agent}` are filled client-side.
  Starters seeded once. Managed under Library > Saved replies.
- **Response targets** (`sla.ts`, `Sla.tsx`): hours per priority live in `settings.sla_hours` (admin: Library > Response targets, `/api/admin/sla`; saving recomputes open tickets). `due_at = created + target + paused_secs`.
  The clock stops while status is `waiting` (`paused_at`), a requester's reply on a waiting ticket resumes it (status back to in_progress/open, event logged), waiting tickets are not "overdue" in any counter.
  `startSla()` runs every 60 s: one `sla_warn` alert when ≤ max(30 min, 20 % of the target) is left and one `sla_breach` when late (assignee, or all staff if unassigned; admins also on breach), tracked in `tickets.sla_alert`.
  Staff see `SlaChip` on queues and `SlaBar` on the ticket; requesters never see targets.
- **Working hours** (`worktime.ts`, `settings.business_hours`, admin: Library > Response targets, `PUT /api/admin/sla/calendar`): off by default (the clock runs 24/7).
  When on, `due_at = addWorkSeconds(created, target + paused_secs)` over the chosen weekdays, hours (UTC = Ghana time) and minus listed holidays, and `paused_secs` holds
  WORKING seconds (`workBetween`). Saving the calendar or the targets re-times every open ticket in JS (`recomputeOpen`). The "close to target" warning compares working time left.
  The calendar is loaded with a top-level await in `sla.ts` so `dueAt` stays synchronous. The countdown chips still show wall-clock time until the due moment.
- **Tickets by email** (`inbound.ts`, migration 007 `tickets.source` + `inbound_mail`): `ingestEmail()` is fed by a Microsoft Graph poller (`INBOUND_MAILBOX`, needs Mail.ReadWrite,
  marks messages read) or `POST /api/inbound/email` with `Bearer INBOUND_SECRET` (404 when unset). New mail = new ticket in the sender's name (account auto-created, no PIN);
  `RE: [FG-0042]` from that ticket's requester = a message on it (through the same `addComment()` the chat uses, so reopen/resume rules apply). A From line can be forged, so email
  is only ever a requester: staff addresses can't reply as IT, other people quoting a ref get their own ticket. Dedup by Message-ID, auto-replies / own address / other domains
  ignored, 20 per sender per hour, no attachments. `cleanEmailBody` strips quoted text and signatures. Outgoing: the notifier now also emails staff replies (`ticket_events.field =
  'reply'`, new_value = comment id; not shown in the chat) and a "we have your email" for email-raised tickets. The Graph poller is untested against a real tenant.
- **Shared ticket helpers** (`tickets.ts`): `createTicket(who, {...})` and `addComment(c | null, user, id, t, text, {...})` are used by the routes, email, checklists and the scheduler.
- **Checklists** (`tasks.ts`, `checklists.ts`, `Tasks.tsx`, `Workflows.tsx`; tables `checklist_templates`, `ticket_tasks`): templates under Library > Checklists (`/api/staff/checklists`,
  everyone reads and starts, admins edit; three seeded once via `settings.checklists_seeded`). "Start" raises a ticket (source `checklist`) assigned to the starter with the steps copied on.
  Any ticket can get steps or a whole template (`POST /:id/tasks`), tick (`PATCH`), remove (`DELETE`); staff only, `tasks` is left out of the ticket JSON for requesters.
  Resolving with unticked steps asks for confirmation. `tasks.ts` must not import `tickets.ts` (tickets mounts its routes: circular import).
- **Recurring tickets** (`recurring.ts`, table `recurring_tickets`, Library > Recurring, `/api/admin/recurring`): daily / weekdays / weekly / monthly / quarterly / yearly at 08:00 UTC,
  optional assignee and checklist, pause, "Raise now". A 60 s timer raises what is due and moves `next_at` on with `nextRunAfter` (one ticket after downtime, not a backlog;
  `anchor_day` keeps "the 31st" from drifting). The requester is whoever set it up, or any active admin.
- **Asset register** (`Assets.tsx`, `GET /api/admin/assets`, admin tab "Computers"): every device row with owner and ticket counts; the browser groups rows by serial number,
  runs `healthChecks()`, filters (needs attention / Windows 10 / no full report), expands to `DeviceView`, exports CSV.
- **Calls and screen sharing** (`calls.ts`, `Calls.tsx`; no tables): WebRTC between the two browsers, the server only signals. Routes live inside the tickets router
  (so both `/api/tickets` and `/api/staff/tickets`): `POST /:id/call` {sdp, tab}, `GET /calls`, `POST /calls/:call/accept|decline|hangup|share`. State is an in-memory snapshot
  that every tab re-reads after a `call` SSE event, which `bus.signal(keys)` sends only to the parties (`r<id>` = requester session, `s<id>` = staff session); no queues, so
  several tabs are safe (all ring, the first `accept` wins, `tab` says which one). Offer and answer are sent once with their ICE candidates inside (no trickle); both sides
  negotiate audio + video up front and screen sharing is `replaceTrack` on the video sender (no renegotiation), flagged through `/share`. **Only staff start calls** (a requester's `POST /:id/call` is 403). A requester
  asks instead: `POST /:id/call-request` {note} (`DELETE` takes it back; staff `DELETE` = "Dismiss"). A request is a `ticket_events` row (field `call_request`, new_value `asked`, old_value = the
  note; cleared by a row with new_value `cleared` and old_value `cancelled|dismissed|answered`; `notified = 1`), open = the latest such row is `asked` and under 24 h old (`pendingRequest()`,
  returned as `call_request` by the ticket detail). It notifies the assignee (all staff when unassigned/inactive) with kind `call_request`, max 5 requests per requester per hour (429). IT's
  `CallRequestBar` offers "Call now" (the normal `CallButton`) and the request is cleared when the requester answers that call; a missed call (requester not online) keeps it open.
  Staff ring the requester only; nobody reachable = 409 `missed` straight away. Ringing lasts 30 s. Every call writes a
  `ticket_events` row (field `call`, old_value ended|missed|declined, new_value seconds, `notified = 1` so it is never emailed), a "Missed call" notification and activity-log
  lines (`call.*`). Needs a secure context (HTTPS or localhost): `callsSupported()`. No microphone = listen-only, can still share. Optional `TURN_*` env for split networks.
  The engine is module-level (survives page changes); `CallDock` (in `UserApp` and `PortalFrame`) renders the incoming card, the call bar and the remote screen through a portal.
  `tests/api.mjs` covers the signalling; a real two-tab call (fake microphone, Edge over CDP) was run during development and is not in the repo.
- **Home** (`Home.tsx`, normal users): a dark hero with a time-of-day greeting and one question, "What do you need help with?": the box (and the "Common:" chips)
  open Submit a ticket with the summary filled in (`initialTitle` on `NewTicket`, held as `draftTitle` in `UserApp` and cleared on any other navigation). Beside it "IT right now":
  three live counts from `/api/board` and Online/Away (`it_online` = `bus.staffOnline()`, any staff stream open). Below: the person's open tickets with the `Progress` tracker
  from `MyQueue`, "Recently fixed", and Shortcuts (Help, Live board, Account, Take the tour). Data: `/queue` + `/board`, live.
- **Online status** (`useConnected` in `live.ts`): the header chip shows Online / Offline / Connecting for THIS tab's connection to the helpdesk (the shared event stream being open
  and `navigator.onLine`), as the badge on the avatar's corner (so it also shows on phones): green circle with a tick = online, red with a cross = offline, grey pulsing dot = connecting; the word is in its tooltip and for screen readers. The avatar itself is neutral (dark in light mode, grey in dark mode) so the green badge always stands out. "Offline" only shows after 6 s down, so the planned 10-minute stream reconnect never flickers.
- **Tour** (`Tour.tsx`): five slides with small drawn pictures (submit, queue, chat/call/screen, live board, help). `TourSlides` is the second step of the first-time setup
  (welcome -> tour -> this computer -> done; "Skip the tour" / "Skip everything" on the welcome) and `TourDialog` reopens it from Home > Shortcuts. Arrow keys work.
- **Hardware reminder** (`HardwareNudge.tsx` on Home): for Windows users without a hardware report; same one-click flow as onboarding; "Not now" snoozes 14 days in localStorage.
- **Feedback** (`Rating.tsx`, `POST /:id/rating`): when a ticket is resolved/closed the requester gets "Was this fixed?" (👍/👎 + optional comment, again after a later re-resolve). 👎 on a resolved ticket reopens it
  (event + comment + notification); on a closed ticket it only records and tells IT. Shown to staff on the ticket, in Insights ("Said it was fixed", list of 👎) and in the monthly report + CSV.

## Commands
`npm run dev:server` (API :3000) + `npm run dev` (web :5173) for development; `npm start` builds and runs on one port; `npm test` runs the
API suite (builds the server, starts it on a temp database, ~90 checks); `npm run typecheck`.

## Gotchas
- `node:sqlite` is built into Node 24 (the Docker image uses `node:24-alpine`). `esbuild` needs `--external:node:sqlite`.
- A missing static file with an extension returns 404, never index.html (a stale JS bundle must not come back as HTML).
- One process, one SQLite file: don't run several replicas. WAL mode is on; back up with `VACUUM INTO` (README).
- The API suite in `tests/api.mjs` is portable (Node only). The browser suites used during development (puppeteer + Edge) are not in the repo.
