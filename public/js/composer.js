// The recorder UI: big floating mic with an audio-reactive ring.
//   hold → record · release → send · slide ← cancel · slide ↑ lock · quick tap → lock
//   locked: ■ stops into a preview (play back, trim silence on/off) · ➤ sends · 🗑 discards
//   desktop: hold Space to talk, Esc cancels.
import { $, fmt, toast, haptic, icon } from './util.js';
import { Capture, canRecord, drawLive } from './capture.js';
import { processRecording } from './audio-tools.js';

export function initComposer({ getMaxDuration, onSend, onRecording, onLevel, isActive }) {
  const composer = $('composer'), mic = $('micBtn'), rail = $('lockRail'), slide = composer.querySelector('.slide-cancel');
  let state = 'idle', cap = null, press = null, preview = null, pvAudio = null, lastLevelSent = 0;
  const setState = (s) => { state = s; composer.dataset.state = s; if (s !== 'holding') { slide.style.removeProperty('--dx'); slide.style.removeProperty('--slide-op'); rail.style.removeProperty('--dy'); rail.classList.remove('armed'); composer.classList.remove('cancelling'); } };
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--rec').trim() || '#ff3b5c';

  async function begin() {
    if (!canRecord()) {
      toast(location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname) ? 'The microphone needs HTTPS. See the README for phone setup.' : "This browser can't record audio.", 4500);
      return setState('idle');
    }
    setState('holding');
    cap = new Capture({ onLevel: (lvl, t) => {
      mic.style.setProperty('--lvl', lvl.toFixed(3));
      $('recTime').textContent = fmt(t);
      $('recTime').classList.toggle('warn', getMaxDuration() - t <= 10);
      drawLive($('liveWave'), cap.levels, accent());
      const now = performance.now(); if (now - lastLevelSent > 100) { lastLevelSent = now; onLevel(lvl); }
      if (t >= getMaxDuration()) { toast(`Max length is ${fmt(getMaxDuration())}. Sending.`); send(); }
    } });
    const askedAt = performance.now();
    try {
      const ok = await cap.start();
      if (!ok) return;
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it to talk.' : "Couldn't access the microphone.", 4000);
      cap = null; return setState('idle');
    }
    haptic('start');
    onRecording(true);
    if (performance.now() - askedAt > 700 && state === 'holding') lock(); // permission prompt interrupted the hold
    if (press && press.pending) { const p = press.pending; press.pending = null; p(); }
  }

  function lock() { if (state !== 'holding') return; setState('locked'); haptic('lock'); mic.setAttribute('aria-label', 'Send voice note'); }

  async function finishCapture() {
    const c = cap; cap = null;
    onRecording(false); mic.style.setProperty('--lvl', 0);
    if (!c) return null;
    const rec = await c.stop();
    if (!rec || rec.duration < 0.5) { toast('Too short. Hold the mic while you talk.'); return null; }
    return rec;
  }

  async function send() {
    if (state === 'preview' && preview) { const p = preview; stopPreviewAudio(); preview = null; setState('idle'); haptic('send'); return onSend(p.processed); }
    if (state !== 'holding' && state !== 'locked') return;
    setState('idle'); mic.setAttribute('aria-label', 'Record a voice note');
    const rec = await finishCapture(); if (!rec) return;
    haptic('send');
    const processed = await processRecording(rec, { trim: true });
    if (processed.duration < 0.4) return toast('Nothing to send: it was all silence.');
    onSend(processed);
  }

  async function toPreview() {
    if (state !== 'locked') return;
    const rec = await finishCapture(); if (!rec) return setState('idle');
    const processed = await processRecording(rec, { trim: true });
    preview = { rec, processed, trim: true };
    setState('preview'); haptic('tap');
    renderPreview();
  }

  function renderPreview() {
    const p = preview.processed, full = p.full || p.duration;
    const bars = (p.fullPeaks && p.fullPeaks.length ? p.fullPeaks : p.peaks).map((v, i, a) => {
      const t = (i / a.length) * full;
      const inside = !preview.trim || (t >= p.start - 0.01 && t <= p.end + 0.01);
      return Object.assign(document.createElement('i'), { className: inside ? '' : 'trimmed', style: `height:${Math.max(12, v * 100)}%` });
    });
    $('pvWave').replaceChildren(...bars);
    $('pvTime').textContent = fmt(p.duration);
    const trimBtn = $('pvTrim');
    const can = p.trimmed > 0 || p.couldTrim;
    trimBtn.classList.toggle('hidden', !can);
    trimBtn.classList.toggle('on', preview.trim); trimBtn.setAttribute('aria-pressed', String(preview.trim));
    trimBtn.title = p.trimmed > 0 ? `Trimmed ${p.trimmed.toFixed(1)}s of silence` : 'Trim leading/trailing silence';
    trimBtn.lastChild.textContent = p.trimmed > 0 ? `−${p.trimmed.toFixed(1)}s` : 'Trim';
  }

  function stopPreviewAudio() { if (pvAudio) { pvAudio.pause(); URL.revokeObjectURL(pvAudio.src); pvAudio = null; } setPvIcon(false); }
  function setPvIcon(playing) { $('pvPlay').replaceChildren(icon(playing ? 'pause' : 'play')); $('pvPlay').setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview'); }
  $('pvPlay').onclick = () => {
    if (!preview) return;
    if (pvAudio && !pvAudio.paused) { pvAudio.pause(); return setPvIcon(false); }
    if (!pvAudio) {
      pvAudio = new Audio(URL.createObjectURL(preview.processed.blob));
      const bars = () => [...$('pvWave').children];
      const p = preview.processed, full = p.full || p.duration;
      pvAudio.ontimeupdate = () => {
        if (!preview) return;
        const t = (preview.trim ? p.start : 0) + pvAudio.currentTime;
        bars().forEach((b, i, a) => b.classList.toggle('on', (i / a.length) * full <= t && !b.classList.contains('trimmed')));
        $('pvTime').textContent = `${fmt(pvAudio.currentTime)} / ${fmt(p.duration)}`;
      };
      pvAudio.onended = () => {
        if (!preview || !pvAudio) return; setPvIcon(false); bars().forEach((b) => b.classList.remove('on')); $('pvTime').textContent = fmt(p.duration); pvAudio.currentTime = 0; };
    }
    pvAudio.play(); setPvIcon(true);
  };
  $('pvTrim').onclick = async () => {
    if (!preview) return;
    stopPreviewAudio();
    preview.trim = !preview.trim;
    preview.processed = await processRecording(preview.rec, { trim: preview.trim, decoded: preview.processed.decoded });
    if (!preview.trim) preview.processed.start = 0;
    renderPreview(); haptic('tick');
  };

  function cancel(silent = false) {
    const had = state !== 'idle';
    if (cap) { cap.cancel(); cap = null; onRecording(false); }
    stopPreviewAudio(); preview = null;
    mic.style.setProperty('--lvl', 0); mic.setAttribute('aria-label', 'Record a voice note');
    setState('idle');
    if (had && !silent) { haptic('cancel'); toast('Recording discarded', 1400); }
  }

  // ---------- gestures on the mic ----------
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'locked' || state === 'preview') return send();
    if (state !== 'idle') return;
    try { mic.setPointerCapture(e.pointerId); } catch {}
    press = { x: e.clientX, y: e.clientY, t: performance.now(), pending: null };
    begin();
  });
  mic.addEventListener('pointermove', (e) => {
    if (state !== 'holding' || !press) return;
    const dx = Math.max(0, press.x - e.clientX), dy = Math.max(0, press.y - e.clientY);
    slide.style.setProperty('--dx', `${-dx * 0.7}px`); slide.style.setProperty('--slide-op', String(Math.max(0, 1 - dx / 140)));
    composer.classList.toggle('cancelling', dx > 70);
    rail.style.setProperty('--dy', `${-Math.min(dy, 64)}px`); rail.classList.toggle('armed', dy > 50);
    if (dx > 130) cancel();
    else if (dy > 72 && cap) lock();
  });
  const release = () => {
    if (state !== 'holding' || !press) return;
    const quick = performance.now() - press.t < 300;
    const decide = () => { if (state === 'holding') (quick ? lock() : send()); };
    if (cap && cap.state === 'recording') decide(); else press.pending = decide;
  };
  mic.addEventListener('pointerup', release);
  mic.addEventListener('pointercancel', () => { if (state === 'holding') lock(); });
  $('recTrash').onclick = () => cancel();
  $('pvTrash').onclick = () => cancel();
  $('recStop').onclick = () => toPreview();

  // keyboard: hold Space to talk, Esc to cancel
  let spaceHeld = false;
  document.addEventListener('keydown', (e) => {
    if (!isActive() || e.target.tagName === 'INPUT') return;
    if (e.code === 'Escape' && state !== 'idle') { e.preventDefault(); cancel(); }
    if (e.code === 'Space' && !e.repeat && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      if (state === 'locked' || state === 'preview') return send();
      if (state === 'idle') { spaceHeld = true; press = { x: 0, y: 0, t: performance.now() - 1000, pending: null }; begin(); }
    }
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceHeld) { spaceHeld = false; e.preventDefault(); release(); } });

  return { cancel, get state() { return state; } };
}
