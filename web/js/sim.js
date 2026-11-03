// Practice Sunday: a fast simulation of live games involving your real players, for testing AutoTune when nothing is
// on. Produces the same game and points shapes as data.js, so everything downstream runs unchanged.

const R = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

const COLORS = {
  ARI: ['97233f', '000000'], ATL: ['a71930', '000000'], BAL: ['241773', '9e7c0c'], BUF: ['00338d', 'c60c30'],
  CAR: ['0085ca', '101820'], CHI: ['0b162a', 'c83803'], CIN: ['fb4f14', '000000'], CLE: ['311d00', 'ff3c00'],
  DAL: ['003594', '869397'], DEN: ['fb4f14', '002244'], DET: ['0076b6', 'b0b7bc'], GB: ['203731', 'ffb612'],
  HOU: ['03202f', 'a71930'], IND: ['002c5f', 'a2aaad'], JAX: ['006778', 'd7a22a'], KC: ['e31837', 'ffb81c'],
  LV: ['000000', 'a5acaf'], LAC: ['0080c6', 'ffc20e'], LAR: ['003594', 'ffa300'], MIA: ['008e97', 'fc4c02'],
  MIN: ['4f2683', 'ffc62f'], NE: ['002244', 'c60c30'], NO: ['d3bc8d', '101820'], NYG: ['0b2265', 'a71930'],
  NYJ: ['125740', 'ffffff'], PHI: ['004c54', 'a5acaf'], PIT: ['ffb612', '101820'], SF: ['aa0000', 'b3995d'],
  SEA: ['002244', '69be28'], TB: ['d50a0a', 'ff7900'], TEN: ['0c2340', '4b92db'], WAS: ['5a1414', 'ffb612'],
};
const ESPN_LOGO = { WAS: 'wsh' };

function team(abbr) {
  const [c, a] = COLORS[abbr] || ['334155', '94a3b8'];
  const id = (ESPN_LOGO[abbr] || abbr).toLowerCase();
  return { id: abbr, abbr, espnAbbr: abbr, name: abbr, full: abbr, color: '#' + c, alt: '#' + a,
    logo: `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${id}.png`, darkLogo: `https://a.espncdn.com/i/teamlogos/nfl/500-dark/${id}.png`,
    record: `${Math.floor(R(1, 9))}-${Math.floor(R(1, 9))}`, score: 0 };   // like a real game: dark-background logo, a season record
}

export class Sim {
  /** roster: {players} from loadRosters. Builds up to 8 games so most of your players are playing. */
  constructor(roster, schedule) {
    this.roster = roster;
    this.stats = {};
    this.proj = {};
    const mineTeams = [...new Set(Object.values(roster).map(p => p.team))];
    const pairs = [];
    const used = new Set();
    // Use this week's real matchups where they include your teams, then make up the rest.
    for (const g of schedule || []) {
      if ((mineTeams.includes(g.home.abbr) || mineTeams.includes(g.away.abbr)) && !used.has(g.home.abbr) && !used.has(g.away.abbr)) {
        pairs.push([g.away.abbr, g.home.abbr]); used.add(g.home.abbr); used.add(g.away.abbr);
      }
    }
    const rest = Object.keys(COLORS).filter(t => !used.has(t));
    for (const t of mineTeams) {
      if (used.has(t) || pairs.length >= 8) continue;
      const opp = rest.find(o => o !== t && !used.has(o) && !mineTeams.includes(o)) || rest.find(o => o !== t && !used.has(o));
      if (!opp) break;
      pairs.push([t, opp]); used.add(t); used.add(opp);
    }
    this.games = pairs.slice(0, 8).map(([a, h], i) => this.newGame(i, a, h));
    for (const p of Object.values(roster)) this.proj[p.id] = projFor(p.pos);
  }

  newGame(i, a, h) {
    const away = team(a), home = team(h);
    const period = 1 + (i % 3);
    const g = { id: 'sim' + i, away, home, start: new Date().toISOString(), state: 'in', statusName: 'STATUS_IN_PROGRESS',
      period, clockSec: Math.round(R(120, 880)), detail: '', network: pick(['CBS', 'FOX', 'NFL+']), sit: null,
      _poss: pick([away, home]), _ytg: Math.round(R(25, 80)), _down: 1, _dist: 10, _next: Date.now() + R(1000, 7000), _breakUntil: 0 };
    away.score = 7 * Math.floor(R(0, period + 1)) + (Math.random() < 0.4 ? 3 : 0);
    home.score = 7 * Math.floor(R(0, period + 1)) + (Math.random() < 0.4 ? 3 : 0);
    this.publish(g, { type: 'Rush', text: 'Drive continues' });
    return g;
  }

  /** Advance every game to `now`. */
  step(now = Date.now()) {
    for (const g of this.games) {
      if (g.state !== 'in' || now < g._next) continue;
      if (g._breakUntil && now < g._breakUntil) continue;
      if (g._breakUntil) { g._breakUntil = 0; g.statusName = 'STATUS_IN_PROGRESS'; }
      this.play(g, now);
      g._next = now + R(3500, 9000);
    }
  }

  play(g, now) {
    // After a touchdown play: the extra point, then the kickoff to the other team.
    if (g._tdAt) {
      g._tdAt = 0;
      const k = Object.values(this.roster).find(x => x.team === g._poss.abbr && x.pos === 'K');
      if (k) this.add(k.id, { xpm: 1, xpa: 1 });
      return this.turnover(g, 'Extra Point Good', `${k ? k.short.replace('. ', '.') : g._poss.abbr + ' kicker'} extra point is GOOD`, now, true);
    }
    const off = g._poss, def = off === g.home ? g.away : g.home;
    g.clockSec -= Math.round(R(18, 42));
    if (g.clockSec <= 0) return this.endQuarter(g, now);

    // 4th down: kick or punt.
    if (g._down === 4 && g._dist > 1) {
      if (g._ytg <= 35) {
        const good = Math.random() < 0.85;
        if (good) { off.score += 3; this.credit(off.abbr, 'K', { fgm: 1, fga: 1 }); }
        else this.credit(off.abbr, 'K', { fga: 1 });
        const k = Object.values(this.roster).find(x => x.team === off.abbr && x.pos === 'K');
        const kick = `${k ? k.short.replace('. ', '.') : off.abbr + ' kicker'} ${g._ytg + 17} yard field goal is ${good ? 'GOOD' : 'No Good'}`;
        return this.turnover(g, good ? 'Field Goal Good' : 'Field Goal Missed', kick, now, good);
      }
      return this.turnover(g, 'Punt', `${off.abbr} punts`, now, false, 100 - Math.max(5, g._ytg - 42));
    }

    const pass = Math.random() < 0.58;
    let gain = pass ? (Math.random() < 0.36 ? 0 : Math.round(R(3, 18))) : Math.round(R(-2, 9));
    if (Math.random() < 0.05) gain = Math.round(R(25, 60));
    if (Math.random() < 0.02) return this.turnover(g, 'Interception', `${off.abbr} pass intercepted`, now, false, 100 - g._ytg, true);
    gain = Math.min(gain, g._ytg);
    g._ytg -= gain;
    const who = this.creditPlay(off.abbr, pass, gain, g._ytg <= 0);
    // Written the way ESPN writes plays ("J.Allen pass short right to D.Kincaid to BAL 6 for 8 yards"), so the
    // points popups and the big-play look-ahead can be tried in practice.
    const espn = s => s ? s.replace('. ', '.') : null;
    const qb = espn(this.lastQb), name = espn(who) || `${off.abbr} ${pass ? 'receiver' : 'back'}`;
    const text = (pass
      ? (gain ? `(Shotgun) ${qb || off.abbr + ' QB'} pass short right to ${name} to ${def.abbr} ${Math.max(1, g._ytg)} for ${gain} yards` : `${qb || off.abbr + ' QB'} pass incomplete short left to ${name}`)
      : `${name} up the middle to ${def.abbr} ${Math.max(1, g._ytg)} for ${gain} yards`)
      + (who && Math.random() < 0.01 ? `. ${name} was injured during the play` : '');   // now and then, for the injury alerts
    if (g._ytg <= 0) {
      off.score += 7;
      this.publish(g, { type: pass ? 'Passing Touchdown' : 'Rushing Touchdown', text: `${text}, TOUCHDOWN.` });
      g._tdAt = now;
      return;
    }
    if (gain >= g._dist) { g._down = 1; g._dist = Math.min(10, g._ytg); }
    else { g._down++; g._dist -= gain; }
    if (g._down > 4) return this.turnover(g, 'Turnover on Downs', `${off.abbr} turnover on downs`, now, false, 100 - g._ytg);
    const timeout = Math.random() < 0.04;
    if (timeout) { g._breakUntil = now + R(15000, 30000); const to = this.timeouts(g); to[def.abbr] = Math.max(0, to[def.abbr] - 1); }
    this.publish(g, { type: timeout ? 'Timeout' : pass ? 'Pass Reception' : 'Rush', text: timeout ? `Timeout ${def.abbr}` : text });
  }

  /** Change of possession. After a score the broadcast goes to a break. */
  turnover(g, type, text, now, scored, newYtg = 75, intercepted = false) {
    if (intercepted) this.credit(g._poss.abbr, 'QB', { pass_int: 1 });
    g._poss = g._poss === g.home ? g.away : g.home;
    g._ytg = Math.max(5, Math.min(95, newYtg));
    g._down = 1; g._dist = 10;
    if (scored) g._breakUntil = now + R(20000, 35000);
    this.publish(g, { type, text });
  }

  endQuarter(g, now) {
    if (g.period >= 4) {
      if (g.home.score === g.away.score) g.home.score += 3;
      g.state = 'post'; g.statusName = 'STATUS_FINAL'; g.detail = 'Final'; g.sit = null; g.clock = '0:00';
      return;
    }
    g.period++;
    g.clockSec = 900;
    g.statusName = g.period === 3 ? 'STATUS_HALFTIME' : 'STATUS_END_PERIOD';
    g._breakUntil = now + (g.period === 3 ? 45000 : 20000);
    if (g.period === 3) { g._poss = g._poss === g.home ? g.away : g.home; g._ytg = 75; g._down = 1; g._dist = 10; g._to = null; }   // fresh timeouts for the second half
    this.publish(g, { type: g.period === 3 ? 'End of Half' : 'End Period', text: g.period === 3 ? 'Halftime' : `End of Q${g.period - 1}` });
  }

  /** Timeouts left for each team this half (three each, like the real thing). */
  timeouts(g) {
    return g._to || (g._to = { [g.away.abbr]: 3, [g.home.abbr]: 3 });
  }

  publish(g, lastPlay) {
    const m = Math.max(0, g.clockSec), poss = g._poss;
    g.clock = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    const ord = ['', '1st', '2nd', '3rd', '4th'][g._down];
    const own = g._ytg > 50, yl = own ? 100 - g._ytg : g._ytg;
    const spot = g._ytg === 50 ? '50' : `${own ? poss.abbr : (poss === g.home ? g.away : g.home).abbr} ${yl}`;
    g.detail = `Q${g.period} ${g.clock}`;
    g.sit = { poss: poss.abbr, down: g._down, dist: g._dist, ytg: g._ytg, redZone: g._ytg <= 20,
      downDist: `${ord} & ${g._ytg <= g._dist ? 'Goal' : g._dist}`, spot, lastPlay };
    const to = this.timeouts(g);
    g.sit.awayTO = to[g.away.abbr]; g.sit.homeTO = to[g.home.abbr];
  }

  creditPlay(teamAbbr, pass, gain, td) {
    const mine = Object.values(this.roster).filter(p => p.team === teamAbbr);
    const catcher = pass ? pick(mine.filter(p => ['WR', 'TE', 'RB'].includes(p.pos))) : pick(mine.filter(p => p.pos === 'RB'));
    const qb = mine.find(p => p.pos === 'QB');
    this.lastQb = qb ? qb.short : null;
    if (pass && qb) this.add(qb.id, { pass_att: 1, pass_cmp: gain ? 1 : 0, pass_yd: gain, pass_td: td ? 1 : 0 });
    if (!catcher || Math.random() < 0.45) return null;
    if (pass) this.add(catcher.id, { rec_tgt: 1, rec: gain ? 1 : 0, rec_yd: gain, rec_td: td ? 1 : 0 });
    else this.add(catcher.id, { rush_att: 1, rush_yd: gain, rush_td: td ? 1 : 0 });
    return catcher.short;
  }

  credit(teamAbbr, pos, s) {
    const p = Object.values(this.roster).find(x => x.team === teamAbbr && x.pos === pos);
    if (p) this.add(p.id, s);
  }

  add(id, s) {
    const t = this.stats[id] ||= {};
    for (const [k, v] of Object.entries(s)) t[k] = (t[k] || 0) + v;
    const base = (t.pass_yd || 0) * 0.04 + (t.pass_td || 0) * 4 - (t.pass_int || 0) * 2 + (t.rush_yd || 0) * 0.1
      + (t.rush_td || 0) * 6 + (t.rec_yd || 0) * 0.1 + (t.rec_td || 0) * 6 + (t.fgm || 0) * 3;
    t.pts_std = round(base); t.pts_half_ppr = round(base + (t.rec || 0) * 0.5); t.pts_ppr = round(base + (t.rec || 0));
  }

  points() {
    const out = {};
    for (const id of Object.keys(this.proj)) out[id] = { stats: this.stats[id], proj: this.proj[id] };
    return out;
  }
}

const round = x => Math.round(x * 100) / 100;

function projFor(pos) {
  const base = { QB: 19, RB: 12, WR: 12, TE: 8, K: 8 }[pos] || 6;
  const v = round(base * R(0.7, 1.3));
  return { pts_ppr: v, pts_half_ppr: round(v * 0.92), pts_std: round(v * 0.85) };
}
