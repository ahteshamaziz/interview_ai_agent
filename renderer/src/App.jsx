import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

const WS_URL = window.appConfig?.backendWsUrl ?? 'ws://localhost:8787/ws';
const BACKEND_HTTP_URL = WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '');

const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const SHIFT = IS_MAC ? '⇧' : 'Shift+';

const SHORTCUTS = {
  listen: `${MOD}L`,
  focus: `${MOD}K`,
  capture: `${MOD}P`,
  autoDetect: `${MOD}${SHIFT}A`,
  clear: `${MOD}${SHIFT}X`,
  send: '↵',
};

function Kbd({ children }) {
  return <span className="kbd">{children}</span>;
}

// Auto-detect tuning: poll a cheap low-res thumbnail, only pay for a full
// capture + analysis once the screen has held still for a couple of polls.
const AUTO_DETECT_POLL_MS = 2000;
const AUTO_DETECT_STABLE_POLLS = 2;
const AUTO_DETECT_HASH_SIZE = 16; // 16x16 -> 256-bit hash
const AUTO_DETECT_CHANGE_THRESHOLD = 10; // hamming distance out of 256 bits
const AUTO_DETECT_PREVIEW_SIZE = { width: 320, height: 180 };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Cheap perceptual hash (average hash) so we can tell "screen changed" from
// "screen identical" without shipping every frame to the backend.
async function computeImageHash(base64Png) {
  const img = await loadImage(`data:image/png;base64,${base64Png}`);
  const size = AUTO_DETECT_HASH_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const gray = new Array(size * size);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  const avg = gray.reduce((a, b) => a + b, 0) / gray.length;
  let bits = '';
  for (const g of gray) bits += g >= avg ? '1' : '0';
  return bits;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export default function App() {
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [qaLog, setQaLog] = useState([]);
  const [statusMessage, setStatusMessage] = useState('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [textInput, setTextInput] = useState('');
  const [isSendingText, setIsSendingText] = useState(false);
  const [opacity, setOpacity] = useState(0.85);
  const [stealthEnabled, setStealthEnabled] = useState(true);
  const [stealthAvailable, setStealthAvailable] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [autoDetectEnabled, setAutoDetectEnabled] = useState(false);
  const [autoDetectStatus, setAutoDetectStatus] = useState('off');

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const levelLoopRef = useRef(null);
  const textareaRef = useRef(null);
  const autoDetectBusyRef = useRef(false);

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((deviceList) => {
      const inputs = deviceList.filter((d) => d.kind === 'audioinput');
      setDevices(inputs);
      if (inputs.length > 0) setSelectedDeviceId(inputs[0].deviceId);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hasApi =
      Boolean(window.appConfig?.getContentProtection) &&
      Boolean(window.appConfig?.setContentProtection);
    setStealthAvailable(hasApi);
    if (!hasApi) return;

    window.appConfig
      .getContentProtection()
      .then((enabled) => {
        if (!cancelled) setStealthEnabled(Boolean(enabled));
      })
      .catch(() => {
        if (!cancelled) setStealthAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleStealth() {
    if (!stealthAvailable) return;
    const next = !stealthEnabled;
    setStealthEnabled(next);
    try {
      await window.appConfig.setContentProtection(next);
    } catch {
      // revert if it failed
      setStealthEnabled(!next);
    }
  }

  async function analyzeScreenshotImage(imageBase64) {
    const res = await fetch(`${BACKEND_HTTP_URL}/analyze-screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || 'screenshot analyze failed');

    if (payload.question) {
      setQaLog((prev) => [
        ...prev,
        {
          question: payload.question,
          answer: payload.answer,
          source: payload.source,
          matchType: payload.matchType,
          matchedQuestion: payload.matchedQuestion,
          savedAs: payload.savedAs,
        },
      ]);
    }
    return payload;
  }

  async function captureAndAnalyzeScreen() {
    if (!window.appConfig?.captureScreen) {
      setStatusMessage('screenshot unavailable');
      return;
    }
    setIsCapturing(true);
    setStatusMessage('capturing...');
    try {
      const imageBase64 = await window.appConfig.captureScreen();
      const payload = await analyzeScreenshotImage(imageBase64);
      setStatusMessage(payload.question ? 'screenshot answered' : 'no question detected');
    } catch (err) {
      setStatusMessage(err.message || 'screenshot error');
    } finally {
      setIsCapturing(false);
    }
  }

  function toggleAutoDetect() {
    setAutoDetectEnabled((prev) => !prev);
  }

  // Auto-detect loop: poll a cheap low-res thumbnail on an interval, and only
  // pay for a full-resolution capture + backend analysis once the screen has
  // held still for a couple of consecutive polls (avoids re-answering while
  // you're scrolling/typing, and avoids re-answering a screen we already saw).
  useEffect(() => {
    if (!autoDetectEnabled) {
      setAutoDetectStatus('off');
      return;
    }
    if (!window.appConfig?.captureScreen) {
      setAutoDetectStatus('unavailable');
      return;
    }

    let cancelled = false;
    let prevHash = null;
    let lastAnalyzedHash = null;
    let stableCount = 0;

    setAutoDetectStatus('watching');

    const poll = async () => {
      if (cancelled || autoDetectBusyRef.current) return;
      try {
        const previewBase64 = await window.appConfig.captureScreen(AUTO_DETECT_PREVIEW_SIZE);
        if (cancelled) return;
        const hash = await computeImageHash(previewBase64);
        if (cancelled) return;

        const changed = !prevHash || hammingDistance(hash, prevHash) > AUTO_DETECT_CHANGE_THRESHOLD;
        stableCount = changed ? 0 : stableCount + 1;
        prevHash = hash;

        const alreadyAnalyzed =
          lastAnalyzedHash && hammingDistance(hash, lastAnalyzedHash) <= AUTO_DETECT_CHANGE_THRESHOLD;

        if (stableCount >= AUTO_DETECT_STABLE_POLLS - 1 && !alreadyAnalyzed) {
          autoDetectBusyRef.current = true;
          lastAnalyzedHash = hash;
          setAutoDetectStatus('analyzing');
          try {
            const fullBase64 = await window.appConfig.captureScreen();
            if (!cancelled) {
              const payload = await analyzeScreenshotImage(fullBase64);
              setAutoDetectStatus(payload.question ? 'answered' : 'watching');
            }
          } finally {
            autoDetectBusyRef.current = false;
          }
        }
      } catch (err) {
        if (!cancelled) setAutoDetectStatus(err.message || 'error');
      }
    };

    const id = setInterval(poll, AUTO_DETECT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [autoDetectEnabled]);

  async function clearQaHistory() {
    setQaLog([]);
    setStatusMessage('history-cleared');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'clear-history' }));
      return;
    }
    try {
      await fetch(`${BACKEND_HTTP_URL}/clear-history`, { method: 'POST' });
    } catch {
      // Backend may be down; UI is still cleared.
    }
  }

  useEffect(() => {
    const onKeyDown = (e) => {
      // Avoid stealing keystrokes while typing (except explicit shortcuts).
      const isTypingTarget =
        e.target &&
        (e.target.tagName === 'TEXTAREA' ||
          e.target.tagName === 'INPUT' ||
          e.target.isContentEditable);

      const key = e.key;
      const ctrlOrCmd = e.ctrlKey || e.metaKey;

      // Window move: Alt + Arrow (Shift = faster)
      if (e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        const step = e.shiftKey ? 40 : 12;
        const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
        const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
        window.appConfig?.moveWindow?.(dx, dy);
        return;
      }

      // Shortcuts below require Ctrl/Cmd
      if (!ctrlOrCmd) return;

      // Ctrl/Cmd + L: start/stop listening
      if (key.toLowerCase() === 'l') {
        e.preventDefault();
        if (isListening) stopListening();
        else startListening();
        return;
      }

      // Ctrl/Cmd + K: focus typing box
      if (key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
        return;
      }

      // Ctrl/Cmd + P: capture screenshot
      if (key.toLowerCase() === 'p') {
        e.preventDefault();
        captureAndAnalyzeScreen();
        return;
      }

      // Ctrl/Cmd + Shift + A: toggle auto-detect
      if (e.shiftKey && key.toLowerCase() === 'a') {
        e.preventDefault();
        toggleAutoDetect();
        return;
      }

      // Ctrl/Cmd + Shift + X: clear Q/A history
      if (e.shiftKey && key.toLowerCase() === 'x') {
        e.preventDefault();
        if (isTypingTarget) return;
        clearQaHistory();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isListening, stealthAvailable, stealthEnabled]);

  function handleWsPayload(payload) {
    if (payload.type === 'status') {
      setStatusMessage(payload.message);
      return;
    }
    if (payload.type === 'transcript') {
      setTranscript(payload.text);
      return;
    }
    if (payload.type === 'answer-start') {
      setStatusMessage('answering…');
      setQaLog((prev) => [
        ...prev,
        {
          question: payload.question,
          answer: '',
          source: 'model',
          streaming: true,
        },
      ]);
      setTranscript('');
      return;
    }
    if (payload.type === 'answer-delta') {
      setQaLog((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].question === payload.question && next[i].streaming) {
            next[i] = { ...next[i], answer: next[i].answer + payload.delta };
            break;
          }
        }
        return next;
      });
      return;
    }
    if (payload.type === 'answer-done') {
      setStatusMessage('answered');
      setQaLog((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].question === payload.question && next[i].streaming) {
            next[i] = {
              ...next[i],
              answer: payload.answer || next[i].answer,
              source: payload.source,
              matchType: payload.matchType,
              matchedQuestion: payload.matchedQuestion,
              streaming: false,
            };
            break;
          }
        }
        return next;
      });
      return;
    }
    if (payload.type === 'answer') {
      setStatusMessage('answered');
      setQaLog((prev) => {
        const next = [...prev];
        // Replace streaming placeholder if we already opened one for a cache hit.
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].question === payload.question && next[i].streaming) {
            next[i] = {
              question: payload.question,
              answer: payload.answer,
              source: payload.source,
              matchType: payload.matchType,
              matchedQuestion: payload.matchedQuestion,
              streaming: false,
            };
            return next;
          }
        }
        return [
          ...prev,
          {
            question: payload.question,
            answer: payload.answer,
            source: payload.source,
            matchType: payload.matchType,
            matchedQuestion: payload.matchedQuestion,
          },
        ];
      });
      setTranscript('');
      return;
    }
    if (payload.type === 'error') {
      setStatusMessage(payload.message);
    }
  }

  async function startListening() {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setStatusMessage('connected');
    ws.onclose = () => setStatusMessage('disconnected');
    ws.onerror = () => setStatusMessage('error');

    ws.onmessage = (event) => {
      handleWsPayload(JSON.parse(event.data));
    };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined },
    });
    streamRef.current = stream;

    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(event.data);
      }
    };

    mediaRecorder.start(250);
    setIsListening(true);

    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      setMicLevel(Math.min(1, rms * 4));
      levelLoopRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopListening() {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    wsRef.current?.close();
    if (levelLoopRef.current) cancelAnimationFrame(levelLoopRef.current);
    audioContextRef.current?.close();
    setMicLevel(0);
    setIsListening(false);
    setStatusMessage('idle');
  }

  async function sendTextQuestion() {
    const trimmedText = textInput.trim();
    if (!trimmedText) return;

    setIsSendingText(true);
    setTextInput('');

    // If audio WebSocket is open, use it
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'text-question', text: trimmedText }));
      setIsSendingText(false);
      return;
    }

    // Otherwise create a temporary connection just for this text question
    const tempWs = new WebSocket(WS_URL);

    tempWs.onopen = () => {
      tempWs.send(JSON.stringify({ type: 'text-question', text: trimmedText }));
    };

    tempWs.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      handleWsPayload(payload);
      if (payload.type === 'answer' || payload.type === 'answer-done' || payload.type === 'error') {
        tempWs.close();
      }
    };

    tempWs.onerror = () => {
      setStatusMessage('connection error');
      setIsSendingText(false);
    };

    tempWs.onclose = () => {
      setIsSendingText(false);
    };
  }

  function handleTextKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTextQuestion();
    }
  }

  return (
    <div className="app" style={{ backgroundColor: `rgba(17, 20, 24, ${opacity})` }}>
      <header className="drag-region">
        <h1>Interview Copilot</h1>
        <div className="header-right">
          {stealthAvailable && (
            <button
              type="button"
              tabIndex={-1}
              className={`stealth-toggle ${stealthEnabled ? 'stealth-on' : 'stealth-off'}`}
              onClick={toggleStealth}
              title={
                stealthEnabled
                  ? 'Stealth ON: window is excluded from screen capture'
                  : 'Stealth OFF: window may appear in screen capture'
              }
            >
              {stealthEnabled ? 'Hide: ON' : 'Hide: OFF'}
            </button>
          )}
          <input
            type="range"
            className="opacity-slider"
            min="0.2"
            max="1"
            step="0.05"
            value={opacity}
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
            title={`Opacity: ${Math.round(opacity * 100)}%`}
          />
          <span className={`status status-${statusMessage}`}>{statusMessage}</span>
        </div>
      </header>

      <div className="controls">
        <select
          value={selectedDeviceId}
          onChange={(e) => setSelectedDeviceId(e.target.value)}
          disabled={isListening}
        >
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>

        {!isListening ? (
          <button onClick={startListening} title={`Start listening (${SHORTCUTS.listen})`}>
            Start Listening <Kbd>{SHORTCUTS.listen}</Kbd>
          </button>
        ) : (
          <button onClick={stopListening} title={`Stop listening (${SHORTCUTS.listen})`}>
            Stop <Kbd>{SHORTCUTS.listen}</Kbd>
          </button>
        )}
      </div>

      {isListening && (
        <div className="mic-meter">
          <span className="mic-dot" />
          <div className="mic-bar-track">
            <div className="mic-bar-fill" style={{ width: `${Math.round(micLevel * 100)}%` }} />
          </div>
          <span className="mic-meter-label">{micLevel > 0.03 ? 'hearing audio' : 'silence'}</span>
        </div>
      )}

      {transcript && (
        <div className="live-transcript">
          <strong>Hearing:</strong> {transcript}
        </div>
      )}

      <div className="screenshot-section">
        <button
          className="screenshot-btn"
          onClick={captureAndAnalyzeScreen}
          disabled={isCapturing}
          title={`Capture screen (${SHORTCUTS.capture})`}
        >
          {isCapturing ? 'Capturing…' : 'Capture Screen'} <Kbd>{SHORTCUTS.capture}</Kbd>
        </button>
        <button
          className={`auto-detect-btn ${autoDetectEnabled ? 'auto-detect-on' : ''}`}
          onClick={toggleAutoDetect}
          title={`Auto-detect questions on screen (${SHORTCUTS.autoDetect})`}
        >
          {autoDetectEnabled ? `Auto-Detect: ${autoDetectStatus}` : 'Auto-Detect: OFF'}{' '}
          <Kbd>{SHORTCUTS.autoDetect}</Kbd>
        </button>
      </div>

      <div className="text-input-section">
        <div className="text-input-label">
          Type question if audio is unclear <Kbd>{SHORTCUTS.focus}</Kbd>
        </div>
        <div className="text-input-row">
          <textarea
            className="text-input"
            placeholder="Type the interview question here..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={handleTextKeyDown}
            disabled={isSendingText}
            rows={2}
            ref={textareaRef}
          />
          <button
            className="send-btn"
            onClick={sendTextQuestion}
            disabled={!textInput.trim() || isSendingText}
            title={`Send question (${SHORTCUTS.send})`}
          >
            {isSendingText ? '...' : (
              <>
                Send <Kbd>{SHORTCUTS.send}</Kbd>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="qa-log">
        {qaLog
          .slice()
          .reverse()
          .map((qa, i) => (
            <div key={i} className="qa-item">
              <div className="question">
                Q: {qa.question}
                {qa.streaming ? (
                  <span className="source-badge source-streaming">streaming</span>
                ) : qa.source ? (
                  <span className={`source-badge ${qa.source === 'cache' ? 'source-cache' : 'source-model'}`}>
                    {qa.source === 'cache' ? 'memory' : 'model'}
                  </span>
                ) : null}
              </div>
              <div className="answer">
                <ReactMarkdown
                  components={{
                    code({ node, inline, className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '');
                      return !inline && match ? (
                        <SyntaxHighlighter
                          style={oneDark}
                          language={match[1]}
                          PreTag="div"
                          customStyle={{
                            margin: '8px 0',
                            borderRadius: '6px',
                            fontSize: '12px',
                          }}
                          {...props}
                        >
                          {String(children).replace(/\n$/, '')}
                        </SyntaxHighlighter>
                      ) : (
                        <code className="inline-code" {...props}>
                          {children}
                        </code>
                      );
                    },
                  }}
                >
                  {qa.answer}
                </ReactMarkdown>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
