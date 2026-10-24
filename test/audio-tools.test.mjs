// Unit tests for the browser's audio helpers (silence trimming, peaks, WAV encoding).
import { createRequire } from 'module';
import { findSpeechBounds, peaksFrom, encodeWav, resample, frameRms } from '../public/js/audio-tools.js';
const require = createRequire(import.meta.url);
const { wavDuration, sniffAudio } = require('../lib/audio.js');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${x}`); } };
console.log('Audio tools (smart silence trimming)');

const sr = 16000;
const mk = (lead, speech, tail, noise = 0.003) => {
  const n = Math.round((lead + speech + tail) * sr), s = new Float32Array(n);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const voiced = t >= lead && t < lead + speech;
    s[i] = noise * rnd() + (voiced ? 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.abs(Math.sin(2 * Math.PI * 2.5 * t) + 0.2) : 0);
  }
  return s;
};
const a = mk(1.2, 2.0, 1.5);
const b = findSpeechBounds(a, sr);
check('finds speech start after 1.2 s of leading silence (±0.25 s)', b.found && Math.abs(b.start - (1.2 - 0.16)) < 0.25, JSON.stringify(b));
check('finds speech end before 1.5 s of trailing silence (±0.25 s)', Math.abs(b.end - (3.2 + 0.16)) < 0.25, JSON.stringify(b));
check('trimmed length ≈ speech + padding', Math.abs(b.end - b.start - 2.3) < 0.4);
const noisy = mk(0.8, 1.5, 0.8, 0.03);
const bn = findSpeechBounds(noisy, sr);
check('still trims with a noisy floor (adaptive threshold)', bn.found && bn.start > 0.4 && bn.end < 2.9, JSON.stringify(bn));
const silent = mk(2, 0, 0);
check('pure silence → nothing found (no trim)', findSpeechBounds(silent, sr).found === false);
const p = peaksFrom(a, 48);
check('peaksFrom returns 48 normalised peaks', p.length === 48 && Math.max(...p) === 1 && Math.min(...p) >= 0);
check('peaks are low in the silent parts', p[2] < 0.2 && p[47] < 0.2 && p[20] > 0.5);
const r = resample(a, 16000, 24000);
check('resample keeps duration', Math.abs(r.length / 24000 - a.length / 16000) < 0.001);
const wav = Buffer.from(encodeWav(a.subarray(Math.floor(b.start * sr), Math.floor(b.end * sr)), sr));
check('encodeWav produces a valid WAV the server accepts', sniffAudio(wav)?.ext === 'wav');
check('server-side WAV duration check matches', Math.abs(wavDuration(wav) - (Math.floor(b.end * sr) - Math.floor(b.start * sr)) / sr) < 0.001);
check('frameRms frames = 20 ms', frameRms(a, sr).length === Math.ceil(a.length / 320));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
