/* Real-browser E2E (headless Chrome + fake microphone fed from test/fixtures/fake-voice.wav)
 * for the v3 UI: contacts, private voice chats with receipts, slide-to-lock recorder with
 * preview + silence trimming, voice reactions, voice hello, talking pulse, listen mode +
 * mini player + Media Session, theme/accent, swipe-back, desktop two-pane, rooms, pairing.
 * Usage: npm run test:browser   (CHROME_PATH=/path/to/chrome if not /usr/bin/google-chrome)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const PORT = 4100 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voicely-e2e-'));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const VOICE = path.join(__dirname, 'fixtures', 'fake-voice.wav');

let passed = 0, failed = 0;
const check = (n, c, extra = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${c ? '' : ' ' + extra}`); c ? passed++ : failed++; };
const section = (s) => console.log(s);
const post = (p, body, token) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
const has = async (page, sel) => !!(await page.$(sel));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; };

async function signUp(page, username, name) {
  await page.goto(BASE);
  await page.waitForSelector('#onboard:not(.hidden)');
  await page.fill('#suUsername', username);
  await page.fill('#suName', name);
  await page.waitForSelector('#suUsernameHint.ok');
  await page.click('#signupForm button[type=submit]');
  await page.waitForSelector('#shell:not(.hidden)');
}
async function micCenter(page) { const b = await (await page.$('#micBtn')).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
async function closeSheet(page) { await page.keyboard.press('Escape'); await page.waitForTimeout(350); }
async function sendHeld(page, ms) {
  await page.waitForTimeout(450); // let the chat pane finish sliding in
  const c = await micCenter(page);
  await page.mouse.move(c.x, c.y); await page.mouse.down();
  await page.waitForSelector('#composer[data-state="holding"]', { state: 'attached' });
  await page.waitForTimeout(ms); await page.mouse.up();
}
async function holdMini(page, ms) {
  const btn = await page.waitForSelector('#sheet .mini-rec-btn');
  await page.waitForTimeout(450); // sheet slide-in
  const b = await btn.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.waitForSelector('#sheet .mini-rec-btn.rec', { state: 'attached' });
  await page.waitForTimeout(ms); await page.mouse.up();
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('running') && r()));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${VOICE}`, '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const mobile = { viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, permissions: ['microphone'], timezoneId: 'Asia/Kolkata', colorScheme: 'light' };
    const ctxA = await browser.newContext(mobile), ctxB = await browser.newContext({ ...mobile, colorScheme: 'dark' });
    const a = await ctxA.newPage(), b = await ctxB.newPage();
    for (const [n, p] of [['A', a], ['B', b]]) {
      p.on('pageerror', (e) => errors.push(`${n}: ${e.stack || e.message}`));
      p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${n} console: ${m.text()}`); });
    }

    section('Onboarding');
    await signUp(a, 'adrish', 'Adrish Manna');
    check('A signs up and lands on Chats with the empty-state illustration', !!(await a.waitForSelector('#contactsEmpty svg', { timeout: 5000 }).catch(() => null)));
    check('there is no text box for messages anywhere', (await a.$$('textarea, [contenteditable="true"]')).length === 0);
    await signUp(b, 'priya', 'Priya Sharma');
    check('system dark theme followed on B', (await b.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

    section('Add contact');
    await a.click('#addContactBtn');
    await a.fill('#sheet input[aria-label=Username]', 'priya');
    await a.click('#sheet button[type=submit]');
    await a.click('#sheet .result-card button:has-text("Add")');
    await a.waitForSelector('#sheet .result-card:has-text("request sent")');
    check('A finds @priya and sends a request', true);
    await closeSheet(a);
    await b.waitForSelector('#requestsList button:has-text("Accept")');
    check('B sees the request live', true);
    await b.click('#requestsList button:has-text("Accept")');
    await b.waitForSelector('#contactsList .row[data-username="adrish"]');
    await a.waitForSelector('#contactsList .row[data-username="priya"]');
    check('both see each other in Chats after accepting', true);

    section('Recorder: talking pulse, slide-up lock, preview, trim, send');
    await a.click('#contactsList .row[data-username="priya"]');
    await a.waitForSelector('#chatView:not(.hidden) #tlInner .empty');
    check('A opens the DM (empty chat state shown)', true);
    await a.waitForTimeout(600);
    let c = await micCenter(a);
    await a.mouse.move(c.x, c.y); await a.mouse.down();
    console.log('DEBUG state', await a.$eval('#composer', (x) => x.dataset.state + ' ' + getComputedStyle(x).visibility+ ' ' + x.getBoundingClientRect().height));
    await a.waitForSelector('#composer[data-state="holding"]', { state: 'attached' });
    check('B sees A’s live “recording…” pulse on the contact row', await until(() => b.$eval('#contactsList .row[data-username="adrish"]', (r) => r.classList.contains('is-talking') && r.querySelector('.avatar').classList.contains('talking'))));
    await a.mouse.move(c.x, c.y - 40, { steps: 4 }); await a.mouse.move(c.x, c.y - 100, { steps: 4 });
    await a.waitForSelector('#composer[data-state="locked"]', { state: 'attached' });
    await a.mouse.up();
    check('slide up locks the recording (hands-free)', (await a.$eval('#composer', (x) => x.dataset.state)) === 'locked');
    await a.waitForTimeout(3400);
    const lockedFor = await a.$eval('#recTime', (x) => x.textContent);
    await a.click('#recStop');
    await a.waitForSelector('#composer[data-state="preview"]', { state: 'attached' });
    check('■ opens a preview with a waveform', (await a.$$('#pvWave i')).length > 10);
    const trimLabel = await a.$eval('#pvTrim', (x) => (x.classList.contains('hidden') ? '' : x.textContent.trim()));
    check('smart trim removed the leading silence (shows “−x.xs”)', /−\d\.\ds/.test(trimLabel), trimLabel);
    check('trimmed bars are marked in the preview waveform', (await a.$$('#pvWave i.trimmed')).length > 0);
    await a.click('#pvPlay');
    check('preview plays back before sending', await until(() => a.$eval('#pvTime', (x) => x.textContent.includes('/'))));
    c = await micCenter(a); await a.mouse.click(c.x, c.y);
    await a.waitForSelector('#tlInner .msg.mine');
    const d1 = Number(await a.$eval('#tlInner .msg.mine', (x) => x.dataset.duration));
    const recSec = lockedFor.split(':').reduce((m, x) => m * 60 + Number(x), 0);
    check(`sent note is shorter than the recording (${lockedFor} recorded → ${d1.toFixed(1)}s sent)`, d1 > 0.8 && d1 <= recSec - 0.5);
    check('first note shows “delivered” (B is online)', await until(() => a.$('#tlInner .msg.mine .tick.delivered')));
    await b.waitForSelector('#contactsList .row[data-username="adrish"] .count');
    check('B gets an unplayed badge', (await b.$eval('#contactsList .row[data-username="adrish"] .count', (x) => x.textContent)) === '1');

    section('Hold-to-talk, slide-to-cancel');
    await sendHeld(a, 1800);
    await until(async () => (await a.$$('#tlInner .msg.mine')).length === 2);
    check('hold + release sends a second note, grouped with the first', (await a.$$('#tlInner .msg.mine')).length === 2 && (await a.$$('#tlInner .msg.mine.first')).length === 1);
    c = await micCenter(a);
    await a.mouse.move(c.x, c.y); await a.mouse.down(); await a.waitForSelector('#composer[data-state="holding"]', { state: 'attached' });
    await a.waitForTimeout(800); await a.mouse.move(c.x - 160, c.y, { steps: 8 });
    await a.waitForSelector('#composer[data-state="idle"]', { state: 'attached' }); await a.mouse.up(); await a.waitForTimeout(600);
    check('slide left cancels, nothing sent', (await a.$$('#tlInner .msg.mine')).length === 2);
    await b.click('#contactsList .row[data-username="adrish"]');
    await b.waitForSelector('#tlInner .msg.theirs .play-btn');
    check('B sees the notes with unplayed dots', (await b.$$('#tlInner .msg.theirs .unplayed-dot')).length === 2);

    section('Listened receipts');
    await b.click('#tlInner .msg.theirs >> nth=0 >> .play-btn');
    check('A’s tick turns to 🎧 “listened” after B plays it', await until(() => a.$('#tlInner .msg.mine .tick.listened'), 10000));
    await b.waitForTimeout(500); await b.evaluate(() => document.querySelector('#tlInner .msg.theirs .play-btn').click());

    section('Voice reactions');
    await b.dispatchEvent('#tlInner .msg.theirs >> nth=0 >> .bubble', 'contextmenu');
    await b.waitForSelector('#sheet .mini-rec-btn');
    check('long-press / right-click opens the voice reaction recorder', true);
    check('reaction sheet has no text input', (await b.$$('#sheet input, #sheet textarea')).length === 0);
    await holdMini(b, 1800);
    await a.waitForSelector('#tlInner .msg.mine .reaction');
    check('A sees B’s voice reaction pill on the note', true);
    await a.click('#tlInner .msg.mine .reaction');
    check('tapping the reaction plays it', await until(() => a.$('#tlInner .reaction.playing')));

    section('Listen mode + mini player + Media Session');
    await sendHeld(a, 1500);
    await sendHeld(a, 1500);
    await until(async () => (await b.$$('#tlInner .msg.theirs .unplayed-dot')).length >= 2);
    await b.click('#listenBtn');
    await b.waitForSelector('#miniPlayer.show');
    check('listen mode plays unplayed notes in a queue (mini player shown)', /Listen mode/.test(await b.$eval('#mpSub', (x) => x.textContent)));
    check('Media Session metadata set for lock-screen controls', /Adrish/.test(await b.evaluate(() => (navigator.mediaSession.metadata || {}).title + ' ' + (navigator.mediaSession.metadata || {}).artist)));
    await b.click('#backBtn');
    await b.waitForTimeout(500);
    check('mini player persists after leaving the chat', await has(b, '#miniPlayer.show'));
    await b.click('#mpClose');
    check('mini player can be dismissed', await until(async () => !(await has(b, '#miniPlayer.show'))));

    section('Voice hello (audio profile)');
    await a.click('#backBtn'); await a.waitForTimeout(400);
    await a.click('#tabMe');
    await a.click('#recordHelloBtn');
    await holdMini(a, 2500);
    await a.waitForSelector('#tab-me .hello-card');
    check('A records a voice hello in Me', true);
    await b.click('#contactsList .row[data-username="adrish"]');
    await b.click('#chatHead');
    await b.waitForSelector('#sheet .hello-card .play-btn');
    check('B sees A’s voice hello in A’s profile', true);
    await b.click('#sheet .hello-card .play-btn');
    check('…and can play it (progress fills the waveform)', await until(() => b.$('#sheet .hello-card .wave i.on')));
    await closeSheet(b);

    section('Theme + accent');
    await a.click('#tab-me [data-theme="dark"]');
    check('theme toggle switches to dark', (await a.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    const acc1 = await a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    await a.click('#tab-me [data-accent="teal"]');
    const acc2 = await a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    check('accent picker recolours the app', acc1 !== acc2);
    await a.reload(); await a.waitForSelector('#shell:not(.hidden)');
    check('theme + accent persist across reloads', (await a.evaluate(() => document.documentElement.dataset.theme + localStorage.getItem('voicely:accent'))) === 'darkteal');

    section('Swipe back (touch)');
    const cdp = await b.context().newCDPSession(b);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', 6, 400);
    for (let x = 30; x <= 300; x += 30) { await touch('touchMove', x, 402); await b.waitForTimeout(16); }
    await touch('touchEnd');
    check('edge-swipe right goes back to the list', await until(async () => (await b.evaluate(() => location.pathname)) === '/' && !(await b.$eval('#shell', (s) => s.classList.contains('chat-open')))));

    section('Desktop two-pane (paired device)');
    await a.click('#tabMe'); await a.click('[data-action="pair"]');
    await a.waitForSelector('#sheet .code-box');
    const code = (await a.$eval('#sheet .code-box', (x) => x.textContent)).replace('-', '');
    await closeSheet(a);
    const ctxD = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'], timezoneId: 'Asia/Kolkata' });
    const d = await ctxD.newPage(); d.on('pageerror', (e) => errors.push(`D: ${e.message}`));
    await d.goto(`${BASE}/pair/${code}`);
    await d.waitForSelector('#pairForm:not(.hidden)');
    check('pairing link pre-fills the code on the new device', (await d.inputValue('#pairCode')) === code.toUpperCase());
    await d.click('#pairForm button[type=submit]');
    await d.waitForSelector('#contactsList .row[data-username="priya"]');
    check('pairing link signs the desktop into the same account', true);
    check('desktop shows list + “pick a conversation” side by side', await d.isVisible('#listPane') && await d.isVisible('#chatPlaceholder'));
    await d.click('#contactsList .row[data-username="priya"]');
    await d.waitForSelector('#tlInner .msg.mine');
    check('opening a chat keeps the list visible (two panes)', await d.isVisible('#listPane') && await d.isVisible('#chatView'));
    check('history (with reaction) synced to the new device', (await d.$$('#tlInner .reaction')).length >= 1);
    await d.keyboard.down('Space'); await d.waitForTimeout(1500); await d.keyboard.up('Space');
    check('desktop: hold Space to talk sends a note', await until(async () => (await d.$$('#tlInner .msg.mine')).length === 5));

    section('Rooms + privacy');
    await b.click('#tabRooms'); await b.fill('#roomInput', 'study-group'); await b.click('#roomForm button[type=submit]');
    await b.waitForSelector('#chatView:not(.hidden)');
    await a.goto(`${BASE}/r/study-group`); await a.waitForSelector('#chatView:not(.hidden)');
    await sendHeld(a, 1200);
    check('group room voice notes still work', await until(() => b.$('#tlInner .msg.theirs')));
    const ctxE = await browser.newContext(mobile); const e = await ctxE.newPage();
    await signUp(e, 'eve', 'Eve');
    await e.goto(`${BASE}/c/adrish`);
    check('a non-contact can’t open a DM by URL', await until(async () => (await e.evaluate(() => location.pathname)) === '/'));
    check('service worker registered (installable PWA)', await until(() => e.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r))));

    check('no page errors', errors.length === 0, errors.join('\n'));
  } catch (err) {
    console.error(err); failed++;
    if (errors.length) console.error(errors.join('\n'));
  } finally {
    await browser.close(); srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
