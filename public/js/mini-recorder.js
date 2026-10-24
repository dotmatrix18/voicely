// A compact hold-to-record control with a circular countdown ring, used for
// voice reactions (max 5 s) and the profile "voice hello" (max 10 s).
// Hold to record and release to finish, or tap once to start and tap again to stop.
import { el, fmt, haptic, toast, icon } from './util.js';
import { Capture, canRecord } from './capture.js';
import { processRecording } from './audio-tools.js';

export function miniRecorder({ max, label = 'Hold to record', onDone, onLevel = () => {}, onRecording = () => {} }) {
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('viewBox', '0 0 36 36'); ring.setAttribute('class', 'mini-rec-ring');
  ring.innerHTML = '<circle class="track" cx="18" cy="18" r="16" pathLength="100"/><circle class="bar" cx="18" cy="18" r="16" pathLength="100"/>';
  const btn = el('button', { class: 'mini-rec-btn', 'aria-label': `${label}, up to ${max} seconds` }, ring, icon('mic', 'lg'));
  const status = el('div', { class: 'mini-rec-label', 'aria-live': 'polite' }, label);
  const hint = el('div', { class: 'faint small' }, `Up to ${max} seconds · audio only`);
  let cap = null, startT = 0, mode = 'idle', busy = false;

  async function start() {
    if (!canRecord()) return toast('Recording needs HTTPS (or localhost).');
    mode = 'starting';
    cap = new Capture({ onLevel: (lvl, t) => {
      btn.style.setProperty('--lvl', lvl.toFixed(3)); btn.style.setProperty('--prog', Math.min(1, t / max).toFixed(3));
      status.textContent = `${fmt(t)} / ${fmt(max)}`; onLevel(lvl);
      if (t >= max) stop();
    } });
    try { if (!(await cap.start())) return; } catch { toast("Couldn't access the microphone."); mode = 'idle'; cap = null; return; }
    mode = 'rec'; startT = performance.now(); btn.classList.add('rec'); haptic('start'); onRecording(true);
  }
  async function stop() {
    if (mode !== 'rec' || busy) return;
    busy = true; mode = 'idle';
    const c = cap; cap = null; btn.classList.remove('rec'); btn.style.setProperty('--prog', 0); onRecording(false);
    const rec = await c.stop();
    busy = false;
    status.textContent = label;
    if (!rec || rec.duration < 0.4) { toast('Too short. Hold while you talk.'); return; }
    rec.duration = Math.min(rec.duration, max);
    const note = await processRecording(rec, { trim: true });
    note.duration = Math.min(note.duration, max);
    haptic('send');
    onDone(note);
  }
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (mode === 'rec') return stop();          // second tap stops
    if (mode !== 'idle') return;
    try { btn.setPointerCapture(e.pointerId); } catch {}
    const t0 = performance.now();
    start();
    btn.onpointerup = () => { btn.onpointerup = null; if (performance.now() - t0 > 350) { const go = () => (mode === 'rec' ? stop() : mode === 'starting' ? setTimeout(go, 50) : null); go(); } };
  });
  const node = el('div', { class: 'mini-rec' }, btn, status, hint);
  node.cancel = () => { if (cap) { cap.cancel(); cap = null; onRecording(false); } mode = 'idle'; };
  return node;
}
