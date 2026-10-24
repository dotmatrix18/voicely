// Shared helpers: DOM builder, icons, avatars + ambient gradients, time formatting, haptics, toast, sheet.
export const $ = (id) => document.getElementById(id);
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** el('div', {class, onclick, dataset, style, ...attrs}, ...children). Text is always inserted as text (XSS-safe). */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k === 'vars') for (const [p, val] of Object.entries(v)) n.style.setProperty(p, val);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

// ---------- icons (original line icons, 24×24) ----------
const P = {
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>',
  send: '<path d="M4.5 12 20 4.5l-4 15.5-3.6-6.4L4.5 12Z"/><path d="m12.4 13.6 3.1-3.1"/>',
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor" stroke="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M10 3.5h4M6.5 7l.9 12.1A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9L17.5 7"/>',
  back: '<path d="m14.5 5-7 7 7 7"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  up: '<path d="m6 14.5 6-6 6 6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  more: '<circle cx="12" cy="5.5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="14" width="4.5" height="6.5" rx="1.8"/><rect x="16" y="14" width="4.5" height="6.5" rx="1.8"/>',
  userPlus: '<circle cx="10" cy="8" r="3.8"/><path d="M3 20.5c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5M19 7.5v6M16 10.5h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1-3.8 3.9-6 7.5-6s6.5 2.2 7.5 6"/>',
  chats: '<path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.5-4.3A8 8 0 1 1 20.5 11.5Z"/><path d="M9 10v3M12 8.5v6M15 10v3"/>',
  hash: '<path d="M5 9h15M4 15h15M10.5 3.5 8.5 20.5M15.5 3.5l-2 17"/>',
  wave: '<path d="M3 12h1.5M6.5 9v6M10 5.5v13M13.5 8v8M17 10v4M20.5 12h.5"/>',
  scissors: '<circle cx="6" cy="6.5" r="2.5"/><circle cx="6" cy="17.5" r="2.5"/><path d="M8 8.2 20 18M8 15.8 20 6"/>',
  next: '<path d="M6 5.5v13l9-6.5-9-6.5Z" fill="currentColor" stroke="none"/><path d="M18 5.5v13"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4.5 12.5 4.5 4.5L19.5 6.5"/>',
  checks: '<path d="m2.5 12.5 4.5 4.5L17.5 6.5"/><path d="m11.5 16 1 1L23 6.5" />',
  ear: '<path d="M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-5.5 1.6"/><path d="M10 9.5a2 2 0 0 1 4 0c0 1-1 1.5-1.5 2"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/>',
  devices: '<rect x="2.5" y="4.5" width="13" height="10" rx="2"/><path d="M6 18.5h6"/><rect x="16.5" y="8" width="5" height="11" rx="1.5"/>',
  block: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  logout: '<path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14M9.5 8 5.5 12l4 4M5.5 12H15"/>',
  share: '<path d="M12 3.5v12M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  react: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  chevron: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  sparkle: '<path d="M12 3.5 13.8 9 19.5 10.5 13.8 12.2 12 18 10.2 12.2 4.5 10.5 10.2 9Z"/>',
};
export function icon(name, size = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', `i ${size}`); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || ''; // static, trusted markup
  return s;
}
/** Replace every [data-icon] placeholder in the static HTML with its SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((n) => { if (!n.querySelector('svg')) n.prepend(icon(n.dataset.icon, n.dataset.size || '')); });
}

// ---------- per-user ambient gradient (derived from the username) ----------
function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function hues(key) { const h = hash(key); const a = h % 360; return [a, (a + 35 + ((h >> 9) % 70)) % 360]; }
export function gradientFor(key) { const [a, b] = hues(key); return `linear-gradient(135deg, hsl(${a} 78% 62%), hsl(${b} 80% 52%))`; }
export function ambientFor(key) { const [a, b] = hues(key); return { '--amb-1': `hsl(${a} 85% 60%)`, '--amb-2': `hsl(${b} 85% 55%)` }; }
export const colorFor = (key) => `hsl(${hues(key)[0]} 70% 50%)`;

export function avatar(user, { size = '', online = false, room = false } = {}) {
  const name = (user && (user.displayName || user.username)) || '#';
  const a = el('div', { class: `avatar ${size} ${room ? 'room' : ''}`, dataset: user && user.id ? { uid: user.id } : {}, 'aria-hidden': 'true' });
  fillAvatar(a, user, { room });
  if (online) a.append(el('span', { class: 'presence' }));
  return a;
}
export function fillAvatar(node, user, { room = false } = {}) {
  const name = (user && (user.displayName || user.username)) || '#';
  node.firstChild && node.firstChild.nodeType === 3 ? (node.firstChild.textContent = room ? '#' : initials(name)) : node.prepend(document.createTextNode(room ? '#' : initials(name)));
  node.classList.toggle('room', room);
  node.style.setProperty('--avatar-grad', room ? '' : gradientFor((user && user.username) || name));
  if (user && user.id) node.dataset.uid = user.id;
}
const initials = (name) => { const p = name.trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); };

// ---------- time ----------
export const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const timeStr = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export function dayStr(ts) {
  const d = new Date(ts), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  const sameYear = d.getFullYear() === t.getFullYear();
  return d.toLocaleDateString([], { weekday: (t - d) / 864e5 < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric' });
}
export function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return timeStr(ts);
  if (dayStr(ts) === 'Yesterday') return 'Yesterday';
  if ((now - d) / 864e5 < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// ---------- haptics ----------
const HAPTICS = { tap: 8, start: 14, lock: [10, 30, 10], send: [8, 40, 14], cancel: [30, 40, 30], tick: 5, error: [40, 60, 40] };
export function haptic(kind = 'tap') { try { if (navigator.vibrate && !reducedMotion()) navigator.vibrate(HAPTICS[kind] || 8); } catch {} }

// ---------- toast ----------
let toastT;
export function toast(text, ms = 2600) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

export async function shareLink(url, title, text) {
  try {
    if (navigator.share) { await navigator.share({ title, text, url }); return; }
    await navigator.clipboard.writeText(url); toast('Link copied');
  } catch (e) { if (e && e.name !== 'AbortError') toast(url, 6000); }
}

// ---------- sheet ----------
let onSheetClose = null;
export function openSheet(content, { onClose, className = '' } = {}) {
  const body = $('sheetBody'); body.replaceChildren(...[content].flat());
  const sheet = $('sheet'), scrim = $('scrim');
  sheet.className = `sheet ${className}`; scrim.classList.remove('hidden');
  onSheetClose = onClose || null;
  requestAnimationFrame(() => { sheet.classList.add('show'); scrim.classList.add('show'); });
  const first = body.querySelector('input'); if (first && matchMedia('(min-width: 900px)').matches) setTimeout(() => first.focus(), 60);
}
export function closeSheet() {
  const sheet = $('sheet'), scrim = $('scrim');
  if (sheet.classList.contains('hidden')) return;
  sheet.classList.remove('show'); scrim.classList.remove('show');
  const cb = onSheetClose; onSheetClose = null; if (cb) cb();
  setTimeout(() => { if (!sheet.classList.contains('show')) { sheet.classList.add('hidden'); scrim.classList.add('hidden'); $('sheetBody').replaceChildren(); } }, 260);
}
export const sheetOpen = () => $('sheet').classList.contains('show');
export function confirmSheet(title, text, okLabel, danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeSheet(); resolve(v); };
    openSheet([el('h3', {}, title), el('p', { class: 'lead' }, text),
      el('div', { class: 'sheet-actions' },
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true) }, okLabel),
        el('button', { class: 'btn btn-ghost', onclick: () => finish(false) }, 'Cancel'))], { onClose: () => finish(false) });
  });
}
