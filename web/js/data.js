// Live data: your Sleeper rosters, ESPN's NFL scoreboard (with the down, distance and field position of every live
// game), and Sleeper's live fantasy points and projections. Everything here is public and needs no login.

const SLEEPER = 'https://api.sleeper.app/v1';
const SLEEPER_STATS = 'https://api.sleeper.com';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

// ESPN and Sleeper spell a few teams differently.
const TEAM_FIX = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };
export const teamKey = abbr => TEAM_FIX[abbr] || abbr;

async function json(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/**
 * Your players across every league you're in this season: { [playerId]: {id, name, short, pos, team, leagues:[{league,
 * team, starter, rec}]} }. The player list (5 MB) is cached for a day.
 */
/** Just the user's teams this season ({league, team}), quickly, for the phone to confirm a username. */
export async function findSleeperTeams(username) {
  const user = await json(`${SLEEPER}/user/${encodeURIComponent(username)}`);
  if (!user || !user.user_id) throw new Error(`No Sleeper user named "${username}". Check the spelling.`);
  const st = await json(`${SLEEPER}/state/nfl`);
  const leagues = await json(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${st.league_season}`);
  const users = await Promise.all(leagues.map(lg => json(`${SLEEPER}/league/${lg.league_id}/users`)));
  return leagues.map((lg, i) => {
    const me = users[i].find(u => u.user_id === user.user_id);
    return { league: lg.name, team: (me && me.metadata && me.metadata.team_name) || user.display_name };
  });
}

/** Sleeper leagues (when there's a username) and ESPN leagues (opts.espn); either one alone is fine. */
export async function loadRosters(username, opts = {}) {
  const st = await json(`${SLEEPER}/state/nfl`);
  let user = null, leagues = [];
  if (username) {
    user = await json(`${SLEEPER}/user/${encodeURIComponent(username)}`);
    if (!user || !user.user_id) throw new Error(`No Sleeper user "${username}"`);
    leagues = await json(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${st.league_season}`);
  }
  const players = await playerList();
  const off = opts.skipLeagues || [];
  const mine = {}, opp = {}, teams = [];
  const following = () => teams.filter(t => !t.off && !t.byHand).length;   // MAX_LEAGUES at once: more is too much to follow
  const add = (into, id, entry) => {
    const p = players[id];
    if (!p || !p.team || p.position === 'DEF') return;
    const e = into[id] || (into[id] = {
      id, espn: p.espn_id, name: p.full_name || `${p.first_name} ${p.last_name}`, pos: p.position, team: p.team,
      short: `${(p.first_name || '?')[0]}. ${p.last_name}`, leagues: [] });
    e.leagues.push(entry);
  };
  for (const lg of leagues) {
    const [rosters, users] = await Promise.all([
      json(`${SLEEPER}/league/${lg.league_id}/rosters`), json(`${SLEEPER}/league/${lg.league_id}/users`)]);
    const r = rosters.find(x => x.owner_id === user.user_id);
    if (!r) continue;
    const me = users.find(u => u.user_id === user.user_id);
    const teamName = (me && me.metadata && me.metadata.team_name) || user.display_name;
    const rec = (lg.scoring_settings && lg.scoring_settings.rec) ?? 1;
    const scoring = lg.scoring_settings || null;   // the league's own points per stat, used for every player's points
    const full = following() >= MAX_LEAGUES, counted = !off.includes(lg.name) && !full;
    teams.push({ league: lg.name, team: teamName, rec, scoring, off: !counted, ...(full && !off.includes(lg.name) ? { error: `Over the ${MAX_LEAGUES}-league limit` } : {}) });
    if (!counted) continue;
    // The roster's own `starters` can already be next week's lineup; this week's is in the week's matchups, which
    // also say who you're playing (same matchup_id): their starters are your opponent's players.
    let matchups = [];
    try { matchups = await json(`${SLEEPER}/league/${lg.league_id}/matchups/${st.week}`); } catch { /* none yet */ }
    const m = matchups.find(x => x.roster_id === r.roster_id);
    if (m && m.starters && m.starters.length) r.starters = m.starters;
    for (const id of r.players || []) add(mine, id, { league: lg.name, team: teamName, starter: (r.starters || []).includes(id), rec, scoring });
    const vs = m && matchups.find(x => x.matchup_id === m.matchup_id && x.roster_id !== m.roster_id);
    const t = teams[teams.length - 1];
    t.leagueId = lg.league_id; t.rosterId = r.roster_id; t.week = st.week;
    t.starters = (r.starters || []).filter(id => id && id !== '0');
    if (vs) {
      const ro = rosters.find(x => x.roster_id === vs.roster_id), ou = ro && users.find(u => u.user_id === ro.owner_id);
      const oppName = (ou && ou.metadata && ou.metadata.team_name) || (ou && ou.display_name) || 'Opponent';
      t.opp = oppName; t.oppRosterId = vs.roster_id; t.oppStarters = (vs.starters || []).filter(id => id && id !== '0');
      for (const id of vs.starters || []) add(opp, id, { league: lg.name, team: oppName, starter: true, rec, scoring, opponent: true });
    }
  }
  await addEspn(opts.espn, st.league_season, st.week, players, mine, opp, teams);
  await addYahoo(st.week, players, mine, teams);
  addTracked(opts.tracked, players, mine, teams);
  return { user: user ? user.display_name : 'ESPN', teams, players: mine, opponents: opp, season: st.league_season };
}

/**
 * Tracked players ("Add your team by hand", for any other league): Sleeper player ids picked on the phone, counted as
 * starters on a team of their own.
 */
function addTracked(ids, players, mine, teams) {
  ids = (ids || []).filter(id => players[id]);
  if (!ids.length) return;
  teams.push({ league: 'Tracked', team: 'Tracked players', rec: 1, byHand: true });
  for (const id of ids) {
    const p = players[id];
    const e = mine[id] || (mine[id] = { id, espn: p.espn_id, name: p.full_name, pos: p.position, team: p.team, short: `${(p.first_name || '?')[0]}. ${p.last_name}`, leagues: [] });
    e.leagues.push({ league: 'Tracked', team: 'Tracked players', starter: true, rec: 1, byHand: true });
  }
}

/** Player search for the phone's "Tracked players": name or team ("Jefferson", "MIN"), best matches first. */
export async function searchPlayers(q, limit = 12) {
  const players = await playerList();
  const s = norm(q), up = String(q || '').trim().toUpperCase();
  if (!s) return [];
  const out = [];
  for (const [id, p] of Object.entries(players)) {
    const n = norm(p.full_name);
    const score = p.team === teamKey(up) ? 2 : n.startsWith(s) ? 3 : n.split(' ').some(w => w.startsWith(s)) ? 2.5 : n.includes(s) ? 1 : 0;
    if (score) out.push({ id, name: p.full_name, pos: p.position, team: p.team, score });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Names for tracked ids, for the phone's list. */
export async function playerNames(ids) {
  const players = await playerList();
  return (ids || []).map(id => players[id] ? { id, name: players[id].full_name, pos: players[id].position, team: players[id].team } : null).filter(Boolean);
}

const norm = s => String(s || '').toLowerCase().replace(/[.'’-]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/, '').replace(/\s+/g, ' ').trim();

/**
 * Your Yahoo teams (read by the TV app, which holds the Yahoo sign-in: /api/yahoo/roster), added to the Sleeper ones.
 * Yahoo players are matched to Sleeper's by name and team, so their live points and projections come through.
 * Nothing happens when Yahoo isn't connected, or in the PC test version.
 */
async function addYahoo(week, players, mine, teams) {
  let yahoo;
  try {
    const r = await fetch(`/api/yahoo/roster?week=${week}`, { cache: 'no-store' });
    if (!r.ok) return;
    yahoo = await r.json();
  } catch { return; }
  if (!Array.isArray(yahoo) || !yahoo.length) return;
  const byNameTeam = new Map(), byName = new Map();
  for (const [id, p] of Object.entries(players)) {
    const n = norm(p.full_name);
    byNameTeam.set(`${n}|${p.team}`, id);
    byName.set(n, byName.has(n) ? null : id);   // null: two players share the name
  }
  for (const t of yahoo) {
    if (teams.filter(x => !x.off && !x.byHand).length >= MAX_LEAGUES) {
      teams.push({ league: t.league, team: t.team, yahoo: true, off: true, error: `Over the ${MAX_LEAGUES}-league limit` });
      continue;
    }
    teams.push({ league: t.league, team: t.team, rec: t.rec, yahoo: true });
    for (const yp of t.players || []) {
      const team = teamKey(yp.team), n = norm(yp.name);
      const id = byNameTeam.get(`${n}|${team}`) || byName.get(n) || `y:${n}|${team}`;
      const p = players[id];
      const e = mine[id] || (mine[id] = {
        id, name: p ? p.full_name : yp.name, pos: p ? p.position : yp.pos, team: p ? p.team : team,
        short: p ? `${(p.first_name || '?')[0]}. ${p.last_name}` : yp.name.replace(/^(\S)\S*\s/, '$1. '), leagues: [] });
      e.leagues.push({ league: t.league, team: t.team, starter: !!yp.starter, rec: t.rec });
    }
  }
}

// ---- ESPN fantasy leagues. Public leagues are open to anyone with the league ID; private ones need the espn_s2 and
// SWID cookies from the owner's ESPN login, which the TV app's /proxy sends (only to espn.com). Settings:
// espnLeagues: [{id, teamId, s2?, swid?, name?}].
const ESPN_FF = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const PRO_TEAM = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC',
  13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF',
  26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU' };
const PRO_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K' };
export const MAX_LEAGUES = 4;   // leagues followed at once (Sleeper and ESPN together)
const BENCH = new Set([20, 21]);   // lineup slots that aren't starting: bench, injured reserve

/** One ESPN league this week: its settings, teams (with rosters) and this week's matchups, through the TV's proxy. */
async function espnLeague(cfg, season, week) {
  const url = `${ESPN_FF}/seasons/${season}/segments/0/leagues/${encodeURIComponent(cfg.id)}?scoringPeriodId=${week}`
    + '&view=mSettings&view=mTeam&view=mRoster&view=mMatchupScore&view=mScoreboard';
  const cookie = cfg.s2 && cfg.swid ? `&cookie=${encodeURIComponent(`espn_s2=${cfg.s2}; SWID=${cfg.swid}`)}` : '';
  const r = await fetch(`/proxy?url=${encodeURIComponent(url)}${cookie}`, { cache: 'no-store' });
  if (r.status === 401 || r.status === 403) throw new Error('This ESPN league is private: add the espn_s2 and SWID cookies.');
  if (r.status === 404) throw new Error(`No ESPN league ${cfg.id} this season. Check the league ID.`);
  if (!r.ok) throw new Error(`ESPN answered ${r.status}`);
  return r.json();
}
const espnTeamName = t => t.name || [t.location, t.nickname].filter(Boolean).join(' ') || t.abbrev || `Team ${t.id}`;

/** For the phone: an ESPN league's name and teams, to pick yours ({league, teams: [{id, name, mine}]}). */
export async function findEspnTeams(cfg) {
  const st = await json(`${SLEEPER}/state/nfl`);
  const lg = await espnLeague(cfg, st.league_season, st.week);
  const swid = String(cfg.swid || '').toUpperCase();
  return { league: (lg.settings && lg.settings.name) || `ESPN ${cfg.id}`,
    teams: (lg.teams || []).map(t => ({ id: t.id, name: espnTeamName(t), mine: !!swid && (t.owners || []).some(o => String(o).toUpperCase() === swid) })) };
}

/** This week's matchup for your team: {me, them} (each ESPN's home/away side), or nulls on a bye. */
function espnMatchup(lg, teamId) {
  const period = (lg.status && lg.status.currentMatchupPeriod) || lg.scoringPeriodId;
  const m = (lg.schedule || []).find(s => s.matchupPeriodId === period && ((s.home && s.home.teamId === teamId) || (s.away && s.away.teamId === teamId)));
  if (!m) return { me: null, them: null };
  return m.home && m.home.teamId === teamId ? { me: m.home, them: m.away } : { me: m.away, them: m.home };
}
/** A side's starters this week: [{espnId, name, pos, team, pts}]. */
function espnStarters(side, team) {
  const entries = (side && side.rosterForCurrentScoringPeriod && side.rosterForCurrentScoringPeriod.entries)
    || (team && team.roster && team.roster.entries) || [];
  return entries.filter(e => !BENCH.has(e.lineupSlotId)).map(e => {
    const p = (e.playerPoolEntry && e.playerPoolEntry.player) || {};
    return { espnId: String(p.id || e.playerId), name: p.fullName, pos: PRO_POS[p.defaultPositionId], team: PRO_TEAM[p.proTeamId],
      pts: (e.playerPoolEntry && e.playerPoolEntry.appliedStatTotal) || 0 };
  }).filter(p => p.pos && p.team);   // team defenses aren't followed (as with Sleeper)
}
/** ESPN players matched to Sleeper's ids (ESPN's id, then name and team), so live stats and projections come through. */
function espnMatcher(players) {
  const byEspn = new Map(), byNameTeam = new Map();
  for (const [id, p] of Object.entries(players)) {
    if (p.espn_id) byEspn.set(String(p.espn_id), id);
    byNameTeam.set(`${norm(p.full_name)}|${p.team}`, id);
  }
  return p => byEspn.get(p.espnId) || byNameTeam.get(`${norm(p.name)}|${p.team}`) || `e:${p.espnId}`;
}

/** Adds your ESPN teams (and this week's opponents) to the Sleeper ones, the same shape loadRosters returns. */
async function addEspn(leagues, season, week, players, mine, opp, teams) {
  const idOf = espnMatcher(players);
  const add = (into, p, entry) => {
    const id = idOf(p), s = players[id];
    const e = into[id] || (into[id] = { id, espn: p.espnId, name: s ? s.full_name : p.name, pos: p.pos, team: p.team,
      short: (s ? `${(s.first_name || '?')[0]}. ${s.last_name}` : String(p.name || '').replace(/^(\S)\S*\s/, '$1. ')), leagues: [] });
    e.leagues.push(entry);
    return id;
  };
  for (const cfg of leagues || []) {
    if (!cfg.id || cfg.teamId == null) continue;
    if (teams.filter(t => !t.off && !t.byHand).length >= MAX_LEAGUES) { teams.push({ league: cfg.name || `ESPN ${cfg.id}`, team: cfg.team || '', espn: cfg, error: `Over the ${MAX_LEAGUES}-league limit`, off: true }); continue; }
    let lg;
    try { lg = await espnLeague(cfg, season, week); } catch (e) { teams.push({ league: cfg.name || `ESPN ${cfg.id}`, team: '', espn: cfg, error: e.message, off: true }); continue; }
    const lgName = (lg.settings && lg.settings.name) || cfg.name || `ESPN ${cfg.id}`;
    const team = (lg.teams || []).find(t => t.id === +cfg.teamId);
    if (!team) { teams.push({ league: lgName, team: '', espn: cfg, error: 'Your team is no longer in this league', off: true }); continue; }
    // Two of your teams in one league: the league name alone would mix them up, so the second goes by its team name.
    const name = teams.some(x => x.league === lgName) ? espnTeamName(team) : lgName;
    const items = (lg.settings && lg.settings.scoringSettings && lg.settings.scoringSettings.scoringItems) || [];
    const rec = ((items.find(i => i.statId === 53) || {}).points) ?? 1;   // points per catch
    const teamName = espnTeamName(team);
    const { me, them } = espnMatchup(lg, team.id);
    const oppTeam = them && (lg.teams || []).find(t => t.id === them.teamId);
    const starters = espnStarters(me, team), oppStarters = them ? espnStarters(them, oppTeam) : [];
    const t = { league: name, team: teamName, rec, scoring: null, espn: cfg, week, opp: oppTeam ? espnTeamName(oppTeam) : 'Bye' };
    teams.push(t);
    const startIds = new Set(starters.map(p => p.espnId));
    for (const e of (team.roster && team.roster.entries) || []) {
      const p = espnStarters({ rosterForCurrentScoringPeriod: { entries: [{ ...e, lineupSlotId: 0 }] } })[0];
      if (p) add(mine, p, { league: name, team: teamName, starter: startIds.has(p.espnId), rec });
    }
    t.starters = starters.map(idOf);
    t.oppStarters = oppStarters.map(p => add(opp, p, { league: name, team: t.opp, starter: true, rec, opponent: true }));
  }
}

/**
 * Headshots: ESPN's cut-out photos need ESPN's player id, which Sleeper only has for some players. The rest are found
 * by name on ESPN's team rosters (once a day, kept on the TV). Fills p.espn in place.
 */
export async function espnPhotos(players) {
  const KEY = 'ftv.espnIds', norm = s => String(s || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b|[^a-z]/g, '');
  let known = {};
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && Date.now() - c.at < 24 * 3600e3) known = c.ids; } catch { /* fresh */ }
  const missing = Object.values(players).filter(p => !p.espn && p.team);
  for (const p of missing) if (known[p.id]) p.espn = known[p.id];
  const teams = [...new Set(missing.filter(p => !p.espn).map(p => p.team))];
  for (const team of teams) {
    try {
      const r = await json(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team === 'WAS' ? 'wsh' : team.toLowerCase()}/roster`);
      const byName = {};
      for (const group of r.athletes || []) for (const a of group.items || []) byName[norm(a.fullName || a.displayName)] = a.id;
      for (const p of missing) if (p.team === team && !p.espn && byName[norm(p.name)]) p.espn = known[p.id] = byName[norm(p.name)];
    } catch { /* that team's roster didn't load: no photo for now */ }
  }
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), ids: known })); } catch { /* fine */ }
}

async function playerList() {
  const KEY = 'ftv.players2', AGE = 24 * 3600e3;
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && Date.now() - c.at < AGE) return c.players;
  } catch { /* storage blocked or full: fetch below */ }
  const all = await json(`${SLEEPER}/players/nfl`);
  const slim = {};
  for (const [id, p] of Object.entries(all))
    if (p.team && ['QB', 'RB', 'WR', 'TE', 'K'].includes(p.position))
      slim[id] = { full_name: p.full_name, first_name: p.first_name, last_name: p.last_name, position: p.position, team: p.team, espn_id: p.espn_id };   // espn_id: headshots
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), players: slim })); } catch { /* fine */ }
  return slim;
}

/** ESPN's scoreboard, normalized: every game this week with teams, score, clock and (live games) the situation. */
/** A game's whole play-by-play so far, oldest first: the play texts ("NYG-J.McCarthy was injured during the play."). */
export async function loadPlays(gameId) {
  const j = await json(`${ESPN}/summary?event=${encodeURIComponent(gameId)}`);
  const d = j.drives || {};
  const drives = [...(d.previous || []), ...(d.current && !(d.previous || []).some(x => x.id === d.current.id) ? [d.current] : [])];
  return drives.flatMap(x => (x.plays || []).map(p => p.text || '')).filter(Boolean);
}

export async function loadScoreboard() {
  const j = await json(`${ESPN}/scoreboard`);
  return { week: j.week && j.week.number, season: j.season && j.season.year, games: (j.events || []).map(normalize) };
}

function side(c) {
  const t = c.team;
  return { id: t.id, abbr: teamKey(t.abbreviation), espnAbbr: t.abbreviation, name: t.shortDisplayName, full: t.displayName, city: t.location,
    color: '#' + (t.color || '334155'), alt: '#' + (t.alternateColor || '94a3b8'), logo: t.logo, darkLogo: `https://a.espncdn.com/i/teamlogos/nfl/500-dark/${String(t.abbreviation).toLowerCase()}.png`, score: +c.score || 0,
    record: ((c.records || []).find(r => r.type === 'total') || (c.records || [])[0] || {}).summary || '' };   // season record, "5-3"
}

function normalize(ev) {
  const c = ev.competitions[0];
  const home = side(c.competitors.find(x => x.homeAway === 'home'));
  const away = side(c.competitors.find(x => x.homeAway === 'away'));
  const st = ev.status.type;
  const s = c.situation;
  let sit = null;
  if (st.state === 'in' && s) {
    const poss = s.possession === home.id ? home : s.possession === away.id ? away : null;
    // "NYJ 18": on their own side it's 82 yards to go, on the other side 18.
    let ytg = null;
    const m = /([A-Z]{2,3})\s+(\d+)/.exec(s.possessionText || '');
    if (poss && m) ytg = teamKey(m[1]) === poss.abbr ? 100 - +m[2] : +m[2];
    else if (s.yardLine === 50) ytg = 50;
    // ESPN leaves isRedZone on after a score, with nobody in possession (down -1): that's no red zone.
    sit = { poss: poss && poss.abbr, homeTO: s.homeTimeouts, awayTO: s.awayTimeouts, down: s.down, dist: s.distance, ytg, redZone: !!s.isRedZone && !!poss && s.down > 0,
      downDist: s.shortDownDistanceText || s.downDistanceText || '', spot: s.possessionText || '',
      lastPlay: s.lastPlay ? { text: s.lastPlay.text || '', type: (s.lastPlay.type && s.lastPlay.type.text) || '' } : null };
  }
  return { id: ev.id, home, away, start: ev.date, state: st.state, statusName: st.name, period: ev.status.period,
    clock: ev.status.displayClock, detail: st.shortDetail, network: (c.broadcasts && c.broadcasts[0] && c.broadcasts[0].names[0]) || '', sit };
}

/** Sleeper's live fantasy points (and the stat line) for this week, plus projections: { [playerId]: {stats, proj} }. */
export async function loadPoints(season, week) {
  const pos = ['QB', 'RB', 'WR', 'TE', 'K'].map(p => `position[]=${p}`).join('&');
  const [stats, proj] = await Promise.all([
    json(`${SLEEPER_STATS}/stats/nfl/${season}/${week}?season_type=regular&${pos}`).catch(() => []),
    json(`${SLEEPER_STATS}/projections/nfl/${season}/${week}?season_type=regular&${pos}`).catch(() => [])]);
  const out = {};
  for (const s of stats) (out[s.player_id] ||= {}).stats = s.stats;
  for (const p of proj) (out[p.player_id] ||= {}).proj = p.stats;
  return out;
}

/**
 * This week's matchup in each Sleeper league, live: [{league, team, opp, me, them, meProj, themProj}]. Points are
 * Sleeper's own (league scoring); projections are the starters' projections added up.
 */
export async function loadMatchups(teams, proj) {
  const out = [];
  for (const t of teams) {
    if (t.espn && !t.off) { try { out.push(await espnMatchupNow(t, proj)); } catch { /* this league next time */ } continue; }
    if (!t.leagueId || t.off) continue;
    try {
      const ms = await json(`${SLEEPER}/league/${t.leagueId}/matchups/${t.week}`);
      const me = ms.find(x => x.roster_id === t.rosterId), them = ms.find(x => x.roster_id === t.oppRosterId);
      const sumProj = ids => (ids || []).reduce((s, id) => s + points((proj[id] || {}).proj, t.scoring || t.rec), 0);
      // Your starters' own points by the league's scoring, as Sleeper totals them: what the popups compare.
      const playerPts = {};
      for (const id of (me && me.starters) || []) if (id && id !== '0') playerPts[id] = (me.players_points || {})[id] || 0;
      out.push({ league: t.league, team: t.team, opp: t.opp || 'Bye', me: me ? me.points || 0 : 0, them: them ? them.points || 0 : 0,
        meProj: sumProj(me && me.starters), themProj: sumProj(them && them.starters), playerPts,
        // Starters on both sides, with each one's projection by this league's scoring: for the live win chance.
        meStarters: starterProj(me, proj, t), themStarters: starterProj(them, proj, t) });
    } catch { /* this league next time */ }
  }
  return out;
}

/** An ESPN league's matchup live, the same shape as Sleeper's: ESPN's own points, Sleeper's projections. */
async function espnMatchupNow(t, proj) {
  const st = await json(`${SLEEPER}/state/nfl`);
  const lg = await espnLeague(t.espn, st.league_season, t.week || st.week);
  const team = (lg.teams || []).find(x => x.id === +t.espn.teamId);
  const { me, them } = espnMatchup(lg, team && team.id);
  const idOf = espnMatcher(await playerList());
  const total = side => side ? (side.totalPointsLive ?? side.totalPoints ?? 0) : 0;
  const mine = espnStarters(me, team), theirs = them ? espnStarters(them, (lg.teams || []).find(x => x.id === them.teamId)) : [];
  const withProj = list => list.map(p => { const id = idOf(p); return { id, proj: points((proj[id] || {}).proj, t.rec) }; });
  const playerPts = {};
  for (const p of mine) playerPts[idOf(p)] = p.pts;
  return { league: t.league, team: t.team, opp: t.opp || 'Bye', me: total(me), them: total(them),
    meProj: withProj(mine).reduce((s, p) => s + p.proj, 0), themProj: withProj(theirs).reduce((s, p) => s + p.proj, 0), playerPts,
    meStarters: withProj(mine), themStarters: withProj(theirs) };
}

function starterProj(side, proj, t) {
  return ((side && side.starters) || []).filter(id => id && id !== '0')
    .map(id => ({ id, proj: points((proj[id] || {}).proj, t.scoring || t.rec) }));
}

/**
 * Live chance of winning a matchup, 0–1. Each side's expected final = points so far + every starter's projection
 * times the share of their game still to play (all of it before kickoff, none after the final). The spread around
 * that grows with what's left (about half a player's remaining projection each), so it sits near 50% early and
 * firms up as games finish. teamOf(id) gives a player's NFL team; leftFor(team) the share of its game left.
 */
export function winChance(m, teamOf, leftFor) {
  let meExp = m.me, themExp = m.them, variance = 0;
  for (const [list, side] of [[m.meStarters, 1], [m.themStarters, -1]]) {
    for (const s of list || []) {
      const left = leftFor(teamOf(s.id));
      const rest = Math.max(0, s.proj) * left;
      if (side > 0) meExp += rest; else themExp += rest;
      // A player's week swings by about ¾ of his projection (a 15-point WR scores 4 or 30 often enough).
      variance += Math.pow(0.75 * Math.max(s.proj, 4), 2) * left;
    }
  }
  if (variance < 0.01) return meExp > themExp ? 1 : meExp < themExp ? 0 : 0.5;
  const z = (meExp - themExp) / Math.sqrt(variance);
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Settled for real, not just likely: 'won' when your lead is beyond what their starters still to play could score even
 * on a huge day (3× their projections for the rest of their games), or they have none left; 'lost' the same the other
 * way; else null. Win chances near 100% early in the day are a forecast, this is the "CLINCHED" badge.
 */
export function settled(m, teamOf, leftFor) {
  const rest = list => (list || []).reduce((s, p) => s + Math.max(0, p.proj) * leftFor(teamOf(p.id)), 0);
  const playing = list => (list || []).some(p => leftFor(teamOf(p.id)) > 0);
  const lead = m.me - m.them;
  if (lead > 0 && (!playing(m.themStarters) || lead > 3 * rest(m.themStarters) + 5)) return 'won';
  if (lead < 0 && (!playing(m.meStarters) || -lead > 3 * rest(m.meStarters) + 5)) return 'lost';
  return null;
}

function erf(x) {   // Abramowitz–Stegun 7.1.26
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

/**
 * Fantasy points by your league's own scoring: every stat times what the league gives for it, the way Sleeper scores
 * your matchup (so a league with no penalty for a missed field goal never shows one). Without the league's settings
 * (Yahoo, tracked players, practice), Sleeper's standard totals by points per catch.
 */
export function points(stats, scoring) {
  if (!stats) return 0;
  if (scoring && typeof scoring === 'object') {
    let total = 0;
    for (const [k, v] of Object.entries(scoring)) if (stats[k]) total += stats[k] * v;
    return Math.round(total * 100) / 100;
  }
  const rec = scoring ?? 1;
  return rec >= 1 ? stats.pts_ppr || 0 : rec >= 0.5 ? stats.pts_half_ppr || 0 : stats.pts_std || 0;
}

/** "18/26 · 212 YD · 2 TD", "6 REC · 81 YD", "14-61 RUSH". */
export function statLine(pos, s) {
  if (!s) return '';
  const n = k => Math.round(s[k] || 0);
  const yd = k => (n(k) < 0 ? `−${-n(k)}` : `${n(k)}`);   // a real minus: "−2", not "-2" run into a dash
  const parts = [];
  if (pos === 'QB' || n('pass_att')) {
    if (n('pass_att')) parts.push(`${n('pass_cmp')}/${n('pass_att')}`, `${yd('pass_yd')} YD`);
    if (n('pass_td')) parts.push(`${n('pass_td')} TD`);
    if (n('pass_int')) parts.push(`${n('pass_int')} INT`);
  }
  // A QB's line is long already: just his rushing yards. Everyone else: carries and yards, like catches ("3 RUSH · 12 YD";
  // "3-12" read "3--2" with lost yards).
  if (n('rush_att')) parts.push(pos === 'QB' ? `${yd('rush_yd')} RUSH YD` : `${n('rush_att')} RUSH · ${yd('rush_yd')} YD`);
  if (n('rec_tgt') || n('rec')) parts.push(`${n('rec')}/${n('rec_tgt')} REC · ${yd('rec_yd')} YD`);
  if (pos !== 'QB' && n('rush_td') + n('rec_td')) parts.push(`${n('rush_td') + n('rec_td')} TD`);
  if (pos === 'K' && (n('fga') || n('xpa'))) parts.push(`FG ${n('fgm')}/${n('fga')}`, `XP ${n('xpm')}/${n('xpa')}`);
  if (n('fum_lost')) parts.push(`${n('fum_lost')} FUM`);   // so a negative score says why
  return parts.join(' · ');
}
