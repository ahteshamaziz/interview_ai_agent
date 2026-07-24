# Interview Copilot — Application Guide

## What this application does

**Interview Copilot** is an Electron desktop app that acts as a real-time interview assistant. It:

1. Listens to your microphone (and optionally interviewer/system audio via a loopback device)
2. Transcribes speech live with **Deepgram**
3. Looks up or generates suggested answers with **Claude** (Anthropic)
4. Shows answers in a floating, always-on-top overlay window that can be **hidden from screen share**

You can also type questions manually or capture the screen when a coding/interview question is visible visually. Answers are cached in MongoDB with semantic similarity so repeated or similar questions reuse previous answers instead of calling the model every time.

---

## Architecture

| Layer | Path | Role |
|-------|------|------|
| Electron main | `electron/` | Window creation, stealth/content protection, screen capture, window move IPC |
| Renderer (UI) | `renderer/` | React + Vite UI inside the Electron window |
| Backend | `backend/` | Express + WebSocket: audio → Deepgram → knowledge base / Claude → UI |

```
Mic / typed text / screenshot
        │
        ▼
  Electron + React UI  ──WebSocket/HTTP──►  Express backend (:8787)
                                                │
                         ┌──────────────────────┼──────────────────────┐
                         ▼                      ▼                      ▼
                    Deepgram STT           MongoDB KB            Claude Sonnet
                 (live transcript)     (exact + semantic)      (answer generation)
```

---

## Features

### 1. Live audio listening & transcription

- Choose an input device from a dropdown (mic or virtual loopback like BlackHole).
- **Start Listening** opens a WebSocket to the backend and streams mic audio as WebM/Opus chunks every 250ms.
- Deepgram (`nova-2`) returns interim and final transcripts.
- The UI shows a live **“Hearing:”** line and a mic level meter (`hearing audio` / `silence`).
- After a short silence debounce, the backend treats the utterance as a question and generates/looks up an answer.

**Tuning (backend `.env`):**

| Variable | Default | Purpose |
|----------|---------|---------|
| `DG_ENDPOINTING_MS` | `900` | Deepgram endpointing sensitivity; higher = fewer splits on short pauses |
| `UTTERANCE_SILENCE_MS` | `900` | Silence wait before answering |
| `MIN_UTTERANCE_CHARS` | `12` | Ignore very short fragments |

### 2. AI answer generation

- Uses **Claude Sonnet** (`claude-sonnet-4-6`) with a system prompt for calm, spoken-style interview answers.
- Answers are concise (under ~500 words), often in bullets, with code examples for technical questions.
- Duplicate back-to-back identical questions within 3 seconds are ignored.

### 3. Knowledge base / answer cache (MongoDB)

- Answers are stored in `knowledge_entries`.
- Lookup order:
  1. **Exact** match on normalized question text
  2. **Semantic** match via local embeddings (`Xenova/all-MiniLM-L6-v2`), cosine similarity ≥ `0.85`
- Cache hits show a **memory** badge; model calls show a **model** badge.
- Hit count and `lastUsedAt` are updated on cache hits.
- On startup, missing embeddings are backfilled.

### 4. Typed questions

- Fallback when audio is unclear: type the question in the text box and press **Send** (or **Enter**).
- **Shift+Enter** inserts a new line (does not send).
- Works while listening (over the open WebSocket) or via a temporary WebSocket if not listening.

### 5. Screenshot / screen question capture

- Captures the primary screen (PNG thumbnail via Electron `desktopCapturer`).
- Saves the image under `screenshots/`.
- Claude extracts the question text from the image, then the same cache + model pipeline answers it.
- On macOS, screen recording permission is required; the app opens System Settings if missing.

### 6. Stealth / content protection (“Hide”)

- Window uses `setContentProtection(true)` so it is excluded from screen capture/recording on macOS and Windows.
- Toggle in the header: **Hide: ON** / **Hide: OFF**.
- Default is ON when the Electron APIs are available.

### 7. Floating overlay UI

- Frameless, transparent, always-on-top window.
- Visible on all workspaces / over fullscreen apps (macOS).
- Drag the header title area to move the window.
- Opacity slider (20%–100%) for how translucent the overlay is.
- Q&A log shows newest answers first, with Markdown + syntax-highlighted code blocks.

### 8. Interviewer audio (optional setup)

macOS does not expose system output as an input by default. With [BlackHole](https://github.com/ExistentialAudio/BlackHole):

1. Install BlackHole 2ch.
2. Create a Multi-Output Device (speakers + BlackHole) in Audio MIDI Setup.
3. Select BlackHole (or an aggregate with mic + BlackHole) in the app’s device dropdown.

Without this, the app only hears your microphone.

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl/Cmd + L** | Start or stop listening |
| **Ctrl/Cmd + K** | Focus the “type question” text box |
| **Ctrl/Cmd + P** | Capture screen and analyze for a question |
| **Ctrl/Cmd + Shift + X** | Clear Q/A history (ignored while typing in an input) |
| **Alt + Arrow keys** | Move the window (12px per press) |
| **Alt + Shift + Arrow keys** | Move the window faster (40px per press) |
| **Enter** (in text box) | Send typed question |
| **Shift + Enter** (in text box) | New line in the text box |

Notes:

- On macOS, use **Cmd**; on Windows/Linux, use **Ctrl**.
- Most Ctrl/Cmd shortcuts still work while typing; clear-history (`Ctrl/Cmd+Shift+X`) does not fire inside inputs/textareas.
- Window move requires Electron `appConfig.moveWindow` (desktop app, not a plain browser tab).

---

## UI controls summary

| Control | What it does |
|---------|----------------|
| Device dropdown | Select mic / loopback input (disabled while listening) |
| Start Listening / Stop | Begin or end audio + WebSocket session |
| Hide: ON/OFF | Toggle content protection (stealth) |
| Opacity slider | Window background transparency |
| Capture Screen | Screenshot → extract question → answer |
| Type + Send | Submit a text question |
| Status label | `idle`, `connected`, `transcription-ready`, `capturing…`, errors, etc. |
| Mic meter | Live input level while listening |
| Q/A log | Questions + Markdown answers with memory/model source badges |

---

## API surface (backend)

| Endpoint / channel | Purpose |
|--------------------|---------|
| `GET /health` | Health check `{ ok: true }` |
| `POST /analyze-screenshot` | Body `{ imageBase64 }` → extract question + answer |
| `WS /ws` | Binary audio chunks → Deepgram; JSON `{ type: "text-question", text }` → answer |

**WebSocket messages to UI:**

- `{ type: "status", message }`
- `{ type: "transcript", text, isFinal }`
- `{ type: "answer", question, answer, source, matchType?, matchedQuestion? }`
- `{ type: "error", message }`

---

## Environment variables

Copy `backend/.env.example` → `backend/.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPGRAM_API_KEY` | Yes | Deepgram live STT |
| `ANTHROPIC_API_KEY` | Yes | Claude answers + screenshot OCR |
| `PORT` | No | Default `8787` |
| `MONGODB_URI` | No | Default `mongodb://127.0.0.1:27017/interview_ai` |
| `DG_ENDPOINTING_MS` | No | Speech endpointing (ms) |
| `UTTERANCE_SILENCE_MS` | No | Silence debounce before answer (ms) |
| `MIN_UTTERANCE_CHARS` | No | Minimum utterance length |

---

## How to run (development)

```bash
npm install
npm install --prefix backend
npm install --prefix renderer

# three terminals
npm run dev:backend    # Express + WS on :8787
npm run dev:renderer   # Vite on :5173
npm run dev:electron   # Electron window
```

Requires MongoDB running locally (or a URI in `.env`).

---

## Caveats

- Content protection is reliable on **macOS** and **Windows 10 2004+/11**; not reliable on Linux.
- Stealth hides the **window**, not audio capture. The app does not speak answers aloud.
- Many interview platforms prohibit this kind of tool in real interviews — intended for practice/mock interviews where permitted.
