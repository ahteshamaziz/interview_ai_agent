// Raw 16 kHz mono PCM is what the live transcriber decodes reliably.
// Spoken turns are cut locally so a missed transcript can be retried.
export const PCM_SAMPLE_RATE = 16000;
export const MAX_VOICE_CLIPS = 5;

export function pushVoiceClip(clips, clip, max = MAX_VOICE_CLIPS) {
  return {
    next: [clip, ...clips].slice(0, max),
    dropped: clips.slice(max - 1),
  };
}

export function downsample(buffer, inputRate, outputRate) {
  if (!buffer.length || outputRate === inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const index = i * ratio;
    const i0 = Math.floor(index);
    const i1 = Math.min(i0 + 1, buffer.length - 1);
    const frac = index - i0;
    result[i] = buffer[i0] * (1 - frac) + buffer[i1] * frac;
  }
  return result;
}

export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWavBytes(pcmChunks, sampleRate) {
  const total = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, total * 2, true);

  let offset = 44;
  for (const chunk of pcmChunks) {
    for (let i = 0; i < chunk.length; i++, offset += 2) {
      view.setInt16(offset, chunk[i], true);
    }
  }
  return new Uint8Array(buffer);
}

function countSamples(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function trimEnd(chunks, sampleCount) {
  let drop = sampleCount;
  while (drop > 0 && chunks.length) {
    const last = chunks[chunks.length - 1];
    if (last.length <= drop) {
      drop -= last.length;
      chunks.pop();
    } else {
      chunks[chunks.length - 1] = last.subarray(0, last.length - drop);
      drop = 0;
    }
  }
}

function createPreRoll(maxSamples) {
  const chunks = [];
  let count = 0;
  return {
    push(samples) {
      chunks.push(samples);
      count += samples.length;
      while (count > maxSamples && chunks.length) {
        const extra = count - maxSamples;
        if (chunks[0].length <= extra) {
          count -= chunks[0].length;
          chunks.shift();
        } else {
          chunks[0] = chunks[0].subarray(extra);
          count -= extra;
        }
      }
    },
    snapshot() {
      return chunks.map((chunk) => new Int16Array(chunk));
    },
  };
}

export function createSpeechSegmenter({
  onClip,
  sampleRate = PCM_SAMPLE_RATE,
  minClipMs = 400,
  silenceEndMs = 900,
  maxClipMs = 30000,
  prerollMs = 350,
  tailKeepMs = 280,
} = {}) {
  const preRoll = createPreRoll(Math.round(sampleRate * (prerollMs / 1000)));
  const silenceLimit = Math.round(sampleRate * (silenceEndMs / 1000));
  const maxSamples = Math.round(sampleRate * (maxClipMs / 1000));
  const minVoiced = Math.round(sampleRate * (minClipMs / 1000));
  const tailKeep = Math.round(sampleRate * (tailKeepMs / 1000));

  let noiseFloor = 0.004;
  let speaking = false;
  let silenceSamples = 0;
  let voicedSamples = 0;
  let speechChunks = [];

  function closeUtterance() {
    if (!speaking) return;
    const drop = Math.max(0, silenceSamples - tailKeep);
    if (drop > 0) trimEnd(speechChunks, drop);
    const chunks = speechChunks.map((chunk) => new Int16Array(chunk));
    const voiced = voicedSamples;
    speaking = false;
    silenceSamples = 0;
    voicedSamples = 0;
    speechChunks = [];
    if (voiced < minVoiced || !chunks.length) return;
    const durationMs = Math.round((countSamples(chunks) / sampleRate) * 1000);
    onClip({ chunks, durationMs });
  }

  function push(float32, inputRate) {
    const down = downsample(float32, inputRate, sampleRate);
    if (!down.length) return null;
    const pcm = floatTo16BitPCM(down);
    let sum = 0;
    for (let i = 0; i < down.length; i++) sum += down[i] * down[i];
    const rms = Math.sqrt(sum / down.length);
    const startAt = Math.max(0.007, noiseFloor * 2.4);
    const keepAt = Math.max(0.0045, noiseFloor * 1.5);

    if (!speaking) {
      if (rms >= startAt) {
        speaking = true;
        silenceSamples = 0;
        voicedSamples = pcm.length;
        // Keep audio from just before this chunk, but never trim the chunk itself.
        speechChunks = [...preRoll.snapshot(), pcm];
      } else {
        preRoll.push(pcm);
        noiseFloor = noiseFloor * 0.96 + rms * 0.04;
      }
      return { pcm, rms };
    }

    speechChunks.push(pcm);
    if (rms >= keepAt) {
      silenceSamples = 0;
      voicedSamples += pcm.length;
    } else {
      silenceSamples += pcm.length;
    }

    if (countSamples(speechChunks) >= maxSamples || silenceSamples >= silenceLimit) {
      closeUtterance();
    }
    return { pcm, rms };
  }

  return {
    push,
    flush() {
      closeUtterance();
    },
  };
}
