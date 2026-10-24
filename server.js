'use strict';
/**
 * Voicely server: contacts + private 1:1 voice chats + group rooms.
 * The ONLY message type is a voice note. Text/non-audio payloads are rejected.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Store } = require('./lib/store');
const { validateVoice } = require('./lib/audio');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const MAX_DURATION_SEC = Number(process.env.MAX_DURATION_SEC) || 120;
const MAX_BYTES = Number(process.env.MAX_BYTES) || 5 * 1024 * 1024;
const PAIR_TTL_MS = 10 * 60 * 1000;
const REACTION_MAX_SEC = 5, REACTION_MAX_BYTES = 200 * 1024;   // voice reactions: short + small
const HELLO_MAX_SEC = 10, HELLO_MAX_BYTES = 400 * 1024;        // profile "voice hello"

fs.mkdirSync(AUDIO_DIR, { recursive: true });
const store = new Store(DATA_DIR);

// ---------- rules ----------
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const ROOM_RE = /^[a-z0-9-]{3,32}$/;
const DM_RE = /^dm-([a-f0-9]{10})-([a-f0-9]{10})$/;
const cleanName = (n) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32) : '');
const cleanUsername = (u) => (typeof u === 'string' ? u.trim().replace(/^@/, '').toLowerCase() : '');
const dmRoom = (a, b) => `dm-${[a, b].sort().join('-')}`;
const dmPeer = (room, me) => { const m = DM_RE.exec(room); if (!m) return null; return m[1] === me ? m[2] : m[2] === me ? m[1] : null; };
/** A user may use a DM room only if they are one of its two members AND the two are contacts. */
function canAccessDm(userId, room) {
  const peer = dmPeer(room, userId);
  return !!peer && store.areContacts(userId, peer) && !store.eitherBlocked(userId, peer);
}
const publicUser = (u) => u && ({ id: u.id, username: u.username, displayName: u.displayName, voiceHello: u.voiceHello || null });

// ---------- presence ----------
const userSockets = new Map(); // userId -> count
const isOnline = (id) => (userSockets.get(id) || 0) > 0;
const roomPresence = new Map(); // room -> Map(socketId -> userId)

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind one reverse proxy (Render/Railway); affects req.ip + req.secure
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return readCookie(req, 'vt');
}
function setSessionCookie(req, res, token) {
  // Used so <audio src> requests for private voice notes are authenticated.
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vt=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
}
function auth(req, res, next) {
  const token = tokenFrom(req);
  const user = store.userByToken(token);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user; req.token = token;
  next();
}

// Tiny per-IP rate limiter for sign-up / pairing.
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path; const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many attempts, try again later.' });
    arr.push(now); hits.set(key, arr); next();
  };
}

const api = express.Router();
api.use(express.json({ limit: '2kb' }));

api.post('/signup', limit(20, 60 * 60 * 1000), (req, res) => {
  const username = cleanUsername(req.body && req.body.username);
  const displayName = cleanName(req.body && req.body.displayName);
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3–20 characters: lowercase letters, numbers or _.' });
  if (!displayName) return res.status(400).json({ error: 'Please enter a display name.' });
  const created = store.createUser(username, displayName);
  if (!created) return res.status(409).json({ error: `@${username} is already taken.` });
  setSessionCookie(req, res, created.token);
  res.status(201).json({ token: created.token, user: publicUser(created.user) });
});

api.get('/username-available/:username', (req, res) => {
  const u = cleanUsername(req.params.username);
  res.json({ valid: USERNAME_RE.test(u), available: USERNAME_RE.test(u) && !store.userByUsername(u) });
});

api.get('/me', auth, (req, res) => { setSessionCookie(req, res, req.token); res.json({ user: publicUser(req.user) }); });

api.post('/me', auth, (req, res) => {
  const displayName = cleanName(req.body && req.body.displayName);
  if (!displayName) return res.status(400).json({ error: 'Please enter a display name.' });
  store.setDisplayName(req.user.id, displayName);
  notify([req.user.id, ...store.contactIds(req.user.id)], 'contacts:changed');
  res.json({ user: publicUser(req.user) });
});

api.post('/logout', auth, (req, res) => {
  store.revokeToken(req.token);
  res.setHeader('Set-Cookie', 'vt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// Device pairing: signed-in device creates a one-time code (10 min); new device redeems it.
const pairCodes = new Map(); // code -> {userId, exp}
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
api.post('/pair', auth, (req, res) => {
  for (const [c, v] of pairCodes) if (v.exp < Date.now() || v.userId === req.user.id) pairCodes.delete(c);
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) code += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  pairCodes.set(code, { userId: req.user.id, exp: Date.now() + PAIR_TTL_MS });
  res.json({ code, expiresAt: Date.now() + PAIR_TTL_MS });
});
api.post('/pair/redeem', limit(15, 15 * 60 * 1000), (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const entry = pairCodes.get(code);
  if (!entry || entry.exp < Date.now()) return res.status(400).json({ error: 'That code is invalid or expired.' });
  pairCodes.delete(code); // one-time
  const user = store.user(entry.userId);
  const token = store.issueToken(user.id);
  setSessionCookie(req, res, token);
  res.json({ token, user: publicUser(user) });
});

// Exact-username lookup (no fuzzy search → no user enumeration by prefix).
api.get('/users/:username', auth, (req, res) => {
  const u = store.userByUsername(cleanUsername(req.params.username));
  if (!u || store.isBlocked(u.id, req.user.id)) return res.status(404).json({ error: 'No user with that username.' });
  const me = req.user.id;
  const status = u.id === me ? 'self' : store.areContacts(me, u.id) ? 'contact' : store.hasRequest(me, u.id) ? 'requested'
    : store.hasRequest(u.id, me) ? 'incoming' : store.isBlocked(me, u.id) ? 'blocked' : 'none';
  res.json({ user: publicUser(u), status });
});

function contactsPayload(me) {
  const contacts = store.contactIds(me).map((id) => {
    const u = store.user(id); const room = dmRoom(me, id); const last = store.lastMessage(room);
    return { ...publicUser(u), online: isOnline(id), room, lastTs: last ? last.ts : null, lastFromMe: last ? last.senderId === me : false, lastDuration: last ? last.duration : null,
      lastStatus: last && last.senderId === me ? ((last.listenedBy || []).includes(id) ? 'listened' : (last.deliveredTo || []).includes(id) ? 'delivered' : 'sent') : null, unread: store.unread(me, room) };
  }).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0) || a.displayName.localeCompare(b.displayName));
  const incoming = store.incoming(me).map((r) => ({ ...publicUser(store.user(r.id)), ts: r.ts }));
  const outgoing = store.outgoing(me).map((r) => ({ ...publicUser(store.user(r.id)), ts: r.ts }));
  const blocked = store.blockedIds(me).map((id) => publicUser(store.user(id)));
  return { contacts, incoming, outgoing, blocked };
}
api.get('/contacts', auth, (req, res) => res.json(contactsPayload(req.user.id)));

function target(req, res) {
  const u = store.userByUsername(cleanUsername(req.body && req.body.username));
  if (!u || u.id === req.user.id) { res.status(404).json({ error: 'No user with that username.' }); return null; }
  return u;
}
api.post('/contacts/request', auth, (req, res) => {
  const me = req.user.id; const u = target(req, res); if (!u) return;
  if (store.isBlocked(u.id, me)) return res.status(404).json({ error: 'No user with that username.' });
  if (store.isBlocked(me, u.id)) return res.status(400).json({ error: 'Unblock this user first.' });
  if (store.areContacts(me, u.id)) return res.json({ status: 'contact' });
  if (store.hasRequest(u.id, me)) { store.link(me, u.id); notify([me, u.id], 'contacts:changed'); return res.json({ status: 'contact' }); }
  store.addRequest(me, u.id);
  notify([me, u.id], 'contacts:changed');
  io.to('user:' + u.id).emit('contact:request', { from: publicUser(req.user) });
  res.json({ status: 'requested' });
});
api.post('/contacts/respond', auth, (req, res) => {
  const me = req.user.id; const u = target(req, res); if (!u) return;
  if (!store.hasRequest(u.id, me)) return res.status(404).json({ error: 'No pending request from that user.' });
  if (req.body.accept === true) store.link(me, u.id); else store.dropRequest(u.id, me);
  notify([me, u.id], 'contacts:changed');
  res.json({ status: req.body.accept === true ? 'contact' : 'declined' });
});
api.post('/contacts/cancel', auth, (req, res) => {
  const u = target(req, res); if (!u) return;
  store.dropRequest(req.user.id, u.id); notify([req.user.id, u.id], 'contacts:changed'); res.json({ status: 'none' });
});
api.post('/contacts/remove', auth, (req, res) => {
  const u = target(req, res); if (!u) return;
  store.unlink(req.user.id, u.id); kickFromDm(req.user.id, u.id); notify([req.user.id, u.id], 'contacts:changed'); res.json({ status: 'none' });
});
api.post('/contacts/block', auth, (req, res) => {
  const u = target(req, res); if (!u) return;
  store.block(req.user.id, u.id); kickFromDm(req.user.id, u.id); notify([req.user.id, u.id], 'contacts:changed'); res.json({ status: 'blocked' });
});
api.post('/contacts/unblock', auth, (req, res) => {
  const u = target(req, res); if (!u) return;
  store.unblock(req.user.id, u.id); notify([req.user.id], 'contacts:changed'); res.json({ status: 'none' });
});

// Anything else under /api — including any attempt to POST a text message — is refused.
api.all('*', (_req, res) => res.status(405).json({ error: 'Only voice messages are allowed, and they are sent over the realtime socket.' }));
app.use('/api', api);

// Audio files. Private DM audio requires the session cookie of one of the two contacts.
app.get('/audio/:room/:file', (req, res) => {
  const room = String(req.params.room);
  const file = String(req.params.file);
  if (!ROOM_RE.test(room) || !/^[a-f0-9-]{36}\.(webm|m4a|ogg|wav|mp3)$/.test(file)) return res.sendStatus(404);
  if (room.startsWith('dm-') || room.startsWith('profile-')) {
    const user = store.userByToken(tokenFrom(req));
    if (!user) return res.sendStatus(401);
    if (room.startsWith('dm-') && !canAccessDm(user.id, room)) return res.sendStatus(403);
    // voice hellos: any signed-in user (they're shown when someone looks you up), unless blocked
    if (room.startsWith('profile-') && store.isBlocked(room.slice(8), user.id)) return res.sendStatus(403);
  }
  const mimes = { webm: 'audio/webm', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg' };
  const priv = room.startsWith('dm-') || room.startsWith('profile-');
  res.sendFile(path.join(AUDIO_DIR, room, file), {
    headers: { 'Content-Type': mimes[file.split('.').pop()], 'Cache-Control': `${priv ? 'private' : 'public'}, max-age=31536000, immutable` },
  }, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// SPA routes
const spa = (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'));
['/rooms', '/me', '/r/:room', '/c/:username', '/add/:username', '/pair/:code'].forEach((p) => app.get(p, spa));

// ---------- server ----------
let server;
if (process.env.HTTPS === '1') {
  const certDir = path.join(__dirname, 'certs');
  if (!fs.existsSync(path.join(certDir, 'key.pem'))) { console.error('No certificate found. Run `npm run cert` first.'); process.exit(1); }
  server = https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, app);
} else {
  server = http.createServer(app);
}
const io = new Server(server, { maxHttpBufferSize: MAX_BYTES + 64 * 1024 });

function notify(userIds, event, data = {}) { for (const id of new Set(userIds)) io.to('user:' + id).emit(event, data); }
function kickFromDm(a, b) {
  const room = dmRoom(a, b);
  io.to(room).emit('room:closed', { room });
  io.in(room).socketsLeave(room);
  roomPresence.delete(room);
}
function roster(room) {
  const ids = new Set((roomPresence.get(room) || new Map()).values());
  return [...ids].map((id) => publicUser(store.user(id))).filter(Boolean);
}
const broadcastPresence = (room) => io.to(room).emit('presence', roster(room));

io.use((socket, next) => {
  const user = store.userByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

const RATE_WINDOW = 30_000, RATE_MAX = 10;

/** Users who should see receipts / talking indicators for a room. */
const roomUserIds = (room) => new Set((roomPresence.get(room) || new Map()).values());
function emitReceipt(room, msg) {
  io.to('user:' + msg.senderId).emit('receipt', { room, id: msg.id, deliveredTo: msg.deliveredTo || [], listenedBy: msg.listenedBy || [] });
}
/** When a user comes online, every DM note waiting for them becomes "delivered". */
function deliverPending(userId) {
  for (const cid of store.contactIds(userId)) {
    const room = dmRoom(userId, cid);
    let changed = false;
    for (const m of store.history(room, 1000)) {
      if (m.senderId === userId) continue;
      m.deliveredTo ||= [];
      if (!m.deliveredTo.includes(userId)) { m.deliveredTo.push(userId); changed = true; emitReceipt(room, m); }
    }
    if (changed) store.save();
  }
}
function canUseRoom(socket, room) {
  const me = socket.data.userId;
  if (room.startsWith('dm-')) return canAccessDm(me, room);
  return socket.data.room === room; // group rooms: only while joined
}
function saveAudio(room, v, cb) {
  const id = crypto.randomUUID();
  const dir = path.join(AUDIO_DIR, room);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${id}.${v.sniffed.ext}`;
  fs.writeFile(path.join(dir, file), v.buf, (err) => cb(err, { id, url: `/audio/${room}/${file}`, file: path.join(dir, file) }));
}

io.on('connection', (socket) => {
  const me = socket.data.userId;
  socket.data.sent = [];
  socket.data.lastLevel = 0;
  socket.join('user:' + me);
  const before = userSockets.get(me) || 0;
  userSockets.set(me, before + 1);
  if (!before) notify(store.contactIds(me), 'contact:presence', { id: me, online: true });
  deliverPending(me);

  const rateOk = () => {
    const now = Date.now();
    socket.data.sent = socket.data.sent.filter((t) => now - t < RATE_WINDOW);
    if (socket.data.sent.length >= RATE_MAX) return false;
    socket.data.sent.push(now); return true;
  };
  const ackFn = (a) => (typeof a === 'function' ? a : () => {});

  socket.on('join', (data, ack) => {
    ack = ackFn(ack);
    const room = typeof (data && data.room) === 'string' ? data.room.trim().toLowerCase() : '';
    let peer = null;
    if (room.startsWith('dm-')) {
      if (!canAccessDm(me, room)) return ack({ ok: false, error: 'This private chat is only available to its two contacts.' });
      peer = publicUser(store.user(dmPeer(room, me)));
    } else if (!ROOM_RE.test(room) || room.startsWith('profile-')) {
      return ack({ ok: false, error: 'Room code: 3–32 lowercase letters, numbers or dashes.' });
    }
    if (socket.data.room) leave(socket);
    socket.data.room = room;
    socket.join(room);
    if (!roomPresence.has(room)) roomPresence.set(room, new Map());
    roomPresence.get(room).set(socket.id, me);
    if (peer) store.markRead(me, room);
    ack({ ok: true, room, kind: peer ? 'dm' : 'group', peer: peer && { ...peer, online: isOnline(peer.id) }, history: store.history(room), maxDuration: MAX_DURATION_SEC, reactionMax: REACTION_MAX_SEC, helloMax: HELLO_MAX_SEC });
    broadcastPresence(room);
    if (peer) notify([me], 'contacts:changed');
  });

  socket.on('leave', () => leave(socket));

  socket.on('read', (data) => {
    const room = data && data.room;
    if (typeof room === 'string' && room === socket.data.room) store.markRead(me, room);
  });

  // ---- voice notes ----
  socket.on('voice', (payload, ack) => {
    ack = ackFn(ack);
    const room = socket.data.room;
    if (!room) return ack({ ok: false, error: 'Open a chat first.' });
    if (room.startsWith('dm-') && !canAccessDm(me, room)) return ack({ ok: false, error: 'You can only send voice notes to your contacts.' });
    const v = validateVoice(payload, { maxBytes: MAX_BYTES, maxDuration: MAX_DURATION_SEC });
    if (!v.ok) return ack(v);
    if (!rateOk()) return ack({ ok: false, error: 'Slow down a little.' });
    saveAudio(room, v, (err, saved) => {
      if (err) return ack({ ok: false, error: 'Could not store voice note.' });
      const user = store.user(me);
      const peerId = room.startsWith('dm-') ? dmPeer(room, me) : null;
      const deliveredTo = peerId ? (isOnline(peerId) ? [peerId] : []) : [...roomUserIds(room)].filter((id) => id !== me);
      const msg = { id: saved.id, room, sender: user.displayName, senderUsername: user.username, senderId: me,
        url: saved.url, mime: v.sniffed.mime, duration: v.duration, peaks: v.peaks, size: v.buf.length, ts: Date.now(),
        deliveredTo, listenedBy: [], reactions: [] };
      store.addMessage(room, msg);
      io.to(room).emit('voice', msg);
      if (peerId) {
        for (const uid of roomUserIds(room)) store.markRead(uid, room, msg.ts); // viewers have "read" it
        store.markRead(me, room, msg.ts);
        notify([me, peerId], 'inbox', { room, from: me, ts: msg.ts });
      }
      ack({ ok: true, id: msg.id, deliveredTo });
    });
  });

  // ---- "listened" receipts ----
  socket.on('listened', (data, ack) => {
    ack = ackFn(ack);
    const room = data && typeof data.room === 'string' ? data.room : '';
    const id = data && typeof data.id === 'string' ? data.id : '';
    if (!room || !canUseRoom(socket, room)) return ack({ ok: false, error: 'Not allowed.' });
    const msg = store.findMessage(room, id);
    if (!msg) return ack({ ok: false, error: 'No such voice note.' });
    if (msg.senderId === me) return ack({ ok: true });
    msg.listenedBy ||= []; msg.deliveredTo ||= [];
    if (!msg.deliveredTo.includes(me)) msg.deliveredTo.push(me);
    if (!msg.listenedBy.includes(me)) { msg.listenedBy.push(me); store.save(); emitReceipt(room, msg); }
    ack({ ok: true });
  });

  // ---- voice reactions (audio only, max 5 s) attached to a note ----
  socket.on('react', (data, ack) => {
    ack = ackFn(ack);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ack({ ok: false, error: 'Only voice reactions are allowed.' });
    const extra = Object.keys(data).filter((k) => !['room', 'target', 'note'].includes(k));
    if (extra.length) return ack({ ok: false, error: `Field "${extra[0]}" is not allowed. Only voice reactions are allowed.` });
    const { room, target, note } = data;
    if (typeof room !== 'string' || !canUseRoom(socket, room)) return ack({ ok: false, error: 'Not allowed.' });
    const msg = typeof target === 'string' ? store.findMessage(room, target) : null;
    if (!msg) return ack({ ok: false, error: 'No such voice note.' });
    const v = validateVoice(note, { maxBytes: REACTION_MAX_BYTES, maxDuration: REACTION_MAX_SEC });
    if (!v.ok) return ack({ ok: false, error: v.error.replace('Limited to', 'Voice reactions are limited to') });
    msg.reactions ||= [];
    if (msg.reactions.filter((r) => r.senderId === me).length >= 3) return ack({ ok: false, error: 'Up to 3 reactions per note.' });
    if (!rateOk()) return ack({ ok: false, error: 'Slow down a little.' });
    saveAudio(room, v, (err, saved) => {
      if (err) return ack({ ok: false, error: 'Could not store reaction.' });
      const user = store.user(me);
      const reaction = { id: saved.id, senderId: me, sender: user.displayName, senderUsername: user.username, url: saved.url, mime: v.sniffed.mime, duration: v.duration, peaks: v.peaks.slice(0, 24), ts: Date.now() };
      msg.reactions.push(reaction);
      store.save();
      io.to(room).emit('reaction', { room, targetId: msg.id, reaction });
      if (room.startsWith('dm-')) notify([dmPeer(room, me)], 'reaction:inbox', { room, from: me, targetId: msg.id });
      ack({ ok: true, id: reaction.id });
    });
  });

  // ---- voice hello (profile) ----
  socket.on('profile:voice', (payload, ack) => {
    ack = ackFn(ack);
    const v = validateVoice(payload, { maxBytes: HELLO_MAX_BYTES, maxDuration: HELLO_MAX_SEC });
    if (!v.ok) return ack({ ok: false, error: v.error.replace('Limited to', 'Voice hellos are limited to') });
    if (!rateOk()) return ack({ ok: false, error: 'Slow down a little.' });
    const room = `profile-${me}`;
    const old = store.user(me).voiceHello;
    saveAudio(room, v, (err, saved) => {
      if (err) return ack({ ok: false, error: 'Could not store voice hello.' });
      store.setVoiceHello(me, { url: saved.url, duration: v.duration, peaks: v.peaks.slice(0, 48), ts: Date.now() });
      if (old) fs.unlink(path.join(AUDIO_DIR, old.url.replace(/^\/audio\//, '')), () => {});
      notify([me, ...store.contactIds(me)], 'contacts:changed');
      ack({ ok: true, voiceHello: store.user(me).voiceHello });
    });
  });
  socket.on('profile:voice:delete', (_d, ack) => {
    ack = ackFn(ack);
    const old = store.user(me).voiceHello;
    if (old) fs.unlink(path.join(AUDIO_DIR, old.url.replace(/^\/audio\//, '')), () => {});
    store.setVoiceHello(me, null);
    notify([me, ...store.contactIds(me)], 'contacts:changed');
    ack({ ok: true });
  });

  // ---- live "talking" presence: on/off + audio level while recording ----
  function relayTalking(payload, volatile) {
    const room = socket.data.room;
    if (!room) return;
    const out = { userId: me, room, ...payload };
    (volatile ? socket.volatile : socket).to(room).emit('talking', out);
    if (room.startsWith('dm-') && canAccessDm(me, room)) (volatile ? io.volatile : io).to('user:' + dmPeer(room, me)).except(room).emit('talking', out);
  }
  socket.on('recording', (on) => relayTalking({ on: !!on, name: store.user(me).displayName }, false));
  socket.on('level', (lvl) => {
    const now = Date.now();
    if (now - socket.data.lastLevel < 60) return; // max ~16/s
    socket.data.lastLevel = now;
    const level = Math.round(Math.max(0, Math.min(1, Number(lvl) || 0)) * 100) / 100;
    relayTalking({ on: true, level }, true);
  });

  // Anything else (e.g. "message", "text", "chat") is refused.
  const ALLOWED = ['join', 'leave', 'read', 'voice', 'listened', 'react', 'profile:voice', 'profile:voice:delete', 'recording', 'level'];
  socket.onAny((event, ...args) => {
    if (ALLOWED.includes(event)) return;
    const ack = args[args.length - 1];
    if (typeof ack === 'function') ack({ ok: false, error: 'Only voice messages are allowed.' });
  });

  socket.on('disconnect', () => {
    leave(socket);
    const n = (userSockets.get(me) || 1) - 1;
    if (n <= 0) { userSockets.delete(me); notify(store.contactIds(me), 'contact:presence', { id: me, online: false }); }
    else userSockets.set(me, n);
  });
});

function leave(socket) {
  const room = socket.data.room;
  if (!room) return;
  const me = socket.data.userId;
  const u = store.user(me);
  const off = { userId: me, room, on: false, name: u && u.displayName };
  socket.to(room).emit('talking', off);
  if (room.startsWith('dm-')) { const peer = dmPeer(room, me); if (peer) io.to('user:' + peer).emit('talking', off); }
  socket.leave(room);
  const m = roomPresence.get(room);
  if (m) { m.delete(socket.id); if (!m.size) roomPresence.delete(room); }
  broadcastPresence(room);
  socket.data.room = null;
}

const shutdown = () => { store.flush(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const proto = process.env.HTTPS === '1' ? 'https' : 'http';
    console.log(`🎙️  Voicely running at ${proto}://localhost:${PORT}`);
    for (const list of Object.values(require('os').networkInterfaces())) for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) console.log(`   On your network: ${proto}://${n.address}:${PORT}`);
  });
}

module.exports = { app, server, io, store, dmRoom };
