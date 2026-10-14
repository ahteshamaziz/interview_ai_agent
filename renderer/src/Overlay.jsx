import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

const ASK_TEXT = 'What do you want to do here?';
const DWELL_MS = 700;
const MOVE_PX = 28;

function isOverInteractive(x, y) {
  const nodes = document.querySelectorAll('[data-interactive]');
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (x >= rect.left - 8 && x <= rect.right + 8 && y >= rect.top - 8 && y <= rect.bottom + 8) {
      return true;
    }
  }
  return false;
}

export default function Overlay() {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [thinking, setThinking] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [label, setLabel] = useState('');
  const [bubble, setBubble] = useState(null);

  const buddyRef = useRef(null);
  const interactiveRef = useRef(false);
  const pointerDownRef = useRef(false);
  const dwellTimerRef = useRef(null);
  const anchorRef = useRef(null);
  const bubbleKindRef = useRef(null);
  const thinkingRef = useRef(false);

  function setBubbleKind(kind, text) {
    bubbleKindRef.current = kind;
    setBubble(kind ? { kind, text } : null);
  }

  function applyCursor(point) {
    const node = buddyRef.current;
    if (!node) return;
    const inside = point.inside !== false;
    if (!inside) {
      node.style.opacity = '0';
    } else {
      const x = Math.min(window.innerWidth - 48, Math.max(4, point.x + 14));
      const y = Math.min(window.innerHeight - 56, Math.max(4, point.y + 18));
      node.style.opacity = '1';
      node.style.transform = `translate(${x}px, ${y}px)`;
      node.classList.toggle('is-near-right', x > window.innerWidth - 300);
      node.classList.toggle('is-near-top', y < 120);

      const anchor = anchorRef.current;
      const moved = !anchor || Math.hypot(point.x - anchor.x, point.y - anchor.y) > MOVE_PX;
      if (moved) {
        anchorRef.current = { x: point.x, y: point.y };
        if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = setTimeout(() => {
          if (thinkingRef.current) return;
          setBubbleKind('ask', ASK_TEXT);
        }, DWELL_MS);
      }
    }

    const hit = Boolean(pointerDownRef.current || (inside && isOverInteractive(point.x, point.y)));
    if (hit !== interactiveRef.current) {
      interactiveRef.current = hit;
      window.appConfig?.setOverlayIgnoreMouse?.(!hit);
    }
  }

  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);

  useEffect(() => {
    window.appConfig?.setOverlayIgnoreMouse?.(true);
    window.appConfig?.buddyHello?.().then((ui) => {
      if (!ui) return;
      setListening(Boolean(ui.listening));
      setTranscript(String(ui.transcript || ''));
    }).catch(() => {});

    let stopCursor = () => {};
    if (window.appConfig?.onBuddyCursor) {
      stopCursor = window.appConfig.onBuddyCursor(applyCursor) || (() => {});
    } else {
      const onMove = (event) => applyCursor({ x: event.clientX, y: event.clientY, inside: true });
      window.addEventListener('mousemove', onMove);
      stopCursor = () => window.removeEventListener('mousemove', onMove);
    }

    const onPointerDown = () => {
      pointerDownRef.current = true;
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      stopCursor();
    };
  }, []);

  useEffect(() => {
    if (!window.appConfig?.onBuddyEvent) return undefined;
    return window.appConfig.onBuddyEvent((event) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'reset') {
        setListening(false);
        setTranscript('');
        setThinking(false);
        thinkingRef.current = false;
        setHighlight(null);
        setLabel('');
        setBubbleKind(null, '');
        return;
      }
      if (event.type === 'listening') {
        setListening(Boolean(event.listening));
        if (!event.listening) setTranscript('');
        return;
      }
      if (event.type === 'transcript') {
        setTranscript(String(event.text || ''));
        return;
      }
      if (event.type === 'thinking') {
        thinkingRef.current = true;
        setThinking(true);
        setHighlight(null);
        setLabel('');
        setBubbleKind('status', 'Looking at the screen…');
        return;
      }
      if (event.type === 'result') {
        thinkingRef.current = false;
        setThinking(false);
        setHighlight(event.highlight || null);
        setLabel(String(event.label || ''));
        setBubbleKind('answer', String(event.answer || ''));
        return;
      }
      if (event.type === 'error') {
        thinkingRef.current = false;
        setThinking(false);
        setBubbleKind('answer', String(event.message || 'Something went wrong.'));
      }
    });
  }, []);

  const hearing = transcript.trim();

  return (
    <div className="overlay-root">
      <button
        type="button"
        className="buddy-chip"
        data-interactive="true"
        onClick={() => window.appConfig?.setBuddyEnabled?.(false)}
        title="Turn off the buddy. Clicks pass through everywhere else."
      >
        <span className="buddy-chip-dot" />
        Buddy ON
      </button>

      {highlight && (
        <div
          className="buddy-highlight"
          style={{
            left: `${highlight.x * 100}%`,
            top: `${highlight.y * 100}%`,
            width: `${highlight.w * 100}%`,
            height: `${highlight.h * 100}%`,
          }}
        >
          {label ? (
            <span className={`buddy-highlight-label ${highlight.y < 0.08 ? 'is-inside' : ''}`}>{label}</span>
          ) : null}
        </div>
      )}

      <div className={`buddy-anchor ${listening ? 'is-listening' : ''} ${thinking ? 'is-thinking' : ''}`} ref={buddyRef}>
        <div className="buddy-body" title="Screen guide">
          <span className="buddy-eye" />
          <span className="buddy-eye" />
        </div>
        {bubble && (
          <div className={`buddy-say buddy-say-${bubble.kind}`}>
            {bubble.kind === 'answer' ? <ReactMarkdown>{bubble.text}</ReactMarkdown> : bubble.text}
          </div>
        )}
        {hearing && bubble?.kind === 'ask' ? <div className="buddy-hear">{hearing}</div> : null}
      </div>
    </div>
  );
}
