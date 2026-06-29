# Interview Copilot

Electron desktop app (React UI) that listens to your mic (and optionally system/interviewer
audio via a loopback device), transcribes live with Deepgram, and generates suggested answers
with Claude. The app window is excluded from screen capture/recording on macOS and Windows via
`BrowserWindow.setContentProtection(true)`, so it stays invisible during screen shares.

## Structure

- `electron/` — Electron main process + preload (window creation, content protection)
- `renderer/` — React UI (Vite), runs inside the Electron window
- `backend/` — Express + WebSocket server: bridges audio → Deepgram live STT → Claude → UI

## Setup

### 1. Install dependencies

```bash
npm install                       # root (Electron)
npm install --prefix backend
npm install --prefix renderer
```

### 2. Backend API keys

```bash
cp backend/.env.example backend/.env
```

Fill in:
- `DEEPGRAM_API_KEY` — https://console.deepgram.com
- `ANTHROPIC_API_KEY` — https://console.anthropic.com

### 3. (Optional) Capture interviewer audio too, not just your mic

macOS doesn't expose system output audio as an input device by default. Install
[BlackHole](https://github.com/ExistentialAudio/BlackHole) (free virtual audio driver):

1. Install BlackHole 2ch.
2. In **Audio MIDI Setup**, create a Multi-Output Device combining your speakers + BlackHole 2ch,
   and set it as your system output (so you still hear audio while it's also routed to BlackHole).
3. In the app's device dropdown, select **BlackHole 2ch** (or a combined aggregate device that
   includes both your mic and BlackHole) as the input — this lets the app hear both you and the
   interviewer (e.g. from Zoom/Meet).

Without this, the app only hears your own microphone.

### 4. Run in development

In three terminals:

```bash
npm run dev:backend     # starts Express+WS server on :8787
npm run dev:renderer    # starts Vite dev server on :5173
npm run dev:electron    # launches the Electron window
```

## Notes / caveats

- Content protection (window invisibility during screen share) is solid on macOS and Windows
  10 2004+/11. Not reliably supported on Linux.
- This hides the *window*, not the audio capture itself — make sure your screen-share doesn't
  also share system audio in a way that exposes the assistant's voice output (this app doesn't
  speak answers aloud, it only displays text).
- Many interview platforms/employers prohibit this kind of tool during real interviews — use for
  practice/mock interviews or contexts where it's permitted.
