// Runs before CSS paints: applies saved theme + accent so there's no flash.
(function () {
  var ACCENTS = { violet: ['#6d5dfc', '#a26bff'], ocean: ['#1f7aff', '#36b6ff'], teal: ['#0ea5a0', '#2dd4bf'], coral: ['#ff5a4e', '#ff9a5a'], rose: ['#e8467c', '#ff7eb3'], amber: ['#e58a00', '#ffc23d'] };
  try {
    var t = localStorage.getItem('voicely:theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    var a = ACCENTS[localStorage.getItem('voicely:accent')] || ACCENTS.violet;
    root.style.setProperty('--accent', a[0]); root.style.setProperty('--accent-2', a[1]);
    window.__VOICELY_ACCENTS = ACCENTS;
  } catch (e) {}
})();
