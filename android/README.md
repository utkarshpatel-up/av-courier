# AV Courier for Android

The phone companion to the AV Courier desktop app. It:

1. **Catches data requests on the phone.** It reads WhatsApp, WhatsApp Business and Gmail notifications
   (sender or chat, message, time) and decides whether each one is a data request with the same rules as
   the desktop app (`Heuristic.kt` is a port of `heuristic()` in `electron/extract.js`). Gujarati/Hindi wording
   such as “joie che”, “mokalo”, “bhejo” and “chahiye” is understood, and bank, bill and promo messages are ignored.
2. **Hands each request to the PC** when it is reachable, so it lands in the PC's Requests inbox. When the PC
   is off, requests stay in the phone's own inbox, which reminds you of unanswered ones (every 60 min by default),
   and they are handed over once the PC is back.
3. **Replies from the phone.** When the PC is off, or WhatsApp Web on the PC is not linked or fails, the
   “data is ready” and “here is where it is” messages go out through the phone's WhatsApp:
   - with the notification's own **Reply** action for that chat (sent at once, nothing to tap), or
   - if there is none, WhatsApp opens with the text filled in (the `wa.me` link when the phone number is
     known, otherwise WhatsApp's chat picker) and you tap **Send**. When the app is in the background, Android
     only allows this from a notification: tap **Tap to send to …**. The text is also copied.
4. **Controls the PC.** Open requests with their catalogue matches, replying, **Copy selected to…** (added
   to the PC's queue with the requester set to be told), queue progress, **Pause / Resume / Skip file**,
   **Tape ready — start** for held copies and **Tape ready — scan** for LTO tapes. Both always ask
   “is the drive light steady?” first.

## Scan a picture

Find tab → **Scan a picture**: take a photo (of a monitor, a poster, a list) or pick a screenshot,
or share a picture to AV Courier from WhatsApp or Gallery. Google ML Kit reads its words on the
phone, offline (English and Hindi; no Gujarati). Correct any misread words, then **Search
catalogue** or **Add as request** (with the WhatsApp chat name of who asked, so replies reach them).

## Known limits

- **Muted chats raise no notification**, so the app cannot see them. Unmute chats that send requests.
- **Photos usually come through only as “📷 Photo”.** Ask for the details in words, or open the chat in
  the PC's WhatsApp window and use *From open WhatsApp chat*.
- **The APK is sideloaded**, not installed from the Play Store (steps below).
- Reply actions live in memory. After the phone restarts or the app is killed, a chat needs one new
  message before replies can be sent without a tap. Until then the chat opens with the text filled in.
- Gmail notifications carry the sender's name but not the address. Replies to an email caught only on the
  phone open Gmail with the text filled in, and you pick the person. Emails the PC caught itself are answered by the PC.
- Some phones (Xiaomi, Oppo, Vivo, Samsung) stop background apps. Set AV Courier's battery use to
  *Unrestricted* so it keeps catching requests and stays linked to the PC.

## Build the APK

Built and tested on this PC with Android Studio's own Java (25) and SDK, Gradle 9.8.2 and the
Android Gradle plugin 9.4.1, which compiles the Kotlin itself (Kotlin 2.4.21).

**Android Studio:** *File → Open* → this `android` folder → *Build → Build App Bundle(s) / APK(s) → Build APK(s)*.

**Command line** (Git Bash, from this folder):
```
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
./gradlew assembleDebug
./gradlew testDebugUnitTest
```
The APK is `app/build/outputs/apk/debug/app-debug.apk`. `local.properties` (not shared) points at the SDK in
`%LOCALAPPDATA%\Android\Sdk`; Android Studio writes it for you when it opens the project.

`HeuristicTest` mirrors the desktop tests *Gujarati and Hindi requests are recognised* and *bank, bill and
promo messages are not data requests*, plus a table of results printed by the JS version. If
`electron/extract.js` changes, regenerate that table.

## Install on the phone (sideload)

1. Copy `app-debug.apk` to the phone (USB, Quick Share, or Google Drive) and open it.
2. Allow *Install unknown apps* for the app you opened it with when Android asks.
3. Open **AV Courier** → allow notifications → **Open notification access** → turn AV Courier on.

## Pair with the PC

1. On the PC: **AV Courier → Settings → Phone** → turn **Phone remote on** → **Pair a phone…**
   A QR code and a 6-digit code appear (valid once, for 10 minutes).
2. On the phone (same Wi-Fi): **PC** tab → **Scan pairing code**, or **Type the code** with the PC address shown.
3. Allow AV Courier through the Windows firewall on *Private* networks when Windows asks (port 8765 by default).

The phone gets its own key, kept encrypted on both sides (Android Keystore / Windows account). The PC
answers only paired phones and only on the local network. **Unpair** on either side withdraws the key.

## How the pieces fit

| File | |
|---|---|
| `CatchService.kt` | Notification listener: reads WhatsApp/Gmail notifications and keeps each chat's reply action. |
| `NotificationParser.kt` | Turns a notification into messages (MessagingStyle, group chats, Gmail subject + snippet). |
| `Heuristic.kt` | Is it a data request? Port of `electron/extract.js` and the `ids()`/`dates()` helpers. |
| `Inbox.kt` | The phone's inbox, joining a chat's messages within 10 minutes like the PC does. |
| `PcLink.kt` | Pairing, calls on the PC's `api`, and the event stream (queue, requests, messages to send). |
| `Sender.kt` | Sends from the phone: reply action, or the chat opened with the text filled in. |
| `ReminderWorker.kt` | Every 15 min: reconnect, hand over requests, remind about unanswered ones. |
| `MainActivity.kt` / `RequestActivity.kt` | The screens. |

On the PC the other half is `electron/remote.js`, plus the phone channel in `electron/notifier.js`.
