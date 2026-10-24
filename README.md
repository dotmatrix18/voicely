# 🎙️ Voicely: voice-only chat

A real-time messenger with one rule: **you can only talk.** There's no text box anywhere in the chat, and no captions or transcripts, so every message, reaction and profile "bio" is audio. The only things you ever type are your username and display name at sign-up, and a username when adding a contact.

| Chats (light) | Voice chat (dark) | Locked recording | Voice hello profile |
|---|---|---|---|
| ![Chats](screenshots/light-mobile-contacts.png) | ![Chat](screenshots/dark-mobile-chat.png) | ![Recording](screenshots/light-mobile-recording.png) | ![Profile](screenshots/dark-mobile-profile.png) |

![Desktop two-pane](screenshots/light-desktop-chat.png)

## What's new in v3 (UI/UX redesign)

### Design system
- **Tokens** in `public/css/tokens.css`: an Inter variable font (bundled, works offline), a type scale, a 4-pt spacing scale, radii, elevation (`--shadow-1..3`) and motion curves and durations.
- **Light and dark themes.** The app follows the system setting by default, and you can override it in **Me → Appearance**.
- **Six accent colours** (violet, ocean, teal, coral, rose, amber) recolour buttons, bubbles, waveforms and the mic. Theme and accent are applied before first paint, so there's no flash.
- Each contact gets a **gradient avatar** from their username. Their chat has a matching soft **ambient background**.

### Layout & motion
- **Mobile layout:**
  - Native-style app bar with **large titles that collapse on scroll**.
  - **Bottom tab bar** (Chats · Rooms · Me) with an unread badge.
  - Screens **slide** between each other, and you can **swipe from the left edge** to go back.
  - **Pull to refresh** on lists.
- **Desktop and tablet (≥ 900 px):** a **two-pane** layout, with the list on the left and the chat on the right. Sheets become centred dialogs.
- **Loading and feedback:**
  - **Skeleton** placeholders while loading.
  - Inline **SVG illustrations** for empty states.
  - Toasts, and **bottom sheets** with a drag handle.
- **Accessibility:**
  - All animation respects `prefers-reduced-motion`.
  - Visible focus rings and ARIA labels and roles throughout: sliders, radio groups, live regions.

### Chat
- **Bubbles:**
  - Bubbles have **tails**. Consecutive notes within 5 minutes are **grouped** with tighter corners.
  - **Day separators** ("Today", "Yesterday", weekday) and a **sticky date chip** while you scroll.
  - Bubble width grows with note length.
- **Delivery ticks:**
  - ✓ sent
  - ✓✓ delivered (reached their device)
  - 🎧 **listened** (they actually played it: 60% or to the end)
  - In group rooms the tick shows how many people listened.
  - Unplayed notes have an accent dot.
- **Playback:**
  - **Scrubbable waveform** with a knob: tap or drag to seek, or use the arrow keys.
  - **1× / 1.5× / 2×** speed.
- **Jump to latest** button with a counter for new notes that arrived while you were scrolled up.

### Recorder
- **Floating mic button** with a ring that **pulses with your voice level**, plus **haptics** (on devices that support vibration).
- **Basic controls:**
  - **Hold** to talk and release to send.
  - **Slide ← to cancel**, with a fading "slide to cancel" hint.
  - **Slide ↑ to lock** for hands-free recording, shown by an animated lock rail. A quick tap also locks.
- **Locked mode:** a live scrolling waveform and timer. Tap ■ to **preview** the note: play it back, see the waveform with the trimmed parts greyed out, toggle **trim** on or off, then send ➤ or discard 🗑.
- **Desktop:** hold **Space** to talk, and press **Esc** to cancel.
- Notes are capped at 2 minutes, with a warning in the last 10 seconds, then the note sends automatically.

## Innovative features
1. **🎧 Voice hello.** Your profile "bio" is a voice clip of up to 10 s, recorded in **Me**. Contacts hear it when they open your profile or find you in **Add contact**. The server accepts audio only.
2. **🟣 Live "talking" presence.** While a contact records a note for you, their avatar **ring pulses with their real-time mic level**, and the row reads "Recording a voice note…". This works in the chat list, in the chat header, and in rooms. Only levels are sent, never audio.
3. **🎧 Listen mode.** One tap on the headphones in a chat plays all **unplayed** notes back-to-back. A **mini player** persists across screens (title, progress, next, close), and it hooks into the **Media Session API**, so lock-screen and headset controls work.
4. **😂 Voice reactions.** Long-press (or right-click, or tap the ☺ button) on any note to react with a **voice clip of up to 5 s**, like a laugh or a "wow". Reactions appear as small playable pills under the bubble. They are audio only, with a maximum of 3 per person per note.
5. **✂️ Smart silence trimming + cleaner audio.**
   - Recording uses noise suppression, echo cancellation and auto gain, plus a high-pass filter and compressor.
   - Before sending, leading and trailing silence is detected with an adaptive threshold and trimmed. You can preview the result and toggle trimming off.
   - The server checks WAV lengths against the file header.
6. **🌈 Per-contact ambience.** Every conversation gets its own gradient avatar and a matching subtle background, so you can tell chats apart at a glance.

## Everything from before still works

### Account (no password)
- On first launch, you pick a **unique username** (3–20 characters: lowercase letters, numbers or `_`, checked live as you type) and a **display name**.
- The server issues a random 256-bit **secret token**. The browser keeps it in `localStorage`, and the server stores only its SHA-256 hash.
- **Link another device:** go to **Me → Link another device**. It shows a one-time 8-character code (valid for 10 minutes) and a `/pair/<code>` link. On the new device, enter the code or open the link and confirm. Each device gets its own token, and **Sign out** revokes only that device.

### Contacts
- **The Chats list:**
  - Each contact shows an avatar with an online dot, the last note's tick and duration, the time, and an unread count.
  - **Requests** appear at the top with Accept / Decline.
  - **Add contact** (top right) searches by exact username. You can also share your `/add/<username>` link.
- **Remove or block** from the contact's profile: tap the chat header or ⋯. Blocked users can be managed in **Me → Blocked users**.

### Private 1:1 voice chats and group rooms
- Opening a contact goes to `/c/<username>`, a private room (`dm-<idA>-<idB>`). The server lets only those two contacts in, and checks this on join, send, history, receipts, reactions and every audio download (authenticated with an HttpOnly cookie).
- **Rooms tab:** join or create a room by code and share `/r/<code>`. Recent rooms are remembered.
- **Formats:**
  - The app records a format the browser supports: `audio/mp4` (Safari, iOS, recent Chrome), or WebM/Ogg with Opus.
  - Trimmed notes are sent as WAV.
  - The server checks real file signatures.
- **Installable PWA:** the app shell works offline, and voice notes are cached after the first play.

### Voice-only enforcement (server)
These are all rejected:
- plain strings and `{text}` objects
- extra fields such as captions, `text` or `bio`
- non-audio bytes, even if labelled `audio/*`
- a non-`audio/*` MIME type
- notes longer than 2 minutes, reactions longer than 5 s (or over 200 KB), and voice hellos longer than 10 s (or over 400 KB)
- WAV files whose header length doesn't match the claimed duration
- unknown socket events (`message`, `text`, `chat`, …)
- any unknown `/api/*` route

There's also a rate limit of 10 audio uploads per 30 seconds per connection, plus limits on sign-up and pairing attempts.

## Run locally (MacBook)

You need [Node.js 18+](https://nodejs.org) (`brew install node`).

```bash
cd voice-only-chat
npm install
npm start          # → http://localhost:3000
```

To try contacts by yourself, open a normal window and a private/incognito window (they're separate accounts). Create two users, add one from the other, accept, and talk.

Settings (environment variables): `PORT` (3000), `DATA_DIR` (`./data`), `MAX_DURATION_SEC` (120), `MAX_BYTES` (5 MB).

## Use it from your phone on the same Wi-Fi

Browsers **only allow the microphone on `https://` or `localhost`**. Over `http://192.168.x.x:3000` the page loads, but the mic won't work.

**Option A: built-in self-signed HTTPS**
```bash
npm run cert          # certificate for localhost + your Mac's LAN IPs
npm run start:https   # prints https://<your-mac-ip>:3000
```
Open that URL on your phone and accept the certificate warning:
- **Android:** tap *Advanced → Proceed*.
- **iPhone:** tap *Show Details → visit this website*. If the mic is still blocked, AirDrop `certs/cert.pem` to the phone, install it, and enable full trust under *Settings → General → About → Certificate Trust Settings*.

If your Mac's IP changes, run `npm run cert` again.

**Option B: tunnel (real HTTPS, also works over mobile data)**
```bash
cloudflared tunnel --url http://localhost:3000   # brew install cloudflared
# or: ngrok http 3000
```

Then sign up on the phone, or use **Me → Link another device** to use your Mac account on the phone. On iPhone, *Share → Add to Home Screen* gives you a full-screen app.

## Deploy

It's a single Node process. Everything lives in `DATA_DIR`: `db.json` holds users, token hashes, contacts, requests, blocks, the voice-note index and read markers, and `audio/` holds the voice notes. On a host without a persistent disk, accounts and history reset whenever the process restarts.

- **Render (free plan):** choose *New → Blueprint* and pick your repo. `render.yaml` creates a **free** web service with **no persistent disk**, and data is stored in `./data` on the instance's temporary filesystem. That means **every restart, redeploy, or spin-down wipes all accounts, contacts, voice notes and voice hellos.** People then have to sign up and add each other again, and their phones will be signed out. Free services also sleep after about 15 minutes without traffic, and the first visit after that takes up to a minute to wake (which also resets data). This is fine for demos and trying it with friends. To keep data later, switch to a paid instance, add a `disk:` block (e.g. `mountPath: /var/data`, `sizeGB: 1`) and set `DATA_DIR=/var/data`.
- **Railway:** deploy from GitHub, add a Volume at `/data`, set `DATA_DIR=/data`, and generate a domain.
- **Docker:** `docker build -t voicely . && docker run -p 3000:3000 -v voicely-data:/data voicely`. Put it behind HTTPS.

WebSockets must be allowed by your host (Render, Railway and Fly allow them by default). If you put the app behind more than one proxy, adjust `app.set('trust proxy', 1)` in `server.js`.

Upgrading from v1: an old `data/messages.json` is imported automatically as group-room history.

## Tests

```bash
npm test               # 115 API/socket checks + 11 audio-tool unit checks:
                       #   sign-up, tokens hashed, pairing, contact request/accept/decline/remove/block,
                       #   DM privacy, delivered/listened receipts (incl. delivered-on-reconnect),
                       #   talking presence relayed only to contacts, voice reactions (audio-only, ≤5 s,
                       #   ≤200 KB, WAV length verified, target must exist, non-contacts refused),
                       #   voice hello (audio-only, ≤10 s, sign-in required to fetch, delete),
                       #   text payloads rejected, group rooms, persistence across a restart;
                       #   silence detection/trim, peaks, WAV encoding (test/audio-tools.test.mjs)
npm run test:browser   # 45 checks in headless Chrome with a fake mic (fed from test/fixtures/fake-voice.wav):
                       #   sign-up, add + accept, talking pulse, slide-up lock, preview, trim, send,
                       #   slide-to-cancel, listened tick, voice reaction, listen mode + mini player +
                       #   Media Session, voice hello, theme/accent persist, edge swipe-back, desktop
                       #   two-pane via pairing, Space-to-talk, rooms, non-contact refused, service worker
npm run screenshots    # seeds a demo account and saves light/dark × mobile/desktop shots to ./screenshots
                       #   (browser timezone Asia/Kolkata)
```
On macOS, set `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` before the browser commands.

## Code layout

```
server.js                 HTTP API, audio serving with access checks, Socket.IO (voice, receipts, reactions, voice hello, talking)
lib/store.js              JSON-file store: users (+ voice hello), tokens (hashed), contacts, requests, blocks, messages, reads
lib/audio.js              Voice validation (magic bytes, duration/size limits, WAV header length)
public/index.html         All screens: onboarding, list pane (Chats / Rooms / Me), chat pane, composer, mini player, sheet
public/css/tokens.css     Design tokens: font, type & spacing scales, radii, shadows, motion, light/dark palettes
public/css/base.css       Components: buttons, inputs, avatars, rows, sheets, toasts, skeletons, empty states
public/css/app.css        Layout & screens: shell, app bar, tab bar, chat, bubbles, composer, mini player, profile
public/js/main.js         App controller: routing, socket events, lists, profile, sheets, chat screen
public/js/timeline.js     Bubbles, grouping, day separators, ticks, scrubbing, reactions, sticky date, jump-to-latest
public/js/composer.js     Recorder gestures & states (hold / slide-cancel / slide-lock / preview / trim)
public/js/capture.js      Mic capture, Web Audio clean-up chain, live levels
public/js/audio-tools.js  Silence detection & trimming, peaks, WAV encoding (pure functions, unit-tested)
public/js/player.js       Global player, listen-mode queue, mini player, Media Session
public/js/mini-recorder.js  Compact recorder for reactions & voice hello
public/js/gestures.js     Collapsing titles, pull-to-refresh, swipe-back
public/js/theme*.js       Theme + accent (boot script prevents flashes)
public/js/util.js         DOM helper, icons, avatars/gradients, time formatting, toast, sheets, haptics
public/js/illustrations.js  Inline SVG empty-state art
test/                     run-test.js, audio-tools.test.mjs, browser-test.js, screenshots.js, fixtures/
```

To restyle, change the variables in `tokens.css`. The accent palette is in `public/js/theme-boot.js`.

## Limitations

- **No password or recovery.** The account lives in the browser token. Link a second device to keep a backup. The pairing screen has no QR image.
- **Not end-to-end encrypted.** The server operator can access the audio files. Group rooms are open to anyone signed in who has the code.
- **Small-scale storage.** A JSON file is fine for friends and small groups. For more users, move to SQLite/Postgres plus object storage (everything is isolated in `lib/store.js`). On Render's free plan, data resets whenever the service restarts (see Deploy).
- **Notifications and recording:**
  - **No push notifications** when the app is closed.
  - Haptics need the Vibration API, which iPhone Safari doesn't support.
  - **iOS** stops recording if the phone locks mid-note.
- **Larger trimmed notes.** Trimmed notes are re-encoded as WAV (24 kHz mono, or 16 kHz for long notes so they stay under the 5 MB limit), which is bigger than compressed audio. They're only re-encoded when trimming saves at least 0.35 s.
- **Browser coverage.** Tested in desktop and mobile-emulated Chrome. Real iOS Safari hasn't been tested yet, and older Safari (before 17) may not play Opus notes recorded by other browsers.
