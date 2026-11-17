/* Starter help library, added once on top of the first five articles (see seedKbPack in kb.ts). Written for office staff using
   Windows 11 and Microsoft 365; everything here is edited or deleted from Staff > Library like any other article.
   A line that is only a YouTube link is shown as an embedded video. The four videos below are third-party picks that match their topic;
   they have NOT been reviewed by IT, so watch them and swap or remove any you don't want to stand behind. */

export interface Starter { title: string; category: string; body: string }

export const PACK: Starter[] = [
  {
    title: "How to take a screenshot and attach it to a ticket",
    category: "Other",
    body: `A picture of the problem is the fastest way to get it fixed.

## Windows 11
1. Press **Windows key + Shift + S**. The screen dims.
2. Drag a box around the problem (or pick a window or full screen from the bar at the top).
3. The picture is now copied. Click in the ticket (or the chat on your ticket) and press **Ctrl + V** to paste it.

## On a phone
Press the power and volume-up buttons together, then attach the photo from your gallery.

## Tips
- Include the whole error message, not just part of it.
- Never include passwords or personal details in a picture.

https://www.youtube.com/watch?v=wUQXMLNQwAk`,
  },
  {
    title: "How to write a ticket that gets fixed faster",
    category: "Other",
    body: `The more IT knows on the first message, the fewer questions you get back.

## Say
- **What happened**, and what you expected to happen.
- **The exact error message** (a screenshot is best).
- **When it started**, and whether anything changed before that (an update, a new password, a move).
- **What you already tried.**
- **Where you are** (floor, room or desk) if it involves a device.

## Don't
- Don't put passwords in a ticket. IT will never ask for your password.
- Don't raise the same problem twice. Reply on your existing ticket instead.

## Priority
Every ticket starts as medium and IT sets the priority. If something stops a whole team from working, say so in the first line.`,
  },
  {
    title: "Set up Microsoft sign-in with the Authenticator app (MFA)",
    category: "Accounts & Access",
    body: `Multi-factor authentication (MFA) means a thief with your password still can't get in.

## What you need
Your phone, and a few minutes on your computer.

## Steps
1. On your phone, install **Microsoft Authenticator** from the App Store or Google Play.
2. On your computer, go to **https://aka.ms/mysecurityinfo** and sign in with your work account.
3. Choose **Add sign-in method > Authenticator app** and follow the prompts. A QR code appears.
4. In the phone app tap **+ > Work or school account > Scan a QR code** and scan it.
5. Approve the test notification on your phone.

## Good to know
- Only approve a sign-in you started yourself. If a request appears and you did nothing, tap **Deny** and tell IT.
- Getting a new phone? Add the new one **before** you hand in the old one.
- Lost your phone? Raise a ticket straight away.

https://www.youtube.com/watch?v=HDseXZWVQ8s`,
  },
  {
    title: "How to spot a phishing email",
    category: "Accounts & Access",
    body: `Phishing emails try to trick you into clicking a link, opening a file or giving away a password. They look more convincing every year.

## Warning signs
- A **sense of panic**: "Your account will be closed today", "Urgent payment needed".
- An **unexpected request** for money, gift cards, bank details or a password, even from a name you know.
- A sender address that is **slightly wrong** (fortressghana.co instead of the real domain).
- A link whose address **doesn't match** what it says. Hover over it (don't click) to see where it really goes.
- **Unexpected attachments**, especially .zip, .html, or Office files asking you to "enable content".
- Poor spelling or an odd greeting.

## If you're not sure
1. **Don't click** anything and don't reply.
2. Forward it to IT as an attachment, or raise a ticket and attach a screenshot.
3. Check by phoning the sender on a number you already know.

## If you already clicked or typed your password
Tell IT **immediately**. Speed matters far more than embarrassment, and nobody gets in trouble for reporting.

https://www.youtube.com/watch?v=67ueWajFc4I`,
  },
  {
    title: "Choosing a strong password you can remember",
    category: "Accounts & Access",
    body: `Length beats complexity. A long phrase is stronger and easier to remember than a short jumble.

## Good
- Three or four unrelated words with a number or symbol: **tractor-lemon-river-47**
- At least **14 characters**.
- A **different** password for every important account.

## Avoid
- Names, birthdays, football teams or the company name.
- Adding 1 or ! to an old password.
- Using your work password anywhere else.
- Writing it on a sticky note, or sharing it, even with IT.

## Tips
- Use the password manager IT recommends if there is one.
- Change it straight away if you think someone saw it.`,
  },
  {
    title: "Teams: my microphone, speakers or camera don't work in a meeting",
    category: "Microsoft 365",
    body: `## In the meeting
1. Check you aren't muted: the microphone icon should have no slash through it.
2. Click **More > Settings > Devices** (or the arrow next to the mic) and choose the right microphone, speaker and camera. Use **Make a test call**.
3. Is a headset plugged in but the sound comes from elsewhere? Pick the headset in the same list.

## In Windows
1. Open **Settings > Privacy & security > Microphone** (and **Camera**) and make sure access is **On**, including for desktop apps.
2. Open **Settings > System > Sound** and check the right input device is chosen and its bar moves when you speak.
3. Unplug the headset, plug it back in, and **restart Teams** (right-click the Teams icon near the clock > Quit).

## Still no luck?
Join from your phone for now, then raise a ticket and tell us which headset or camera you use.

https://www.youtube.com/watch?v=AY4iyud2EH4`,
  },
  {
    title: "Outlook: I can't send or receive email",
    category: "Microsoft 365",
    body: `## Check these in order
1. Look at the bottom of Outlook. If it says **Working Offline** or **Disconnected**, open **Send / Receive** and turn **Work Offline** off.
2. Open a website. No internet means this is a network problem, not Outlook.
3. Sign in at **outlook.office.com**. If email works there, your account is fine and only the app needs fixing.
4. Check your **Outbox**. A stuck message blocks the others: open it, remove a very large attachment, and send again.
5. Close Outlook completely and reopen it, then restart the computer.

## Mailbox full?
You'll see a warning about the size. Empty **Deleted Items** and **Junk**, and archive or delete large old messages (**Home > Clean Up**).

## Attachment too big?
Email limits are about 20 MB. Upload the file to **OneDrive**, choose **Share**, and send the link instead.`,
  },
  {
    title: "Outlook tips: out of office, signature, and finding old emails",
    category: "Microsoft 365",
    body: `## Out of office
1. In Outlook choose **File > Automatic replies** (or in the web app: the gear icon > **Automatic replies**).
2. Turn it on, set the dates, and write one message for colleagues and one for outside senders.

## Signature
**File > Options > Mail > Signatures.** Keep it short: name, role, phone number.

## Find an old email
- Click the search box and type a name, subject or word, then choose **All Mailboxes** or **Current Mailbox**.
- Use **From:**, **Has attachment** and **Date** filters to narrow it down.

## Calendar
- To see a colleague's free time: **New meeting > Scheduling Assistant**.
- Add a Teams link to any invitation with **Teams Meeting**.`,
  },
  {
    title: "OneDrive and SharePoint: files aren't syncing or I can't find a file",
    category: "Microsoft 365",
    body: `## Check the cloud icon near the clock
- A **blue cloud** with arrows means it's syncing, so give it time.
- A **red X** or **yellow triangle** means an error: click the icon to read it.
- **Paused**: click the icon, then **Resume syncing**.

## Common fixes
1. Make sure you are signed in to OneDrive with your work account.
2. Is your computer disk almost full? Free some space (see "Free up space on my computer").
3. Long file names, or characters like # % & : / in a name, can stop a file syncing. Rename it.
4. Close the file in Word or Excel and wait a minute: open files can't finish syncing.

## Lost a file?
- Search at **office.com** (the search box at the top finds files by name or content).
- Deleted by mistake? Open OneDrive on the web and use the **Recycle bin**. Files stay there for 93 days.
- Overwrote the wrong version? Right-click the file > **Version history**.

## Sharing safely
Choose **Share > People you choose** and type names. Avoid "Anyone with the link" for company documents.`,
  },
  {
    title: "Excel or Word crashed and I lost my work",
    category: "Software",
    body: `## Recover it
1. Reopen the program. A **Document Recovery** panel often appears on the left. Pick the newest version and **Save As** straight away.
2. If nothing appears: **File > Info > Manage Document** (or **Manage Workbook**) **> Recover Unsaved Documents**.
3. For files saved on OneDrive or SharePoint: **File > Info > Version History** shows earlier copies.

## Stop it happening again
- Save to **OneDrive** or **SharePoint**: they save as you type (look for **AutoSave** at the top left).
- If AutoSave is off, press **Ctrl + S** every few minutes.
- If Excel keeps crashing with one workbook, open it in **Safe mode**: hold **Ctrl** while opening Excel.

## Tell IT if
It crashes with every file, or only after a particular add-in is on.`,
  },
  {
    title: "Free up space on my computer (disk almost full)",
    category: "Hardware",
    body: `A nearly full C: drive makes everything slow and stops updates installing.

## See what is using it
**Settings > System > Storage** shows what takes the space.

## Safe things to clear
1. **Recycle Bin**: right-click it > **Empty**.
2. **Downloads** folder: delete installers and old files you don't need.
3. **Temporary files**: in Storage choose **Temporary files**, tick them, and click **Remove files**.
4. **Storage Sense**: switch it on to tidy up automatically.
5. Large videos and photos: move them to OneDrive and choose **Free up space** on them.

## Don't
- Don't delete Windows, Program Files or folders you don't recognise.
- Don't delete anything you cannot replace without checking.

Still low? Raise a ticket. A bigger disk or a clean-up may be needed.`,
  },
  {
    title: "Windows says it needs to restart for updates",
    category: "Software",
    body: `Updates fix security holes. Putting them off leaves your computer exposed.

## What to do
1. Save and close your work.
2. Choose **Start > Power > Update and restart**. This takes 10 to 30 minutes, so do it at lunch or end of day.
3. Don't switch off or unplug during an update. The screen may restart more than once.

## It keeps asking?
- Restart at least once a week. Closing the lid is **not** a restart.
- Use **Settings > Windows Update > Active hours** to stop restarts during your working day.

## Update stuck or failed?
If it's been stuck for over an hour or says "Undoing changes", leave it a while, then raise a ticket with the message on screen.`,
  },
  {
    title: "My laptop won't start, shows a blue screen, or restarts by itself",
    category: "Hardware",
    body: `## First
1. Write down or photograph any **error text** (for a blue screen, the **stop code** at the bottom).
2. Unplug everything: USB drives, docks, extra screens, headsets. Then hold the power button for 10 seconds, wait, and start it again.
3. Check the charger light and cable. A flat battery can look like a dead laptop. Charge for 20 minutes first.

## Don't
- Don't keep pressing the power button repeatedly.
- Don't open the laptop or remove the battery.

## Then
Raise a ticket and attach the photo of the error. If it's the only machine you have, say so, and IT will arrange a loan laptop.`,
  },
  {
    title: "Connecting to the company network or VPN from home",
    category: "Network",
    body: `## Before you connect
- Make sure your home internet works (open a website).
- Update Windows and restart the laptop once a week.

## Connect
1. Open the VPN app IT installed (or **Settings > Network > VPN**) and choose **Connect**.
2. Sign in with your work account and approve the MFA prompt on your phone.
3. Wait for **Connected** before opening shared drives or internal sites.

## Not connecting?
- Disconnect and try again after switching Wi-Fi off and on.
- Try your phone's hotspot. If it works there, your home internet or router is the cause.
- Check the date and time on your laptop are right.
- If the error mentions a certificate or password, raise a ticket with a screenshot.

## Safety
Never use public Wi-Fi (cafés, airports) for company work without the VPN switched on.`,
  },
  {
    title: "Slow internet or Wi-Fi in the office",
    category: "Network",
    body: `## Is it only you?
Ask a colleague next to you. If they are fine too, the problem is your computer. If they are slow as well, tell IT. It's the network.

## Try these
1. Turn Wi-Fi off and back on (the airplane-mode key on a laptop).
2. Move closer to an access point, or check you are on the right network.
3. Close streaming, large downloads and cloud backups running in the background.
4. Restart the computer.
5. Plug in with a network cable if a socket is nearby. It is faster and steadier.

## Tell IT
- **Where** you were (floor and room).
- **When** it was slow, and for how long.
- What you were trying to do (video calls, a website, a shared drive).`,
  },
  {
    title: "Printing and scanning: common fixes",
    category: "Printing",
    body: `## Prints are blank, faint or streaky
- The toner may be low. Look at the printer's screen for a message and tell IT which one it is.
- Printed pages with lines across them usually mean the drum or toner needs replacing.

## Paper jam
1. Open the doors the printer's screen points to.
2. Pull the paper out gently in the direction of travel. Never yank it.
3. Close everything and wait for it to restart.
Raise a ticket if jams keep happening on the same printer.

## The job went to the wrong printer
**Ctrl + P**, then use the printer list at the top to choose the right one before pressing **Print**. Right-click the right printer and choose **Set as default** to stop it happening.

## Scan to email doesn't arrive
Check your address was typed correctly at the printer, look in **Junk**, and try again. If it still fails, raise a ticket with the printer name.

## Large or confidential prints
Use the secure-release option if your printer has one. Collect printouts straight away.`,
  },
  {
    title: "Meeting room screens, projectors and conference audio",
    category: "AV / Production",
    body: `## The screen shows "No signal"
1. Check the laptop cable (HDMI or USB-C) is pushed in at **both** ends.
2. On the screen, use the remote to choose the right **Input** (HDMI 1, HDMI 2…).
3. On your laptop press **Windows key + P** and choose **Duplicate** or **Extend**.

## The picture is fine but there is no sound
- Open **Settings > System > Sound** and pick the room's screen or speaker as the output.
- Check the room speaker's volume knob and mute button.

## Video calls in the room
- In Teams choose the **room's microphone and speaker** (not the laptop's) under **Devices**.
- Mute your laptop's microphone if the room one is in use, or you get echo.

## Before an important meeting
Test the room **ten minutes earlier**. If something doesn't work, raise a ticket marked **urgent** and say the room and the time.`,
  },
  {
    title: "CCTV and security cameras: who to tell and what not to touch",
    category: "CCTV / Security",
    body: `## Report it if
- A camera is **offline**, blurry, pointing the wrong way or its light is off.
- You need to **see or export** footage after an incident.
- A recorder is beeping or showing an error.

## When you raise the ticket
- Say **which camera or area** and the **date and time** of anything you need footage for. Footage is overwritten after a set number of days, so report quickly.
- If it's about an incident, ask your manager before sharing any footage with anyone.

## Please don't
- Don't turn cameras, recorders or their power off, or unplug cables.
- Don't move or cover a camera.
- Don't share footage by messaging apps or personal email.`,
  },
  {
    title: "Phones and tablets: get work email safely",
    category: "Microsoft 365",
    body: `## Set up
1. Install **Outlook** from the App Store or Google Play (the built-in Mail app is less secure for work).
2. Open it, choose **Add account**, and sign in with your work email.
3. Approve the MFA request, and accept the security prompts about a screen lock.

## Keep it safe
- Use a **PIN or fingerprint** to unlock your phone.
- Keep the phone's software up to date.
- If it is **lost or stolen**, tell IT at once so your account can be secured.

## Don't
- Don't forward company email to a personal account.
- Don't leave your phone unlocked and unattended.`,
  },
  {
    title: "Lost or stolen laptop, phone or USB drive",
    category: "Accounts & Access",
    body: `Report it **immediately**: every minute counts, even late at night or on a weekend.

## Do now
1. Tell IT and your manager. Raise an **urgent** ticket or phone IT directly.
2. Say **what** it was, **when and where** you last had it, and whether it was locked or had company files or email on it.
3. If it was stolen, report it to the police and keep the reference number.
4. Change your password from another device if IT hasn't done it for you.

## What IT will do
Lock your accounts, sign the device out, and wipe it remotely where possible.

## No blame
Reporting fast protects you and the company. Hiding it makes the damage much worse.`,
  },
  {
    title: "Keyboard shortcuts that save time every day",
    category: "Software",
    body: `## Everyday
- **Ctrl + C / X / V**: copy, cut, paste
- **Ctrl + Z / Y**: undo, redo
- **Ctrl + F**: find on a page or in a document
- **Ctrl + S**: save
- **Alt + Tab**: switch between open programs
- **Windows key + D**: show the desktop
- **Windows key + L**: lock your screen when you step away

## Windows
- **Windows key + Shift + S**: take a screenshot
- **Windows key + V**: clipboard history
- **Windows key + .**: emoji and symbols

## Browser
- **Ctrl + T / W**: new tab, close tab
- **Ctrl + Shift + T**: reopen a tab you closed by mistake
- **Ctrl + Shift + Delete**: clear browsing data

## Teams
- **Ctrl + Shift + M**: mute or unmute
- **Ctrl + Shift + O**: camera on or off`,
  },
  {
    title: "Website or app is acting strangely: clear the browser cache",
    category: "Software",
    body: `A saved copy of a page can make a site look broken or stop a login working.

## Quick fix
1. Press **Ctrl + Shift + R** to reload the page without the saved copy.
2. Still wrong? Press **Ctrl + Shift + Delete**.
3. Choose **Cached images and files** (leave passwords unticked), set the time range to **All time**, and click **Clear now**.
4. Close the browser completely and open it again.

## Try a private window
Press **Ctrl + Shift + N** (Edge, Chrome) and open the site there. If it works, the problem is the saved data in your normal window.

## Tell IT
Which site, which browser, and the exact message you see. A screenshot is ideal.`,
  },
  {
    title: "Which computer is mine? Finding your computer name and IP address",
    category: "Other",
    body: `IT sometimes asks for these to find your machine quickly.

## Computer name
**Settings > System > About**. The name is under **Device name**.

## IP address
1. Press **Windows key + R**, type **cmd**, and press **Enter**.
2. Type **ipconfig** and press **Enter**.
3. Look for **IPv4 Address** (for example 192.168.1.44).

## The easy way
Open **Your account** on this helpdesk and use **Send hardware details to IT**. It gathers everything for IT in one go.`,
  },
  {
    title: "Getting started: your accounts, email and who to call",
    category: "Other",
    body: `## Your first day
- Sign in to Windows with your work account.
- Set up **MFA** on your phone (see "Set up Microsoft sign-in with the Authenticator app").
- Open **Outlook** and **Teams** and check you can send and receive.
- Find your files in **OneDrive** and your team's files in **SharePoint**.

## This helpdesk
- **Submit a ticket** for anything that isn't working. You'll be asked to pick a category and write a short summary.
- **My queue** shows where your tickets are.
- **Live board** shows what IT is working on.
- **Help** (this page) has quick fixes for common problems.

## Good habits
- Lock your screen (**Windows key + L**) when you leave your desk.
- Restart your computer at least once a week.
- Report anything odd early, before it becomes a big problem.`,
  },
];
