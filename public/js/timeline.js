// Chat timeline: grouped bubbles with tails, day separators + sticky date chip, delivery/listened
// receipts, unplayed markers, scrubbable waveforms, voice reactions, skeletons and scroll-to-latest.
import { el, icon, avatar, fmt, timeStr, dayStr, colorFor, haptic } from './util.js';
import { illus } from './illustrations.js';
import { player } from './player.js';

const GROUP_MS = 5 * 60 * 1000;

export function createTimeline({ scroller, inner, sticky, fab, fabCount, onReact }) {
  let ctx = { myId: null, kind: 'group', title: '', room: '', peerId: null };
  let rows = new Map(); // id -> { msg, row, bars, knob, durEl, metaTick, reactionsEl, speed }
  let order = [];       // msg ids in order
  let last = null, lastDay = '', newWhileAway = 0;

  // ---------- lifecycle ----------
  function reset(c) {
    ctx = { ...ctx, ...c }; rows = new Map(); order = []; last = null; lastDay = ''; newWhileAway = 0;
    inner.replaceChildren(); updateFab();
  }
  function skeleton() {
    inner.classList.remove('is-empty');
    inner.replaceChildren(...[0, 1, 2, 3, 4].map((i) => el('div', { class: `msg ${i % 2 ? 'mine' : 'theirs'} first last`, style: { opacity: 1 - i * 0.12 } },
      el('div', { class: 'skel', style: { width: `${180 + (i * 37) % 90}px`, height: '52px', borderRadius: '20px' } }))));
  }
  function empty() {
    inner.classList.add('is-empty');
    inner.replaceChildren(el('div', { class: 'empty', style: { margin: 'auto' } }, illus('chat'),
      el('h4', {}, ctx.kind === 'dm' ? `Say hi to ${ctx.title.split(' ')[0]}` : 'This room is quiet'),
      el('p', {}, 'Hold the mic to record. Slide up to lock for longer notes. Voice notes are the only way to talk here.')));
  }
  function setHistory(list) {
    inner.replaceChildren(); rows = new Map(); order = []; last = null; lastDay = '';
    if (!list.length) return empty();
    list.forEach((m) => add(m, { live: false }));
    scrollToBottom(false);
  }

  // ---------- receipts ----------
  function statusOf(m) {
    const listened = (m.listenedBy || []).filter((id) => id !== ctx.myId);
    const delivered = (m.deliveredTo || []).filter((id) => id !== ctx.myId);
    if (ctx.kind === 'dm') return listened.includes(ctx.peerId) ? ['listened', 0] : delivered.includes(ctx.peerId) ? ['delivered', 0] : ['sent', 0];
    return listened.length ? ['listened', listened.length] : delivered.length ? ['delivered', delivered.length] : ['sent', 0];
  }
  function tickNode(m) {
    const [s, n] = statusOf(m);
    const label = { sent: 'Sent', delivered: 'Delivered', listened: n ? `Listened by ${n}` : 'Listened' }[s];
    return el('span', { class: `tick ${s}`, title: label, 'aria-label': label }, icon(s === 'listened' ? 'headphones' : s === 'delivered' ? 'checks' : 'check', 'xs'), n && s === 'listened' && ctx.kind !== 'dm' ? el('span', {}, ` ${n}`) : null);
  }
  function updateReceipt({ id, deliveredTo, listenedBy }) {
    const r = rows.get(id); if (!r) return;
    r.msg.deliveredTo = deliveredTo; r.msg.listenedBy = listenedBy;
    if (r.metaTick) { const t = tickNode(r.msg); r.metaTick.replaceWith(t); r.metaTick = t; if (statusOf(r.msg)[0] === 'listened') t.animate?.([{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' }); }
  }
  const isUnplayed = (m) => m.senderId !== ctx.myId && !(m.listenedBy || []).includes(ctx.myId);
  function markListenedLocal(id) {
    const r = rows.get(id); if (!r) return;
    r.msg.listenedBy = [...new Set([...(r.msg.listenedBy || []), ctx.myId])];
    r.row.querySelector('.unplayed-dot')?.remove();
  }

  // ---------- items for the player ----------
  const toItem = (m) => ({ id: m.id, url: m.url, duration: m.duration, sender: m.sender, senderUsername: m.senderUsername, senderId: m.senderId, room: ctx.room, title: ctx.title, kind: 'note' });
  function unplayedQueue() { return order.map((id) => rows.get(id).msg).filter(isUnplayed).map(toItem); }
  function playFrom(m) {
    // tapping an unplayed note continues through the following unplayed notes
    if (isUnplayed(m)) {
      const idx = order.indexOf(m.id);
      const q = order.slice(idx).map((id) => rows.get(id).msg).filter((x, i) => i === 0 || isUnplayed(x)).map(toItem);
      player.toggle(toItem(m), { queue: q });
    } else player.toggle(toItem(m));
  }

  // ---------- render one note ----------
  function add(m, { live = true } = {}) {
    if (rows.has(m.id)) return;
    if (!order.length) { inner.replaceChildren(); inner.classList.remove('is-empty'); }
    const nearBottom = isNearBottom();
    const mine = m.senderId === ctx.myId;
    const day = dayStr(m.ts);
    if (day !== lastDay) { lastDay = day; last = null; inner.append(el('div', { class: 'day-sep', dataset: { day } }, day)); }
    const grouped = last && last.senderId === m.senderId && m.ts - last.ts < GROUP_MS;
    if (grouped) last.row.classList.remove('last');

    const peaks = m.peaks && m.peaks.length ? m.peaks : Array.from({ length: 40 }, (_, i) => 0.3 + 0.3 * Math.abs(Math.sin(i * 1.7 + (m.ts % 7))));
    const bars = peaks.map((p) => el('i', { style: { height: `${Math.max(12, p * 100)}%` } }));
    const knob = el('span', { class: 'knob' });
    const wave = el('div', { class: 'wave', role: 'slider', 'aria-label': 'Seek', 'aria-valuemin': 0, 'aria-valuemax': Math.round(m.duration), 'aria-valuenow': 0, tabindex: 0 }, bars, knob);
    const ic = (n) => { const s = icon(n, 'sm'); s.classList.add(`i-${n}`); return s; };
    const play = el('button', { class: 'play-btn', 'aria-label': `Play voice note from ${m.sender}, ${fmt(m.duration)}` }, ic('play'), ic('pause'));
    const durEl = el('span', {}, fmt(m.duration));
    const speed = el('button', { class: 'speed hidden', 'aria-label': 'Playback speed' }, `${player.rate}×`);
    const metaTick = mine ? tickNode(m) : null;
    const meta = el('div', { class: 'meta' }, durEl, !mine && isUnplayed(m) ? el('span', { class: 'unplayed-dot', title: 'Not played yet' }) : null, speed, el('span', { class: 'grow' }), el('span', {}, timeStr(m.ts)), metaTick);
    const reactionsEl = el('div', { class: 'reactions' });
    const bubble = el('div', { class: 'bubble', vars: { '--dur-w': Math.min(180, m.duration * 10) } }, el('div', { class: 'player' }, play, wave), meta);
    const reactBtn = el('button', { class: 'react-btn', 'aria-label': 'React with your voice', title: 'React with your voice', onclick: () => onReact(m) }, icon('react', 'sm'));
    const row = el('div', { class: `msg ${mine ? 'mine' : 'theirs'} ${grouped ? '' : 'first'} last ${live ? 'enter' : ''}`, dataset: { id: m.id, day, duration: m.duration } },
      avatar({ displayName: m.sender, username: m.senderUsername, id: m.senderId }, { size: 'sm' }),
      el('div', { class: 'msg-col' }, el('div', { class: 'sender', style: { color: colorFor(m.senderUsername || m.sender) } }, m.sender), el('div', { style: { position: 'relative' } }, bubble, reactBtn), reactionsEl));
    inner.append(row);
    const r = { msg: m, row, bars, knob, durEl, metaTick, reactionsEl, speed, wave };
    rows.set(m.id, r); order.push(m.id);
    last = { senderId: m.senderId, ts: m.ts, row };
    (m.reactions || []).forEach((x) => renderReaction(r, x, false));

    play.onclick = (e) => { e.stopPropagation(); haptic('tap'); playFrom(m); };
    speed.onclick = (e) => { e.stopPropagation(); speed.textContent = `${player.cycleRate()}×`; };
    bindScrub(wave, r);
    bindLongPress(bubble, () => onReact(m));
    bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); onReact(m); });
    wave.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const p = player.isCurrent(m.id) ? player.progress() : { t: 0, d: m.duration }; player.seek(toItem(m), (p.t + (e.key === 'ArrowRight' ? 5 : -5)) / (p.d || m.duration)); } });

    if (live) {
      if (nearBottom || mine) scrollToBottom(true);
      else { newWhileAway++; updateFab(); }
    }
  }

  function bindScrub(wave, r) {
    let scrubbing = false;
    const ratioAt = (x) => { const b = wave.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - b.left) / b.width)); };
    wave.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); scrubbing = true; wave.setPointerCapture(e.pointerId); r.row.classList.add('scrubbing');
      paint(r, ratioAt(e.clientX), r.msg.duration * ratioAt(e.clientX));
    });
    wave.addEventListener('pointermove', (e) => { if (scrubbing) paint(r, ratioAt(e.clientX), r.msg.duration * ratioAt(e.clientX)); });
    const end = (e) => {
      if (!scrubbing) return; scrubbing = false; r.row.classList.remove('scrubbing');
      const ratio = ratioAt(e.clientX);
      if (player.isCurrent(r.msg.id)) player.seek(toItem(r.msg), ratio);
      else { playFrom(r.msg); player.seek(toItem(r.msg), ratio); }
    };
    wave.addEventListener('pointerup', end); wave.addEventListener('pointercancel', () => { scrubbing = false; r.row.classList.remove('scrubbing'); });
  }

  function bindLongPress(node, fn) {
    let t = 0, sx = 0, sy = 0;
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.play-btn, .wave, .speed')) return;
      sx = e.clientX; sy = e.clientY; node.classList.add('pressing');
      t = setTimeout(() => { node.classList.remove('pressing'); haptic('lock'); fn(); }, 480);
    });
    const cancel = () => { clearTimeout(t); node.classList.remove('pressing'); };
    node.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
    node.addEventListener('pointerup', cancel); node.addEventListener('pointerleave', cancel); node.addEventListener('pointercancel', cancel);
  }

  // ---------- reactions ----------
  function renderReaction(r, x, animate = true) {
    const bars = (x.peaks && x.peaks.length ? x.peaks : [0.4, 0.8, 0.5, 1, 0.6, 0.3]).filter((_, i) => i % 2 === 0).slice(0, 9);
    const pill = el('button', { class: 'reaction', dataset: { id: x.id }, 'aria-label': `Voice reaction from ${x.sender}, ${fmt(x.duration)}`, title: `${x.sender} reacted`, style: animate ? null : { animation: 'none' } },
      avatar({ displayName: x.sender, username: x.senderUsername, id: x.senderId }, { size: 'xs' }),
      el('span', { class: 'mini-wave' }, bars.map((p) => el('i', { style: { height: `${Math.max(25, p * 100)}%` } }))),
      el('span', {}, fmt(x.duration)));
    pill.onclick = () => player.toggle({ id: x.id, url: x.url, duration: x.duration, sender: x.sender, senderUsername: x.senderUsername, senderId: x.senderId, room: ctx.room, title: ctx.title, kind: 'reaction' });
    r.reactionsEl.append(pill);
  }
  function addReaction(targetId, x) {
    const r = rows.get(targetId); if (!r || r.reactionsEl.querySelector(`[data-id="${x.id}"]`)) return;
    (r.msg.reactions ||= []).push(x);
    renderReaction(r, x, true);
    if (isNearBottom()) scrollToBottom(true);
  }

  // ---------- playback painting ----------
  let paintedId = null;
  function paint(r, ratio, t) {
    const n = Math.round(ratio * r.bars.length);
    r.bars.forEach((b, i) => b.classList.toggle('on', i < n));
    r.knob.style.setProperty('--pos', `${ratio * 100}%`);
    r.durEl.textContent = t > 0.05 ? `${fmt(t)} / ${fmt(r.msg.duration)}` : fmt(r.msg.duration);
    r.wave.setAttribute('aria-valuenow', Math.round(t));
  }
  player.subscribe((s) => {
    if (paintedId && (!s.item || s.item.id !== paintedId)) {
      const old = rows.get(paintedId);
      if (old) { old.row.classList.remove('playing', 'started'); old.speed.classList.add('hidden'); paint(old, 0, 0); }
      inner.querySelectorAll('.reaction.playing').forEach((p) => p.classList.remove('playing'));
      paintedId = null;
    }
    if (!s.item) return;
    if (s.item.kind === 'reaction') { inner.querySelectorAll('.reaction').forEach((p) => p.classList.toggle('playing', p.dataset.id === s.item.id && s.playing)); paintedId = s.item.id; return; }
    const r = rows.get(s.item.id); if (!r) return;
    paintedId = s.item.id;
    r.row.classList.toggle('playing', s.playing); r.row.classList.add('started');
    r.speed.classList.remove('hidden'); r.speed.textContent = `${s.rate}×`;
    paint(r, s.d ? Math.min(1, s.t / s.d) : 0, s.t);
  });

  // ---------- scrolling: sticky date + scroll-to-latest ----------
  const isNearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  function scrollToBottom(smooth) {
    requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));
    newWhileAway = 0; updateFab();
  }
  function updateFab() {
    fab.classList.toggle('show', !isNearBottom() && order.length > 0);
    fabCount.textContent = newWhileAway; fabCount.classList.toggle('hidden', !newWhileAway);
  }
  let stickyT;
  scroller.addEventListener('scroll', () => {
    updateFab();
    if (isNearBottom()) { newWhileAway = 0; updateFab(); }
    const top = scroller.getBoundingClientRect().top + 48;
    const firstRow = [...inner.querySelectorAll('.msg')].find((n) => n.getBoundingClientRect().bottom > top);
    if (firstRow && scroller.scrollTop > 20) { sticky.textContent = firstRow.dataset.day; sticky.classList.add('show'); }
    clearTimeout(stickyT); stickyT = setTimeout(() => sticky.classList.remove('show'), 1100);
  }, { passive: true });
  fab.onclick = () => scrollToBottom(true);

  return { reset, skeleton, setHistory, add, updateReceipt, addReaction, markListenedLocal, unplayedQueue, isNearBottom, scrollToBottom, get count() { return order.length; }, toItem };
}
