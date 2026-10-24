// Pure audio helpers (also unit-tested in Node): RMS framing, smart silence trimming,
// waveform peaks, resampling and 16-bit WAV encoding. Plus browser-only decode/process.

/** RMS per frame (default 20 ms). */
export function frameRms(samples, sampleRate, frameMs = 20) {
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const n = Math.ceil(samples.length / size);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0; const a = f * size, b = Math.min(samples.length, a + size);
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / Math.max(1, b - a));
  }
  return out;
}

/**
 * Find where speech starts/ends. Threshold adapts to the recording: a bit above the
 * noise floor (10th-percentile frame) and at least 6% of the loudest frame.
 * Returns seconds {start, end, found}.
 */
export function findSpeechBounds(samples, sampleRate, { frameMs = 20, padMs = 160, minRms = 0.008 } = {}) {
  const rms = frameRms(samples, sampleRate, frameMs);
  const duration = samples.length / sampleRate;
  if (!rms.length) return { start: 0, end: duration, found: false };
  const sorted = Array.from(rms).sort((x, y) => x - y);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[sorted.length - 1];
  const thr = Math.max(minRms, floor * 2.5, peak * 0.06);
  // require 2 consecutive loud frames to avoid clicks
  let first = -1, last = -1;
  for (let i = 0; i < rms.length - 1; i++) if (rms[i] > thr && rms[i + 1] > thr) { first = i; break; }
  for (let i = rms.length - 1; i > 0; i--) if (rms[i] > thr && rms[i - 1] > thr) { last = i; break; }
  if (first < 0 || last < 0 || peak < minRms) return { start: 0, end: duration, found: false };
  const f = frameMs / 1000, pad = padMs / 1000;
  return { start: Math.max(0, first * f - pad), end: Math.min(duration, (last + 1) * f + pad), found: true };
}

/** n normalised peaks (0..1) for a waveform. */
export function peaksFrom(samples, n = 48) {
  if (!samples.length) return [];
  const out = new Array(n).fill(0);
  const step = samples.length / n;
  for (let i = 0; i < n; i++) {
    let mx = 0; const a = Math.floor(i * step), b = Math.min(samples.length, Math.floor((i + 1) * step));
    for (let j = a; j < b; j++) { const v = Math.abs(samples[j]); if (v > mx) mx = v; }
    out[i] = mx;
  }
  const top = Math.max(...out, 1e-4);
  return out.map((v) => Math.round(Math.pow(v / top, 0.8) * 100) / 100);
}

/** Linear-interpolation resampler (good enough for speech). */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const len = Math.floor((samples.length * to) / from);
  const out = new Float32Array(len); const r = from / to;
  for (let i = 0; i < len; i++) {
    const x = i * r, i0 = Math.floor(x), i1 = Math.min(samples.length - 1, i0 + 1), t = x - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

/** Mono 16-bit PCM WAV with short fade in/out to avoid clicks. */
export function encodeWav(samples, sampleRate) {
  const fade = Math.min(samples.length >> 1, Math.round(sampleRate * 0.012));
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (i < fade) s *= i / fade; else if (i > samples.length - fade) s *= (samples.length - i) / fade;
    s = Math.max(-1, Math.min(1, s));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// ---------------- browser-only ----------------
let decodeCtx;
export async function decodeBlob(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  decodeCtx ||= new AC();
  const ab = await blob.arrayBuffer();
  const audio = await new Promise((res, rej) => { const p = decodeCtx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
  const ch = audio.numberOfChannels; const len = audio.length; const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }
  return { samples: mono, sampleRate: audio.sampleRate, duration: audio.duration };
}

/**
 * Turn a raw recording into a sendable note. With trim on, leading/trailing silence is removed
 * and the result is re-encoded as WAV (only when it actually saves ≥ 0.35 s; otherwise the
 * original compressed file is kept). Always returns accurate peaks for the waveform.
 */
export async function processRecording(rec, { trim = true, decoded = null } = {}) {
  let d = decoded;
  try { d ||= await decodeBlob(rec.blob); } catch { d = null; }
  if (!d || !d.samples.length) {
    return { audio: await rec.blob.arrayBuffer(), blob: rec.blob, mime: rec.mime, duration: rec.duration, peaks: rec.fallbackPeaks || [], fullPeaks: rec.fallbackPeaks || [], trimmed: 0, start: 0, end: rec.duration, decoded: null };
  }
  const full = d.duration || d.samples.length / d.sampleRate;
  const bounds = findSpeechBounds(d.samples, d.sampleRate);
  const fullPeaks = peaksFrom(d.samples, 64);
  const saved = full - (bounds.end - bounds.start);
  if (trim && bounds.found && saved >= 0.35 && bounds.end - bounds.start >= 0.5) {
    const seg = d.samples.subarray(Math.floor(bounds.start * d.sampleRate), Math.ceil(bounds.end * d.sampleRate));
    const dur = seg.length / d.sampleRate;
    const rate = dur * 24000 * 2 < 4.5e6 ? 24000 : 16000;
    const wav = encodeWav(resample(seg, d.sampleRate, rate), rate);
    const blob = new Blob([wav], { type: 'audio/wav' });
    return { audio: wav, blob, mime: 'audio/wav', duration: Math.round(dur * 100) / 100, peaks: peaksFrom(seg, 48), fullPeaks, trimmed: saved, start: bounds.start, end: bounds.end, full, decoded: d };
  }
  return { audio: await rec.blob.arrayBuffer(), blob: rec.blob, mime: rec.mime, duration: Math.min(rec.duration, full || rec.duration), peaks: peaksFrom(d.samples, 48), fullPeaks, trimmed: 0, start: 0, end: full, full, decoded: d, couldTrim: bounds.found && saved >= 0.35 };
}
