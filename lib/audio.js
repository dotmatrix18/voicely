'use strict';
/** Voice-note validation: the server only ever accepts real audio. */

function sniffAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { ext: 'webm', mime: 'audio/webm' };   // EBML (Chrome/Firefox)
  if (buf.toString('ascii', 4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' }; // MP4 (Safari, new Chrome)
  if (buf.toString('ascii', 0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}

function toBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof ArrayBuffer) return Buffer.from(x);
  if (ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  return null;
}

/** Exact duration of a PCM WAV file from its header (null if not parseable). */
function wavDuration(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') return byteRate ? Math.min(size, buf.length - off - 8) / byteRate : null;
    off += 8 + size + (size & 1);
  }
  return null;
}

function validateVoice(payload, { maxBytes, maxDuration }) {
  const deny = (error) => ({ ok: false, error });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return deny('Only voice messages are allowed.');
  const allowed = new Set(['audio', 'mime', 'duration', 'peaks']);
  for (const k of Object.keys(payload)) if (!allowed.has(k)) return deny(`Field "${k}" is not allowed. Only voice messages are allowed.`);
  const buf = toBuffer(payload.audio);
  if (!buf) return deny('Only voice messages are allowed (audio must be binary).');
  if (buf.length > maxBytes) return deny('Voice note too large.');
  const declared = typeof payload.mime === 'string' ? payload.mime.toLowerCase() : '';
  if (!declared.startsWith('audio/')) return deny('Only audio is allowed.');
  const sniffed = sniffAudio(buf);
  if (!sniffed) return deny('Payload is not a recognised audio file.');
  const duration = Number(payload.duration);
  if (!Number.isFinite(duration) || duration <= 0.2) return deny('Voice note too short.');
  if (duration > maxDuration + Math.min(1, maxDuration * 0.1)) return deny(`Limited to ${maxDuration} seconds.`);
  if (sniffed.ext === 'wav') { // WAV lets us verify the real length instead of trusting the client
    const real = wavDuration(buf);
    if (real == null || real > maxDuration + 0.25 || Math.abs(real - duration) > 0.5) return deny(`Limited to ${maxDuration} seconds.`);
  }
  const peaks = Array.isArray(payload.peaks)
    ? payload.peaks.slice(0, 64).map((p) => Math.round(Math.max(0, Math.min(1, Number(p) || 0)) * 100) / 100)
    : [];
  return { ok: true, buf, sniffed, duration: Math.round(duration * 10) / 10, peaks };
}

module.exports = { sniffAudio, validateVoice, wavDuration };
