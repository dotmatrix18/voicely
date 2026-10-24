// Microphone capture: getUserMedia with browser noise suppression + a Web Audio chain
// (high-pass at 85 Hz to cut rumble, gentle compressor) feeding MediaRecorder.
// Exposes a live level (0..1) for the audio-reactive UI.
const MIME_CANDIDATES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
export const pickMime = () => (window.MediaRecorder && MediaRecorder.isTypeSupported ? MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) : '') || '';
export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

export class Capture {
  constructor({ onLevel } = {}) { this.onLevel = onLevel || (() => {}); this.levels = []; this.chunks = []; this.state = 'idle'; }

  /** Must be called from a user gesture. Resolves true when recording. */
  async start() {
    this.state = 'starting';
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC(); // created inside the gesture so it can run
    try { await this.ctx.resume(); } catch {}
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) { this.ctx.close().catch(() => {}); this.state = 'idle'; throw e; }
    if (this.state !== 'starting') { this.release(); return false; } // cancelled while waiting
    const src = this.ctx.createMediaStreamSource(this.stream);
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;
    const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -28; comp.knee.value = 18; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024;
    src.connect(hp); hp.connect(comp); comp.connect(this.analyser);
    let recStream = this.stream;
    if (this.ctx.state === 'running' && this.ctx.createMediaStreamDestination) {
      const dest = this.ctx.createMediaStreamDestination(); comp.connect(dest); recStream = dest.stream; // processed audio
    }
    const mimeType = pickMime();
    this.recorder = new MediaRecorder(recStream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.state = 'recording';
    this.buf = new Uint8Array(this.analyser.fftSize);
    const loop = () => {
      if (this.state !== 'recording') return;
      this.analyser.getByteTimeDomainData(this.buf);
      let sum = 0; for (const v of this.buf) { const d = (v - 128) / 128; sum += d * d; }
      const level = Math.min(1, Math.sqrt(sum / this.buf.length) * 4);
      this.levels.push(level);
      this.onLevel(level, this.elapsed);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
    return true;
  }

  get elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }

  /** Stop and get {blob, mime, duration, levels, fallbackPeaks}. */
  stop() {
    return new Promise((resolve) => {
      if (this.state !== 'recording') { this.cancel(); resolve(null); return; }
      const duration = this.elapsed;
      this.state = 'stopping';
      cancelAnimationFrame(this.raf);
      this.recorder.onstop = () => {
        const mime = (this.recorder.mimeType || (this.chunks[0] && this.chunks[0].type) || 'audio/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type: mime });
        this.release();
        resolve({ blob, mime, duration, levels: this.levels, fallbackPeaks: downsample(this.levels, 48) });
      };
      try { this.recorder.requestData(); } catch {}
      this.recorder.stop();
    });
  }

  cancel() {
    const was = this.state; this.state = 'idle';
    cancelAnimationFrame(this.raf);
    if (this.recorder && this.recorder.state !== 'inactive') { this.recorder.onstop = null; try { this.recorder.stop(); } catch {} }
    this.release();
    return was !== 'idle';
  }

  release() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = null; this.ctx = null;
  }
}

function downsample(levels, n) {
  if (!levels.length) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * levels.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * levels.length));
    let mx = 0; for (let j = a; j < b && j < levels.length; j++) mx = Math.max(mx, levels[j]); out.push(mx);
  }
  const top = Math.max(...out, 0.05);
  return out.map((v) => Math.round((v / top) * 100) / 100);
}

/** Draw a scrolling live waveform of recent levels onto a canvas. */
export function drawLive(canvas, levels, color) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d'); g.clearRect(0, 0, w, h);
  const bw = 3 * dpr, gap = 2 * dpr, n = Math.floor(w / (bw + gap));
  const lv = levels.filter((_, i) => i % 2 === 0).slice(-n);
  g.fillStyle = color;
  lv.forEach((v, i) => { const bh = Math.max(3 * dpr, Math.min(1, v * 1.4) * h); const x = w - (lv.length - i) * (bw + gap); g.beginPath(); g.roundRect ? g.roundRect(x, (h - bh) / 2, bw, bh, bw / 2) : g.rect(x, (h - bh) / 2, bw, bh); g.fill(); });
}
