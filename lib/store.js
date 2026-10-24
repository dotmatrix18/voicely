'use strict';
/**
 * Tiny JSON-file store (atomic writes). Holds users, auth token hashes, contacts,
 * contact requests, blocks, voice-note index and read markers.
 * Fine for personal / small-group use; swap for SQLite if it grows.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'db.json');
    this.legacy = path.join(dataDir, 'messages.json');
    let db = {};
    try { db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { db = {}; }
    this.db = {
      users: db.users || {},       // id -> {id, username, displayName, tokens:[sha256], createdAt}
      contacts: db.contacts || {}, // id -> {otherId: sinceTs}
      requests: db.requests || {}, // toId -> {fromId: ts}
      blocks: db.blocks || {},     // id -> {otherId: ts}
      messages: db.messages || {}, // room -> [msg]
      reads: db.reads || {},       // id -> {room: ts}
    };
    // migrate v1 (messages.json) group-room history
    if (!db.messages && fs.existsSync(this.legacy)) {
      try { Object.assign(this.db.messages, JSON.parse(fs.readFileSync(this.legacy, 'utf8'))); } catch {}
    }
    this.byUsername = new Map();
    this.byToken = new Map();
    for (const u of Object.values(this.db.users)) {
      this.byUsername.set(u.username, u.id);
      for (const t of u.tokens) this.byToken.set(t, u.id);
    }
    this.timer = null;
  }

  save() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 100); }
  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  // ---------- users & tokens ----------
  user(id) { return this.db.users[id] || null; }
  userByUsername(username) { const id = this.byUsername.get(username); return id ? this.db.users[id] : null; }
  userByToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const id = this.byToken.get(sha256(token));
    return id ? this.db.users[id] : null;
  }
  createUser(username, displayName) {
    if (this.byUsername.has(username)) return null;
    let id; do { id = crypto.randomBytes(5).toString('hex'); } while (this.db.users[id]);
    const user = { id, username, displayName, tokens: [], createdAt: Date.now() };
    this.db.users[id] = user;
    this.byUsername.set(username, id);
    const token = this.issueToken(id);
    return { user, token };
  }
  issueToken(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const h = sha256(token);
    const u = this.db.users[userId];
    u.tokens.push(h);
    if (u.tokens.length > 10) { const old = u.tokens.shift(); this.byToken.delete(old); } // max 10 devices
    this.byToken.set(h, userId);
    this.save();
    return token;
  }
  revokeToken(token) {
    const h = sha256(token);
    const id = this.byToken.get(h);
    if (!id) return;
    this.byToken.delete(h);
    const u = this.db.users[id];
    u.tokens = u.tokens.filter((t) => t !== h);
    this.save();
  }
  setDisplayName(id, name) { this.db.users[id].displayName = name; this.save(); }

  // ---------- contacts ----------
  areContacts(a, b) { return !!(this.db.contacts[a] && this.db.contacts[a][b]); }
  contactIds(id) { return Object.keys(this.db.contacts[id] || {}); }
  isBlocked(by, other) { return !!(this.db.blocks[by] && this.db.blocks[by][other]); }
  eitherBlocked(a, b) { return this.isBlocked(a, b) || this.isBlocked(b, a); }
  blockedIds(id) { return Object.keys(this.db.blocks[id] || {}); }
  hasRequest(from, to) { return !!(this.db.requests[to] && this.db.requests[to][from]); }
  incoming(id) { return Object.entries(this.db.requests[id] || {}).map(([from, ts]) => ({ id: from, ts })); }
  outgoing(id) {
    const out = [];
    for (const [to, m] of Object.entries(this.db.requests)) if (m[id]) out.push({ id: to, ts: m[id] });
    return out;
  }
  addRequest(from, to) { (this.db.requests[to] ||= {})[from] = Date.now(); this.save(); }
  dropRequest(from, to) { if (this.db.requests[to]) { delete this.db.requests[to][from]; if (!Object.keys(this.db.requests[to]).length) delete this.db.requests[to]; } this.save(); }
  link(a, b) {
    const now = Date.now();
    (this.db.contacts[a] ||= {})[b] = now;
    (this.db.contacts[b] ||= {})[a] = now;
    this.dropRequest(a, b); this.dropRequest(b, a);
  }
  unlink(a, b) {
    if (this.db.contacts[a]) delete this.db.contacts[a][b];
    if (this.db.contacts[b]) delete this.db.contacts[b][a];
    this.save();
  }
  block(by, other) {
    this.unlink(by, other); this.dropRequest(by, other); this.dropRequest(other, by);
    (this.db.blocks[by] ||= {})[other] = Date.now(); this.save();
  }
  unblock(by, other) { if (this.db.blocks[by]) delete this.db.blocks[by][other]; this.save(); }

  // ---------- messages & reads ----------
  findMessage(room, id) { return (this.db.messages[room] || []).find((m) => m.id === id) || null; }
  setVoiceHello(id, hello) { this.db.users[id].voiceHello = hello; this.save(); }
  history(room, limit = 200) { return (this.db.messages[room] || []).slice(-limit); }
  lastMessage(room) { const l = this.db.messages[room]; return l && l.length ? l[l.length - 1] : null; }
  addMessage(room, msg) {
    const l = (this.db.messages[room] ||= []);
    l.push(msg);
    if (l.length > 1000) this.db.messages[room] = l.slice(-1000);
    this.save();
  }
  markRead(userId, room, ts = Date.now()) { (this.db.reads[userId] ||= {})[room] = ts; this.save(); }
  unread(userId, room) {
    const since = (this.db.reads[userId] || {})[room] || 0;
    let n = 0;
    for (const m of this.db.messages[room] || []) if (m.ts > since && m.senderId !== userId) n++;
    return n;
  }
}

module.exports = { Store, sha256 };
