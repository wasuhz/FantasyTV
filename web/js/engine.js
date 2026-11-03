// AutoTune: scores every live drive by how likely it is to put fantasy points on your board right now, and decides
// when to change the channel. Pure logic: feed it games and players, it tells you what to watch.

import { points, statLine } from './data.js';

const POS_WEIGHT = { QB: 1.0, RB: 0.9, WR: 0.9, TE: 0.8, K: 0.45 };

// Plays after which the broadcast usually goes to a commercial, by ESPN's play type (the play text names players and
// can say anything: "reviewed", "injured"…), plus the few texts that only appear in a stoppage.
const BREAK_TYPE = /timeout|end (of )?(period|quarter|half|game)|two-minute|kickoff|extra point|two-point|field goal|touchdown|halftime|punt|interception|fumble recovery \(opponent\)|turnover on downs/i;
const BREAK_TEXT = /\btimeout #\d|two-minute warning|end of (the )?(1st|2nd|3rd|4th|first|second|third|fourth) quarter/i;

/** Chance the drive ends in points, from yards to the end zone. Rough, but the order is what matters. */
function scoreChance(ytg) {
  if (ytg == null) return 0.18;
  return 0.06 + 0.86 * Math.exp(-ytg / 28);
}

/**
 * One game, ranked: its value right now (`value`), whether it's on a break, the "excitement" used to break ties, and
 * your players in it with their status and points.
 */
export function rankGame(g, roster, pts, prefs) {
  const players = [];
  const out = prefs.out || {};
  // Your opponents' starters this week count too, as much as you say (0–100%), and show when you want them shown.
  const oppWeight = Math.max(0, Math.min(100, +(prefs.oppWeight ?? 0))) / 100;
  const everyone = Object.values(roster).map(p => [p, false]);
  if (prefs.opponents && (oppWeight > 0 || prefs.showOpp))
    for (const p of Object.values(prefs.opponents)) if (!roster[p.id]) everyone.push([p, true]);
  for (const [p, opp] of everyone) {
    if (p.team !== g.home.abbr && p.team !== g.away.abbr) continue;
    if (opp && !prefs.showOpp && !oppWeight) continue;
    const starts = p.leagues.filter(l => l.starter).length;
    const first = p.leagues.find(l => l.starter) || p.leagues[0];
    const info = pts[p.id] || {};
    const offense = g.sit && g.sit.poss === p.team;
    players.push({
      id: p.id, espn: p.espn, name: p.name, short: p.short, pos: p.pos, team: p.team, starts, teams: p.leagues.length,
      bench: starts === 0, pts: points(info.stats, first.scoring || first.rec), proj: points(info.proj, first.scoring || first.rec),
      line: statLine(p.pos, info.stats), out: !!out[p.id], byHand: p.leagues.some(l => l.byHand),
      opp, oppTeam: opp ? first.team : '', hidden: opp && !prefs.showOpp,
      status: out[p.id] ? 'Out' : g.state !== 'in' ? '' : offense ? (g.sit.redZone ? 'Red zone' : 'On field') : 'Off field',
    });
  }
  // Your starters first, those on the field (red zone first) leading; then by live projection: points so far plus the
  // projection for the share of the game still to play (the bench just by that).
  const live = p => (p.status === 'Red zone' ? 2 : p.status === 'On field' ? 1 : 0);
  const clock = /(\d+):(\d+)/.exec(g.clock || ''), secs = clock ? +clock[1] * 60 + +clock[2] : 900;
  const left = g.state === 'pre' ? 1 : g.state !== 'in' ? 0 : Math.max(0, Math.min(1, ((4 - Math.min(g.period, 4)) * 900 + secs) / 3600));
  for (const p of players) p.liveProj = Math.round((p.pts + p.proj * left) * 10) / 10;
  players.sort((a, b) => a.opp - b.opp || a.bench - b.bench || a.out - b.out
    || (a.bench ? 0 : live(b) - live(a)) || b.liveProj - a.liveProj);

  // Favourite teams count like a heart on every game they play; blackout teams' games are never tuned.
  const teams = [g.home.abbr, g.away.abbr];
  const favTeam = teams.some(t => (prefs.favTeams || []).includes(t)), blackout = teams.some(t => (prefs.blackout || []).includes(t));
  const fav = !!prefs.hearts[g.id] || favTeam, skip = !!prefs.skips[g.id] || blackout;
  let value = 0, onBreak = false, breakWhy = '';
  if (g.state === 'in') {
    const chance = g.sit ? scoreChance(g.sit.ytg) : 0.18;
    const downBoost = g.sit && g.sit.down && g.sit.down <= 2 ? 1.1 : g.sit && g.sit.down === 4 ? 0.8 : 1;
    for (const p of players) {
      if (p.out || p.bench) continue;   // bench players score you nothing: they never pull the TV anywhere
      const w = p.starts * (POS_WEIGHT[p.pos] || 0.5) * (p.opp ? oppWeight : 1);
      if (p.status === 'Red zone' || p.status === 'On field') {
        const kick = p.pos === 'K' ? (g.sit.ytg != null && g.sit.ytg < 40 ? 1.6 : 0.5) : 1;
        value += w * chance * downBoost * kick;
      } else {
        value += w * 0.06; // they'll get the ball back
      }
    }
    if (g.statusName === 'STATUS_HALFTIME' || g.statusName === 'STATUS_END_PERIOD') { onBreak = true; breakWhy = g.statusName === 'STATUS_HALFTIME' ? 'Halftime' : 'End of quarter'; }
    else if (g.sit && g.sit.lastPlay && (BREAK_TYPE.test(g.sit.lastPlay.type) || BREAK_TEXT.test(g.sit.lastPlay.text))) {
      onBreak = true; breakWhy = g.sit.lastPlay.type || 'Break';
    } else if (!g.sit) { onBreak = true; breakWhy = 'Between plays'; }
    if (onBreak) value *= 0.25;
    if (fav) value *= 1.35;
    if (skip) value = 0;
  }
  const margin = Math.abs(g.home.score - g.away.score);
  const excite = g.state !== 'in' ? 0 : (g.period >= 4 ? 0.4 : g.period === 3 ? 0.15 : 0) + (margin <= 8 ? 0.3 : margin <= 16 ? 0.1 : 0)
    + (g.sit && g.sit.redZone ? 0.3 : 0) + (g.period >= 5 ? 0.5 : 0);
  return { ...g, players: players.filter(p => !p.hidden), value, onBreak, breakWhy, excite, fav, skip, favTeam, blackout };
}

/** Rank all games: live ones by value (ties to the more exciting game), then upcoming, then finished. */
export function rankAll(games, roster, pts, prefs) {
  const ranked = games.map(g => rankGame(g, roster, pts, prefs)).filter(g => g.players.some(p => !p.opp) || g.state === 'in');
  const max = Math.max(0.0001, ...ranked.map(g => g.value));
  for (const g of ranked) g.signal = g.state !== 'in' || g.value <= 0 ? 0 : Math.max(1, Math.round(5 * g.value / max));
  const order = { in: 0, pre: 1, post: 2 };
  ranked.sort((a, b) => order[a.state] - order[b.state] || better(b, a) || new Date(a.start) - new Date(b.start));
  return ranked;
}

/** >0 when a should beat b. Within 10% it's a tie, and the more exciting game wins. */
function better(a, b) {
  const hi = Math.max(a.value, b.value);
  if (hi > 0 && Math.abs(a.value - b.value) / hi > 0.1) return a.value - b.value;
  return a.excite - b.excite || a.value - b.value;
}

/**
 * The switching rules. State lives here; call tick() every couple of seconds with fresh rankings. It returns
 * {pending} while counting down and {switchTo} when the countdown finishes.
 */
export class AutoTune {
  constructor(opts) {
    this.opts = Object.assign({ cooldown: 75, countdown: 5, margin: 1.3, holdAfterPick: 45 }, opts);
    this.current = null;      // game id on screen
    this.paused = false;
    this.pending = null;      // {to, endsAt, why}
    this.lastSwitch = 0;
    this.holdUntil = 0;       // after you pick a game yourself
    this.snoozed = {};        // game id -> until (you cancelled a switch to it)
    this.locked = null;       // game id you locked: AutoTune stays on it until it ends or you unlock
    this.log = [];
  }

  pick(id, now = Date.now()) {
    this.pending = null;
    this.holdUntil = now + this.opts.holdAfterPick * 1000;
    const r = this.go(id, 'You picked it', now);
    // AutoTune is fully back when the hold ends: the usual cooldown after a switch ends then too.
    this.lastSwitch = now - Math.max(0, this.opts.cooldown - this.opts.holdAfterPick) * 1000;
    return r;
  }

  cancel(now = Date.now()) {
    if (!this.pending) return;
    this.snoozed[this.pending.to] = now + 90e3;
    this.note(`Stayed put`, now);
    this.pending = null;
    this.lastSwitch = now; // and restart the cooldown, so it doesn't ask again straight away
  }

  setPaused(on) { this.paused = on; this.pending = null; }

  /**
   * Look-ahead: ESPN already reported a big play by your player in another game, and it hasn't reached your stream
   * yet. Switch there now, with a short countdown and without waiting for the current play, then stay long enough to
   * watch it air.
   */
  lookahead(id, why, now = Date.now()) {
    if (this.paused || this.locked || id === this.current || (this.pending && this.pending.to === id)) return {};
    this.pending = { to: id, endsAt: now + 3000, total: 3, why, big: true };
    return { pending: this.pending };
  }

  /** Lock a game: watch it now and stay on it. Locking it again unlocks. */
  lock(id, now = Date.now()) {
    if (this.locked === id) { this.locked = null; this.note('Unlocked', now); return {}; }
    this.locked = id;
    this.pending = null;
    return this.current === id ? (this.note('Locked here', now), {}) : this.go(id, 'Locked', now);
  }

  go(id, why, now) {
    this.current = id;
    this.lastSwitch = now;
    this.note(why, now, id);
    return { switchTo: id, why };
  }

  /** The switch history ("You're watching"): when, which game, and why. */
  note(text, now, game = null) {
    this.log.unshift({ at: now, text, game, label: this.label ? this.label(game) : '' });
    this.log.length = Math.min(this.log.length, 30);
  }

  tick(ranked, now = Date.now()) {
    const live = ranked.filter(g => g.state === 'in');
    if (this.locked) {
      if (live.some(g => g.id === this.locked)) {
        this.pending = null;
        return this.current === this.locked ? {} : this.go(this.locked, 'Locked', now);
      }
      this.locked = null; // the locked game ended
    }
    if (this.pending) {
      const target = live.find(g => g.id === this.pending.to);
      if (!target || this.paused) { this.pending = null; return {}; }
      if (now >= this.pending.endsAt) {
        // The countdown is the only wait (cancel it to stay): waiting for "the play to end" went by ESPN's timing,
        // which never quite matches the picture.
        const { why, big } = this.pending;
        this.pending = null;
        if (big) this.holdUntil = now + 45e3;   // stay for the play to air
        return this.go(target.id, why, now);
      }
      return { pending: this.pending };
    }
    if (this.paused) return {};
    if (!live.length) {
      // Nothing live yet, but a game kicks off within 15 minutes (or is late starting): its channel, for the pregame.
      // Yours first, then the soonest. AutoTune carries on from there once ESPN calls it live.
      if (this.current && ranked.some(g => g.id === this.current && g.state === 'pre')) return {};
      const soon = ranked.filter(g => g.state === 'pre' && g.hasChannel !== false && new Date(g.start) - now < 15 * 60e3)
        .sort((a, b) => b.players.some(p => !p.opp) - a.players.some(p => !p.opp) || new Date(a.start) - new Date(b.start))[0];
      return soon ? this.go(soon.id, 'Kickoff soon', now) : {};
    }
    // The game already on the right in split screen isn't a reason to switch: you're watching it.
    const ok = g => !(this.snoozed[g.id] > now) && g.id !== this.splitGame && g.hasChannel !== false;
    let best = live.find(g => g.value > 0 && ok(g));
    const cur = live.find(g => g.id === this.current);
    if (!cur) {
      // Nothing on screen (just opened, or your game ended): straight into a game whenever one is live. Yours if one
      // counts right now, else the most exciting one on your channels.
      const any = best || live.filter(ok).sort((a, b) => b.excite - a.excite)[0];
      return any ? this.go(any.id, this.current ? 'Your game ended' : 'Top game', now) : {};
    }
    // A game you picked is held for a while, but not through an ad seen on the picture.
    if (now < this.holdUntil && this.adOn !== cur.id) return {};
    // Leaving for a break: not within 20 s of the last switch, so one break can't bounce you around. An ad seen on the
    // picture itself (adOn, set by the TV page) goes after 8 s.
    const seenAd = this.adOn === cur.id;
    // A break ESPN reported (end of quarter, timeout) waits 15 s into it: ESPN calls it the instant it happens, and the
    // last play and its replay are still on your screen. An ad seen on the picture goes at once.
    const breakOk = cur.onBreak && (seenAd ? now - this.lastSwitch >= 8e3
      : now - this.lastSwitch >= 20e3 && (cur.breakFor == null || cur.breakFor >= 15));
    // Never sit on an ad while football is on somewhere: when none of your games is playing, any live game that is
    // (yours first, then the most exciting), until one of yours comes back.
    let filler = false;
    if (breakOk && (!best || best.onBreak || best.id === cur.id)) {
      const playing = live.filter(g => g.id !== cur.id && !g.onBreak && ok(g)).sort((a, b) => b.value - a.value || b.excite - a.excite);
      if (playing.length) { best = playing[0]; filler = best.value <= 0; }
    }
    if (!best || best.id === cur.id) return {};
    const cooled = now - this.lastSwitch >= this.opts.cooldown * 1000;
    let why = null;
    if (breakOk && !best.onBreak) why = filler ? `${best.away.abbr} at ${best.home.abbr} is playing (${cur.away.abbr}-${cur.home.abbr}: ${cur.breakWhy.toLowerCase()})`
      : `${whyBetter(best)} (${cur.away.abbr}-${cur.home.abbr}: ${cur.breakWhy.toLowerCase()})`;
    // On a fill-in game (none of yours): back to yours as soon as it's playing again, no cooldown.
    else if (cur.value <= 0 && best.value > 0 && !best.onBreak && now - this.lastSwitch >= 20e3) why = whyBetter(best);
    else if (cooled && best.value > cur.value * this.opts.margin + 0.05) why = whyBetter(best);
    if (!why) return {};
    this.pending = { to: best.id, endsAt: now + this.opts.countdown * 1000, why };
    return { pending: this.pending };
  }
}


/** Why this game, like a broadcaster would say it: "M. Nabers, 3rd & 4 at the NYJ 14". */
function whyBetter(g) {
  const lead = g.players.find(p => !p.opp && !p.bench && (p.status === 'Red zone' || p.status === 'On field'));
  const where = g.sit && g.sit.downDist ? `${g.sit.downDist}${g.sit.spot ? ` at the ${g.sit.spot}` : ''}` : '';
  if (lead && where) return `${lead.short}, ${where}`;
  if (lead) return `${g.sit && g.sit.poss ? g.sit.poss + ' driving' : 'Driving'} · your ${lead.pos} ${lead.short}`;
  return `${g.away.abbr} at ${g.home.abbr}, bigger drive`;
}
