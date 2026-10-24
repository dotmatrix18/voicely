/* End-to-end API test (no browser): REST + two/three socket.io clients.
 * Covers sign-up, username uniqueness, device pairing, contact requests (accept/decline/block),
 * private DM delivery + unread counts, non-contacts refused from DM room/history/audio,
 * group rooms, text rejection, persistence across a server restart.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voicely-test-'));
const fixtures = path.join(__dirname, 'fixtures');
const webm = fs.readFileSync(path.join(fixtures, 'sample.webm'));
const m4a = fs.readFileSync(path.join(fixtures, 'sample.m4a'));

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, p, { token, body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, res };
}
const emit = (s, ev, data) => new Promise((res) => s.timeout(5000).emit(ev, data, (err, r) => res(err ? { ok: false, error: 'timeout' } : r)));
const once = (s, ev, ms = 5000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms); s.once(ev, (d) => { clearTimeout(t); res(d); }); });
const connect = (token) => new Promise((res, rej) => {
  const s = io(BASE, { transports: ['websocket'], forceNew: true, auth: { token }, reconnection: false });
  s.on('connect', () => res(s)); s.on('connect_error', (e) => rej(e));
});

let srv;
async function startServer() {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => srv.stdout.on('data', (d) => { if (String(d).includes('running')) res(); }));
}
async function stopServer() { const done = new Promise((r) => srv.once('exit', r)); srv.kill('SIGTERM'); await done; }

async function main() {
  await startServer();
  const sockets = [];
  try {
    console.log('HTTP / app shell');
    const page = await req('GET', '/'); const html = await page.res.text();
    check('GET / serves the app', page.status === 200 && html.includes('micBtn'));
    check('no <textarea> or contenteditable message box in the HTML', !/<textarea|contenteditable/i.test(html));
    for (const p of ['/rooms', '/me', '/c/bob', '/add/bob', '/r/abc-room', '/pair/ABCDEFGH']) check(`SPA route ${p} → 200`, (await req('GET', p)).status === 200);
    check('manifest + service worker served', (await req('GET', '/manifest.webmanifest')).status === 200 && (await req('GET', '/sw.js')).status === 200);

    console.log('Sign-up & identity');
    const a = await req('POST', '/api/signup', { body: { username: 'adrish', displayName: 'Adrish Manna' } });
    check('sign-up returns token + user', a.status === 201 && a.data.token && a.data.user.username === 'adrish');
    check('sign-up sets HttpOnly session cookie', /vt=.*HttpOnly/i.test(a.res.headers.get('set-cookie') || ''));
    const dup = await req('POST', '/api/signup', { body: { username: 'adrish', displayName: 'Someone else' } });
    check('duplicate username rejected (409)', dup.status === 409);
    const dupCase = await req('POST', '/api/signup', { body: { username: 'ADRISH', displayName: 'Caps' } });
    check('username uniqueness is case-insensitive', dupCase.status === 409);
    for (const bad of ['ab', 'has space', 'x'.repeat(21), 'émoji', 'dash-name']) {
      const r = await req('POST', '/api/signup', { body: { username: bad, displayName: 'X' } });
      check(`invalid username "${bad.slice(0, 12)}" rejected (400)`, r.status === 400);
    }
    check('availability check: taken', (await req('GET', '/api/username-available/adrish')).data.available === false);
    check('availability check: free', (await req('GET', '/api/username-available/newname')).data.available === true);
    const b = await req('POST', '/api/signup', { body: { username: 'rahul', displayName: 'Rahul' } });
    const e = await req('POST', '/api/signup', { body: { username: 'eve', displayName: 'Eve' } });
    const A = a.data.token, B = b.data.token, E = e.data.token;
    const me = await req('GET', '/api/me', { token: A });
    check('GET /api/me with token works', me.status === 200 && me.data.user.username === 'adrish');
    check('GET /api/me with bad token → 401', (await req('GET', '/api/me', { token: 'x'.repeat(43) })).status === 401);
    let sockRejected = false; try { await connect('bogus-token-bogus-token-123'); } catch (err) { sockRejected = err.message === 'unauthorized'; }
    check('socket without valid token is refused', sockRejected);

    console.log('Device pairing');
    const pair = await req('POST', '/api/pair', { token: A });
    check('signed-in device gets an 8-char pairing code', pair.status === 200 && /^[A-Z2-9]{8}$/.test(pair.data.code));
    const redeem = await req('POST', '/api/pair/redeem', { body: { code: pair.data.code.slice(0, 4) + '-' + pair.data.code.slice(4) } });
    check('new device redeems code → same user, new token', redeem.status === 200 && redeem.data.user.username === 'adrish' && redeem.data.token !== A);
    check('pairing code is single-use', (await req('POST', '/api/pair/redeem', { body: { code: pair.data.code } })).status === 400);
    const A2 = redeem.data.token;
    check('second device token is valid', (await req('GET', '/api/me', { token: A2 })).status === 200);

    console.log('Contacts');
    check('exact username lookup', (await req('GET', '/api/users/rahul', { token: A })).data.status === 'none');
    check('unknown username → 404', (await req('GET', '/api/users/rah', { token: A })).status === 404);
    const sb = await connect(B); sockets.push(sb);
    const reqEvt = once(sb, 'contact:request');
    const rq = await req('POST', '/api/contacts/request', { token: A, body: { username: 'rahul' } });
    check('A sends contact request to B', rq.data && rq.data.status === 'requested');
    check('B is notified in real time', (await reqEvt).from.username === 'adrish');
    const bList = await req('GET', '/api/contacts', { token: B });
    check('B sees 1 pending incoming request', bList.data.incoming.length === 1 && bList.data.incoming[0].username === 'adrish');
    check('A sees it as outgoing', (await req('GET', '/api/contacts', { token: A })).data.outgoing.length === 1);
    const acc = await req('POST', '/api/contacts/respond', { token: B, body: { username: 'adrish', accept: true } });
    check('B accepts', acc.data.status === 'contact');
    const aList = (await req('GET', '/api/contacts', { token: A })).data;
    check('A and B are now contacts (both sides)', aList.contacts.length === 1 && aList.contacts[0].username === 'rahul' && (await req('GET', '/api/contacts', { token: B })).data.contacts.length === 1);
    check('B shows as online to A', aList.contacts[0].online === true);
    const dmRoom = aList.contacts[0].room;
    check('DM room id is deterministic from both user ids', dmRoom === (await req('GET', '/api/contacts', { token: B })).data.contacts[0].room && /^dm-[a-f0-9]{10}-[a-f0-9]{10}$/.test(dmRoom));
    // decline flow
    await req('POST', '/api/contacts/request', { token: E, body: { username: 'rahul' } });
    const dec = await req('POST', '/api/contacts/respond', { token: B, body: { username: 'eve', accept: false } });
    check('B declines Eve', dec.data.status === 'declined' && (await req('GET', '/api/contacts', { token: B })).data.incoming.length === 0);

    console.log('Private DM');
    const sa = await connect(A); sockets.push(sa);
    const ja = await emit(sa, 'join', { room: dmRoom });
    const jb = await emit(sb, 'join', { room: dmRoom });
    check('both contacts can join the DM room', ja.ok && jb.ok && ja.kind === 'dm' && ja.peer.username === 'rahul');
    const got = once(sb, 'voice');
    const sent = await emit(sa, 'voice', { audio: webm, mime: 'audio/webm;codecs=opus', duration: 2, peaks: [0.2, 1, 0.5] });
    const msg = await got;
    check('A → B voice note delivered in real time', sent.ok && msg.id === sent.id && msg.senderId && msg.sender === 'Adrish Manna');
    const cookieA = `vt=${encodeURIComponent(A)}`, cookieB = `vt=${encodeURIComponent(B)}`, cookieE = `vt=${encodeURIComponent(E)}`;
    const fa = await req('GET', msg.url, { cookie: cookieB });
    check('B can download DM audio (cookie auth), identical bytes', fa.status === 200 && Buffer.from(await fa.res.arrayBuffer()).equals(webm));
    check('DM audio served as private cache', /private/.test(fa.res.headers.get('cache-control')));
    // unread: B leaves the room, A sends a Safari m4a note → B gets inbox + unread=1
    await emit(sb, 'leave');
    sb.emit('leave');
    const inbox = once(sb, 'inbox');
    const s2 = await emit(sa, 'voice', { audio: m4a, mime: 'audio/mp4', duration: 2 });
    const ib = await inbox;
    check('Safari audio/mp4 note accepted; B gets an inbox notification', s2.ok && ib.room === dmRoom);
    await wait(150);
    let bc = (await req('GET', '/api/contacts', { token: B })).data.contacts[0];
    check('B has 1 unread voice note from A + last voice-note time', bc.unread === 1 && bc.lastTs > 0);
    check('sender has 0 unread', (await req('GET', '/api/contacts', { token: A })).data.contacts[0].unread === 0);
    await emit(sb, 'join', { room: dmRoom });
    bc = (await req('GET', '/api/contacts', { token: B })).data.contacts[0];
    check('opening the chat clears unread', bc.unread === 0);

    console.log('Non-contact refused');
    const se = await connect(E); sockets.push(se);
    const je = await emit(se, 'join', { room: dmRoom });
    check('Eve (non-contact) cannot join the DM room', je.ok === false && !je.history);
    const ev = await emit(se, 'voice', { audio: webm, mime: 'audio/webm', duration: 2 });
    check('Eve cannot send into it', ev.ok === false);
    check('Eve cannot download DM audio (403)', (await req('GET', msg.url, { cookie: cookieE })).status === 403);
    check('anonymous cannot download DM audio (401)', (await req('GET', msg.url)).status === 401);
    const fakeDm = 'dm-' + 'a'.repeat(10) + '-' + 'b'.repeat(10);
    check('cannot join an arbitrary dm-* room', (await emit(se, 'join', { room: fakeDm })).ok === false);

    console.log('Receipts: delivered + listened');
    const recA = [];
    const onRec = (r) => recA.push(r); sa.on('receipt', onRec);
    const got3 = once(sb, 'voice');
    const s3 = await emit(sa, 'voice', { audio: webm, mime: 'audio/webm', duration: 2 });
    const m3 = await got3;
    check('note to an online contact is "delivered" immediately', s3.ok && s3.deliveredTo.includes(m3.deliveredTo[0]) && m3.deliveredTo.length === 1);
    const lsn = await emit(sb, 'listened', { room: dmRoom, id: m3.id });
    await wait(150);
    check('B marks it listened → A gets a "listened" receipt', lsn.ok && recA.some((r) => r.id === m3.id && r.listenedBy.length === 1));
    check('contacts list shows last status = listened for A', (await req('GET', '/api/contacts', { token: A })).data.contacts[0].lastStatus === 'listened');
    check('sender listening to own note is a no-op', (await emit(sa, 'listened', { room: dmRoom, id: m3.id })).ok && (await emit(sa, 'join', { room: dmRoom })).history.find((x) => x.id === m3.id).listenedBy.length === 1);
    check('non-contact cannot send a listened receipt', (await emit(se, 'listened', { room: dmRoom, id: m3.id })).ok === false);
    check('listened for unknown note id is refused', (await emit(sb, 'listened', { room: dmRoom, id: 'nope' })).ok === false);
    // offline → delivered on reconnect
    sb.close(); await wait(200);
    const s4 = await emit(sa, 'voice', { audio: webm, mime: 'audio/webm', duration: 2 });
    check('note to an offline contact is only "sent"', s4.ok && s4.deliveredTo.length === 0);
    recA.length = 0;
    const sb2 = await connect(B); sockets.push(sb2);
    await wait(300);
    check('when B comes back online A gets a "delivered" receipt', recA.some((r) => r.id === s4.id && r.deliveredTo.length === 1 && r.listenedBy.length === 0));
    sa.off('receipt', onRec);

    console.log('Live "talking" presence');
    const talkB = []; const onTalk = (t) => talkB.push(t); sb2.on('talking', onTalk);
    const talkE = []; se.on('talking', (t) => talkE.push(t));
    sa.emit('recording', true); await wait(80); sa.emit('level', 0.73); await wait(200); sa.emit('recording', false); await wait(150);
    const aId = (await req('GET', '/api/me', { token: A })).data.user.id;
    check('contact (not even in the chat) sees A start recording', talkB.some((t) => t.userId === aId && t.on === true && t.room === dmRoom));
    check('…with A’s live audio level', talkB.some((t) => t.level === 0.73));
    check('…and the stop', talkB.some((t) => t.on === false));
    check('non-contact receives no talking events', talkE.length === 0);
    sb2.off('talking', onTalk);

    console.log('Voice reactions (audio only, ≤ 5 s)');
    const v4 = fs.readFileSync(path.join(fixtures, 'voice-4.webm'));
    const tone7 = fs.readFileSync(path.join(fixtures, 'tone-7s-8k.wav'));
    await emit(sb2, 'join', { room: dmRoom });
    const reacted = once(sa, 'reaction');
    const r1 = await emit(sb2, 'react', { room: dmRoom, target: m3.id, note: { audio: v4, mime: 'audio/webm', duration: 4, peaks: [0.2, 0.9] } });
    const rev = await reacted;
    check('B reacts to A’s note with a 4 s voice reaction', r1.ok && rev.targetId === m3.id && rev.reaction.duration === 4);
    check('reaction audio downloadable by the contact', (await req('GET', rev.reaction.url, { cookie: cookieA })).status === 200);
    check('reaction audio refused to a non-contact', (await req('GET', rev.reaction.url, { cookie: cookieE })).status === 403);
    const rx = [
      ['text instead of audio', { room: dmRoom, target: m3.id, note: { text: 'lol' } }],
      ['a text field next to the audio', { room: dmRoom, target: m3.id, note: { audio: v4, mime: 'audio/webm', duration: 2 }, text: 'lol' }],
      ['text bytes labelled audio', { room: dmRoom, target: m3.id, note: { audio: Buffer.from('haha this is text!'), mime: 'audio/webm', duration: 2 } }],
      ['a 6 s reaction', { room: dmRoom, target: m3.id, note: { audio: v4, mime: 'audio/webm', duration: 6 } }],
      ['a 7 s WAV claiming to be 4.5 s', { room: dmRoom, target: m3.id, note: { audio: tone7, mime: 'audio/wav', duration: 4.5 } }],
      ['an oversized file (> 200 KB)', { room: dmRoom, target: m3.id, note: { audio: fs.readFileSync(path.join(fixtures, 'fake-voice.wav')), mime: 'audio/wav', duration: 4 } }],
      ['an unknown target note', { room: dmRoom, target: 'missing', note: { audio: v4, mime: 'audio/webm', duration: 2 } }],
    ];
    for (const [n, p] of rx) { const r = await emit(sb2, 'react', p); check(`reaction rejected: ${n}`, r && r.ok === false, JSON.stringify(r)); }
    check('non-contact cannot react in the DM', (await emit(se, 'react', { room: dmRoom, target: m3.id, note: { audio: v4, mime: 'audio/webm', duration: 2 } })).ok === false);
    const hist3 = (await emit(sa, 'join', { room: dmRoom })).history.find((x) => x.id === m3.id);
    check('reaction is stored on the note (history)', hist3.reactions.length === 1 && hist3.reactions[0].senderId !== hist3.senderId);

    console.log('Voice hello (profile, audio only, ≤ 10 s)');
    const hx = [
      ['text', { text: 'Hi, I am Adrish' }],
      ['text bytes labelled audio', { audio: Buffer.from('Hi, I am Adrish — text!'), mime: 'audio/webm', duration: 3 }],
      ['a 12 s hello', { audio: webm, mime: 'audio/webm', duration: 12 }],
      ['a 7 s WAV claiming 3 s', { audio: tone7, mime: 'audio/wav', duration: 3 }],
      ['an oversized file', { audio: Buffer.concat([webm, Buffer.alloc(420 * 1024)]), mime: 'audio/webm', duration: 5 }],
      ['extra bio field', { audio: webm, mime: 'audio/webm', duration: 2, bio: 'hello' }],
    ];
    for (const [n, p] of hx) { const r = await emit(sa, 'profile:voice', p); check(`voice hello rejected: ${n}`, r && r.ok === false, JSON.stringify(r)); }
    const hv = await emit(sa, 'profile:voice', { audio: tone7, mime: 'audio/wav', duration: 7, peaks: [0.5, 1] });
    check('a real 7 s voice hello is saved', hv.ok && hv.voiceHello.url.startsWith('/audio/profile-') && hv.voiceHello.duration === 7);
    const look = await req('GET', '/api/users/adrish', { token: B });
    check('voice hello appears on the profile for others', look.data.user.voiceHello && look.data.user.voiceHello.url === hv.voiceHello.url);
    check('…and on the contact card', (await req('GET', '/api/contacts', { token: B })).data.contacts[0].voiceHello.url === hv.voiceHello.url);
    check('voice hello audio requires sign-in (401 anonymous, 200 signed in)', (await req('GET', hv.voiceHello.url)).status === 401 && (await req('GET', hv.voiceHello.url, { cookie: cookieB })).status === 200);
    const del = await emit(sa, 'profile:voice:delete', {});
    check('voice hello can be deleted', del.ok && (await req('GET', '/api/users/adrish', { token: B })).data.user.voiceHello === null);
    await emit(sa, 'profile:voice', { audio: webm, mime: 'audio/webm', duration: 2 });

    console.log('Voice only: text is rejected');
    let leaked = 0; const leak = () => leaked++; sb2.on('voice', leak);
    const cases = [
      ['plain string', 'hello there'],
      ['{text}', { text: 'hello there' }],
      ['text bytes labelled audio/webm', { audio: Buffer.from('hello there, this is text'), mime: 'audio/webm', duration: 2 }],
      ['audio with text/plain mime', { audio: webm, mime: 'text/plain', duration: 2 }],
      ['base64 string as audio', { audio: 'SGVsbG8=', mime: 'audio/webm', duration: 2 }],
      ['audio + text caption', { audio: webm, mime: 'audio/webm', duration: 2, text: 'caption' }],
      ['> 2 minutes', { audio: webm, mime: 'audio/webm', duration: 180 }],
    ];
    for (const [n, p] of cases) { const r = await emit(sa, 'voice', p); check(`rejects ${n}`, r && r.ok === false, JSON.stringify(r)); }
    for (const evn of ['message', 'text', 'chat']) { const r = await emit(sa, evn, { text: 'hi' }); check(`rejects "${evn}" event`, r && r.ok === false && /voice/i.test(r.error)); }
    check('POST /api/messages (text) → 405', (await req('POST', '/api/messages', { token: A, body: { text: 'hi' } })).status === 405);
    await wait(300);
    check('nothing rejected reached B', leaked === 0);
    sb2.off('voice', leak);

    console.log('Group rooms still work');
    const g = 'study-group-1';
    check('A joins group room', (await emit(sa, 'join', { room: g })).ok);
    check('Eve joins group room', (await emit(se, 'join', { room: g })).ok);
    const gGot = once(se, 'voice');
    await emit(sa, 'voice', { audio: webm, mime: 'audio/webm', duration: 1.5 });
    const gm = await gGot;
    check('group voice note delivered', gm.room === g);
    check('group audio downloadable', (await req('GET', gm.url)).status === 200);

    console.log('Remove / block');
    await emit(sb2, 'join', { room: dmRoom });
    const closed = once(sb2, 'room:closed');
    const rm = await req('POST', '/api/contacts/remove', { token: A, body: { username: 'rahul' } });
    check('A removes B', rm.data.status === 'none' && (await req('GET', '/api/contacts', { token: A })).data.contacts.length === 0);
    check('B is kicked from the DM room', (await closed).room === dmRoom);
    check('ex-contact can no longer join DM', (await emit(sb2, 'join', { room: dmRoom })).ok === false);
    check('ex-contact can no longer fetch DM audio', (await req('GET', msg.url, { cookie: cookieB })).status === 403);
    await req('POST', '/api/contacts/request', { token: E, body: { username: 'adrish' } });
    const bl = await req('POST', '/api/contacts/block', { token: A, body: { username: 'eve' } });
    check('A blocks Eve (pending request dropped)', bl.data.status === 'blocked' && (await req('GET', '/api/contacts', { token: A })).data.incoming.length === 0);
    check('Eve can no longer find A', (await req('GET', '/api/users/adrish', { token: E })).status === 404);
    check('Eve cannot send A a request', (await req('POST', '/api/contacts/request', { token: E, body: { username: 'adrish' } })).status === 404);
    // re-add A <-> B via mutual request (auto-accept)
    await req('POST', '/api/contacts/request', { token: B, body: { username: 'adrish' } });
    const mutual = await req('POST', '/api/contacts/request', { token: A, body: { username: 'rahul' } });
    check('mutual request auto-accepts', mutual.data.status === 'contact');

    console.log('Persistence (server restart)');
    sockets.forEach((s) => s.close()); sockets.length = 0;
    await stopServer(); await startServer();
    check('token still valid after restart', (await req('GET', '/api/me', { token: A })).status === 200);
    const after = (await req('GET', '/api/contacts', { token: A })).data;
    check('contacts + blocks persisted', after.contacts.length === 1 && after.blocked.length === 1);
    const sa2 = await connect(A); sockets.push(sa2);
    const hist = await emit(sa2, 'join', { room: dmRoom });
    check('DM history persisted (4 voice notes, receipts + reactions kept)', hist.ok && hist.history.length === 4 && hist.history[0].id === sent.id && hist.history[2].reactions.length === 1 && hist.history[2].listenedBy.length === 1);
    const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
    check('tokens stored only as SHA-256 hashes', !JSON.stringify(db).includes(A) && Object.values(db.users)[0].tokens.every((t) => /^[a-f0-9]{64}$/.test(t)));
    const lo = await req('POST', '/api/logout', { token: A2 });
    check('logout revokes that device token only', lo.status === 200 && (await req('GET', '/api/me', { token: A2 })).status === 401 && (await req('GET', '/api/me', { token: A })).status === 200);
  } catch (err) {
    failed++; console.error('  ❌ test crashed:', err);
  } finally {
    sockets.forEach((s) => s.close());
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
