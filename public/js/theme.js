// Theme (system / light / dark) + accent colour. theme-boot.js applies the saved choice before first paint.
const root = document.documentElement;
export const ACCENTS = window.__VOICELY_ACCENTS || { violet: ['#6d5dfc', '#a26bff'] };
const mq = window.matchMedia('(prefers-color-scheme: dark)');

export const getTheme = () => localStorage.getItem('voicely:theme') || 'system';
export const getAccent = () => (ACCENTS[localStorage.getItem('voicely:accent')] ? localStorage.getItem('voicely:accent') : 'violet');

export function applyTheme(choice = getTheme()) {
  localStorage.setItem('voicely:theme', choice);
  const dark = choice === 'dark' || (choice === 'system' && mq.matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach((m) => m.setAttribute('content', dark ? '#0b0c11' : '#f3f4f8'));
}
export function applyAccent(name = getAccent()) {
  const a = ACCENTS[name] || ACCENTS.violet;
  localStorage.setItem('voicely:accent', name);
  root.style.setProperty('--accent', a[0]); root.style.setProperty('--accent-2', a[1]);
}
mq.addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme('system'); });
