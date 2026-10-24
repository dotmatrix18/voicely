// Global voice-note player: one <audio> for the whole app, a play queue ("Listen mode"),
// a persistent mini player, and lock-screen Media Session controls.
import { $, icon, fillAvatar, fmt, haptic } from './util.js';

const audio = new Audio();
audio.preload = 'auto';
const subs = new Set();
const state = { item: null, queue: [], index: -1, rate: 1, viewingRoom: null, listenMode: false };
let onListened = () => {}, onOpen = () => {};
let raf = 0, markedFor = null;

/** item: { id, url, duration, sender, senderUsername, senderId, room, title (chat name), kind: 'note'|'reaction'|'hello' } */
export const player = {
  configure({ listened, open }) { onListened = listened || onListened; onOpen = open || onOpen; },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  get current() { return state.item; },
  get playing() { return !audio.paused && !!state.item; },
  get rate() { return state.rate; },
  isCurrent: (id) => !!state.item && state.item.id === id,
  progress() { return { t: audio.currentTime || 0, d: total() }; },

  /** Play an item, optionally as part of a queue (list of items). */
  play(item, { queue = null, listenMode = false } = {}) {
    if (queue) { state.queue = queue; state.index = Math.max(0, queue.findIndex((q) => q.id === item.id)); }
    else { state.queue = [item]; state.index = 0; }
    state.listenMode = listenMode;
    load(item);
  },
  toggle(item, opts) {
    if (state.item && item && state.item.id !== item.id) return player.play(item, opts);
    if (!state.item && item) return player.play(item, opts);
    audio.paused ? resume() : audio.pause();
  },
  pause() { audio.pause(); },
  seek(item, ratio) {
    if (!state.item || state.item.id !== item.id) { player.play(item); }
    const go = () => { try { audio.currentTime = Math.max(0, Math.min(0.995, ratio)) * total(); } catch {} emit(); };
    audio.readyState >= 1 ? go() : audio.addEventListener('loadedmetadata', go, { once: true });
  },
  setRate(r) { state.rate = r; audio.playbackRate = r; emit(); },
  cycleRate() { player.setRate(state.rate === 1 ? 1.5 : state.rate === 1.5 ? 2 : 1); return state.rate; },
  next() { if (state.index < state.queue.length - 1) { state.index++; load(state.queue[state.index]); } else stop(); },
  prev() { if (audio.currentTime > 2 || state.index === 0) { audio.currentTime = 0; } else { state.index--; load(state.queue[state.index]); } },
  stop,
  setViewingRoom(room) { state.viewingRoom = room; renderMini(); },
  queueInfo: () => ({ index: state.index, length: state.queue.length, listenMode: state.listenMode }),
};

function total() { return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.item && state.item.duration) || 0; }

function load(item) {
  state.item = item; markedFor = null;
  audio.src = item.url;
  audio.playbackRate = item.kind === 'note' ? state.rate : 1;
  resume();
  setMediaSession(item);
  emit();
}
function resume() { audio.play().catch((e) => { if (e.name !== 'AbortError') emit({ error: e }); }); }
function stop() {
  audio.pause(); audio.removeAttribute('src'); try { audio.load(); } catch {}
  state.item = null; state.queue = []; state.index = -1; state.listenMode = false;
  if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
  emit();
}

function emit(extra = {}) {
  const snap = { item: state.item, playing: !audio.paused, t: audio.currentTime || 0, d: total(), rate: state.rate, ...extra };
  subs.forEach((fn) => fn(snap));
  renderMini(snap);
  // "listened" once ≥ 60% heard (or ended)
  if (state.item && state.item.kind === 'note' && markedFor !== state.item.id && snap.d && snap.t / snap.d >= 0.6) { markedFor = state.item.id; onListened(state.item); }
}
const loop = () => { emit(); raf = requestAnimationFrame(loop); };
audio.addEventListener('play', () => { cancelAnimationFrame(raf); loop(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { cancelAnimationFrame(raf); emit(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('ended', () => {
  cancelAnimationFrame(raf);
  if (state.item && state.item.kind === 'note' && markedFor !== state.item.id) { markedFor = state.item.id; onListened(state.item); }
  if (state.index < state.queue.length - 1) { haptic('tick'); player.next(); } else { const it = state.item; stop(); emit({ ended: it }); }
});
audio.addEventListener('error', () => { if (state.item) emit({ error: audio.error }); });
audio.addEventListener('timeupdate', () => {
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && total()) {
    try { navigator.mediaSession.setPositionState({ duration: total(), playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, total()) }); } catch {}
  }
});

// ---------- Media Session (lock screen / headphones / keyboard media keys) ----------
function setMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.kind === 'reaction' ? `Voice reaction from ${item.sender}` : item.kind === 'hello' ? `${item.sender}'s voice hello` : `Voice note from ${item.sender}`,
    artist: item.title || 'Voicely', album: state.queue.length > 1 ? `Listen mode · ${state.index + 1} of ${state.queue.length}` : 'Voicely',
    artwork: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  const h = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  h('play', () => resume()); h('pause', () => audio.pause()); h('stop', () => stop());
  h('nexttrack', state.queue.length > 1 ? () => player.next() : null);
  h('previoustrack', state.queue.length > 1 ? () => player.prev() : null);
  h('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  h('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 5)); });
  h('seekforward', (d) => { audio.currentTime = Math.min(total(), audio.currentTime + (d.seekOffset || 5)); });
}

// ---------- mini player ----------
const mp = () => $('miniPlayer');
function renderMini(snap) {
  const box = mp(); if (!box) return;
  const it = state.item;
  const show = !!it && it.kind === 'note' && (state.listenMode || it.room !== state.viewingRoom);
  box.classList.toggle('show', show);
  if (!it) return;
  if (box.dataset.id !== it.id) {
    box.dataset.id = it.id;
    fillAvatar($('mpAvatar'), { username: it.senderUsername, displayName: it.sender, id: it.senderId });
    $('mpTitle').textContent = it.sender;
  }
  const s = snap || { t: audio.currentTime, d: total(), playing: !audio.paused };
  const q = state.queue.length > 1 ? ` · ${state.index + 1} of ${state.queue.length}` : '';
  $('mpSub').textContent = `${state.listenMode ? 'Listen mode' : ({ reaction: 'Voice reaction', hello: 'Voice hello' })[it.kind] || 'Voice note'}${q} · ${fmt(s.t)} / ${fmt(s.d)}`;
  box.style.setProperty('--p', `${s.d ? Math.min(100, (s.t / s.d) * 100) : 0}%`);
  const pb = $('mpPlay'); const want = s.playing ? 'pause' : 'play';
  if (pb.dataset.state !== want) { pb.dataset.state = want; pb.replaceChildren(icon(want)); pb.setAttribute('aria-label', s.playing ? 'Pause' : 'Play'); }
  $('mpNext').classList.toggle('hidden', !(state.index < state.queue.length - 1));
}
export function initMiniPlayer() {
  $('mpPlay').onclick = () => (audio.paused ? resume() : audio.pause());
  $('mpNext').onclick = () => player.next();
  $('mpClose').onclick = () => stop();
  $('mpMain').onclick = () => state.item && onOpen(state.item);
}
