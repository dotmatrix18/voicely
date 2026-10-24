// Voicely app controller: onboarding, routing, Chats / Rooms / Me, chat screen, sheets, realtime.
// Voice-only by design: there is no text input for messages anywhere.
import { $, el, icon, hydrateIcons, avatar, fillAvatar, ambientFor, gradientFor, fmt, shortTime, toast, haptic, shareLink, openSheet, closeSheet, sheetOpen, confirmSheet } from './util.js';
import { illus } from './illustrations.js';
import { api, session } from './api.js';
import { player, initMiniPlayer } from './player.js';
import { createTimeline } from './timeline.js';
import { initComposer } from './composer.js';
import { miniRecorder } from './mini-recorder.js';
import { collapsingTitle, pullToRefresh, swipeBack } from './gestures.js';
import { ACCENTS, applyTheme, applyAccent, getTheme, getAccent } from './theme.js';

const state = {
  me: null, socket: null, loaded: false,
  data: { contacts: [], incoming: [], outgoing: [], blocked: [] },
  chat: null, // { room, kind: 'dm'|'group', peer, roster, maxDuration, reactionMax }
  tab: 'chats',
  talking: new Map(), // userId -> { level, t, room, name }
};
const isDesktop = () => matchMedia('(min-width: 900px)').matches;
const emit = (ev, data, cb) => state.socket && state.socket.emit(ev, data, cb);

hydrateIcons();
initMiniPlayer();

// =====================================================================
// Chat building blocks
// =====================================================================
const timeline = createTimeline({ scroller: $('timeline'), inner: $('tlInner'), sticky: $('stickyDate'), fab: $('fabLatest'), fabCount: $('fabCount'), onReact: openReactionSheet });
const composer = initComposer({
  getMaxDuration: () => (state.chat && state.chat.maxDuration) || 120,
  isActive: () => !!state.chat && !sheetOpen(),
  onRecording: (on) => emit('recording', on),
  onLevel: (lvl) => state.socket && state.socket.volatile.emit('level', lvl),
  onSend: (n) => {
    state.socket.timeout(30000).emit('voice', { audio: n.audio, mime: n.mime, duration: n.duration, peaks: n.peaks }, (err, res) => {
      if (err) toast('Sending timed out. Check your connection.');
      else if (!res.ok) { haptic('error'); toast(res.error || "Couldn't send."); }
      else if (n.trimmed > 0.3) toast(`Sent · trimmed ${n.trimmed.toFixed(1)}s of silence`, 1800);
    });
  },
});
player.configure({
  listened: (item) => {
    emit('listened', { room: item.room, id: item.id });
    if (state.chat && state.chat.room === item.room) timeline.markListenedLocal(item.id);
  },
  open: (item) => {
    const c = state.data.contacts.find((x) => x.room === item.room);
    navigate(c ? `/c/${c.username}` : `/r/${item.room}`);
  },
});

// =====================================================================
// Routing:  /  /rooms  /me  /c/<username>  /r/<room>  /add/<username>  /pair/<code>
// =====================================================================
function navigate(path, { replace = false } = {}) {
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  render();
}
window.addEventListener('popstate', render);

function render() {
  const p = location.pathname; let m;
  if (!state.me) {
    $('shell').classList.add('hidden'); $('onboard').classList.remove('hidden');
    if ((m = p.match(/^\/pair\/([A-Za-z0-9-]+)/))) { showPair(); $('pairCode').value = m[1].toUpperCase(); }
    else if (/^\/(add|c|r)\//.test(p)) sessionStorage.setItem('voicely:after', p);
    return;
  }
  $('onboard').classList.add('hidden'); $('shell').classList.remove('hidden');
  if ((m = p.match(/^\/c\/([a-z0-9_]{3,20})$/))) return openDm(m[1]);
  if ((m = p.match(/^\/r\/([a-z0-9-]{3,32})$/i))) return openGroup(m[1].toLowerCase());
  closeChat();
  if ((m = p.match(/^\/add\/@?([a-zA-Z0-9_]{3,20})$/))) { setTab('chats'); history.replaceState(null, '', '/'); return openAddContact(m[1].toLowerCase()); }
  if (p.startsWith('/pair/')) { history.replaceState(null, '', '/'); toast('This device is already signed in.'); }
  setTab(p === '/rooms' ? 'rooms' : p === '/me' ? 'me' : 'chats');
}

// =====================================================================
// Onboarding
// =====================================================================
function showPair() { $('pairForm').classList.remove('hidden'); $('showPairBtn').classList.add('hidden'); }
$('showPairBtn').onclick = showPair;
let checkT;
$('suUsername').addEventListener('input', () => {
  const inp = $('suUsername'); inp.value = inp.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const hint = $('suUsernameHint'); clearTimeout(checkT);
  hint.className = 'hint'; hint.textContent = '3–20 lowercase letters, numbers or _';
  if (inp.value.length < 3) return;
  checkT = setTimeout(async () => {
    try {
      const r = await api('GET', `/username-available/${inp.value}`);
      hint.className = `hint ${r.available ? 'ok' : 'bad'}`;
      hint.textContent = r.available ? `✓ @${inp.value} is available` : r.valid ? `@${inp.value} is taken` : 'Invalid username';
    } catch {}
  }, 280);
});
$('signupForm').onsubmit = async (e) => {
  e.preventDefault(); $('suError').textContent = '';
  try { signedIn(await api('POST', '/signup', { username: $('suUsername').value, displayName: $('suName').value })); }
  catch (err) { $('suError').textContent = err.message; haptic('error'); }
};
$('pairForm').onsubmit = async (e) => {
  e.preventDefault(); $('pairError').textContent = '';
  try { signedIn(await api('POST', '/pair/redeem', { code: $('pairCode').value })); }
  catch (err) { $('pairError').textContent = err.message; haptic('error'); }
};
function signedIn({ token, user }) {
  session.set(token); state.me = user;
  const after = sessionStorage.getItem('voicely:after'); sessionStorage.removeItem('voicely:after');
  startApp(); navigate(after || '/', { replace: true });
}

// =====================================================================
// Realtime
// =====================================================================
function connectSocket() {
  const s = io({ auth: { token: session.token } });
  state.socket = s;
  s.on('connect', () => { if (state.chat) joinRoom(state.chat.room, true); refreshContacts(); });
  s.on('connect_error', (err) => { if (err.message === 'unauthorized') signOutLocal(); });
  s.on('disconnect', () => { if (state.chat) $('chatStatus').textContent = 'Reconnecting…'; });
  s.on('voice', (m) => {
    if (!state.chat || m.room !== state.chat.room) return;
    timeline.add(m, { live: true });
    if (m.senderId !== state.me.id) { haptic('tick'); if (state.chat.kind === 'dm' && !document.hidden) emit('read', { room: m.room }); }
  });
  s.on('receipt', (r) => { if (state.chat && state.chat.room === r.room) timeline.updateReceipt(r); refreshContacts(); });
  s.on('reaction', ({ room, targetId, reaction }) => { if (state.chat && state.chat.room === room) timeline.addReaction(targetId, reaction); });
  s.on('reaction:inbox', ({ room, from }) => {
    if (state.chat && state.chat.room === room) return;
    const c = state.data.contacts.find((x) => x.id === from); if (c) toast(`${c.displayName} reacted to your voice note`);
  });
  s.on('inbox', ({ room, from }) => {
    if (state.chat && state.chat.room === room && !document.hidden) return;
    refreshContacts();
    if (from !== state.me.id && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const c = state.data.contacts.find((x) => x.id === from);
      try { new Notification(c ? c.displayName : 'Voicely', { body: '🎙️ Sent you a voice note', icon: '/icons/icon-192.png', tag: room }); } catch {}
    }
  });
  s.on('contacts:changed', refreshContacts);
  s.on('contact:request', ({ from }) => { haptic('tick'); toast(`${from.displayName} wants to add you`, 3200); });
  s.on('contact:presence', ({ id, online }) => {
    const c = state.data.contacts.find((x) => x.id === id);
    if (c) { c.online = online; renderChats(); }
    if (state.chat && state.chat.peer && state.chat.peer.id === id) { state.chat.peer.online = online; renderChatHeader(); }
  });
  s.on('presence', (list) => { if (state.chat && state.chat.kind === 'group') { state.chat.roster = list; renderChatHeader(); } });
  s.on('talking', onTalking);
  s.on('room:closed', ({ room }) => { if (state.chat && state.chat.room === room) { toast('This chat is no longer available.'); navigate('/'); } });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.chat && state.chat.kind === 'dm') { emit('read', { room: state.chat.room }); refreshContacts(); }
});

// ---------- live "talking" presence ----------
function onTalking({ userId, room, on, level, name }) {
  if (userId === state.me.id) return;
  if (on) state.talking.set(userId, { level: level ?? (state.talking.get(userId)?.level || 0.2), t: Date.now(), room, name });
  else state.talking.delete(userId);
  paintTalking(userId);
}
setInterval(() => { const now = Date.now(); for (const [id, v] of state.talking) if (now - v.t > 2500) { state.talking.delete(id); paintTalking(id); } }, 600);
function paintTalking(userId) {
  const t = state.talking.get(userId);
  document.querySelectorAll(`#tab-chats .row[data-uid="${userId}"]`).forEach((row) => {
    const isDmToMe = t && t.room && t.room.startsWith('dm-');
    row.classList.toggle('is-talking', !!isDmToMe);
    const av = row.querySelector('.avatar'); av.classList.toggle('talking', !!isDmToMe); av.style.setProperty('--lvl', isDmToMe ? t.level : 0);
  });
  if (state.chat) renderChatHeader();
}

// =====================================================================
// Contacts data
// =====================================================================
let refreshT, refreshP = null;
function refreshContacts() {
  clearTimeout(refreshT);
  return new Promise((resolve) => { refreshT = setTimeout(() => resolve(refreshNow()), 80); });
}
async function refreshNow() {
  try {
    state.data = await api('GET', '/contacts'); state.loaded = true;
    renderChats(); renderBadge();
    if (state.chat && state.chat.kind === 'dm') { const c = state.data.contacts.find((x) => x.id === state.chat.peer.id); if (c) { Object.assign(state.chat.peer, c); renderChatHeader(); } }
    if (state.tab === 'me') renderMe();
  } catch (e) { if (e.status === 401) signOutLocal(); }
}
function renderBadge() {
  const { contacts, incoming } = state.data;
  const n = incoming.length + contacts.reduce((a, c) => a + c.unread, 0);
  $('chatsBadge').textContent = n > 99 ? '99+' : n; $('chatsBadge').classList.toggle('hidden', !n);
  document.title = n ? `(${n}) Voicely` : 'Voicely';
}

// =====================================================================
// Tabs
// =====================================================================
const TITLES = { chats: 'Chats', rooms: 'Rooms', me: 'Profile' };
const collapse = collapsingTitle($('listScroll'), $('listAppbar'));
function setTab(tab) {
  const changed = state.tab !== tab;
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  ['chats', 'rooms', 'me'].forEach((t) => $(`tab-${t}`).classList.toggle('hidden', t !== tab));
  $('largeTitle').textContent = TITLES[tab]; $('listAppbarTitle').textContent = TITLES[tab];
  $('addContactBtn').classList.toggle('hidden', tab !== 'chats');
  if (changed) { $('listScroll').scrollTop = 0; const p = $(`tab-${tab}`); p.style.animation = 'none'; void p.offsetWidth; p.style.animation = ''; }
  ({ chats: renderChats, rooms: renderRooms, me: renderMe })[tab]();
  collapse();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { haptic('tap'); navigate(t.dataset.tab === 'chats' ? '/' : `/${t.dataset.tab}`); }));
$('addContactBtn').onclick = () => openAddContact();
$('scrim').onclick = closeSheet;
pullToRefresh($('listScroll'), $('ptr'), () => refreshNow(), () => state.tab === 'chats');

// ---------- Chats tab ----------
const statusIcon = (s) => icon(s === 'listened' ? 'headphones' : s === 'delivered' ? 'checks' : 'check', 'xs');
function renderChats() {
  const root = $('tab-chats'); if (state.tab !== 'chats' && root.childElementCount) return;
  const { contacts, incoming, outgoing } = state.data;
  if (!state.loaded) {
    root.replaceChildren(...Array.from({ length: 6 }, (_, i) => el('div', { class: 'skel-row', style: { opacity: 1 - i * 0.13 } }, el('div', { class: 'skel circle' }),
      el('div', { class: 'skel-lines' }, el('div', { class: 'skel skel-line', style: { width: `${45 + (i * 17) % 30}%` } }), el('div', { class: 'skel skel-line', style: { width: `${30 + (i * 23) % 40}%` } })))));
    return;
  }
  const parts = [];
  if (incoming.length) {
    parts.push(el('div', { class: 'group-title' }, 'Requests', el('span', { class: 'pill-badge' }, incoming.length)));
    parts.push(el('ul', { class: 'list', id: 'requestsList' }, incoming.map((u) => el('li', { class: 'row' }, avatar(u),
      el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, u.displayName), el('div', { class: 'row-sub' }, `@${u.username} wants to connect`)),
      el('div', { class: 'row-actions' },
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => respond(u, true) }, 'Accept'),
        el('button', { class: 'btn btn-ghost btn-sm', 'aria-label': `Decline ${u.displayName}`, onclick: () => respond(u, false) }, icon('close', 'sm')))))));
  }
  if (contacts.length) {
    if (incoming.length) parts.push(el('div', { class: 'group-title' }, 'Chats'));
    parts.push(el('ul', { class: 'list', id: 'contactsList' }, contacts.map(contactRow)));
  } else {
    parts.push(el('div', { class: 'empty', id: 'contactsEmpty' }, illus('chats'), el('h4', {}, 'No chats yet'),
      el('p', {}, 'Add a friend by their username, or share your link. Then just hold the mic and talk.'),
      el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } },
        el('button', { class: 'btn btn-primary', onclick: () => openAddContact() }, icon('userPlus', 'sm'), 'Add contact'),
        el('button', { class: 'btn btn-tonal', onclick: shareMe }, icon('share', 'sm'), 'Share my link'))));
  }
  if (outgoing.length) {
    parts.push(el('div', { class: 'group-title' }, 'Sent requests'));
    parts.push(el('ul', { class: 'list', id: 'outgoingList' }, outgoing.map((u) => el('li', { class: 'row' }, avatar(u),
      el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, u.displayName), el('div', { class: 'row-sub' }, `@${u.username} · pending`)),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => contactAction('cancel', u) }, 'Cancel')))));
  }
  root.replaceChildren(...parts);
  contacts.forEach((c) => paintTalking(c.id));
}
function contactRow(c) {
  const active = state.chat && state.chat.room === c.room;
  const normal = c.lastTs
    ? el('div', { class: 'row-sub sub-normal' }, c.lastFromMe ? el('span', { class: 'faint', style: { display: 'inline-flex' } }, statusIcon(c.lastStatus)) : null, icon('mic', 'xs'), `Voice note · ${fmt(c.lastDuration)}`)
    : el('div', { class: 'row-sub sub-normal' }, `@${c.username}`);
  const talking = el('div', { class: 'row-sub talking sub-talking' }, el('span', { class: 'equalizer' }, el('i'), el('i'), el('i')), 'Recording a voice note…');
  const row = el('li', { class: `row tappable ${active ? 'active' : ''}`, dataset: { username: c.username, uid: c.id }, tabindex: 0, role: 'link', 'aria-label': `${c.displayName}${c.unread ? `, ${c.unread} unplayed` : ''}`,
    onclick: () => navigate(`/c/${c.username}`), onkeydown: (e) => { if (e.key === 'Enter') navigate(`/c/${c.username}`); },
    oncontextmenu: (e) => { e.preventDefault(); openProfile(c); } },
    avatar(c, { online: c.online }),
    el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, c.displayName, c.voiceHello ? el('span', { class: 'faint', title: 'Has a voice hello', style: { display: 'inline-flex' } }, icon('wave', 'xs')) : null), normal, talking),
    el('div', { class: 'row-side' }, el('span', { class: `row-time ${c.unread ? 'unread' : ''}` }, shortTime(c.lastTs)), c.unread ? el('span', { class: 'count' }, c.unread > 99 ? '99+' : c.unread) : el('span', { style: { height: '20px' } })));
  return row;
}
async function respond(u, accept) {
  try { await api('POST', '/contacts/respond', { username: u.username, accept }); haptic(accept ? 'send' : 'tap'); toast(accept ? `${u.displayName} added` : 'Request declined'); refreshContacts(); }
  catch (e) { toast(e.message); }
}
async function contactAction(action, u) {
  try { await api('POST', `/contacts/${action}`, { username: u.username }); refreshContacts(); return true; }
  catch (e) { toast(e.message); return false; }
}

// ---------- Rooms tab ----------
const words = ['sunny', 'brave', 'calm', 'lucky', 'swift', 'cosmic', 'mellow', 'bright', 'quiet', 'happy'];
const animals = ['tiger', 'otter', 'panda', 'falcon', 'koala', 'lynx', 'dolphin', 'fox', 'owl', 'yak'];
const randomRoom = () => `${words[(Math.random() * 10) | 0]}-${animals[(Math.random() * 10) | 0]}-${10 + ((Math.random() * 90) | 0)}`;
const recentRooms = () => { try { return JSON.parse(localStorage.getItem('voicely:rooms')) || []; } catch { return []; } };
const rememberRoom = (room) => localStorage.setItem('voicely:rooms', JSON.stringify([{ room, ts: Date.now() }, ...recentRooms().filter((r) => r.room !== room)].slice(0, 12)));
function renderRooms() {
  const input = el('input', { id: 'roomInput', class: 'input', maxlength: 32, placeholder: 'Room code, e.g. sunny-otter-42', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Room code' });
  input.addEventListener('input', () => { input.value = input.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); });
  const err = el('p', { class: 'error', id: 'roomError' });
  const form = el('form', { id: 'roomForm', class: 'settings-card', autocomplete: 'off', onsubmit: (e) => {
    e.preventDefault(); const room = input.value.trim();
    if (!/^[a-z0-9-]{3,32}$/.test(room) || /^(dm|profile)-/.test(room)) { err.textContent = 'Use 3–32 lowercase letters, numbers or dashes.'; return; }
    navigate(`/r/${room}`);
  } },
    el('div', {}, el('div', { class: 'label' }, 'Join or start a group room'), el('p', { class: 'muted small' }, 'Anyone with the code can join and listen. Share it with your study group or friends.')),
    el('div', { style: { display: 'flex', gap: '8px' } }, input, el('button', { type: 'button', class: 'btn btn-ghost', id: 'newRoomBtn', onclick: () => { input.value = randomRoom(); haptic('tick'); } }, icon('sparkle', 'sm'), 'New')),
    el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Join room'), err);
  const list = recentRooms();
  $('tab-rooms').replaceChildren(el('div', { class: 'settings-group' }, form),
    list.length ? el('div', {}, el('div', { class: 'group-title' }, 'Recent rooms'), el('ul', { class: 'list', id: 'recentRooms' }, list.map((r) => el('li', { class: 'row tappable', onclick: () => navigate(`/r/${r.room}`) },
      avatar({ displayName: r.room }, { room: true }), el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, r.room), el('div', { class: 'row-sub' }, 'Group room')),
      el('div', { class: 'row-side' }, el('span', { class: 'row-time' }, shortTime(r.ts))))))) :
      el('div', { class: 'empty' }, illus('rooms'), el('h4', {}, 'No rooms yet'), el('p', {}, 'Start a room and share its link. Everyone in it hears every voice note.')));
}

// ---------- Me tab ----------
function helloCard(user, { own = false } = {}) {
  const h = user.voiceHello;
  if (!h) {
    return own
      ? el('div', { class: 'hello-empty' }, icon('wave', 'lg'), el('b', { style: { color: 'var(--text)' } }, 'Record a voice hello'), el('span', {}, 'Instead of a text bio, people hear your voice when they open your profile. Up to 10 seconds.'),
          el('button', { class: 'btn btn-primary btn-sm', id: 'recordHelloBtn', onclick: openHelloSheet }, icon('mic', 'sm'), 'Record'))
      : el('div', { class: 'hello-empty' }, `${user.displayName.split(' ')[0]} hasn’t recorded a voice hello yet.`);
  }
  const item = { id: `hello-${user.id}-${h.ts || 0}`, url: h.url, duration: h.duration, sender: user.displayName, senderUsername: user.username, senderId: user.id, kind: 'hello' };
  const bars = (h.peaks && h.peaks.length ? h.peaks : Array(32).fill(0.5)).map((p) => el('i', { style: { height: `${Math.max(12, p * 100)}%` } }));
  const btn = el('button', { class: 'play-btn', 'aria-label': `Play ${user.displayName}'s voice hello` }, icon('play', 'sm'));
  const time = el('span', { class: 'small faint', style: { fontVariantNumeric: 'tabular-nums' } }, fmt(h.duration));
  const card = el('div', { class: 'hello-card', dataset: { hello: item.id } }, btn,
    el('div', { style: { flex: 1, minWidth: 0 } }, el('div', { class: 'label' }, 'Voice hello'), el('div', { class: 'wave' }, bars)), time,
    own ? el('button', { class: 'icon-btn', 'aria-label': 'Re-record voice hello', title: 'Re-record', onclick: openHelloSheet }, icon('mic', 'sm')) : null,
    own ? el('button', { class: 'icon-btn', 'aria-label': 'Delete voice hello', title: 'Delete', onclick: deleteHello }, icon('trash', 'sm')) : null);
  btn.onclick = () => { haptic('tap'); player.toggle(item); };
  const unsub = player.subscribe((s) => {
    if (!card.isConnected) return unsub();
    const mine = s.item && s.item.id === item.id;
    const ratio = mine && s.d ? s.t / s.d : 0;
    bars.forEach((b, i) => b.classList.toggle('on', i < Math.round(ratio * bars.length)));
    btn.replaceChildren(icon(mine && s.playing ? 'pause' : 'play', 'sm'));
    time.textContent = mine && s.t > 0 ? fmt(s.t) : fmt(h.duration);
  });
  return card;
}
function hero(user, { own = false, online = false } = {}) {
  return el('div', { class: 'hero' },
    el('div', { class: 'hero-banner', style: { '--avatar-grad': gradientFor(user.username) }, vars: { '--avatar-grad': gradientFor(user.username) } }),
    el('div', { class: 'hero-body' }, avatar(user, { size: 'xl', online }),
      el('div', { class: 'hero-name' }, user.displayName), el('div', { class: 'muted' }, `@${user.username}${online ? ' · online' : ''}`),
      helloCard(user, { own })));
}
function renderMe() {
  const me = state.me; if (!me) return;
  const seg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' }, ['system', 'light', 'dark'].map((t) =>
    el('button', { role: 'radio', 'aria-checked': String(getTheme() === t), dataset: { theme: t }, onclick: () => { applyTheme(t); haptic('tick'); renderMe(); } }, t[0].toUpperCase() + t.slice(1))));
  const sw = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent colour' }, Object.entries(ACCENTS).map(([name, [c1, c2]]) =>
    el('button', { class: 'swatch', role: 'radio', 'aria-label': name, title: name, 'aria-checked': String(getAccent() === name), dataset: { accent: name }, vars: { '--c1': c1, '--c2': c2 }, onclick: () => { applyAccent(name); haptic('tick'); renderMe(); } })));
  const row = (ic, color, label, action, extra) => el('button', { class: `menu-row ${color === 'danger' ? 'danger' : ''}`, dataset: { action }, onclick: ACTIONS[action] },
    el('span', { class: 'menu-icon', style: { background: color === 'danger' ? 'var(--danger)' : color } }, icon(ic)), label, extra || el('span', { class: 'chev' }, icon('chevron', 'sm')));
  $('tab-me').replaceChildren(hero(me, { own: true }),
    el('div', { class: 'settings-group' }, el('div', { class: 'group-title' }, 'Appearance'),
      el('div', { class: 'settings-card' }, el('div', {}, el('div', { class: 'label' }, 'Theme'), seg), el('div', {}, el('div', { class: 'label' }, 'Accent'), sw))),
    el('div', { class: 'settings-group' }, el('div', { class: 'group-title' }, 'Account'),
      el('div', { class: 'card' },
        row('share', '#3b82f6', 'Share my “add me” link', 'share-me'),
        row('edit', '#f59e0b', 'Change display name', 'edit-name'),
        row('devices', '#10b981', 'Link another device', 'pair'),
        row('block', '#64748b', 'Blocked users', 'blocked', el('em', {}, state.data.blocked.length || ''))
      )),
    el('div', { class: 'settings-group' }, el('div', { class: 'card' }, row('logout', 'danger', 'Sign out of this device', 'logout', el('span')))),
    el('p', { class: 'faint small', style: { textAlign: 'center', padding: '8px 0 24px' } }, 'Voicely · voice notes only, no typing'));
}
const ACTIONS = { 'share-me': () => shareMe(), 'edit-name': () => editName(), pair: () => pairDevice(), blocked: () => showBlocked(), logout: () => logout() };
const shareMe = () => shareLink(`${location.origin}/add/${state.me.username}`, 'Add me on Voicely', `Add me on Voicely, the voice-only messenger: @${state.me.username}`);

function openHelloSheet() {
  let rec;
  rec = miniRecorder({ max: 10, label: 'Hold to record your hello', onDone: (n) => {
    state.socket.timeout(20000).emit('profile:voice', { audio: n.audio, mime: n.mime, duration: n.duration, peaks: n.peaks }, (err, res) => {
      if (err || !res.ok) return toast((res && res.error) || 'Upload failed');
      state.me.voiceHello = res.voiceHello; closeSheet(); toast('Voice hello saved'); renderMe();
    });
  } });
  openSheet([el('h3', {}, 'Your voice hello'), el('p', { class: 'lead' }, 'Say hi in your own voice, e.g. who you are and what you’re into. It shows on your profile instead of a text bio.'), rec], { onClose: () => rec.cancel() });
}
async function deleteHello() {
  if (!(await confirmSheet('Delete voice hello?', 'Your profile will show no voice hello until you record a new one.', 'Delete'))) return;
  emit('profile:voice:delete', {}, () => { state.me.voiceHello = null; renderMe(); toast('Voice hello deleted'); });
}
function editName() {
  const input = el('input', { class: 'input', maxlength: 32, value: state.me.displayName, 'aria-label': 'Display name' });
  const err = el('p', { class: 'error' });
  openSheet([el('h3', {}, 'Display name'), el('form', { style: { display: 'grid', gap: '12px' }, onsubmit: async (e) => {
    e.preventDefault();
    try { state.me = (await api('POST', '/me', { displayName: input.value })).user; renderMe(); closeSheet(); toast('Name updated'); }
    catch (x) { err.textContent = x.message; }
  } }, input, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'), err)]);
}
async function pairDevice() {
  let r; try { r = await api('POST', '/pair'); } catch (e) { return toast(e.message); }
  const pretty = `${r.code.slice(0, 4)}-${r.code.slice(4)}`; const link = `${location.origin}/pair/${r.code}`;
  const left = el('p', { class: 'faint small', style: { textAlign: 'center' } });
  const t = setInterval(() => {
    const s = Math.round((r.expiresAt - Date.now()) / 1000);
    if (s <= 0 || !sheetOpen()) { clearInterval(t); left.textContent = 'Expired. Close and try again.'; return; }
    left.textContent = `Expires in ${fmt(s)} · works once`;
  }, 500);
  openSheet([el('h3', {}, 'Link another device'),
    el('p', { class: 'lead' }, 'On the other device, open Voicely, tap “Already have an account? Link this device”, and enter this code. Or open the link there.'),
    el('div', { class: 'code-box', 'aria-label': 'Pairing code' }, pretty), left, el('div', { class: 'link-box' }, link),
    el('div', { class: 'sheet-actions' }, el('button', { class: 'btn btn-ghost', onclick: () => shareLink(link, 'Link Voicely', 'Open on your other device to sign in to Voicely') }, icon('share', 'sm'), 'Share link'))]);
}
function showBlocked() {
  const list = state.data.blocked;
  openSheet([el('h3', {}, 'Blocked users'), list.length ? el('ul', { class: 'list' }, list.map((u) => el('li', { class: 'row' }, avatar(u),
    el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, u.displayName), el('div', { class: 'row-sub' }, `@${u.username}`)),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { if (await contactAction('unblock', u)) { toast(`@${u.username} unblocked`); closeSheet(); } } }, 'Unblock'))))
    : el('p', { class: 'lead' }, 'You haven’t blocked anyone.')]);
}
async function logout() {
  if (!(await confirmSheet('Sign out?', 'This device will forget your account. There’s no password, so link another device first if you want to keep access.', 'Sign out'))) return;
  try { await api('POST', '/logout'); } catch {}
  signOutLocal();
}
function signOutLocal() {
  session.clear(); state.me = null; player.stop();
  if (window.caches) caches.keys().then((ks) => ks.filter((k) => k.endsWith('-audio')).forEach((k) => caches.delete(k))).catch(() => {});
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  location.href = '/';
}

// ---------- Add contact ----------
function openAddContact(prefill = '') {
  const input = el('input', { class: 'input', maxlength: 21, placeholder: 'username', autocapitalize: 'none', spellcheck: 'false', value: prefill, 'aria-label': 'Username' });
  input.addEventListener('input', () => { input.value = input.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); });
  const result = el('div', { 'aria-live': 'polite' });
  async function search() {
    const q = input.value.trim(); result.replaceChildren(); if (q.length < 3) return;
    try {
      const { user, status } = await api('GET', `/users/${encodeURIComponent(q)}`);
      const [label, cls, fn] = {
        none: ['Add', 'btn-primary', async () => { if (await contactAction('request', user)) { haptic('send'); toast('Request sent'); search(); } }],
        requested: ['Requested', 'btn-ghost', async () => { await contactAction('cancel', user); search(); }],
        incoming: ['Accept', 'btn-primary', async () => { await respond(user, true); search(); }],
        contact: ['Open chat', 'btn-tonal', () => { closeSheet(); navigate(`/c/${user.username}`); }],
        blocked: ['Unblock', 'btn-ghost', async () => { await contactAction('unblock', user); search(); }],
        self: ['You', 'btn-ghost', null],
      }[status];
      result.replaceChildren(el('div', { class: 'result-card' }, avatar(user),
        el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, user.displayName), el('div', { class: 'row-sub' }, `@${user.username}${status === 'requested' ? ' · request sent' : ''}`)),
        el('button', { class: `btn btn-sm ${cls}`, disabled: !fn, onclick: fn }, label)),
        user.voiceHello ? el('div', { style: { marginTop: '8px' } }, helloCard(user)) : null);
    } catch (e) { result.replaceChildren(el('p', { class: 'error', style: { marginTop: '12px' } }, e.status === 404 ? `No one is called @${q}` : e.message)); }
  }
  openSheet([el('h3', {}, 'Add contact'), el('p', { class: 'lead' }, 'Type their exact username. They’ll get a request to accept.'),
    el('form', { onsubmit: (e) => { e.preventDefault(); search(); }, style: { display: 'flex', gap: '8px' } },
      el('div', { class: 'input-wrap', style: { flex: 1 } }, el('span', {}, '@'), input), el('button', { class: 'btn btn-primary', type: 'submit' }, 'Find')),
    result,
    el('div', { class: 'group-title', style: { padding: '24px 0 8px' } }, 'Or share your link'),
    el('div', { class: 'link-box' }, `${location.origin}/add/${state.me.username}`),
    el('div', { class: 'sheet-actions' }, el('button', { class: 'btn btn-tonal', onclick: shareMe }, icon('share', 'sm'), 'Share my link'))]);
  if (prefill) search();
}

// ---------- Profile sheet ----------
function openProfile(c) {
  const contact = state.data.contacts.find((x) => x.id === c.id) || c;
  const inChat = state.chat && state.chat.room === contact.room;
  openSheet([el('div', { class: 'profile-sheet' }, hero(contact, { online: contact.online })),
    el('div', { class: 'sheet-actions' },
      !inChat && contact.room ? el('button', { class: 'btn btn-primary', onclick: () => { closeSheet(); navigate(`/c/${contact.username}`); } }, icon('mic', 'sm'), 'Open voice chat') : null,
      el('button', { class: 'btn btn-ghost', onclick: () => removeContact(contact) }, 'Remove contact'),
      el('button', { class: 'btn btn-danger', onclick: () => blockContact(contact) }, `Block @${contact.username}`))], { className: 'profile' });
}
async function removeContact(c) {
  if (!(await confirmSheet(`Remove ${c.displayName}?`, 'You won’t be able to send each other voice notes until one of you adds the other again.', 'Remove'))) return;
  if (await contactAction('remove', c)) { toast('Contact removed'); if (state.chat) navigate('/'); }
}
async function blockContact(c) {
  if (!(await confirmSheet(`Block @${c.username}?`, 'They’ll be removed from your contacts and can’t find you or send requests. You can unblock them from your profile.', 'Block'))) return;
  if (await contactAction('block', c)) { toast(`@${c.username} blocked`); if (state.chat) navigate('/'); }
}

// ---------- Voice reactions ----------
function openReactionSheet(msg) {
  if (!state.chat) return;
  const room = state.chat.room;
  const who = msg.senderId === state.me.id ? 'your' : `${msg.sender.split(' ')[0]}’s`;
  const rec = miniRecorder({ max: (state.chat && state.chat.reactionMax) || 5, label: 'Hold to react', onLevel: (l) => state.socket.volatile.emit('level', l), onRecording: (on) => emit('recording', on),
    onDone: (n) => {
      state.socket.timeout(20000).emit('react', { room, target: msg.id, note: { audio: n.audio, mime: n.mime, duration: n.duration, peaks: n.peaks } }, (err, res) => {
        if (err || !res.ok) { haptic('error'); return toast((res && res.error) || 'Reaction failed'); }
        closeSheet(); toast('Reaction sent', 1400);
      });
    } });
  openSheet([el('h3', {}, 'Voice reaction'), el('p', { class: 'lead' }, `React to ${who} ${fmt(msg.duration)} voice note with a laugh, a “wow”, or a quick reply. Up to 5 seconds.`), rec], { onClose: () => rec.cancel() });
}

// =====================================================================
// Chat screen
// =====================================================================
$('chatPlaceholder').append(el('div', { class: 'empty' }, illus('pick'), el('h4', {}, 'Pick a conversation'), el('p', {}, 'Choose a contact on the left, or start a room. Everything here is said out loud.')));

async function openDm(username) {
  let c = state.data.contacts.find((x) => x.username === username);
  if (!c) { await refreshNow(); c = state.data.contacts.find((x) => x.username === username); }
  if (!c) { toast(`@${username} isn’t in your contacts yet`); return navigate('/', { replace: true }); }
  if (!state.tab || $('tab-chats').classList.contains('hidden')) setTab('chats');
  enterChat({ room: c.room, kind: 'dm', peer: { ...c } });
}
function openGroup(room) {
  if (/^(dm|profile)-/.test(room)) { toast('That’s a private chat.'); return navigate('/', { replace: true }); }
  rememberRoom(room);
  if (isDesktop()) setTab('rooms');
  enterChat({ room, kind: 'group', roster: [] });
}
let hideT;
function enterChat(chat) {
  clearTimeout(hideT);
  if (state.chat && state.chat.room === chat.room) { showChatPane(); return; }
  leaveRoomOnly();
  state.chat = chat;
  timeline.reset({ myId: state.me.id, kind: chat.kind, title: chat.kind === 'dm' ? chat.peer.displayName : `#${chat.room}`, room: chat.room, peerId: chat.peer && chat.peer.id });
  timeline.skeleton();
  const amb = ambientFor(chat.kind === 'dm' ? chat.peer.username : chat.room);
  Object.entries(amb).forEach(([k, v]) => $('chatView').style.setProperty(k, v));
  $('chatView').classList.toggle('dm', chat.kind === 'dm');
  $('listenBtn').classList.toggle('hidden', false);
  renderChatHeader();
  showChatPane();
  joinRoom(chat.room, false);
  if (state.tab === 'chats') renderChats();
  if ('Notification' in window && Notification.permission === 'default') document.addEventListener('pointerdown', () => Notification.requestPermission().catch(() => {}), { once: true });
}
function showChatPane() {
  $('chatPlaceholder').classList.add('hidden'); $('chatView').classList.remove('hidden');
  requestAnimationFrame(() => $('shell').classList.add('chat-open'));
  document.body.classList.add('in-chat');
  player.setViewingRoom(state.chat.room);
}
function joinRoom(room, rejoin) {
  emit('join', { room }, (res) => {
    if (!state.chat || state.chat.room !== room) return;
    if (!res || !res.ok) { toast((res && res.error) || 'Couldn’t open chat.'); state.chat = null; return navigate('/', { replace: true }); }
    Object.assign(state.chat, { maxDuration: res.maxDuration, reactionMax: res.reactionMax });
    if (res.peer) state.chat.peer = { ...state.chat.peer, ...res.peer };
    if (rejoin) res.history.forEach((m) => timeline.add(m, { live: false })); else timeline.setHistory(res.history);
    renderChatHeader();
  });
}
function leaveRoomOnly() {
  if (!state.chat) return;
  composer.cancel(true);
  emit('leave');
  state.chat = null;
}
function closeChat() {
  if (!state.chat) { $('shell').classList.remove('chat-open'); document.body.classList.remove('in-chat'); return; }
  leaveRoomOnly();
  $('shell').classList.remove('chat-open'); document.body.classList.remove('in-chat');
  player.setViewingRoom(null);
  hideT = setTimeout(() => { if (!state.chat) { $('chatView').classList.add('hidden'); $('chatPlaceholder').classList.remove('hidden'); } }, isDesktop() ? 0 : 380);
  refreshContacts();
}
function renderChatHeader() {
  const c = state.chat; if (!c) return;
  const av = $('chatAvatar'), st = $('chatStatus');
  av.querySelector('.presence')?.remove();
  if (c.kind === 'dm') {
    fillAvatar(av, c.peer);
    if (c.peer.online) av.append(el('span', { class: 'presence' }));
    $('chatTitle').textContent = c.peer.displayName;
    const t = state.talking.get(c.peer.id);
    av.classList.toggle('talking', !!t); av.style.setProperty('--lvl', t ? t.level : 0);
    st.className = `chat-status ${t ? 'talking' : c.peer.online ? 'online' : ''}`;
    st.textContent = t ? 'recording a voice note…' : c.peer.online ? 'online' : `@${c.peer.username}`;
    $('chatHead').setAttribute('aria-label', `View ${c.peer.displayName}'s profile`);
  } else {
    fillAvatar(av, { displayName: c.room }, { room: true });
    $('chatTitle').textContent = `#${c.room}`;
    const talkers = [...state.talking.values()].filter((t) => t.room === c.room);
    av.classList.toggle('talking', talkers.length > 0); av.style.setProperty('--lvl', talkers[0] ? talkers[0].level : 0);
    st.className = `chat-status ${talkers.length ? 'talking' : ''}`;
    st.textContent = talkers.length ? `${talkers.map((t) => t.name).slice(0, 2).join(', ')} recording…` : `${(c.roster || []).length || 1} here now`;
    $('chatHead').setAttribute('aria-label', 'Who’s here');
  }
  document.title = `${c.kind === 'dm' ? c.peer.displayName : '#' + c.room} · Voicely`;
}
const goBack = () => navigate(state.chat && state.chat.kind === 'group' ? '/rooms' : '/');
$('backBtn').onclick = goBack;
swipeBack($('chatPane'), $('shell'), goBack, () => !isDesktop());
$('chatHead').onclick = () => {
  const c = state.chat; if (!c) return;
  if (c.kind === 'dm') return openProfile(c.peer);
  openSheet([el('h3', {}, `#${c.room}`), el('p', { class: 'lead' }, 'Here now'), el('ul', { class: 'list' }, (c.roster || []).map((u) => el('li', { class: 'row' }, avatar(u, { size: 'md' }),
    el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, u.displayName), el('div', { class: 'row-sub' }, `@${u.username}${u.id === state.me.id ? ' · you' : ''}`)))))]);
};
$('chatMenuBtn').onclick = () => {
  const c = state.chat; if (!c) return;
  if (c.kind === 'dm') return openProfile(c.peer);
  openSheet([el('h3', {}, `#${c.room}`), el('div', { class: 'sheet-actions' },
    el('button', { class: 'btn btn-primary', onclick: () => { closeSheet(); shareLink(`${location.origin}/r/${c.room}`, 'Join my Voicely room', 'Talk with me on Voicely, voice only!'); } }, icon('share', 'sm'), 'Share room link'),
    el('button', { class: 'btn btn-ghost', onclick: () => { closeSheet(); navigate('/rooms'); } }, 'Leave room'))]);
};
$('listenBtn').onclick = () => {
  const q = timeline.unplayedQueue();
  if (!q.length) { toast('You’re all caught up 🎧'); return; }
  haptic('start'); player.play(q[0], { queue: q, listenMode: true });
  toast(`Listen mode · ${q.length} voice note${q.length > 1 ? 's' : ''}`, 1600);
};

// Voice only: no pasting/dropping text or files into the chat.
['paste', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (state.chat && !sheetOpen()) { e.preventDefault(); toast('Voice only here. Hold the mic to talk 🎙️'); }
}));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

// =====================================================================
// Boot
// =====================================================================
function startApp() { connectSocket(); renderChats(); refreshContacts(); }
(async function boot() {
  if (session.token) {
    try { state.me = (await api('GET', '/me')).user; startApp(); }
    catch (e) { if (e.status === 401) session.clear(); else { toast('Offline. Retrying…'); setTimeout(boot, 3000); return; } }
  }
  render();
})();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
