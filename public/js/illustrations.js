// Inline SVG illustrations for empty states. They use CSS variables so they follow theme & accent.
const wrap = (inner) => `<svg class="illus" viewBox="0 0 168 128" aria-hidden="true" fill="none">${inner}</svg>`;
const blob = '<ellipse cx="84" cy="70" rx="72" ry="50" fill="var(--accent-soft)"/>';
const grad = (id) => `<defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="1"><stop stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs>`;

export const ILLUS = {
  chats: wrap(`${blob}${grad('ig1')}
    <rect x="30" y="34" width="78" height="34" rx="17" fill="var(--surface)" stroke="var(--line-strong)"/>
    <circle cx="47" cy="51" r="9" fill="var(--accent)"/><path d="M45 47v8l6-4z" fill="#fff"/>
    <g fill="var(--wave-theirs)"><rect x="62" y="47" width="3" height="8" rx="1.5"/><rect x="68" y="43" width="3" height="16" rx="1.5"/><rect x="74" y="46" width="3" height="10" rx="1.5"/><rect x="80" y="41" width="3" height="20" rx="1.5"/><rect x="86" y="46" width="3" height="10" rx="1.5"/><rect x="92" y="48" width="3" height="6" rx="1.5"/></g>
    <rect x="62" y="76" width="78" height="32" rx="16" fill="url(#ig1)"/>
    <g fill="#fff" opacity=".9"><rect x="74" y="88" width="3" height="8" rx="1.5"/><rect x="80" y="84" width="3" height="16" rx="1.5"/><rect x="86" y="87" width="3" height="10" rx="1.5"/><rect x="92" y="82" width="3" height="20" rx="1.5"/><rect x="98" y="86" width="3" height="12" rx="1.5"/><rect x="104" y="89" width="3" height="6" rx="1.5"/></g>
    <circle cx="126" cy="92" r="8" fill="rgba(255,255,255,.25)"/>`),
  rooms: wrap(`${blob}${grad('ig2')}
    <circle cx="58" cy="58" r="16" fill="var(--surface)" stroke="var(--line-strong)"/><circle cx="110" cy="58" r="16" fill="var(--surface)" stroke="var(--line-strong)"/>
    <circle cx="84" cy="76" r="20" fill="url(#ig2)"/>
    <path d="M84 66v14M78 74a6 6 0 0 0 12 0" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M52 58h12M104 58h12" stroke="var(--text-3)" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M40 30c6-4 12-4 18 0M110 30c6-4 12-4 18 0" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" opacity=".6"/>`),
  chat: wrap(`${blob}${grad('ig3')}
    <circle cx="84" cy="62" r="30" fill="url(#ig3)"/>
    <rect x="77" y="44" width="14" height="24" rx="7" fill="#fff"/><path d="M71 60a13 13 0 0 0 26 0M84 73v7" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <circle cx="84" cy="62" r="40" stroke="var(--accent)" stroke-width="2" opacity=".25"/><circle cx="84" cy="62" r="50" stroke="var(--accent)" stroke-width="2" opacity=".12"/>`),
  pick: wrap(`${blob}${grad('ig4')}
    <rect x="34" y="28" width="100" height="72" rx="14" fill="var(--surface)" stroke="var(--line-strong)"/>
    <path d="M48 28h20v72H48a14 14 0 0 1-14-14V42a14 14 0 0 1 14-14Z" fill="var(--surface-2)"/>
    <circle cx="51" cy="46" r="7" fill="var(--accent)"/><circle cx="51" cy="64" r="7" fill="var(--wave-theirs)"/><circle cx="51" cy="82" r="7" fill="var(--wave-theirs)"/>
    <rect x="78" y="44" width="40" height="14" rx="7" fill="var(--surface-3)"/><rect x="88" y="66" width="38" height="14" rx="7" fill="url(#ig4)"/>`),
};
export function illus(name) { const t = document.createElement('template'); t.innerHTML = ILLUS[name].trim(); return t.content.firstChild; }
