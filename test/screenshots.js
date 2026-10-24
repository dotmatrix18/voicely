/* Seeds a realistic demo account and captures the UI in light + dark, mobile + desktop.
 * Usage: npm run screenshots   → ./screenshots/<theme>-<device>-<screen>.png
 * Browser timezone is Asia/Kolkata so times read like they would for the owner.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');

const PORT = 4300 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voicely-shots-'));
const SHOTS = path.join(ROOT, 'screenshots');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const FX = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const TZ = 'Asia/Kolkata';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (method, p, token, body) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const connect = (token) => new Promise((res, rej) => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emit = (s, ev, p) => new Promise((r) => s.timeout(15000).emit(ev, p, (e, x) => r(e ? { ok: false, error: String(e) } : x)));
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const peaks = (n = 48) => Array.from({ length: n }, (_, i) => +(0.18 + 0.82 * Math.abs(Math.sin(i / 3.1 + rnd())) * (0.55 + 0.45 * rnd())).toFixed(2));
const NOTE = { 3: 'voice-3.webm', 4: 'voice-4.webm', 6: 'voice-6.webm', 8: 'voice-8.webm', 11: 'voice-11.webm' };
const note = (d) => ({ audio: FX(NOTE[d]), mime: 'audio/webm', duration: d, peaks: peaks() });

function startServer() {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, DATA_DIR }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r(srv)));
}
const stopServer = (srv) => new Promise((r) => { srv.on('exit', r); srv.kill('SIGINT'); setTimeout(() => srv.kill('SIGKILL'), 3000); });

async function seedData() {
  const people = [['adrish', 'Adrish Manna'], ['priya', 'Priya Sharma'], ['rahul', 'Rahul Verma'], ['meera', 'Meera Iyer'], ['kabir', 'Kabir Singh'], ['ananya', 'Ananya Das'], ['zoya', 'Zoya Khan'], ['sam', 'Sam Newton']];
  const T = {};
  for (const [u, n] of people) T[u] = (await api('POST', '/api/signup', null, { username: u, displayName: n })).token;
  for (const u of ['priya', 'rahul', 'meera', 'kabir', 'ananya']) {
    await api('POST', '/api/contacts/request', T.adrish, { username: u });
    await api('POST', '/api/contacts/respond', T[u], { username: 'adrish', accept: true });
  }
  await api('POST', '/api/contacts/request', T.zoya, { username: 'adrish' }); // pending request in Adrish's list
  const S = {};
  for (const u of ['adrish', 'priya', 'rahul', 'meera', 'kabir']) S[u] = await connect(T[u]);
  const room = async (u) => (await api('GET', '/api/contacts', T.adrish)).contacts.find((c) => c.username === u).room;
  const R = { priya: await room('priya'), rahul: await room('rahul'), meera: await room('meera'), kabir: await room('kabir') };
  const ids = [];
  const say = async (who, peer, d) => { const r = await emit(S[who], 'voice', note(d)); if (!r.ok) throw new Error(`seed voice: ${r.error}`); ids.push({ room: R[peer], id: r.id }); await wait(60); return r.id; };

  // Kabir: one note from yesterday, already heard.
  await emit(S.kabir, 'join', { room: R.kabir }); await say('kabir', 'kabir', 6);
  // Priya: a real back-and-forth with grouping, a reaction, receipts.
  await emit(S.priya, 'join', { room: R.priya }); await emit(S.adrish, 'join', { room: R.priya });
  const p1 = await say('priya', 'priya', 4); const p2 = await say('priya', 'priya', 6);
  await emit(S.adrish, 'listened', { room: R.priya, id: p1 }); await emit(S.adrish, 'listened', { room: R.priya, id: p2 });
  const a1 = await say('adrish', 'priya', 8); await emit(S.priya, 'listened', { room: R.priya, id: a1 });
  const r1 = await emit(S.priya, 'react', { room: R.priya, target: a1, note: { audio: FX('voice-3.webm'), mime: 'audio/webm', duration: 3, peaks: peaks(12) } });
  if (!r1.ok) throw new Error(r1.error);
  const p3 = await say('priya', 'priya', 11); await emit(S.adrish, 'listened', { room: R.priya, id: p3 });
  const a2 = await say('adrish', 'priya', 3); await emit(S.priya, 'listened', { room: R.priya, id: a2 });
  const a3 = await say('adrish', 'priya', 4);
  await emit(S.adrish, 'react', { room: R.priya, target: p3, note: { audio: FX('voice-3.webm'), mime: 'audio/webm', duration: 2, peaks: peaks(12) } });
  const p4 = await say('priya', 'priya', 6);
  // Meera: Adrish sent, Meera listened.
  await emit(S.adrish, 'join', { room: R.meera }); await emit(S.meera, 'join', { room: R.meera });
  const m1 = await say('adrish', 'meera', 8); await emit(S.meera, 'listened', { room: R.meera, id: m1 });
  await emit(S.adrish, 'leave');
  // Rahul: two unplayed notes waiting for Adrish.
  await emit(S.rahul, 'join', { room: R.rahul }); await say('rahul', 'rahul', 3); await say('rahul', 'rahul', 4);
  // Voice hellos
  for (const u of ['adrish', 'priya']) { const h = await emit(S[u], 'profile:voice', { audio: FX('voice-6.webm'), mime: 'audio/webm', duration: 6, peaks: peaks(40) }); if (!h.ok) throw new Error(h.error); }
  Object.values(S).forEach((s) => s.close());
  return { T, R, plan: { kabir: [-26.2], priya: [-23.6, -23.55, -22.9, -0.95, -0.9, -0.62, -0.08], meera: [-3.2], rahul: [-0.35, -0.33] } };
}

function backdate(plan, R) {
  // Spread the seeded notes over "yesterday" and "today" (relative to now) so day separators and times look real.
  const file = path.join(DATA_DIR, 'db.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = Date.now();
  for (const [peer, hours] of Object.entries(plan)) {
    const list = db.messages[R[peer]] || [];
    list.forEach((m, i) => {
      const ts = Math.round(now + (hours[i] ?? -0.05) * 3600e3);
      m.ts = ts; (m.reactions || []).forEach((x, j) => { x.ts = ts + 60e3 * (j + 1); });
    });
  }
  for (const reads of Object.values(db.reads)) for (const room of Object.keys(reads)) reads[room] = now - 60e3;
  // Rahul's two notes stay unplayed: drop any read mark Adrish might have.
  const adrishId = Object.values(db.users).find((u) => u.username === 'adrish').id;
  if (db.reads[adrishId]) delete db.reads[adrishId][R.rahul];
  fs.writeFileSync(file, JSON.stringify(db));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.unlinkSync(path.join(SHOTS, f));
  let srv = await startServer();
  const { T, R, plan } = await seedData();
  await wait(700); await stopServer(srv);
  backdate(plan, R);
  srv = await startServer();

  // Live presence: Priya and Rahul online, Kabir is recording right now (talking pulse).
  const live = { priya: await connect(T.priya), rahul: await connect(T.rahul), kabir: await connect(T.kabir) };
  await emit(live.kabir, 'join', { room: R.kabir });
  let talkOn = false; const talk = setInterval(() => { if (!talkOn) { live.kabir.emit('recording', true); talkOn = true; } live.kabir.emit('level', +(0.35 + 0.6 * Math.random()).toFixed(2)); }, 200);

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(__dirname, 'fixtures', 'fake-voice.wav')}`, '--autoplay-policy=no-user-gesture-required', '--font-render-hinting=none'] });
  const out = [];
  const devices = { mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } };
  try {
    for (const theme of ['light', 'dark']) for (const [dev, opts] of Object.entries(devices)) {
      const ctx = async (token) => {
        const c = await browser.newContext({ ...opts, colorScheme: theme, timezoneId: TZ, locale: 'en-IN', permissions: ['microphone'], reducedMotion: 'no-preference' });
        await c.addInitScript((t) => { localStorage.setItem('voicely:token', t); localStorage.setItem('voicely:theme', 'system'); }, token);
        await c.addCookies([{ name: 'vt', value: encodeURIComponent(token), url: BASE }]);
        return c;
      };
      const shot = async (page, name) => {
        await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
        await page.waitForTimeout(450);
        const file = path.join(SHOTS, `${theme}-${dev}-${name}.png`);
        await page.screenshot({ path: file }); out.push(path.relative(ROOT, file));
      };
      const c = await ctx(T.adrish); const p = await c.newPage();
      p.on('pageerror', (e) => console.log('page error:', e.message));
      // 1) contacts / chats list
      await p.goto(BASE + '/'); await p.waitForSelector('#contactsList .row'); await p.waitForSelector('#contactsList .row.is-talking', { timeout: 5000 }).catch(() => {});
      await shot(p, 'contacts');
      // 2) chat with bubbles (play a bit of Priya's long note so the playing state + progress show)
      await p.click('#contactsList .row[data-username="priya"]'); await p.waitForSelector('#tlInner .msg .reaction');
      await p.waitForTimeout(500);
      const long = p.locator('#tlInner .msg.theirs[data-duration="11"] .play-btn');
      await long.scrollIntoViewIfNeeded(); await long.click(); await p.waitForTimeout(2600);
      if (dev === 'mobile') { await p.evaluate(() => { const s = document.getElementById('timeline'); s.scrollTop = s.scrollHeight; }); }
      await shot(p, 'chat');
      await long.click(); // pause
      await p.evaluate(() => document.getElementById('mpClose').click()); // dismiss the mini player
      // 3) locked recording
      await p.waitForTimeout(300);
      const mb = await (await p.$('#micBtn')).boundingBox(); const mx = mb.x + mb.width / 2, my = mb.y + mb.height / 2;
      await p.mouse.move(mx, my); await p.mouse.down(); await p.waitForSelector('#composer[data-state="holding"]', { state: 'attached' });
      await p.mouse.move(mx, my - 50, { steps: 4 }); await p.mouse.move(mx, my - 100, { steps: 4 }); await p.mouse.up();
      await p.waitForTimeout(2600);
      await shot(p, 'recording');
      await p.click('#recTrash');
      // 4) profile with voice hello (own "Me" tab), plus the contact's profile sheet on mobile
      if (dev === 'mobile') {
        await p.click('#chatHead'); await p.waitForSelector('#sheet .hello-card'); await shot(p, 'contact-profile');
        await p.keyboard.press('Escape'); await p.waitForTimeout(300); await p.click('#backBtn'); await p.waitForTimeout(450);
      }
      await p.click('#tabMe'); await p.waitForSelector('#tab-me .hello-card');
      await shot(p, 'profile');
      await c.close();
      // 5) empty state (brand-new account)
      const c2 = await ctx(T.sam); const p2 = await c2.newPage();
      await p2.goto(BASE + '/'); await p2.waitForSelector('#contactsEmpty');
      await shot(p2, 'empty');
      if (dev === 'mobile') { await p2.goto(BASE + '/r/sunny-otter-42'); await p2.waitForSelector('#tlInner .empty'); await shot(p2, 'empty-room'); }
      await c2.close();
    }
  } finally {
    clearInterval(talk); Object.values(live).forEach((s) => s.close());
    await browser.close(); await stopServer(srv);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(out.join('\n'));
  console.log(`\n${out.length} screenshots in ./screenshots`);
})().catch((e) => { console.error(e); process.exit(1); });
