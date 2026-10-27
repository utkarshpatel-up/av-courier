# AV Courier

Copy · Find · Tell. A TeraCopy-style copy queue that also catches data requests
from WhatsApp and Gmail, looks them up in the drive/tape catalogue, and tells
each person on the channel they asked on when their copy is ready.

## Pages

| Page | |
|---|---|
| **Copy Queue** | Jobs run one after another, one file at a time, MD5-verified. Pause/resume, skip file, cancel, hold, reorder, retry failed. **+ Files** adds to a job even while it runs; ✕ on a file removes it. Drop files on the window (or on a job to add to it), or Explorer → Send to → AV Courier. Each finished job writes a CSV report. The queue survives a restart. |
| **Requests** | Everything that looks like a data request, from WhatsApp, Gmail, or pasted by hand (text or a screenshot, Ctrl+V). Each is read for drive/tape numbers, dates and keywords and matched against the catalogue straight away. Reply with the location, reply "not found", or **Copy selected…** to queue the copy with the requester already set to be told. Unanswered requests remind you every hour. |
| **Find Data** | Search the imported Excel catalogue: `HDD 123`, `lto 45`, `janmashtami ahmedabad 16 aug`. Drive/tape numbers match however they are written (HDD-0123 = drive 123 = hdd no 123). |
| **Channels** | WhatsApp Web (linked by QR inside the app), Gmail (App Password; replies stay in the thread), optional Claude API key for loosely written requests and pictures. |
| **Settings** | Conflict rule, verify, buffer, message templates, auto-send, reminder time, Send to menu., phone remote. |

## Catalogue
Export the archive database to Excel every quarter or half-year and **Find Data →
Import catalogue**. Columns are detected from their headers (Drive, Tape, Event/Title,
Date, Place, Folder/Path); every column is searched either way. If the path column
points at a connected drive, **Copy selected…** fills in the source for you.

## Run
```
npm install
npm start
npm test
npm run dist:win    # Windows installer into dist/
npm run dist:mac    # macOS .dmg into dist/ — on a Mac only
```
Settings, queue, requests, reports and encrypted passwords live in
`%APPDATA%\AV Courier` (Settings → Open data folder); on a Mac in
`~/Library/Application Support/AV Courier`.

**macOS build.** A `.dmg` can only be made on a Mac. There, with Node.js 20+ and the Xcode
command-line tools (`xcode-select --install`), run `bash scripts/build-mac.sh` (this Mac's chip),
or add `universal` / `arm64` / `x64`. It installs the packages, runs the tests and writes
`dist/AV-Courier-<version>-mac-<arch>.dmg`. The app is not signed with an Apple Developer ID
(only "ad hoc", which Apple silicon needs), so open it the first time with right-click → Open;
if macOS says it is damaged, run `xattr -dr com.apple.quarantine "/Applications/AV Courier.app"`.
On a Mac, "Send to" and drive/tape names are Windows-only; drives appear under `/Volumes`.

## Sign in with Google (instead of an App Password)
Work Google accounts (Google Workspace) often do not allow App Passwords. Then use **Channels → Gmail →
Log in with: Sign in with Google**. It needs an OAuth client, made once in your organisation's Google Cloud
(about 10 minutes; if your account may not create projects, ask IT to do steps 1–5):

1. Open **console.cloud.google.com** signed in with the work account (e.g. you@dadabhagwan.org) and create a
   project, e.g. *AV Courier*.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **Google Auth Platform → Branding**: app name *AV Courier*, your email as support and developer contact.
4. **Audience**: choose **Internal**. Only accounts of your organisation can then use it, and Google does not
   need to review it.
5. **Data Access → Add or remove scopes** → add `https://mail.google.com/` → Save.
6. **Clients → Create client** → type **Desktop app**, name *AV Courier* → copy the **Client ID** and
   **Client secret**.
7. In AV Courier → **Channels → Gmail**: choose *Sign in with Google*, paste the ID and secret, press
   **Sign in with Google**, and allow access on Google's page in the browser. The Gmail address fills itself in.

The app keeps only the lasting sign-in token, encrypted with the Windows account; it never sees the password.
Mail checks, replies and the Gmail sync between computers all use it. Withdraw it any time with **Sign out**, or
in your Google Account → Security → *Third-party connections*. Each computer signs in once with the same client.
The code is `electron/google-auth.js`.

## More than one computer
Run AV Courier on, say, the office PC and a MacBook. On each, **Settings → Other computers**: name the
computer, leave **Through** on *the Gmail account*, and turn on **Share request status**. That is all: it uses
the Gmail address and App Password already saved on the Channels page (the same account on every computer).
A request you reply to, copy, mark not found or close on one computer then shows as done on the others within
about a minute, with a line such as “Replied on whatsapp: … — on Office PC” in its history. A computer that was
off catches up when it starts; one that is offline writes its updates once it is back.

The updates are kept as small notes in a Gmail label, **AV Courier sync**: saved straight into the label over
IMAP, already read, never in the inbox, and never sent to anyone. Each computer only adds its own notes, and moves
its notes older than a month to the bin, so it stays at a few KB. Instead of Gmail you can choose *a shared folder*
that every computer syncs (Google Drive for desktop, OneDrive, a network share).

Emails are matched by their Message-ID; WhatsApp messages by chat, opening words and time (within 20 minutes),
because each computer catches them separately. Only request status is shared: the copy queue, drives, tapes and
catalogue stay with their own computer. Keep **Send the “ready” message automatically** on for one computer only.
The code is `electron/sync.js`.

## Pictures (screenshots, photos of a monitor)

The words in a request's pictures are read on this computer with Tesseract: offline, free, in
English, Gujarati and Hindi (Gujarati less reliably). They go through the same pattern reader as
typed text, and are shown under **Words read from the picture** on the request. It reads letters
only: a poster with a picture and a styled title needs the optional Claude key. Photos of a
monitor read best taken straight on, close, sharp and without glare.

## Phone (Android companion)
The Android app in `android/` catches requests from the phone's own WhatsApp and Gmail notifications, hands
them to this PC, and lets you reply, queue copies, pause/resume and start tapes from the phone. Turn it on
in **Settings → Phone** and pair with the one-time code or QR. When WhatsApp Web here is not linked or a send
fails, "data is ready" messages are handed to the paired phone to send; the Activity log says which route
was used. The server (`electron/remote.js`) answers only paired phones on the local network. Build and
install steps, and the limits (muted chats, "📷 Photo", sideloaded APK), are in `android/README.md`.

## WhatsApp notes
WhatsApp Web runs in a hidden window of the app. Turn **Watch WhatsApp** on, click
**Open WhatsApp window** and scan the QR code once. Messages are picked up from
WhatsApp's notifications (muted chats raise none) and from unread chats. Pictures:
open the chat in that window and press **From open WhatsApp chat**. Sending types
into the chat found by its exact name. WhatsApp changes its page now and then; all
selectors are in `electron/whatsapp.js`.
