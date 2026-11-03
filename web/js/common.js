// Bits shared by the TV screen and the phone remote.

// The FantasyTV app icon, the square FTV mark (brand/FantasyTV-Icon-2026.png).
export const LOGO = '<img class="logo-mark" src="img/icon.png" alt="">';

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const bars = n => `<span class="bars s${n || 0}"><i></i><i></i><i></i><i></i><i></i></span>`;
export const pts = n => (Math.round((n || 0) * 10) / 10).toFixed(1);
export const HEART = on => `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 5.3 3.2 1.7-2 3.2-3.2 5.3-3.2 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z" fill="${on ? '#ff4d57' : 'none'}" stroke="${on ? '#ff4d57' : 'currentColor'}" stroke-width="1.8"/></svg>`;

export function statusLine(g) {
  if (g.state === 'pre') return new Date(g.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + (g.network ? ` · ${g.network}` : '');
  if (g.state === 'post') return 'Final';
  if (g.statusName === 'STATUS_HALFTIME') return 'Halftime';
  const q = g.period > 4 ? 'OT' : `Q${g.period}`;
  return [`${q} ${g.clock}`, g.sit && g.sit.downDist, g.sit && g.sit.spot].filter(Boolean).join('  ');
}

/** The TV publishes its state through the test server; the remote sends commands back. */
export const link = {
  async publish(state) {
    try { await fetch('/api/state', { method: 'POST', body: JSON.stringify(state) }); } catch { /* server gone */ }
  },
  async commands() {
    try { return await (await fetch('/api/cmd', { cache: 'no-store' })).json(); } catch { return []; }
  },
  async state() {
    try { return await (await fetch('/api/state', { cache: 'no-store' })).json(); } catch { return null; }
  },
  async send(cmd) {
    try { await fetch('/api/cmd', { method: 'POST', body: JSON.stringify(cmd) }); } catch { /* retry next tap */ }
  },
};

export function loadSettings() {
  const d = { sleeper: '', mode: 'live', delay: 30, cooldown: 75, iptvBase: '', xtServer: '', xtUser: '', xtPass: '', stalkerPortal: '', stalkerMac: '' };
  try { return Object.assign(d, JSON.parse(localStorage.getItem('ftv.settings') || '{}')); } catch { return d; }
}

export function saveSettings(s) {
  try { localStorage.setItem('ftv.settings', JSON.stringify(s)); } catch { /* private window */ }
}
