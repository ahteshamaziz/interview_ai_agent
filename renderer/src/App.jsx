import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import SessionSetup from './SessionSetup.jsx';
import {
  PCM_SAMPLE_RATE,
  MAX_VOICE_CLIPS,
  encodeWavBytes,
  createSpeechSegmenter,
  pushVoiceClip,
} from './audioClips.js';

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
  buddy: `${MOD}${SHIFT}B`,
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
  const [session, setSession] = useState(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [buddyEnabled, setBuddyEnabled] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [voiceClips, setVoiceClips] = useState([]);
  const [playingClipId, setPlayingClipId] = useState(null);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const audioContextRef = useRef(null);
  const textareaRef = useRef(null);
  const autoDetectBusyRef = useRef(false);
  const buddyEnabledRef = useRef(false);
  const buddyCaptureRef = useRef(null);
  const buddyBusyRef = useRef(false);
  const buddyQueuedRef = useRef(null);
  const onWsMessageRef = useRef(() => {});
  const isListeningRef = useRef(false);
  const listeningLockRef = useRef(false);
  const listenCancelRef = useRef(false);
  const startListeningRef = useRef(() => {});
  const stopListeningRef = useRef(() => {});
  const voiceClipsRef = useRef([]);
  const playbackRef = useRef(null);
  const flushSpeechRef = useRef(() => {});

  buddyEnabledRef.current = buddyEnabled;

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND_HTTP_URL}/session`)
      .then((res) => res.json())
      .then((payload) => {
        if (!cancelled && payload?.profile) setSession(payload.profile);
      })
      .catch(() => {
        // Backend may still be starting; stay on setup.
      })
      .finally(() => {
        if (!cancelled) setSessionReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function endSession() {
    if (isListening) stopListening();
    setAutoDetectEnabled(false);
    if (buddyEnabledRef.current) {
      buddyEnabledRef.current = false;
      setBuddyEnabled(false);
      try {
        await window.appConfig?.setBuddyEnabled?.(false);
      } catch {
        // Overlay hides on the next successful toggle.
      }
    }
    setQaLog([]);
    setTranscript('');
    clearVoiceClips();
    try {
      await fetch(`${BACKEND_HTTP_URL}/session/clear`, { method: 'POST' });
    } catch {
      // UI still returns to setup even if backend is down.
    }
    setSession(null);
    setStatusMessage('idle');
  }

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

  useEffect(() => {
    if (!window.appConfig?.onBuddyEnabled) return undefined;
    return window.appConfig.onBuddyEnabled((payload) => {
      const enabled = Boolean(payload?.enabled);
      buddyEnabledRef.current = enabled;
      setBuddyEnabled(enabled);
      if (payload && payload.displayId != null) {
        buddyCaptureRef.current = {
          displayId: payload.displayId,
          width: payload.captureSize?.width,
          height: payload.captureSize?.height,
        };
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'buddy-mode', enabled }));
      }
      if (enabled) {
        if (!isListeningRef.current) startListeningRef.current();
      } else if (isListeningRef.current || listeningLockRef.current) {
        stopListeningRef.current();
      }
    });
  }, []);

  useEffect(() => {
    if (!buddyEnabled) return undefined;
    window.appConfig?.pushBuddyEvent?.({ type: 'listening', listening: isListening });
  }, [buddyEnabled, isListening]);

  useEffect(() => {
    if (!buddyEnabled) return undefined;
    window.appConfig?.pushBuddyEvent?.({ type: 'transcript', text: transcript });
  }, [buddyEnabled, transcript]);

  useEffect(() => {
    const sendHits = () => {
      const rects = [...document.querySelectorAll('[data-hit]')].map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          id: node.getAttribute('data-hit'),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      });
      window.appConfig?.setMainHitRects?.(rects);
    };
    const frame = requestAnimationFrame(sendHits);
    window.addEventListener('resize', sendHits);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', sendHits);
    };
  }, [keysOpen, session, sessionReady, buddyEnabled]);

  useEffect(() => {
    if (!window.appConfig?.onKeysHot) return undefined;
    return window.appConfig.onKeysHot((hot) => {
      if (buddyEnabledRef.current) setKeysOpen(Boolean(hot));
    });
  }, []);

  async function toggleBuddy() {
    if (!window.appConfig?.setBuddyEnabled) {
      setStatusMessage('buddy needs the desktop app');
      return;
    }
    const next = !buddyEnabledRef.current;
    try {
      await window.appConfig.setBuddyEnabled(next);
    } catch (err) {
      setStatusMessage(err.message || 'buddy unavailable');
    }
  }

  async function runBuddyQuestion(question) {
    const asked = String(question || '').trim();
    if (!asked || !buddyEnabledRef.current) return;
    if (buddyBusyRef.current) {
      buddyQueuedRef.current = asked;
      return;
    }
    buddyBusyRef.current = true;
    setStatusMessage('capturing…');
    window.appConfig?.pushBuddyEvent?.({ type: 'thinking', question: asked });
    try {
      if (!window.appConfig?.captureScreen) throw new Error('screenshot unavailable');
      const imageBase64 = await window.appConfig.captureScreen(buddyCaptureRef.current || undefined);
      setStatusMessage('pointing…');
      const res = await fetch(`${BACKEND_HTTP_URL}/buddy-point`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: asked, imageBase64 }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'guide failed');
      window.appConfig?.pushBuddyEvent?.({
        type: 'result',
        question: asked,
        answer: payload.answer,
        highlight: payload.highlight,
        label: payload.label,
      });
      setQaLog((prev) => [
        ...prev,
        {
          question: asked,
          answer: payload.answer,
          source: 'guide',
          label: payload.label,
        },
      ]);
      setTranscript('');
      setStatusMessage(payload.highlight ? 'highlighted' : 'answered');
    } catch (err) {
      const message = err.message || 'guide error';
      setStatusMessage(message);
      window.appConfig?.pushBuddyEvent?.({ type: 'error', question: asked, message });
    } finally {
      buddyBusyRef.current = false;
      const next = buddyQueuedRef.current;
      buddyQueuedRef.current = null;
      if (next && buddyEnabledRef.current) runBuddyQuestion(next);
    }
  }

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
      if (!session) return;

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

      // Ctrl/Cmd + Shift + B: toggle the screen guide
      if (e.shiftKey && key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleBuddy();
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
  }, [isListening, stealthAvailable, stealthEnabled, session]);

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

  function updateVoiceClip(id, patch) {
    const next = voiceClipsRef.current.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip));
    voiceClipsRef.current = next;
    setVoiceClips(next);
  }

  function rememberVoiceClip(clip) {
    const prev = voiceClipsRef.current;
    const { next, dropped } = pushVoiceClip(prev, clip);
    for (const droppedClip of dropped) {
      if (playbackRef.current?.id === droppedClip.id) {
        playbackRef.current.audio.pause();
        playbackRef.current = null;
        setPlayingClipId(null);
      }
      URL.revokeObjectURL(droppedClip.url);
    }
    voiceClipsRef.current = next;
    setVoiceClips(next);
  }

  function clearVoiceClips() {
    if (playbackRef.current) {
      playbackRef.current.audio.pause();
      playbackRef.current = null;
    }
    for (const clip of voiceClipsRef.current) URL.revokeObjectURL(clip.url);
    voiceClipsRef.current = [];
    setVoiceClips([]);
    setPlayingClipId(null);
  }

  function toggleClipPlayback(clip) {
    if (playbackRef.current?.id === clip.id) {
      playbackRef.current.audio.pause();
      playbackRef.current = null;
      setPlayingClipId(null);
      return;
    }
    playbackRef.current?.audio.pause();
    const audio = new Audio(clip.url);
    audio.onended = () => {
      if (playbackRef.current?.id === clip.id) {
        playbackRef.current = null;
        setPlayingClipId(null);
      }
    };
    playbackRef.current = { id: clip.id, audio };
    setPlayingClipId(clip.id);
    audio.play().catch(() => {
      playbackRef.current = null;
      setPlayingClipId(null);
    });
  }

  async function retryClipTranscription(clip) {
    updateVoiceClip(clip.id, { status: 'retrying', error: '' });
    try {
      const res = await fetch(`${BACKEND_HTTP_URL}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: clip.blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'transcription failed');
      const text = String(data.text || '').trim();
      updateVoiceClip(clip.id, {
        status: text ? 'ready' : 'empty',
        transcript: text,
        error: text ? '' : 'No speech detected in this clip',
      });
      if (text) {
        setTextInput(text);
        setKeysOpen(true);
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    } catch (err) {
      updateVoiceClip(clip.id, { status: 'error', error: err.message || 'transcription failed' });
    }
  }

  async function startListening() {
    if (listeningLockRef.current || isListeningRef.current) return;
    listeningLockRef.current = true;
    listenCancelRef.current = false;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    const outbound = [];

    const flushOutbound = () => {
      while (outbound.length && ws.readyState === WebSocket.OPEN) {
        ws.send(outbound.shift());
      }
    };

    ws.onopen = () => {
      setStatusMessage('connected');
      ws.send(JSON.stringify({ type: 'buddy-mode', enabled: buddyEnabledRef.current }));
      flushOutbound();
    };
    ws.onclose = () => setStatusMessage('disconnected');
    ws.onerror = () => setStatusMessage('error');

    ws.onmessage = (event) => {
      onWsMessageRef.current(JSON.parse(event.data));
    };

    const sendPcm = (pcm) => {
      if (ws.readyState === WebSocket.OPEN) {
        flushOutbound();
        ws.send(pcm);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        outbound.push(pcm);
        if (outbound.length > 100) outbound.shift();
      }
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: true },
        },
      });
    } catch (err) {
      listeningLockRef.current = false;
      ws.close();
      setStatusMessage(err.message || 'microphone unavailable');
      return;
    }
    if (listenCancelRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      ws.close();
      listeningLockRef.current = false;
      return;
    }
    streamRef.current = stream;
    const micTrack = stream.getAudioTracks()[0];
    if (micTrack) {
      try {
        await micTrack.applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        });
      } catch {
        // Some virtual devices ignore these. Capture still continues.
      }
    }

    const segmenter = createSpeechSegmenter({
      onClip: ({ chunks, durationMs }) => {
        const bytes = encodeWavBytes(chunks, PCM_SAMPLE_RATE);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        rememberVoiceClip({
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          url: URL.createObjectURL(blob),
          blob,
          durationMs,
          label: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          transcript: '',
          status: 'saved',
          error: '',
        });
      },
    });
    flushSpeechRef.current = () => segmenter.flush();

    let audioContext;
    try {
      audioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
    } catch {
      audioContext = new AudioContext();
    }
    audioContextRef.current = audioContext;
    await audioContext.resume();
    if (listenCancelRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      ws.close();
      audioContext.close();
      listeningLockRef.current = false;
      return;
    }

    let lastMeterAt = 0;
    const handleFrame = (input) => {
      if (!isListeningRef.current || !input?.length) return;
      const framed = segmenter.push(input, audioContext.sampleRate);
      if (!framed) return;
      const now = performance.now();
      if (now - lastMeterAt > 80) {
        lastMeterAt = now;
        setMicLevel(Math.min(1, framed.rms * 4));
      }
      sendPcm(framed.pcm);
    };

    const source = audioContext.createMediaStreamSource(stream);
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    mute.connect(audioContext.destination);

    let processor;
    try {
      const workletUrl = URL.createObjectURL(
        new Blob(
          [
            `class PcmCaptureProcessor extends AudioWorkletProcessor {
              process(inputs) {
                const channel = inputs[0] && inputs[0][0];
                if (channel && channel.length) this.port.postMessage(channel);
                return true;
              }
            }
            registerProcessor('pcm-capture', PcmCaptureProcessor);`,
          ],
          { type: 'application/javascript' },
        ),
      );
      await audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      processor = new AudioWorkletNode(audioContext, 'pcm-capture');
      processor.port.onmessage = (event) => handleFrame(event.data);
    } catch {
      if (typeof audioContext.createScriptProcessor !== 'function') {
        stream.getTracks().forEach((track) => track.stop());
        ws.close();
        audioContext.close();
        listeningLockRef.current = false;
        setStatusMessage('audio capture unavailable');
        return;
      }
      processor = audioContext.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => handleFrame(event.inputBuffer.getChannelData(0));
    }

    if (listenCancelRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      ws.close();
      audioContext.close();
      listeningLockRef.current = false;
      return;
    }

    isListeningRef.current = true;
    processorRef.current = processor;
    source.connect(processor);
    processor.connect(mute);
    listeningLockRef.current = false;
    setIsListening(true);
  }

  function stopListening() {
    listenCancelRef.current = true;
    isListeningRef.current = false;
    listeningLockRef.current = false;
    try {
      flushSpeechRef.current();
    } catch {
      // Segmenter may not have started yet.
    }
    flushSpeechRef.current = () => {};
    try {
      processorRef.current?.disconnect();
    } catch {
      // Processor may not have started yet.
    }
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    wsRef.current?.close();
    audioContextRef.current?.close();
    audioContextRef.current = null;
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

  onWsMessageRef.current = (payload) => {
    if (payload.type === 'buddy-question') {
      runBuddyQuestion(payload.question);
      return;
    }
    handleWsPayload(payload);
  };
  startListeningRef.current = startListening;
  stopListeningRef.current = stopListening;

  return (
    <div className="app" style={{ backgroundColor: `rgba(17, 20, 24, ${opacity})` }}>
      <header className="drag-region titlebar" data-hit="title">
        <div className="window-controls">
          <button type="button" className="win-btn win-close" onClick={() => window.appConfig?.windowClose?.()} title="Close">
            ×
          </button>
          <button type="button" className="win-btn win-min" onClick={() => window.appConfig?.windowMinimize?.()} title="Minimize">
            –
          </button>
          <button
            type="button"
            className="win-btn win-full"
            onClick={async () => {
              const next = await window.appConfig?.windowToggleFullscreen?.();
              if (typeof next === 'boolean') setIsFullScreen(next);
            }}
            title={isFullScreen ? 'Exit full screen' : 'Full screen'}
          >
            {isFullScreen ? '↘' : '↗'}
          </button>
        </div>
        <h1>Interview Copilot</h1>
        <span className={`status status-${statusMessage}`}>{statusMessage}</span>
      </header>

      {!sessionReady ? (
        <div className="session-loading">Loading session…</div>
      ) : !session ? (
        <SessionSetup
          backendUrl={BACKEND_HTTP_URL}
          onStarted={(profile) => {
            setSession(profile);
            setStatusMessage('session-ready');
          }}
        />
      ) : (
        <>
      <div className="session-banner">
        <div className="session-banner-text">
          <strong>{session.roleTitle}</strong>
          {session.company ? ` · ${session.company}` : ''}
          {session.primaryLanguage ? ` · ${session.primaryLanguage}` : ''}
        </div>
        <button type="button" className="session-new-btn" onClick={endSession} title="Start a new JD + resume session">
          New
        </button>
      </div>

      <div
        className={`keys-dock ${keysOpen ? 'is-open' : ''}`}
        data-hit="keys"
        onMouseEnter={() => {
          if (!buddyEnabledRef.current) setKeysOpen(true);
        }}
        onMouseLeave={() => {
          if (!buddyEnabledRef.current) setKeysOpen(false);
        }}
      >
        <div className="keys-tab">Controls</div>
        {keysOpen && (
          <div className="keys-panel">
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
            </div>
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
              <button
                type="button"
                className={`buddy-toggle ${buddyEnabled ? 'buddy-on' : ''}`}
                onClick={toggleBuddy}
                title="When on, clicks pass through this window, listening starts, and the buddy asks what to do where you rest the cursor."
              >
                {buddyEnabled ? 'Buddy: ON' : 'Buddy: OFF'} <Kbd>{SHORTCUTS.buddy}</Kbd>
              </button>
            </div>
            {buddyEnabled && (
              <p className="buddy-hint">
                Listening is on. Rest the cursor and the buddy asks what to do. Clicks pass through this window.
              </p>
            )}
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
          </div>
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

      {(isListening || voiceClips.length > 0) && (
        <div className="voice-clips">
          <div className="voice-clips-head">
            <strong>Recent audio</strong>
            <span>Latest {MAX_VOICE_CLIPS} turns are kept. Older ones are deleted.</span>
          </div>
          {voiceClips.length === 0 ? (
            <div className="voice-clips-empty">Speak, and the turn is saved here if the live text is wrong.</div>
          ) : (
            voiceClips.map((clip) => (
              <div key={clip.id} className="voice-clip-row">
                <div className="voice-clip-meta">
                  <div className="voice-clip-title">
                    {clip.label} · {(clip.durationMs / 1000).toFixed(1)}s
                  </div>
                  <div className="voice-clip-text">
                    {clip.status === 'retrying'
                      ? 'Converting to text…'
                      : clip.transcript || clip.error || 'Saved — retry if the live transcript missed it'}
                  </div>
                </div>
                <button type="button" className="clip-btn" onClick={() => toggleClipPlayback(clip)}>
                  {playingClipId === clip.id ? 'Stop' : 'Play'}
                </button>
                <button
                  type="button"
                  className="clip-btn"
                  onClick={() => retryClipTranscription(clip)}
                  disabled={clip.status === 'retrying'}
                >
                  {clip.status === 'retrying' ? 'Working…' : 'Retry text'}
                </button>
              </div>
            ))
          )}
        </div>
      )}

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
                  <span className={`source-badge ${qa.source === 'cache' ? 'source-cache' : qa.source === 'guide' ? 'source-guide' : 'source-model'}`}>
                    {qa.source === 'cache' ? 'memory' : qa.source === 'guide' ? 'guide' : 'model'}
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
        </>
      )}
    </div>
  );
}
