// Your IPTV (Dispatcharr), the same way the Talkies launcher finds a game (Iptv.java): the guide entry on the air
// whose text names both teams, then the channel to play: one in the NFL group or named "NFL …" first, then your
// local channels (Network TV), then any other, the highest channel number within each. Goes through the test
// server's /proxy, since Dispatcharr doesn't allow browsers to read it directly.

const GUIDE_AGE = 10 * 60e3;

export class Iptv {
  /**
   * cfg: {base} for Dispatcharr on your network, {server, user, pass} for an Xtream Codes login, or {stalker} for a
   * Stalker portal (the app logs in with its address and MAC, and serves its channels and guide at /stalker/).
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.guide = null;      // {at, now: Map(channelId -> text on the air)}
    this.list = null;       // {at, channels: [{id, name, group, no, url}]}
  }

  /** Settings' "Play from" picks one; Automatic takes Dispatcharr, then Xtream, then Stalker, whichever is filled in. */
  static fromSettings(s) {
    const all = {
      dispatcharr: s.iptvBase && (() => new Iptv({ base: s.iptvBase.replace(/\/+$/, '') })),
      xtream: s.xtServer && s.xtUser && (() => new Iptv({ server: s.xtServer.replace(/\/+$/, ''), user: s.xtUser, pass: s.xtPass || '' })),
      stalker: s.stalkerPortal && s.stalkerMac && (() => new Iptv({ stalker: true })),
    };
    const make = all[s.iptvSource] || all.dispatcharr || all.xtream || all.stalker;
    return make ? make() : null;
  }

  get guideUrl() {
    const c = this.cfg;
    return c.stalker ? '/stalker/epg' : c.base ? `${c.base}/output/epg?days=1` : `${c.server}/xmltv.php?username=${enc(c.user)}&password=${enc(c.pass)}`;
  }

  get listUrl() {
    const c = this.cfg;
    return c.stalker ? '/stalker/m3u' : c.base ? `${c.base}/output/m3u` : `${c.server}/get.php?username=${enc(c.user)}&password=${enc(c.pass)}&type=m3u_plus&output=ts`;
  }

  /**
   * The channel for this game, {name, url, no, via}, or null. In order: your pick for this game, your team rule,
   * the guide or a channel named after the game, then your network rule (e.g. CBS → your local CBS).
   * rules: {games: {gameId: channelName}, teams: {ABBR: channelName}, networks: {NAME: channelName}}.
   */
  async find(game, rules = {}) {
    // The channel list is small and quick; the guide can be tens of MB. Channels named after the game ("NFL | NYG/PHI")
    // are found from the list alone, so the first game plays without waiting for the guide.
    await this.refreshList();
    const guide = this.refreshGuide();
    const named = n => n && this.list.channels.find(c => c.name === n);
    const pick = named((rules.games || {})[game.id]);
    if (pick) return { ...pick, via: 'your pick' };
    const teamRule = named((rules.teams || {})[game.home.abbr]) || named((rules.teams || {})[game.away.abbr]);
    if (teamRule) return { ...teamRule, via: 'team rule' };
    if (!this.guide) {
      const early = this.match(game);
      if (early) return early;
      await guide.catch(() => {});
    }
    const found = this.match(game);
    if (found) return found;
    const net = String(game.network || '').toUpperCase();
    const netRule = Object.entries(rules.networks || {}).find(([k]) => k && net.includes(k.toUpperCase()));
    const byNet = netRule && named(netRule[1]);
    return byNet ? { ...byNet, via: `${netRule[0]} rule` } : null;
  }

  /** The guide / channel-name match on its own. */
  match(game) {
    const m = matcher(game);
    const hits = new Set();
    for (const [id, text] of this.guide ? this.guide.now : []) if (!text.includes('replay') && !otherSport(text) && m.names(text)) hits.add(id);
    // Channels named after the matchup ("NFL | CAR/GB", "NFL 05: DAL @ PHI", "Cowboys vs Eagles") count too, guide or not.
    // Never on its own: alternate feeds (Prime Vision, ManningCast, Spanish...), often another show or a placeholder
    // slate. 4K copies only where they play (allow4k: a Shield), and there ahead of the plain feed; elsewhere never.
    // You can still pick any of them for a game yourself. Among equal matches: the plainest name, then the highest
    // channel number.
    const found = [];
    for (const ch of this.list.channels) {
      const lower = ch.name.toLowerCase();
      if (otherSport(`${lower} ${ch.group.toLowerCase()}`)) continue;   // "NCAAM | UIW/OKST": Cardinals at Cowboys, but college
      const k4 = HEAVY.test(lower);
      if (ALT_FEED.test(lower) || (k4 && !this.allow4k)) continue;
      const named = m.names(lower) || (/nfl/.test(lower) && m.codes(lower));
      if (!(ch.id && hits.has(ch.id)) && !named) continue;
      const tier = /nfl/.test(ch.group.toLowerCase()) || /^nfl\b/.test(lower) ? 0 : /network|local/.test(ch.group.toLowerCase()) ? 1 : 2;
      found.push({ ch, key: [tier, k4 ? 0 : 1, lower.length, -ch.no] });
    }
    found.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]; return 0; });
    const best = found[0] && found[0].ch;
    return best ? { ...best, via: hits.has(best.id) ? 'guide' : 'channel name' } : null;
  }

  /** Channel list and guide, both loaded. */
  async refresh() { await Promise.all([this.refreshList(), this.refreshGuide()]); }
  refreshList() { return this.load('list', async () => ({ at: Date.now(), channels: parseM3u(await text(this.listUrl)) })); }
  refreshGuide() { return this.load('guide', async () => { const t = await text(this.guideUrl), now = Date.now(); return { at: now, now: parseGuide(t, now) }; }); }

  /**
   * this[key], loaded once at a time (two callers share one download). Missing: waits for it. Older than GUIDE_AGE:
   * the old copy carries on while the new one loads.
   */
  load(key, get) {
    const have = this[key], busy = `${key}Loading`;
    if (have && Date.now() - have.at <= GUIDE_AGE) return Promise.resolve();
    if (!this[busy]) this[busy] = get().then(v => { this[key] = v; }).finally(() => { this[busy] = null; });
    if (have) { this[busy].catch(() => {}); return Promise.resolve(); }
    return this[busy];
  }
}

const enc = encodeURIComponent;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Other leagues share NFL nicknames (Cardinals, Cowboys, Giants, Rams, Panthers, Jets...): guide text or channels
// that say they're another sport don't count, unless they also say NFL.
const OTHER = /\b(?:ncaa\w*|college|cfb|mlb|nhl|nba|wnba|mls|ufl|xfl|cfl|baseball|hockey|basketball|soccer)\b/;
const otherSport = text => OTHER.test(text) && !/\bnfl\b/.test(text);

// A game's other versions: alternate broadcasts, and heavier copies of the main one.
const ALT_FEED = /\b(?:vision|alt|alternate|manning\s?cast|megacast|spanish|espa[nñ]ol|deportes|kids|nick(?:elodeon)?|all[- ]?22|coach(?:es)?\s?(?:film|cam)|sky\s?cast|command\s?center|watch\s?party)\b/;
const HEAVY = /\b(?:4k|uhd|2160p?)\b/;

// Other codes guides and providers use for the same team.
const ALIAS = { JAX: ['JAC'], LAR: ['LA'], WAS: ['WSH'], WSH: ['WAS'], ARI: ['ARZ'] };
const SEP = '\\s*(?:@|at|vs\\.?|v\\.?|versus|-|/|\\|)\\s*';   // "DAL @ PHI", "DAL vs. PHI", "DAL-PHI", "DAL/PHI"

/**
 * How to recognise a game in guide text or a channel name (lower case):
 *   names(text): both teams by name, whole words: "Eagles", "Philadelphia Eagles" or "Philadelphia";
 *   codes(text): both team codes as whole words anywhere ("NFL | CAR/GB" style channel names);
 *   names() also takes the codes as a matchup ("DAL @ PHI", "PHI vs DAL"), but never a lone code ("NO", "NE" are
 *   everyday words).
 */
function matcher(game) {
  const word = list => new RegExp(`\\b(?:${list.map(esc).join('|')})\\b`);
  const teams = [game.away, game.home].map(t => {
    const long = [t.name, t.full, t.city].filter(s => s && s.length > 3).map(s => s.toLowerCase());
    const codes = [...new Set([t.abbr, t.espnAbbr, ...(ALIAS[t.abbr] || [])].filter(Boolean).map(s => s.toLowerCase()))];
    return { long: long.length ? word(long) : null, code: word(codes), codes: codes.map(esc).join('|') };
  });
  const [a, b] = teams;
  const pair = new RegExp(`\\b(?:${a.codes})${SEP}(?:${b.codes})\\b|\\b(?:${b.codes})${SEP}(?:${a.codes})\\b`);
  return {
    names: text => (teams.every(t => t.long && t.long.test(text))) || pair.test(text),
    codes: text => teams.every(t => t.code.test(text)),
  };
}
export const proxied = url => `/proxy?url=${enc(url)}`;

async function text(url) {
  const r = await fetch(url.startsWith('/') ? url : proxied(url));   // the app's own (Stalker) or through its proxy
  if (!r.ok) throw new Error(`IPTV ${r.status}`);
  return r.text();
}

function xmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return NaN;
  const tz = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z';
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`);
}

function parseGuide(xml, now) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const out = new Map();
  for (const p of doc.getElementsByTagName('programme')) {
    if (!(xmltvTime(p.getAttribute('start')) <= now && now < xmltvTime(p.getAttribute('stop')))) continue;
    let t = '';
    for (const tag of ['title', 'sub-title', 'desc']) for (const e of p.getElementsByTagName(tag)) t += ' ' + e.textContent;
    const id = p.getAttribute('channel');
    out.set(id, ((out.get(id) || '') + t).toLowerCase());
  }
  return out;
}

function parseM3u(m3u) {
  const out = [];
  let cur = null;
  for (const raw of m3u.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const attr = k => (new RegExp(`${k}="([^"]*)"`).exec(line) || [])[1] || '';
      const id = attr('tvg-id');
      cur = { id, name: line.slice(line.lastIndexOf(',') + 1).trim(), group: attr('group-title'),
        no: parseFloat(attr('tvg-chno')) || parseFloat(id) || 0 };
    } else if (cur && line && !line.startsWith('#')) {
      cur.url = line; out.push(cur); cur = null;
    }
  }
  return out;
}
