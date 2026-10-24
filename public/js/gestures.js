// Native-feeling gestures: collapsing large titles, pull-to-refresh, edge swipe-back.
import { haptic } from './util.js';

/** Show the compact app-bar title once the large title scrolls away. */
export function collapsingTitle(scroller, appbar, threshold = 34) {
  const update = () => appbar.classList.toggle('collapsed', scroller.scrollTop > threshold);
  scroller.addEventListener('scroll', update, { passive: true });
  update();
  return update;
}

/** Pull down at the top of a scroller to refresh. enabled() lets the caller limit it to some tabs. */
export function pullToRefresh(scroller, indicator, onRefresh, enabled = () => true) {
  let startY = null, pull = 0, busy = false, armed = false;
  scroller.addEventListener('touchstart', (e) => {
    if (busy || scroller.scrollTop > 0 || !enabled()) return;
    startY = e.touches[0].clientY; pull = 0; armed = false;
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { indicator.style.height = '0px'; return; }
    pull = Math.min(90, dy * 0.45);
    scroller.classList.add('pulling');
    indicator.style.height = `${pull}px`;
    indicator.style.setProperty('--pull', Math.round((pull / 70) * 100));
    if (pull >= 64 && !armed) { armed = true; haptic('tick'); }
    if (pull < 64) armed = false;
  }, { passive: true });
  scroller.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null; scroller.classList.remove('pulling');
    if (pull >= 64) {
      busy = true; indicator.classList.add('refreshing'); indicator.style.height = '52px';
      try { await Promise.all([onRefresh(), new Promise((r) => setTimeout(r, 450))]); } finally {
        busy = false; indicator.classList.remove('refreshing'); indicator.style.height = '0px';
      }
    } else indicator.style.height = '0px';
  });
}

/** iOS-style swipe from the left edge to go back (mobile only). */
export function swipeBack(pane, shell, onBack, isMobile) {
  let sx = null, sy = 0, dx = 0, t0 = 0, locked = false;
  pane.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    const t = e.touches[0];
    if (t.clientX > 28) return;
    sx = t.clientX; sy = t.clientY; dx = 0; t0 = performance.now(); locked = false;
  }, { passive: true });
  pane.addEventListener('touchmove', (e) => {
    if (sx == null) return;
    const t = e.touches[0];
    dx = Math.max(0, t.clientX - sx);
    if (!locked) {
      if (Math.abs(t.clientY - sy) > 14 && Math.abs(t.clientY - sy) > dx) { sx = null; return; } // vertical scroll wins
      if (dx > 10) { locked = true; shell.classList.add('dragging'); }
    }
    if (locked) {
      const w = pane.clientWidth;
      pane.style.transform = `translateX(${dx}px)`;
      shell.querySelector('.list-pane').style.transform = `translateX(${-24 + (dx / w) * 24}%)`;
    }
  }, { passive: true });
  const end = () => {
    if (sx == null) return;
    sx = null;
    const w = pane.clientWidth, v = dx / Math.max(1, performance.now() - t0);
    shell.classList.remove('dragging');
    pane.style.transform = ''; shell.querySelector('.list-pane').style.transform = '';
    if (locked && (dx > w * 0.33 || v > 0.6)) { haptic('tap'); onBack(); }
  };
  pane.addEventListener('touchend', end);
  pane.addEventListener('touchcancel', end);
}
