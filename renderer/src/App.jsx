import { useEffect, useRef, useState } from 'react';

const WS_URL = window.appConfig?.backendWsUrl ?? 'ws://localhost:8787/ws';

export default function App() {
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [qaLog, setQaLog] = useState([]);
  const [statusMessage, setStatusMessage] = useState('idle');
  const [micLevel, setMicLevel] = useState(0);

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const levelLoopRef = useRef(null);

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((deviceList) => {
      const inputs = deviceList.filter((d) => d.kind === 'audioinput');
      setDevices(inputs);
      if (inputs.length > 0) setSelectedDeviceId(inputs[0].deviceId);
    });
  }, []);

  async function startListening() {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setStatusMessage('connected');
    ws.onclose = () => setStatusMessage('disconnected');
    ws.onerror = () => setStatusMessage('error');

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'status') {
        setStatusMessage(payload.message);
      } else if (payload.type === 'transcript') {
        setTranscript(payload.text);
      } else if (payload.type === 'answer') {
        setQaLog((prev) => [...prev, { question: payload.question, answer: payload.answer }]);
        setTranscript('');
      } else if (payload.type === 'error') {
        setStatusMessage(payload.message);
      }
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

  return (
    <div className="app">
      <header>
        <h1>Interview Copilot</h1>
        <span className={`status status-${statusMessage}`}>{statusMessage}</span>
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
          <button onClick={startListening}>Start Listening</button>
        ) : (
          <button onClick={stopListening}>Stop</button>
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

      <div className="qa-log">
        {qaLog
          .slice()
          .reverse()
          .map((qa, i) => (
            <div key={i} className="qa-item">
              <div className="question">Q: {qa.question}</div>
              <div className="answer">{qa.answer}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
