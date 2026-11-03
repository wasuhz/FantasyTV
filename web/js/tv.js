import { loadRosters, espnPhotos, loadScoreboard, loadPoints, loadMatchups, statLine, winChance } from './data.js';
import { rankAll, AutoTune } from './engine.js';
import { Sim } from './sim.js';
import { Iptv, proxied } from './iptv.js';
import { LOGO, esc, bars, pts, HEART, statusLine, link, loadSettings } from './common.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
// On the TV app, ExoPlayer plays the channel under this page (window.Android); in a browser, mpegts.js does.
const native = window.Android || null;
if (native) document.documentElement.classList.add('native');
const settings = loadSettings();
// Settings saved from the phone (/api/config) win over this browser's own.
try { Object.assign(settings, await (await fetch('/api/config', { cache: 'no-store' })).json()); } catch { /* none yet */ }
if (params.has('sim')) settings.mode = 'sim';
if (params.has('live')) settings.mode = 'live';

const prefs = { hearts: {}, skips: {} };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('ftv.prefs') || '{}')); } catch { /* fresh */ }
const savePrefs = () => { try { localStorage.setItem('ftv.prefs', JSON.stringify(prefs)); } catch { /* fine */ } };

const teamList = s => String(s || '').toUpperCase().split(/[\s,]+/).filter(Boolean).map(t => t === 'WSH' ? 'WAS' : t);
const rosterOpts = () => ({ skipLeagues: settings.skipLeagues || [], tracked: settings.tracked || [], espn: settings.espnLeagues || [] });
const hasLeagues = s => !!(s.sleeper || (s.espnLeagues || []).length);   // Sleeper, ESPN or both
/** Settings that shape the ranking, read again on every pass (they can change from the phone). */
function applySettings() {
  prefs.favTeams = teamList(settings.favTeams);
  prefs.blackout = teamList(settings.blackout);
  prefs.oppWeight = +settings.oppWeight || 0;
  prefs.showOpp = settings.showOpp !== false;
  prefs.opponents = roster ? roster.opponents : null;
  prefs.out ||= {};
}

const auto = new AutoTune({ cooldown: +settings.cooldown || 75 });
auto.label = id => { const g = id && game(id); return g ? `${g.away.abbr} at ${g.home.abbr}` : ''; };
let away = false;   // the TV app is in the background (Home pressed): AutoTune stops switching
const iptv = Iptv.fromSettings(settings);
let videoOn = false;
let roster = null, sim = null, ranked = [], pointsNow = {}, week = null;
const snapshots = [];       // live mode: scoreboards as they arrived, so the screen can run `delay` seconds behind
let radarOpen = false, radarFocus = 0, calloutTimer = 0, toastTimer = 0, player = null, tunedChannel = null;

// ---- stage scaling: the TV is drawn at 1920×1080 and scaled to the window
// The TV's WebView settles its viewport after the first layout, so check again now and then.
function fit() {
  const w = document.documentElement.clientWidth || innerWidth, h = document.documentElement.clientHeight || innerHeight;
  const s = Math.min(w / 1920, h / 1080);
  const st = $('#stage');
  st.style.transform = `scale(${s})`;
  st.style.left = `${(w - 1920 * s) / 2}px`;
  st.style.top = `${(h - 1080 * s) / 2}px`;
}
addEventListener('resize', fit);
addEventListener('load', fit);
setInterval(fit, 1000);
fit();
document.querySelectorAll('.mk').forEach(e => e.innerHTML = LOGO);

// ---- data
/**
 * A fresh install: nobody's teams are built in. Show the welcome screen with the pairing code until a Sleeper
 * username arrives from the phone (its settings open on their own), then start.
 */
function setupScreen() {
  $('#splash').classList.add('gone');
  $('#setup').classList.add('on');
  pairCode();
  allowUpdatesStep();
  setInterval(async () => {
    allowUpdatesStep();
    try { const c = await (await fetch('/api/config', { cache: 'no-store' })).json(); if (hasLeagues(c)) location.reload(); } catch { /* keep waiting */ }
  }, 3000);
}

/**
 * The one Android setting FantasyTV needs: "Install unknown apps", so it can update itself. Asked during setup with
 * the TV remote, because Android closes the app the moment it's switched on (better now than mid-update).
 */
function allowUpdatesStep() {
  const el = $('#allowUpd');
  if (!native || !native.canInstall) return;
  el.classList.add('on');
  const ok = native.canInstall();
  el.classList.toggle('done', ok);
  el.innerHTML = ok ? '✓ Updates allowed. FantasyTV keeps itself up to date.'
    : '<b>On the TV remote: press <span class="k">OK</span></b> to let FantasyTV update itself. Turn <b>FantasyTV</b> on, then press Back. (The app closes and reopens here; that\'s normal.)';
}

async function start() {
  if (!hasLeagues(settings) || params.has('setup')) { setupScreen(); return; }   // ?setup shows it for checking
  try {
    roster = await loadRosters(settings.sleeper, rosterOpts());
    espnPhotos({ ...roster.players, ...roster.opponents });   // headshots, in the background
  } catch (e) {
    $('#splashMsg').textContent = `Couldn't load your leagues${settings.sleeper ? ` (Sleeper user "${settings.sleeper}")` : ""}: ${e.message}`;
    return;
  }
  const n = Object.keys(roster.players).length;
  $('#splashMsg').textContent = `${roster.user} · ${roster.teams.map(t => t.team).join(' · ')} · ${n} players`;
  const board = await loadScoreboard().catch(() => ({ games: [] }));
  week = board.week;
  if (settings.mode === 'sim') {
    sim = new Sim(roster.players, board.games);
  } else {
    snapshots.push({ t: Date.now(), games: board.games });
    pollLoop();
    refreshPoints();
    setInterval(refreshPoints, 15000);
    setInterval(refreshRosters, 10 * 60000);
    setTimeout(refreshMatchups, 2500);
    setInterval(refreshMatchups, 15000);
    setTimeout(refreshChannels, 3000);
    setInterval(refreshChannels, 2 * 60000);
  }
  drawField();
  pairCode();
  setTimeout(() => $('#splash').classList.add('gone'), 1400);
  setInterval(loop, 1000);
  setInterval(countdownFrame, 100);
  setInterval(pollCommands, 700);
  loop();
}

/** Lineup changes in Sleeper (a late swap before the 3 o'clock games) count within 10 minutes. */
async function refreshRosters() {
  try { roster = await loadRosters(settings.sleeper, rosterOpts()); rosterAt = Date.now(); espnPhotos({ ...roster.players, ...roster.opponents }); } catch { /* keep the last */ }
}
let rosterAt = Date.now();

/** Every 3 s while games are live (the look-ahead needs fresh plays), every 15 s otherwise. */
async function pollLoop() {
  await pollScoreboard();
  const live = snapshots.length && snapshots[snapshots.length - 1].games.some(g => g.state === 'in');
  setTimeout(pollLoop, live ? 2000 : 15000);
}

// ---- Look-ahead: your stream is `delay` seconds behind ESPN, so a big play ESPN just reported hasn't aired yet.
// Spot your starters' big plays in the live (undelayed) data and switch there in time to watch them happen.
// Just in time: stay on your game, and switch so the new one is on screen about LAND_EARLY seconds before the play
// airs (by that channel's delay): a little lead-up, not half a minute of it. Too late (under LEAD_NEEDED: the
// countdown and tuning wouldn't make it) and it's skipped.
const LAND_EARLY = 15, COUNTDOWN = 3, LEAD_NEEDED = 9;
let bigPlays = [];        // {game, at, who (your starter, or null: anyone's big play), td, yards, team}

/** "D.Kincaid" as ESPN writes names in play text. */
const espnName = p => {
  const parts = String(p.name || '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i, '').split(/\s+/);
  return parts.length > 1 ? `${parts[0][0]}.${parts.slice(1).join(' ')}` : p.name;
};

/**
 * Fantasy points from one play's text, for one of your players: {pts, what} or null. An estimate (Sleeper's exact
 * totals come later and fill the cards): 0.1 a rushing/receiving yard, the league's points a catch, 0.04 a passing
 * yard, 6 a touchdown (4 passing), 3 a field goal, 1 an extra point.
 */
function playPoints(p, text, type) {
  const n = espnName(p), yards = Number((/for (-?\d+) yards?/i.exec(text) || [])[1] || (/for no gain/i.test(text) ? 0 : NaN));
  const td = /touchdown/i.test(text) || /touchdown/i.test(type || '');
  const rec = (p.leagues.find(l => l.starter) || p.leagues[0]).rec ?? 1;
  // "NO PLAY" (a penalty wiped it out) gains nothing; a penalty that was declined leaves the play standing.
  if (/no play/i.test(text) && !td) return null;
  const at = text.indexOf(n);
  if (at < 0) return null;
  const after = text.slice(at + n.length);
  if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+ yard field goal is GOOD`, 'i').test(text)) {
    const y = Number((/(\d+) yard field goal/i.exec(text) || [])[1] || 30);
    return { pts: y >= 50 ? 5 : y >= 40 ? 4 : 3, what: `${y}-yd field goal` };
  }
  if (/^\s*extra point is GOOD/i.test(after)) return { pts: 1, what: 'extra point' };
  if (/^\s*pass/i.test(after)) {   // the passer
    if (/incomplete|intercepted/i.test(after) || isNaN(yards)) return null;
    return { pts: Math.round((yards * 0.04 + (td ? 4 : 0)) * 10) / 10, what: `${yards}-yd pass${td ? ', TOUCHDOWN' : ''}` };
  }
  if (/pass\b[^.]*\bto\s*$/i.test(text.slice(0, at))) {   // the receiver
    if (/incomplete/i.test(text) || isNaN(yards)) return null;
    return { pts: Math.round((rec + yards * 0.1 + (td ? 6 : 0)) * 10) / 10, what: `${yards}-yd catch${td ? ', TOUCHDOWN' : ''}` };
  }
  if (!/pass|kick|punt|sacked/i.test(text.slice(0, at + n.length + 20)) && !isNaN(yards)) {   // the runner
    return { pts: Math.round((yards * 0.1 + (td ? 6 : 0)) * 10) / 10, what: `${yards}-yd run${td ? ', TOUCHDOWN' : ''}` };
  }
  return null;
}

// Points popups wait for the play to reach your screen: ESPN time + your stream delay.
let popups = [];   // {showAt, game, who, pts, what, team}
let jumpTo = null;  // the latest popup from another game: OK switches there until `until`
const popupFor = {};   // player id -> when a popup was last queued for them (so ESPN and Sleeper don't both pop)
const playStats = { plays: 0, mine: 0, queued: 0, shown: 0, last: '', error: '' };   // for checking it works

function spotBigPlays(prev, next) {
  if (!roster || !prev) return;
  spotFinals(prev, next);
  const mine = Object.values(roster.players).filter(p => p.leagues.some(l => l.starter) && !(prefs.out || {})[p.id]);
  for (const g of next.games) {
    if (g.state !== 'in' || !g.sit || !g.sit.lastPlay) continue;
    const before = prev.games.find(x => x.id === g.id);
    const text = g.sit.lastPlay.text || '';
    if (!text || (before && before.sit && before.sit.lastPlay && before.sit.lastPlay.text === text)) continue;   // nothing new
    // Points popups, first choice: ESPN's play, shown when that play reaches your screen (ESPN time + the channel's
    // delay). Sleeper's points (popupsFromMatchups) only fill in what this misses: they arrive 30–60 s after the play.
    if (settings.pointsPopups !== false) {
      for (const p of mine) {
        if (p.team !== g.home.abbr && p.team !== g.away.abbr) continue;
        const got = playPoints(p, text, g.sit.lastPlay.type);
        if (!got || got.pts <= 0) continue;   // any play that gains you something
        const watching = g.id === auto.current || (split && split.game === g.id);
        // You saw the play: no popup for it (and none from Sleeper's catch-up either).
        if (watching && settings.popupTiming === 'skipWatching') { popupFor[p.id] = Date.now(); continue; }
        popups.push({ showAt: next.t + popupWait(g, watching), game: g.id, who: p, pts: got.pts, what: got.what, espnAt: next.t,
          td: /touchdown/i.test(got.what), team: p.team === g.home.abbr ? g.home : g.away, teams: p.leagues.filter(l => l.starter).length });
        popupFor[p.id] = Date.now();
        playStats.mine++;
        playStats.last = `${got.what} · ${p.short}`;
      }
    }
    injuryFrom(g, text, mine, next.t);
    dangerFrom(g, before, text, next.t);
    const yards = Number((/for (\d+) yards?/i.exec(text) || [])[1] || 0);
    const td = /touchdown/i.test(text) || /touchdown/i.test(g.sit.lastPlay.type || '');
    if (!td && yards < 20) continue;
    if ((/intercept|fumble|no play/i.test(text) || (/penalty/i.test(text) && !/declined/i.test(text))) && !td) continue;
    const who = mine.find(p => (p.team === g.home.abbr || p.team === g.away.abbr) && text.includes(espnName(p)));
    if (who) bigPlays.push({ game: g.id, at: next.t, who, td, yards });
    // Anyone's touchdown or 30+ yard play: worth a look when nothing of yours is on the field where you are.
    else if (td || yards >= 30) bigPlays.push({ game: g.id, at: next.t, who: null, td, yards, team: g.sit.poss || '' });
  }
  bigPlays = bigPlays.filter(b => Date.now() - b.at < 180e3);   // lookahead() drops the ones too late to catch
}

/** The newest big play that will still air after a switch: what the countdown says, without saying what happened. */
function lookahead() {
  if (sim || away || settings.lookahead === false) return;
  const now = Date.now();
  const toAir = b => delayFor(b.game) - (now - b.at) / 1000;   // seconds until it reaches your screen on that channel
  bigPlays = bigPlays.filter(b => toAir(b) >= LEAD_NEEDED);   // missed: it would air before we got there
  // Someone else's big play only pulls you away when none of your starters are on the field in the game you're on.
  const here = game(auto.current);
  const quietHere = !here || here.onBreak || !here.players.some(p => !p.opp && !p.bench && (p.status === 'On field' || p.status === 'Red zone'));
  const due = bigPlays.filter(b => b.game !== auto.current && toAir(b) <= LAND_EARLY + COUNTDOWN && (b.who || quietHere));
  const b = due[due.length - 1];
  if (!b) return;
  const g = game(b.game);
  if (!g || g.skip) return;
  const what = b.who ? `your ${b.who.pos} ${b.who.short}` : `${b.team ? b.team + ' ' : ''}${b.td ? 'touchdown' : `${b.yards}-yard play`}`;
  const r = auto.lookahead(b.game, `Big play coming · ${what}`, now);
  if (r.pending) bigPlays = bigPlays.filter(x => x !== b);
}

async function pollScoreboard() {
  try {
    const b = await loadScoreboard();
    const snap = { t: Date.now(), games: b.games };
    try { spotBigPlays(snapshots[snapshots.length - 1], snap); } catch (e) { playStats.error = String(e && e.stack || e).slice(0, 300); }
    snapshots.push(snap);
    // Enough history for the delay plus the phone's clock sync (up to about 6 minutes back).
    const keep = Date.now() - Math.max(settings.delay * 1000 + 120e3, 400e3);
    while (snapshots.length > 2 && snapshots[1].t < keep) snapshots.shift();
  } catch { /* try again next time */ }
}

/**
 * Games and channels: which of your channels each game will play on, worked out ahead of time for the phone's Feeds
 * tab (and the channel names, for its pickers). Every 2 minutes, and right after a change from the phone.
 */
let channelMap = {}, channelNames = [];
const lastPlaySeen = {};   // game id -> {key: ESPN last play, at: when it changed}
const breakSince = {};     // game id -> when its current break began
async function refreshChannels() {
  if (!iptv || sim) return;
  try {
    await iptv.refresh();
    channelNames = iptv.list.channels.map(c => c.name);
    const map = {};
    for (const g of ranked) {
      if (g.state === 'post') continue;
      const ch = await iptv.find(g, settings.channelRules || {});
      map[g.id] = ch ? { name: ch.name, via: ch.via } : null;
    }
    channelMap = map;
  } catch (e) { channelMap = { error: e.message }; }
}

/**
 * Your matchups (you vs this week's opponent, each league), every 30 s. Sleeper's points run ahead of your stream,
 * so the TV shows the reading from `delay` seconds ago, like the score bug.
 */
const matchupHistory = [];   // {t, list}
async function refreshMatchups() {
  if (!roster || sim) return;
  try {
    const list = await loadMatchups(roster.teams, pointsNow);
    const last = matchupHistory[matchupHistory.length - 1];
    popupsFromMatchups(last && last.list, list);
    matchupHistory.push({ t: Date.now(), list });
    while (matchupHistory.length > 2) matchupHistory.shift();
  } catch { /* next time */ }
}
/** Live: the newest reading (you'd rather see the score now than wait for the stream), with each win chance. */
function matchupsNow() {
  if (sim) return simMatchups();
  const last = matchupHistory[matchupHistory.length - 1];
  if (!last) return [];
  const live = (snapshots[snapshots.length - 1] || {}).games || [];
  // A team defense's id is the team itself ("BUF").
  const teamOf = id => /^[A-Z]{2,3}$/.test(id) ? id : ((roster.players[id] || (roster.opponents || {})[id]) || {}).team;
  // Share of a team's game still to play: all of it before kickoff, none after the final or with no game this week.
  const leftFor = team => {
    const g = live.find(x => x.home.abbr === team || x.away.abbr === team);
    if (!g || g.state === 'post') return 0;
    if (g.state === 'pre') return 1;
    const m = /(\d+):(\d+)/.exec(g.clock || '');
    const clock = m ? +m[1] * 60 + +m[2] : 900;
    return Math.max(0, Math.min(1, ((4 - Math.min(g.period, 4)) * 900 + clock) / 3600));
  };
  return last.list.map(m => ({ ...m, win: winChance(m, teamOf, leftFor) }));
}
/** Practice: your starters' simulated points against a made-up opponent. */
function simMatchups() {
  const p = sim.points();
  return roster.teams.filter(t => !t.off && !t.byHand).map((t, i) => {
    const me = Object.values(roster.players).filter(x => x.leagues.some(l => l.league === t.league && l.starter))
      .reduce((s, x) => s + ((p[x.id] || {}).stats ? ((p[x.id].stats.pts_ppr) || 0) : 0), 0);
    return { league: t.league, team: t.team, opp: t.opp || 'Opponent', me, them: me * (0.8 + 0.15 * i) + 6, meProj: 110, themProj: 104 };
  });
}

async function refreshPoints() {
  try { pointsNow = await loadPoints(roster.season, week); } catch { /* keep last */ }
}

/**
 * Points popups, straight from your matchups (the numbers your Sleeper app shows, by each league's scoring): every
 * starter whose points went up since the last check (15 s), once even when they start for both your teams. Right
 * away, no waiting for the stream.
 */
function popupsFromMatchups(before, after) {
  if (!before || settings.pointsPopups === false) return;
  const gains = {};
  for (const m of after) {
    const old = before.find(x => x.league === m.league);
    if (!old) continue;
    const starters = new Set((m.meStarters || []).map(s => s.id));   // Sleeper scores the bench too: starters only
    for (const [id, pts] of Object.entries(m.playerPts || {})) {
      if (!starters.has(id)) continue;
      const gain = pts - ((old.playerPts || {})[id] || 0);
      if (gain > 0.04 && !(gains[id] && gains[id].gain >= gain)) gains[id] = { gain, leagues: (gains[id] ? gains[id].leagues : 0) + 1 };
    }
  }
  for (const [id, { gain }] of Object.entries(gains)) {
    const p = roster.players[id];
    if (!p || (prefs.out || {})[id]) continue;
    if (Date.now() - (popupFor[id] || 0) < 120e3) continue;   // ESPN's play already popped this one, on time
    popupFor[id] = Date.now();
    const g = ranked.find(x => x.home.abbr === p.team || x.away.abbr === p.team);
    const team = g ? (g.home.abbr === p.team ? g.home : g.away) : { abbr: p.team, color: '#2fd4ee' };
    const line = (() => { const s = (pointsNow[id] || {}).stats; return s ? statLine(p.pos, s) : ''; })();
    // The play itself isn't known here (Sleeper only says points went up): show the day so far. For the game you're
    // watching, wait the channel's delay: Sleeper only hears of a play after it happens, so by then it's on your screen.
    const watching = g && (g.id === auto.current || (split && split.game === g.id));
    const wait = watching ? ((sim ? settings.delay : delayFor(g.id)) + 2) * 1000 : 0;
    popups.push({ showAt: Date.now() + wait, game: g && g.id, who: p, pts: Math.round(gain * 10) / 10, what: line ? `on the day: ${line}` : 'just scored', team,
      teams: p.leagues.filter(l => l.starter).length });
    playStats.queued++;
  }
}

/**
 * How long after ESPN reports a play its popup waits (ms). The game you're watching never spoils your picture: it
 * waits until the play has reached your screen on that channel's delay, plus a 2 s cushion, and at least the popup
 * delay (25 s by default) in case the channel's delay is still a guess. Other games: right away, nothing to spoil
 * ("all": they wait the popup delay too; "stream": every game waits for its channel's delay).
 */
function popupWait(g, watching) {
  const fixed = Math.max(0, +(settings.popupDelay ?? 25) || 0);
  const stream = (sim ? settings.delay : delayFor(g.id)) + 2;
  if (settings.popupTiming === 'stream') return stream * 1000;
  if (watching) return Math.max(fixed, stream) * 1000;
  return settings.popupTiming === 'all' ? fixed * 1000 : 0;
}

/** Live: the scoreboard from `delay` seconds ago, to match the IPTV picture (ESPN runs ahead of the stream). */
/**
 * How far a game's channel runs behind ESPN, in seconds. Channels differ (one provider's feed was 24 s behind, another
 * 34 s), so clock sync saves a delay per channel; channels never synced use the general stream delay.
 */
function delayFor(gameId) {
  const ch = gameId === auto.current && tunedChannel ? tunedChannel.name : (channelMap[gameId] || {}).name;
  const d = ch && settings.channelDelays && settings.channelDelays[ch];
  return d != null ? d : settings.delay;
}

/**
 * The game clock as it reads on your screen right now, running. ESPN's clock only moves in jumps (about once a play),
 * but the screen runs behind ESPN, so the next reading is already in hand: count down from the reading before your
 * screen's moment, a second per second, and stop at the next reading (the clock stopped in between: incomplete pass,
 * out of bounds…). "12:07" etc.; null when there's nothing to show.
 */
function liveClock(gameId) {
  if (sim) return null;
  const at = Date.now() - delayFor(gameId) * 1000;
  let a = null, b = null;
  for (const s of snapshots) {
    const g = s.games.find(x => x.id === gameId);
    if (!g || g.state !== 'in') continue;
    if (s.t <= at) a = { t: s.t, g };
    else { b = { t: s.t, g }; break; }
  }
  if (!a) return null;
  const secs = c => { const m = /(\d+):(\d+)/.exec(c || ''); return m ? +m[1] * 60 + +m[2] : null; };
  let left = secs(a.g.clock);
  if (left == null) return a.g.clock;
  // The clock reached the next reading by the time ESPN posted it, but may have stood still for a while before
  // (a flag, an incompletion, a timeout). So hold, then run a second per second so as to arrive at the next reading
  // exactly when it was posted.
  const next = b && b.g.period === a.g.period ? secs(b.g.clock) : null;
  if (next != null && next < left && a.g.statusName === 'STATUS_IN_PROGRESS')
    left = Math.min(left, Math.max(next, next + Math.ceil((b.t - at) / 1000)));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// ---- The broadcast's own clock, read off the picture by the TV app (ClockReader.java) every 2 seconds.
let readClock = null;          // last reading {game, channel, period, secs, at, running}
const delaySamples = {};       // channel -> recent delay estimates (seconds)
let delaysSavedAt = 0;

// A commercial: no network logo in the corner and no score bug, two readings in a row (about 4 s). The logo stays up
// through the game, replays included, so this rarely mistakes a replay for an ad. Back to the game: either returns.
let bugMisses = 0, bugGame = null, tunedAt = 0, adSince = 0;
const onCommercial = gameId => bugGame === gameId && bugMisses >= 2;

window.ftvClock = (period, secs, at, logo) => {
  const g = game(auto.current);
  if (!g || !tunedChannel || g.state !== 'in') return;
  if (bugGame !== g.id) { bugGame = g.id; bugMisses = 0; }
  if (Date.now() - tunedAt < 12000 || behind) return;   // just tuned (black, catching up), or rewound (not live)
  if (!logo && secs < 0) { if (++bugMisses === 2) adSince = at; return; }   // no logo, no score bug: an ad
  bugMisses = 0;
  if (secs < 0) return;   // logo but no score bug: a replay or close-up, still the game
  // Only this game's clock: same quarter, and within 90 s of where ESPN (at the channel's delay) has it. CBS and
  // others show other games' scores and clocks along the bottom too.
  const expect = /(\d+):(\d+)/.exec(liveClock(g.id) || g.clock || '');
  if (period !== g.period || !expect || Math.abs((+expect[1] * 60 + +expect[2]) - secs) > 90) return;
  const prev = readClock && readClock.game === g.id && readClock.period === period ? readClock : null;
  // Running when the clock went down by about the time between readings.
  const running = !!prev && Math.abs((prev.secs - secs) - (at - prev.at) / 1000) <= 1.5 && prev.secs > secs;
  readClock = { game: g.id, channel: tunedChannel.name, period, secs, at, running };
  if (running) learnDelay(g.id, tunedChannel.name, period, secs, at);
};

/**
 * One estimate of how far this channel runs behind ESPN: when did ESPN's clock reach the clock just read? The first
 * scoreboard at or below it (same quarter) was fetched at s.t showing c ≤ secs; with the clock running into it, ESPN
 * was at `secs` (secs - c) seconds before. Only when c is close, so the guess is tight. The channel's delay becomes
 * the median of the last few estimates, saved for next time.
 */
function learnDelay(gameId, channel, period, secs, at) {
  const secsOf = c => { const m = /(\d+):(\d+)/.exec(c || ''); return m ? +m[1] * 60 + +m[2] : null; };
  let hit = null;
  for (const s of snapshots) {
    const g = s.games.find(x => x.id === gameId);
    if (!g || g.period !== period) continue;
    const c = secsOf(g.clock);
    if (c != null && c <= secs) { hit = { t: s.t, c }; break; }
  }
  if (!hit || secs - hit.c > 8) return;
  const delay = (at - (hit.t - (secs - hit.c) * 1000)) / 1000;
  if (delay < 10 || delay > 90) return;   // IPTV runs 10–90 s behind; anything else is a misread
  const list = (delaySamples[channel] ||= []);
  list.push(delay);
  if (list.length > 9) list.shift();
  if (list.length < 5) return;
  // Change the channel's delay only when the readings agree: the middle five within 4 s of each other.
  const sorted = [...list].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  const core = sorted.slice(Math.max(0, mid - 2), mid + 3);
  if (core[core.length - 1] - core[0] > 4) return;
  const now = Math.round(sorted[mid]);
  const was = (settings.channelDelays || {})[channel];
  if (was !== now && (was == null || Math.abs(was - now) >= 2)) {
    settings.channelDelays = { ...(settings.channelDelays || {}), [channel]: now };
    if (Date.now() - delaysSavedAt > 60e3) {
      delaysSavedAt = Date.now();
      fetch('/api/config', { cache: 'no-store' }).then(r => r.json())
        .then(cfg => fetch('/api/config', { method: 'POST', body: JSON.stringify({ ...cfg, channelDelays: settings.channelDelays }) }))
        .catch(() => {});
    }
  }
}

/** The broadcast's clock as of now, when it was read in the last 5 seconds on this game. */
function broadcastClock(gameId) {
  const r = readClock;
  if (!r || r.game !== gameId || Date.now() - r.at > 5000) return null;
  const left = r.running ? Math.max(0, r.secs - Math.floor((Date.now() - r.at) / 1000)) : r.secs;
  return { period: r.period, text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` };
}

let simPrev = null;
function currentGames() {
  if (sim) {
    sim.step();
    // Practice: the same play watching as live, with no delay.
    const snap = { t: Date.now() - settings.delay * 1000, games: sim.games.map(g => ({ ...g, sit: g.sit && { ...g.sit } })) };
    spotBigPlays(simPrev, snap);
    simPrev = snap;
    return sim.games;
  }
  // The screen follows the channel on it; the other games use their own channel's delay too.
  const pick = d => { const at = Date.now() - d * 1000; let best = snapshots[0]; for (const s of snapshots) if (s.t <= at) best = s; return best; };
  const base = pick(settings.delay);
  if (!base) return [];
  return base.games.map(g => {
    const d = delayFor(g.id);
    if (d === settings.delay) return g;
    const s = pick(d);
    return (s && s.games.find(x => x.id === g.id)) || g;
  });
}

// ---- main loop
function loop() {
  const games = currentGames();
  const pointsSrc = sim ? sim.points() : pointsNow;
  applySettings();
  ranked = rankAll(games, roster.players, pointsSrc, prefs);
  // What ESPN can't say: the channel on screen went to a commercial (its score bug is gone).
  // No new play for 75 s (a snap comes every ~40 s): a stoppage ESPN didn't name (injury, review, a long ad break).
  for (const g of ranked) {
    if (g.state !== 'in' || !g.sit || !g.sit.lastPlay) continue;
    const key = g.sit.lastPlay.text, seen = lastPlaySeen[g.id];
    if (!seen || seen.key !== key) lastPlaySeen[g.id] = { key, at: Date.now() };
    else if (Date.now() - seen.at > 75e3 && !g.onBreak) { g.onBreak = true; g.breakWhy = 'No play for a while'; g.value *= 0.25; }
  }
  const cur = game(auto.current);
  if (cur && cur.state === 'in' && onCommercial(cur.id)) {
    if (!cur.onBreak) cur.value *= 0.25;
    cur.onBreak = true; cur.breakWhy = 'Commercial';
    auto.adOn = cur.id;   // a real ad: leave without the usual wait
  } else auto.adOn = null;
  // How long each game has been on its break, so AutoTune can let the last play and replay finish (breakFor, s).
  for (const g of ranked) {
    if (!g.onBreak) { delete breakSince[g.id]; continue; }
    breakSince[g.id] = breakSince[g.id] || Date.now();
    g.breakFor = (Date.now() - breakSince[g.id]) / 1000;
  }
  // Only games one of your channels carries can be a fill-in during a break.
  if (iptv && !channelMap.error && Object.keys(channelMap).length) for (const g of ranked) g.hasChannel = !!channelMap[g.id];
  lookahead();
  const r = away ? {} : auto.tick(ranked);
  if (r.switchTo) { tune(r.switchTo, r.why); showTicker(); }
  splitCheck();
  render();
  publish();
}

function game(id) { return ranked.find(g => g.id === id); }

async function tune(id, why) {
  const g = game(id);
  if (!g) return;
  leaveRedZone();   // any game on screen ends RedZone (and gives AutoTune back)
  if (split) unsplit();   // a switch always goes back to one game
  if (behind) window.ftvRewound(0);   // and to live
  showCallouts(g, true);
  tunedAt = Date.now();
  stinger(g, why);   // the broadcast-style wipe covers the channel change
  tunedChannel = null;
  stopVideo();
  if (!iptv || sim) return;
  try {
    const ch = await iptv.find(g, settings.channelRules || {});
    if (auto.current !== id) return;
    if (!ch) { toast(`${g.away.abbr} @ ${g.home.abbr} isn't on your IPTV guide right now`); return; }
    tunedChannel = ch;
    // The first few channel changes also teach the rewind key.
    let tips = 0;
    try { tips = +(localStorage.getItem('ftv.rewindTips') || 0); localStorage.setItem('ftv.rewindTips', tips + 1); } catch { /* fine */ }
    toast(native && tips < 5 ? `Tuned ${ch.name} · ◀ rewinds 10 s, ▶ goes live` : `Tuned ${ch.name}`);
    playStream(ch.url);
  } catch (e) {
    toast(`IPTV: ${e.message}`);
  }
}

function playStream(url) {
  const v = $('#video');
  if (native) {
    // Rewind off: straight from the server. Smooth playback (tunneling) off: only if Settings says so.
    native.play(url + (rewindOn() ? '' : '#norewind') + (tunnelOn() ? '' : '#notunnel'));
    setVideo(true);
  } else if (window.mpegts && mpegts.isSupported()) {
    player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: location.origin + proxied(url) },
      { enableStashBuffer: false, liveBufferLatencyChasing: true });
    player.attachMediaElement(v);
    player.load();
    player.play().catch(() => {});
    setVideo(true);
  }
}

// ---- Split screen (TV app only): two of your drives hot at once, side by side. The game on screen stays on the left
// with its sound, score bug and players; the other plays muted on the right with its own label.
let split = null;   // {game, channel, since}
const SPLIT_HOT = 0.5;   // a drive this valuable (about one starter in the red zone) counts as hot

function splitCheck() {
  if (!native || sim || settings.splitScreen === false || away) { if (split) unsplit(); return; }
  const cur = game(auto.current), now = Date.now();
  if (split) {
    const side = game(split.game);
    const cool = !side || side.state !== 'in' || side.onBreak || side.value < SPLIT_HOT * 0.5;
    // Done when the side drive cools off (after 30 s at least), the main one goes to break, or AutoTune moved there.
    if (!cur || split.game === auto.current || (cool && now - split.since > 30e3 && !split.manual) || (cur.onBreak && !split.manual)) unsplit();
    return;
  }
  if (!cur || cur.state !== 'in' || cur.onBreak || cur.value < SPLIT_HOT || auto.pending) return;
  const other = ranked.find(g => g.id !== cur.id && g.state === 'in' && !g.onBreak && !g.skip && g.value >= SPLIT_HOT
    && (channelMap[g.id] || {}).name);
  if (other) splitWith(other, false);
}

async function splitWith(g, manual) {
  if (!native || !iptv) return;
  try {
    const ch = await iptv.find(g, settings.channelRules || {});
    if (!ch) { if (manual) toast(`${g.away.abbr} @ ${g.home.abbr} isn't on your channels right now`); return; }
    split = { game: g.id, channel: ch.name, since: Date.now(), manual };
    native.split(ch.url);
    document.documentElement.classList.add('split');
    renderSplit();
  } catch (e) { if (manual) toast(`Split screen: ${e.message}`); }
}

function unsplit() {
  split = null;
  if (native) native.split('');
  document.documentElement.classList.remove('split');
}

// How far behind live the picture plays after a rewind; the tag says so, and Up (or the phone) goes back to live.
let behind = 0, rewindAsked = 0;
/** Rewind seconds more on the main picture (0 = back to live). */
// Rewind: on unless turned off in Settings, and off by default on a lower-powered TV (it made the picture stutter there).
const rewindOn = () => settings.rewind ?? !(native && native.lowPower && native.lowPower());
// Smooth playback (tunneling): video straight from the decoder to the screen. Smooth on slower TVs, but the picture
// can't be read then (game clock, channel delay, commercials), so it's on by default only on a lower-powered TV; a
// stronger one (Shield) plays smoothly without it and keeps reading the picture.
const tunnelOn = () => settings.tunnel ?? !!(native && native.lowPower && native.lowPower());
// Settings (for development): save the clean score-bug strip every 3 s, to build a reader for each network's digits.
if (native && native.captureBugs) native.captureBugs(!!settings.captureBugs);
function rewindBy(seconds) {
  if (!native) return;
  if (!rewindOn()) { if (seconds > 0) toast('Rewind is off on this TV: turn it on in phone Settings'); return; }
  rewindAsked = seconds; native.rewind(seconds);
}
window.ftvRewound = secs => {
  behind = secs;
  const tag = $('#rewind');
  tag.classList.toggle('on', secs > 0);
  tag.innerHTML = secs > 0
    ? `<span class="behind">⏪ ${secs}s BEHIND</span><span class="key">◀ 10s back</span><span class="key go">▶ GO <b>LIVE</b></span>`
    : '';
  if (secs === 0) toast(rewindAsked > 0 ? 'Nothing saved to rewind yet: this channel keeps the last minute as you watch it' : '● Live');
};

// ---- Updates (TV app): a newer release on GitHub shows a card; OK installs it, Back puts it off until next time.
let update = null, updateCardUntil = 0, installing = false;
window.ftvUpdate = release => {
  update = release;
  if (installing) return;   // already downloading or on the installer screen: no card over it
  if (settings.autoUpdate) return;   // automatic: no card; it installs at a quiet moment (below)
  updateCardUntil = Date.now() + 30e3;
  $('#update').innerHTML = `<b>Update available · FantasyTV ${esc(release.versionName)}</b>`
    + (release.notes ? `<span class="notes">${esc(release.notes)}</span>` : '')
    + '<span class="keys"><b>OK</b> update now · <b>Back</b> later</span>';
  $('#update').classList.add('on');
  setTimeout(() => { if (Date.now() >= updateCardUntil) $('#update').classList.remove('on'); }, 30e3);
};
// Automatic updates (phone setting): install a waiting update once no game is live, so it never cuts into one.
setInterval(() => {
  if (!settings.autoUpdate || !update || installing || !native) return;
  if (ranked.some(g => g.state === 'in')) return;
  startUpdate();
}, 60e3);
window.ftvUpdateStatus = msg => { if (!/^Installing/.test(msg)) installing = false; toast(msg); };
function startUpdate() {
  if (!native || !update) return;
  installing = true;
  $('#update').classList.remove('on');
  updateCardUntil = 0;
  toast(`Downloading FantasyTV ${update.versionName}…`);
  native.installUpdate();
}

window.ftvSide = state => { if (state === 'dead' && split) { toast(`${split.channel} isn't sending video · back to one game`); unsplit(); } };

/** The labels over each half: the game, its situation, and your player in it. */
function renderSplit() {
  if (!split) return;
  const label = g => {
    if (!g) return '';
    const lead = g.players.find(p => !p.opp && !p.bench && (p.status === 'Red zone' || p.status === 'On field')) || g.players.find(p => !p.opp && !p.bench);
    return `<span class="tb" style="background:${g.away.color}">${esc(g.away.abbr)} ${g.away.score}</span><span class="tb" style="background:${g.home.color}">${esc(g.home.abbr)} ${g.home.score}</span>`
      + `<span class="st ${g.sit && g.sit.redZone ? 'rz' : ''}">${esc(g.sit ? `${g.sit.downDist} · ${g.sit.spot}` : statusLine(g))}</span>`
      + (lead ? `<span class="pl">${esc(lead.pos)} ${esc(lead.short)}</span>` : '');
  };
  $('#splitL').innerHTML = label(game(auto.current));
  $('#splitR').innerHTML = label(game(split.game)) + '<span class="mute">MUTED</span>';
}

function stopVideo() {
  if (native) native.stop();
  if (player) { try { player.destroy(); } catch { /* already gone */ } player = null; }
  setVideo(false);
}

/** Real picture on: the field drawing gives way to it (on the TV the page turns see-through over ExoPlayer). */
function setVideo(on) {
  videoOn = on;
  $('#video').classList.toggle('on', on && !native);
  document.documentElement.classList.toggle('playing', on);
}

/** For checking the player: {type:'channel', name:'NFL Network'} sent to /api/cmd plays that channel. */
async function testChannel(name) {
  try {
    await iptv.refresh();
    const ch = iptv.list.channels.find(c => c.name.toLowerCase() === String(name).toLowerCase());
    if (!ch) { toast(`No channel "${name}"`); return; }
    tunedChannel = ch;
    toast(`Test: ${ch.name}`);
    playStream(ch.url);
  } catch (e) { toast(`IPTV: ${e.message}`); }
}

// ExoPlayer's news, from MainActivity.
window.ftvPlayer = state => {
  if (state === 'error') toast(`${tunedChannel ? tunedChannel.name : 'The channel'} dropped · retrying`);
  if (state === 'dead') toast(`${tunedChannel ? tunedChannel.name : 'The channel'} isn't sending video. Still retrying; pick another game from All Games (Down) or your phone`);
};

// ---- commands from the phone
async function pollCommands() {
  for (const c of await link.commands()) handle(c);
}

function handle(c) {
  if (c.type === 'pick') { leaveRedZone(); const r = auto.pick(c.id); if (r.switchTo) tune(r.switchTo, r.why); }
  else if (c.type === 'redzone') watchRedZone();
  else if (c.type === 'tour') startTour();   // the phone's "Show the remote tour"
  // A pretend play for checking the look: {type: 'testPlay', name?: 'Okonkwo', pts?, what?}. It goes through the real
  // popup, so the card glow, the touchdown flash and the replay prompt all show (nothing is scored).
  // elsewhere: true picks your player in another live game instead (the banner and OK·WATCH path).
  else if (c.type === 'testPlay') {
    const named = x => !x.opp && (!c.name || x.name.toLowerCase().includes(String(c.name).toLowerCase()));
    const g =c.elsewhere ? ranked.find(x => x.id !== auto.current && x.state === 'in' && x.players.some(named)) : game(auto.current);
    const p = g && g.players.find(named);
    if (!p) { toast(`Test play: no such player in ${c.elsewhere ? 'another live game' : 'the game on screen'}`); return; }
    const what = c.what || 'TEST · 18-yd catch, TOUCHDOWN';
    popups.push({ showAt: Date.now(), game: g.id, who: roster.players[p.id] || p, pts: +c.pts || 7.8, what, espnAt: Date.now() - delayFor(g.id) * 1000,
      td: /touchdown/i.test(what), team: p.team === g.home.abbr ? g.home : g.away, teams: 1 });
  }
  // A pretend injury for checking the look: {type: 'testInjury', name?, how?} for your starter in the game on screen.
  else if (c.type === 'testInjury') {
    const g = game(auto.current), mine = Object.values(roster.players).filter(p => p.leagues.some(l => l.starter));
    const p = g && mine.find(x => (x.team === g.home.abbr || x.team === g.away.abbr) && (!c.name || x.name.toLowerCase().includes(String(c.name).toLowerCase())));
    if (!p) { toast('Test injury: none of your starters in the game on screen'); return; }
    injuryFrom(g, `${espnName(p)} up the middle for 3 yards. ${espnName(p)} ${c.how || 'was injured during the play'}.`, [p], Date.now() - delayFor(g.id) * 1000);
  }
  else if (c.type === 'lock') {
    const r = auto.lock(c.id);
    if (r.switchTo) tune(r.switchTo, r.why);
    toast(auto.locked ? 'Locked: AutoTune stays on this game' : 'Unlocked: AutoTune is back on');
  } else if (c.type === 'heart') { prefs.hearts[c.id] = !prefs.hearts[c.id]; savePrefs(); }
  else if (c.type === 'skip') { prefs.skips[c.id] = !prefs.skips[c.id]; savePrefs(); }
  else if (c.type === 'pause') {
    // AutoTune on while RedZone is up: leave RedZone, and tune its top game now (the old game isn't on screen).
    if (!c.on && redZone) { redZone = null; auto.current = null; }
    auto.setPaused(!!c.on);
    toast(c.on ? 'AutoTune off · ▲ turns it back on' : 'AutoTune on');
  }
  else if (c.type === 'cancel') auto.cancel();
  else if (c.type === 'reload') { location.reload(); return; }
  else if (c.type === 'channel' && iptv) testChannel(c.name);
  else if (c.type === 'out') { prefs.out[c.id] = !prefs.out[c.id]; if (!prefs.out[c.id]) delete prefs.out[c.id]; savePrefs(); }
  else if (c.type === 'rewind') rewindBy(+c.seconds || 0);
  else if (c.type === 'checkUpdate') { if (native) { native.checkUpdate(); toast('Checking for updates…'); } }
  else if (c.type === 'installUpdate') startUpdate();
  else if (c.type === 'split') {
    if (split && split.game === c.id) unsplit();
    else if (game(c.id) && c.id !== auto.current) { if (split) unsplit(); splitWith(game(c.id), true); }
  }
  else if (c.type === 'rules') { settings.channelRules = c.rules || {}; refreshChannels(); }
  else if (c.type === 'syncRosters') { toast('Syncing your teams…'); refreshRosters().then(() => toast('Teams synced')); }
  else if (c.type === 'clock') { syncClock(c.clock); return; }
  loop();
}

/**
 * Clock sync: the game clock you see on the TV right now ("8:42") for the game on screen. The scoreboard history says
 * when ESPN showed that clock; the gap is how far the stream runs behind, which becomes the delay.
 */
async function syncClock(text) {
  const g = game(auto.current);
  const m = /(\d{1,2}):(\d{2})/.exec(String(text || ''));
  if (!g || !m || sim) { toast(!g ? 'Clock sync needs a game on screen' : sim ? 'Clock sync works with live games' : 'Type the clock as 8:42'); return; }
  const want = Number(m[1]) * 60 + Number(m[2]);
  const secs = c => { const x = /(\d+):(\d+)/.exec(c || ''); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  // The earliest snapshot showing that clock (or the nearest one above it: ESPN's clock jumps between updates).
  let at = null, best = Infinity;
  for (const s of snapshots) {
    const sg = s.games.find(x => x.id === g.id);
    if (!sg || sg.period !== g.period) continue;
    const c = secs(sg.clock);
    if (c == null || c < want) continue;
    if (c - want < best || (c - want === best && at && s.t < at)) { best = c - want; at = s.t; }
  }
  if (at == null || best > 45) { toast("Couldn't match that clock: check the quarter on screen and try again"); return; }
  const delay = Math.max(0, Math.min(180, Math.round((Date.now() - at) / 1000)));
  // Saved for this channel, and as the general delay for channels not synced yet.
  const ch = tunedChannel && tunedChannel.name;
  settings.channelDelays = { ...(settings.channelDelays || {}), ...(ch ? { [ch]: delay } : {}) };
  settings.delay = delay;
  try {
    const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
    await fetch('/api/config', { method: 'POST', body: JSON.stringify({ ...cfg, delay, channelDelays: settings.channelDelays }) });
  } catch { /* still applies until a restart */ }
  toast(`Synced: ${ch || 'your stream'} is ${delay} s behind live`);
}

window.ftvAway = on => { away = !!on; if (away) auto.pending = null; };

function publish() {
  link.publish({
    at: Date.now(), mode: sim ? 'sim' : 'live', screen: [document.documentElement.clientWidth, innerWidth, innerHeight, devicePixelRatio], user: roster.user, teams: roster.teams.map(({ espn, ...t }) => ({ ...t, espn: espn ? { id: espn.id, teamId: espn.teamId } : undefined })), week,   // no ESPN cookies to the phone
    current: auto.current, paused: auto.paused, locked: auto.locked, split: split && split.game, behind,
    redZone: !!redZone, redZoneOpen: !!redZoneRow(),
    version: native ? native.version() : 'browser', update: update && { versionName: update.versionName, notes: update.notes }, channel: tunedChannel && tunedChannel.name,
    pending: auto.pending && { to: auto.pending.to, endsAt: auto.pending.endsAt, why: auto.pending.why },
    playStats, popupsWaiting: popups.length, ad: { misses: bugMisses, game: bugGame, on: auto.adOn }, readClock, channelDelays: settings.channelDelays || {}, delaySamples,
    matchups: matchupsNow(), channels: channelMap, channelNames, iptv: !!iptv, bigPlays: bigPlays.map(b => ({ game: b.game, at: b.at, who: b.who ? b.who.short : b.team, td: b.td, yards: b.yards })),
    log: auto.log.slice(0, 12), delay: settings.delay, away, rosterAt, out: prefs.out,
    hideSpoilers: settings.hideSpoilers !== false, rewind: rewindOn(), tunnel: tunnelOn(), waiting: !!(auto.pending && auto.pending.waiting),
    games: ranked.map(g => ({ id: g.id, away: g.away, home: g.home, state: g.state, statusName: g.statusName, period: g.period,
      clock: g.clock, start: g.start, network: g.network, sit: g.sit, onBreak: g.onBreak, breakWhy: g.breakWhy, signal: g.signal,
      value: g.value, fav: g.fav, skip: g.skip, players: g.players })),
  });
}

// ---- drawing
function render() {
  const g = game(auto.current);
  auto.splitGame = split ? split.game : null;
  renderSplit();
  renderBug(g);
  renderRail(g);
  renderField(g);
  if (radarOpen) { renderRadar(); renderTicker(); $('#ticker').classList.add('on'); }
  else if ($('#ticker').classList.contains('on')) renderTicker();   // keep its "Now" points live
  // AutoTune on or off, always in view above your players; ▲ on the remote flips it.
  $('#atPair').style.display = 'none';
  const at = $('#atTag');
  at.classList.toggle('off', auto.paused);
  at.innerHTML = `AUTOTUNE <b>${auto.paused ? (redZone ? 'OFF · REDZONE' : 'OFF') : 'ON'}</b><span class="k">▲</span>`;
  $('#lower').classList.toggle('hide', !g);
}


/** A team in the score bug: its logo (ESPN's, for dark backgrounds) over a stripe of its colour, and its record.
 *  No logo (offline, a new team): its name instead. */
// The home team mirrors the away team (record, then logo), so both logos sit on the outer edges.
const bugTeam = (t, timeouts, home = false) => `<div class="t${home ? ' home' : ''}" style="--team:${t.color}">`
  + `<img src="${esc(t.darkLogo || t.logo || '')}" alt="${esc(t.abbr)}" onerror="this.replaceWith(Object.assign(document.createElement('span'), { textContent: this.alt }))">`
  + '<span class="tr">' + (t.record ? `<small>${esc(t.record)}</small>` : '')
  // Timeouts left: three dots, the used ones dim (ESPN sends them while the game is on).
  + (timeouts != null ? `<span class="tos">${[0, 1, 2].map(i => `<i class="${i < timeouts ? 'on' : ''}"></i>`).join('')}</span>` : '')
  + '</span></div>';

/**
 * Moments the score bug marks, from the (delayed, so in step with your picture) game data:
 * 3. a first down (same team still has it, back to 1st down at a new spot) flashes "1ST DOWN" for a second and a half;
 * 4. a change of possession pops the football in beside the new team's score;
 * 5. crunch time (4th quarter or overtime, two minutes or less, one score apart) pulses the clock.
 */
const bugSeen = {};   // game id -> {poss, down, dist, spot, fdAt, possAt}
function bugMoments(g) {
  const s = g.sit, now = Date.now();
  const b = bugSeen[g.id] || (bugSeen[g.id] = { fdAt: 0, possAt: 0 });
  if (s && s.poss) {
    if (b.poss && b.poss !== s.poss) b.possAt = now;
    else if (b.poss === s.poss && s.down === 1 && b.spot !== s.spot && (b.down > 1 || (b.down === 1 && s.dist >= b.dist))) b.fdAt = now;
    Object.assign(b, { poss: s.poss, down: s.down, dist: s.dist, spot: s.spot });
  }
  const fdAge = now - b.fdAt, possAge = now - b.possAt;
  const clock = /(\d+):(\d+)/.exec((broadcastClock(g.id) || {}).text || liveClock(g.id) || g.clock || '');
  const secs = clock ? +clock[1] * 60 + +clock[2] : 999;
  return {
    firstDown: fdAge < 1500, fdStyle: fdAge < 1500 ? `animation-delay:-${fdAge}ms` : '',
    newPoss: possAge < 900 ? 'newposs' : '', possStyle: possAge < 900 ? `;--pd:-${possAge}ms` : '',
    crunch: g.state === 'in' && g.period >= 4 && secs <= 120 && Math.abs(g.home.score - g.away.score) <= 8,
  };
}

/** The clock panel: the quarter small and spaced ("3RD") over the time, big ("2:51"). */
function clockHtml(g) {
  if (g.state !== 'in') return `<span class="tm sm">${esc(statusLine(g))}</span>`;
  if (g.statusName === 'STATUS_HALFTIME') return '<span class="c q cap">HALF</span><span class="tm">TIME</span>';
  const bc = broadcastClock(g.id) || {};
  // Between quarters ESPN still says "end of the 3rd, 0:00" until the next snap; the broadcast already shows the next
  // quarter at 15:00, so do the same (unless the picture's own clock is in hand).
  const between = g.statusName === 'STATUS_END_PERIOD' && !bc.text;
  const q = between ? g.period + 1 : bc.period || g.period;
  const label = q > 4 ? 'OT' : ['1ST', '2ND', '3RD', '4TH'][q - 1] || `Q${q}`;
  const time = between ? (q > 4 ? '10:00' : '15:00') : bc.text || liveClock(g.id) || g.clock;
  return `<span class="c q cap">${label}</span><span class="tm">${esc(time)}</span>`;
}

function renderBug(g) {
  if (!g) { setHtml($('#bug .in'), ''); return; }
  const poss = g.sit && g.sit.poss;
  const rz = g.sit && g.sit.redZone;
  const fa = scoreClass(g, 'away'), fh = scoreClass(g, 'home');
  // 5. Your starter's team in the red zone: a slow red heartbeat on the bug.
  $('#bug .in').classList.toggle('rzbeat', !!rz && g.players.some(p => !p.opp && !p.bench && p.status === 'Red zone'));
  const m = bugMoments(g);
  const pc = side => poss === g[side].abbr ? `poss ${m.newPoss}` : '';
  const ddText = m.firstDown ? '1ST DOWN' : g.sit && g.sit.downDist ? `${esc(g.sit.downDist)}${g.sit.spot ? ' · ' + esc(g.sit.spot) : ''}` : '';
  setHtml($('#bug .in'), driveHtml(g) + `
    ${bugTeam(g.away, g.sit && g.sit.awayTO)}
    <div class="s ${pc('away')} ${fa.cls}" style="${fa.style}${m.possStyle}">${g.away.score}</div>
    <div class="c clk ${m.crunch ? 'crunch' : ''}">${clockHtml(g)}</div>
    ${ddText ? `<div class="c dd cap ${m.firstDown ? 'gold fd' : rz ? 'rz' : 'blue'}" style="${m.fdStyle}">${ddText}</div>` : ''}
    <div class="s ${pc('home')} ${fh.cls}" style="${fh.style}${m.possStyle}">${g.home.score}</div>
    ${bugTeam(g.home, g.sit && g.sit.homeTO, true)}`);
}


/** You vs your opponent in each league: score, then a bar of your share of the projected total. */
// 🔥 on a matchup: your team has scored 15+ in the last 10 minutes (shown for 5 of them) (each league's own points, as shown).
// The flame shows for 5 minutes from the moment the run gets there, then goes; it can only come back once the run has
// cooled off (under 15 in the last 10 minutes) and heated up again.
const HOT_PTS = 15, HOT_MS = 10 * 60e3, FIRE_SHOW_MS = 5 * 60e3;
const scoreTrail = {};   // league -> [[time, your points]], the last 10 minutes
const fireSince = {};    // league -> when its current run turned hot
function onFire(m) {
  const now = Date.now(), trail = scoreTrail[m.league] ||= [];
  if (!trail.length || trail[trail.length - 1][1] !== m.me) trail.push([now, m.me]);
  while (trail.length > 1 && now - trail[1][0] > HOT_MS) trail.shift();   // keep the score as of 10 minutes ago
  if (m.me - trail[0][1] < HOT_PTS) { fireSince[m.league] = 0; return false; }
  fireSince[m.league] ||= now;
  return now - fireSince[m.league] < FIRE_SHOW_MS;
}

function renderMatchups() {
  const list = matchupsNow();
  $('#mu').style.display = list.length && settings.showMatchups !== false ? '' : 'none';
  // Two fit; with more leagues, the next two every 10 seconds. Always two to a page: with an odd number of leagues the
  // last page wraps round to the first (3 leagues: A+B, C+A).
  const pages = Math.ceil(list.length / 2), page = pages > 1 ? Math.floor(Date.now() / 10000) % pages : 0;
  const hot = new Set(list.filter(onFire).map(m => m.league));   // every league's run is followed, shown or not
  const mu = $('#mu'), prev = mu.querySelector('.pg:not(.out)');
  const shown = pages > 1 ? [list[page * 2], list[(page * 2 + 1) % list.length]] : list;
  const html = '<div class="pg">' + shown.map(m => {
    const share = m.me / Math.max(0.01, m.me + m.them) * 100;
    // The bar is your live chance of winning (the number on the right of the league name), not the points split.
    const win = m.win != null ? Math.round(m.win * 100) : Math.round(m.me + m.them > 0 ? share : 50);
    // 5. Settled either way says so (the win chance shows how close the rest are).
    const badge = m.win != null && win >= 99 ? ['clinch', 'CLINCHED'] : m.win != null && win <= 1 ? ['miracle', 'NEED A MIRACLE'] : [win >= 50 ? 'up' : 'down', `${win}% WIN`];
    return `<div><div class="lg">${esc(m.league.toUpperCase())}<b class="wp ${badge[0]}">${badge[1]}</b></div>
      <div class="ln"><span class="a">${esc(m.team)}</span><span class="s ${m.me >= m.them ? 'win' : 'lose'}"><span class="n">${hot.has(m.league) ? '<i class="fire" title="15+ points in 10 minutes">🔥</i>' : ''}${rollHtml('me:' + m.league, m.me, false)}</span></span><span class="v">vs</span>
        <span class="s ${m.them > m.me ? 'win' : 'lose'}">${rollHtml('them:' + m.league, m.them, false)}</span><span class="b">${esc(m.opp)}</span>
        <div class="bar">${rollBar('win:' + m.league, win)}</div></div></div>`;
  }).join('') + '</div>';
  // A new page scrolls up: the old one rolls out the top (kept for its 0.8 s) with the new one right behind it.
  const turned = renderMatchups.page !== undefined && renderMatchups.page !== page;
  renderMatchups.page = page;
  if (!setHtml(mu, html) || !turned || !prev) return;
  mu.querySelector('.pg').classList.add('in');
  prev.classList.add('out');
  mu.appendChild(prev);
  setTimeout(() => prev.remove(), 850);
}

function renderRail(g) {
  renderMatchups();
  if (!g) { setHtml($('#rail .cards'), ''); return; }
  const room = $('#mu').style.display === 'none' ? 5 : 4;   // the matchups take room
  const here = g.players.filter(p => !p.opp && !p.out).slice(0, room);
  // Room left over: your starters in the other live games (on the field first), each with its game. Still room
  // (nobody else live): the FantasyTV wordmark in the gap.
  const rank = p => p.status === 'Red zone' ? 0 : p.status === 'On field' ? 1 : 2;
  const elsewhere = ranked.filter(x => x.state === 'in' && x.id !== g.id)
    .flatMap(x => x.players.filter(p => !p.opp && !p.out && !p.bench).map(p => ({ ...p, game: x })))
    .sort((a, b) => rank(a) - rank(b) || b.pts - a.pts).slice(0, room - here.length);
  const card = (p, i) => {
    const cls = p.status === 'Red zone' ? 'rz' : p.status === 'On field' ? 'on' : '';
    const where = p.game ? `<span class="gm">${esc(p.game.away.abbr)} @ ${esc(p.game.home.abbr)}</span>` : '';
    const hit = cardHit[p.id], hitAge = hit ? Date.now() - hit.at : 1e9;
    // While it glows the markup stays the same from second to second (no running age in it), so the card isn't
    // rebuilt every render; the animations are lined up to the hit once, when it is (setRail below).
    return `<div data-pid="${esc(p.id)}" class="card ${i === 0 && !p.game ? 'lead' : ''} ${p.bench ? 'bench' : ''} ${p.game ? 'away' : ''} ${hitAge < 10000 ? (hit.td ? 'hit td' : 'hit') : ''}" ${hitAge < 10000 ? `data-hit="${hit.at}" style="--hit:${hit.color}"` : ''}>
      ${hitAge < 10000 ? `<i class="fx"></i>${hit.td ? '<i class="fx b"></i>' : ''}` : ''}
      ${p.espn ? `<img class="hs" src="https://a.espncdn.com/i/headshots/nfl/players/full/${p.espn}.png" alt="" onerror="this.remove()">` : ''}
      ${p.pts >= 20 ? '<i class="fire corner" title="20+ points today">🔥</i>' : ''}
      <div class="nm">${i === 0 && !p.game ? HEART(g.fav) : ''}${esc(p.short)} <span class="pos">${p.pos}</span>${p.teams > 1 ? `<span class="pos" title="on ${p.teams} of your teams">×${p.teams}</span>` : ''}</div>
      <div class="st ${cls}">${hitAge < 10000 && hit.td ? '<span class="tdtag">TOUCHDOWN</span>' : `${where}${p.status ? '● ' + p.status : ''}${p.bench ? ' · bench' : ''}`}</div>
      <div class="p"><b>${rollHtml(p.id, p.pts, hitAge > 120e3)}${hitAge < 10000 ? `<i class="gain big">+${pts(hit.pts)}</i>` : ''}</b><small>${pts(p.proj)} proj</small></div>
      <div class="ln">${esc(p.line) || '&nbsp;'}</div></div>`;
  };
  if (setHtml($('#rail .cards'), [...here, ...elsewhere].map(card).join(''))) {
    // Rebuilt (a stat or points changed): carry each glow on from where it was, not from the start.
    for (const c of document.querySelectorAll('#rail .card[data-hit]')) {
      const d = `-${Date.now() - +c.dataset.hit}ms`;
      for (const el of [c, ...c.querySelectorAll('.fx, .gain.big')]) el.style.animationDelay = d;
    }
  }
  const full = here.length + elsewhere.length >= room;
  $('#rail .fill').innerHTML = full ? '' : '<img class="wm" src="img/wordmark.png" alt="">';
  $('#rail').classList.toggle('full', full);   // every card spot taken: the cards stretch to fill the bar
}

function drawField() {
  const lines = [];
  for (let y = 5; y <= 95; y += 5) {
    const x = 160 + y * 16;
    lines.push(`<div class="yl" style="left:${x}px;opacity:${y % 10 ? .45 : 1}"></div>`);
    if (y % 10 === 0) {
      const n = y <= 50 ? y : 100 - y;
      lines.push(`<div class="num" style="left:${x - 30}px;top:130px">${n}</div><div class="num" style="left:${x - 30}px;bottom:300px;transform:rotate(180deg)">${n}</div>`);
    }
  }
  $('#field .lines').innerHTML = lines.join('');
}

function renderField(g) {
  const f = $('#field');
  renderIdle(g);
  if (!g) { f.classList.remove('break'); return; }
  const off = g.sit && g.sit.poss === g.home.abbr ? g.home : g.away;
  const def = off === g.home ? g.away : g.home;
  f.querySelector('.ez.l').style.background = off.color;
  f.querySelector('.ez.l span').textContent = off.abbr;
  f.querySelector('.ez.r').style.background = def.color;
  f.querySelector('.ez.r span').textContent = def.abbr;
  // The offense always drives to the right here.
  const ytg = g.sit && g.sit.ytg != null ? g.sit.ytg : 50;
  const x = 160 + (100 - ytg) * 16;
  f.querySelector('.los').style.left = `${x}px`;
  f.querySelector('.ball').style.left = `${x - 17}px`;
  const fd = g.sit && g.sit.dist ? Math.min(100, 100 - ytg + g.sit.dist) : null;
  f.querySelector('.fd').style.display = fd == null ? 'none' : '';
  if (fd != null) f.querySelector('.fd').style.left = `${160 + fd * 16}px`;
  f.querySelector('.play').textContent = g.sit && g.sit.lastPlay ? g.sit.lastPlay.text : statusLine(g);
  f.querySelector('.demo').textContent = sim ? 'PRACTICE SUNDAY · SIMULATED' : tunedChannel ? `CH ${tunedChannel.name}` : iptv ? 'LOOKING UP CHANNEL…' : 'NO IPTV SET UP · FIELD VIEW';
  f.classList.toggle('break', g.onBreak && !videoOn);
  f.querySelector('.brk span').textContent = g.breakWhy || 'Break';
  f.querySelector('.brk small').textContent = 'COMMERCIAL BREAK LIKELY · AUTOTUNE IS LOOKING ELSEWHERE';
}

const mineOf = g => g.players.filter(p => !p.opp);

/** Nothing on: your games today, with kickoff times and how many of your players are in each. */
function renderIdle(g) {
  const idle = $('#idle');
  idle.classList.toggle('on', !g);
  if (g) return;
  const up = ranked.filter(x => x.state !== 'post' && x.players.some(p => !p.opp)).slice(0, 6);
  idle.querySelector('h2').textContent = auto.paused ? 'AutoTune is paused' : up.some(x => x.state === 'in') ? 'Finding your best drive…' : 'Waiting for kickoff';
  idle.querySelector('.games').innerHTML = up.map(x => `<div class="ig">
      <span class="tb" style="background:${x.away.color}">${esc(x.away.abbr)}</span><span class="muted">@</span><span class="tb" style="background:${x.home.color}">${esc(x.home.abbr)}</span>
      <span class="when">${esc(statusLine(x))}</span>
      <span class="who">${mineOf(x).slice(0, 3).map(p => esc(p.short)).join(' · ')}${mineOf(x).length > 3 ? ` +${mineOf(x).length - 3}` : ''}</span></div>`).join('')
    || '<div class="muted">None of your players are on this week\'s schedule.</div>';
}

function showCallouts(g, force) {
  const mine = g.players.filter(p => !p.opp && !p.out && !p.bench);
  // Only your players on the team with the ball: "Red zone" over a player on the other side made no sense.
  const lead = mine.find(p => p.status === 'Red zone' || p.status === 'On field');
  const rows = [];
  if (g.sit && g.sit.redZone) rows.push(`<div class="red">Red zone · ${esc(g.sit.poss || '')} ball</div>`);
  if (lead) rows.push(`<div class="dark">Your ${esc(lead.pos)} · ${esc(lead.short)}</div>`);
  if (!rows.length && !force) return;
  const c = $('#callouts');
  c.innerHTML = rows.join('');
  c.classList.add('on');
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => c.classList.remove('on'), 8000);
}

let lastRedZone = null;
setInterval(() => {
  const g = game(auto.current);
  const rz = g && g.sit && g.sit.redZone ? g.id + g.sit.poss : null;
  if (rz && rz !== lastRedZone) showCallouts(g);
  lastRedZone = rz;
}, 1000);

function countdownFrame() {
  const p = auto.pending, cd = $('#countdown');
  cd.classList.toggle('on', !!p);
  if (!p) return;
  const g = game(p.to);
  if (!g) return;
  const left = Math.max(0, (p.endsAt - Date.now()) / 1000);
  // Team logos on their colours (the name if a logo won't load); only redrawn when something changes, so they don't flicker.
  const logo = t => `<b style="background:${t.color}"><img src="${esc(t.darkLogo || t.logo || '')}" alt="${esc(t.abbr)}" onerror="this.replaceWith(this.alt)"></b>`;
  setHtml(cd.querySelector('.teams'), `${logo(g.away)}<span class="muted">@</span>${logo(g.home)}<span style="margin-left:auto;display:flex;gap:16px;align-items:center">${HEART(g.fav)}${bars(g.signal)}</span>`);
  cd.querySelector('.why').textContent = p.waiting ? 'Switching when this play ends' : p.why;
  cd.querySelector('.secs').textContent = p.waiting ? 'PLAY' : left.toFixed(1);
  cd.querySelector('.prog i').style.width = `${100 * (1 - left / (p.total || auto.opts.countdown))}%`;
  cd.querySelector('.lbl').innerHTML = p.big ? 'BIG PLAY<br>COMING' : 'SWITCHING<br>TO';
  cd.querySelector('.mk').innerHTML = LOGO;
}
$('#countdown .cancel').onclick = () => { auto.cancel(); loop(); };

// ---- NFL RedZone: Sundays 12:00–6:45 pm Central, first in All Games when one of your channels carries it. Watching
// it, AutoTune stands by (RedZone does the switching) until you pick a game, or RedZone signs off.
let redZone = null;   // {wasPaused} while it's on screen
function redZoneHours(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric',
    minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
  const m = +p.hour * 60 + +p.minute;
  return p.weekday === 'Sun' && m >= 12 * 60 && m < 18 * 60 + 45;
}
function redZoneChannel() {
  const chans = iptv && iptv.list ? iptv.list.channels : [];
  return chans.find(c => /^nfl\s*red\s?zone$/i.test(c.name.trim())) || chans.find(c => /red\s?zone/i.test(c.name)) || null;
}
const redZoneRow = () => (redZoneHours() || params.has('redzone')) && redZoneChannel() ? { redzone: true, id: 'redzone' } : null;
function watchRedZone() {
  const ch = redZoneChannel();
  if (!ch) { toast('No RedZone channel on your IPTV'); return; }
  if (!redZone) redZone = { wasPaused: auto.paused };
  auto.setPaused(true);
  if (split) unsplit();
  if (behind) window.ftvRewound(0);
  tunedChannel = ch;
  stopVideo();
  playStream(ch.url);
  toast('NFL RedZone · AutoTune waits until you pick a game');
}
function leaveRedZone() {
  if (!redZone) return;
  auto.setPaused(redZone.wasPaused);
  redZone = null;
}
// At 6:45 RedZone signs off: back to AutoTune's best game.
setInterval(() => {
  if (!redZone || redZoneHours() || params.has('redzone')) return;
  leaveRedZone();
  const best = ranked.find(g => g.state === 'in');
  if (best) tune(auto.go(best.id, 'RedZone ended', Date.now()).switchTo, 'RedZone ended');
}, 30e3);

/** All Games (the Down list): NFL RedZone while it's on, then every live game (yours first, by how much they matter), then your later games. */
function radarList() {
  const live = ranked.filter(g => g.state === 'in');
  const mine = g => g.players.some(p => !p.opp);
  const rz = redZoneRow();
  // An update waiting (the card was put off or missed): first in the list, OK installs it.
  const up = update && !installing && native ? { upd: true, id: 'update' } : null;
  return [...(up ? [up] : []), ...(rz ? [rz] : []), ...live.filter(mine), ...live.filter(g => !mine(g)), ...ranked.filter(g => g.state === 'pre')];
}
const RADAR_ROWS = 5;   // shown at once; the list scrolls with the focus

function renderRadar() {
  const list = radarList();
  $('#radar .n').textContent = `${list.filter(g => g.state === 'in').length} LIVE`;
  radarFocus = Math.max(0, Math.min(radarFocus, list.length - 1));
  const first = Math.max(0, Math.min(radarFocus - 2, list.length - RADAR_ROWS));
  setHtml($('#radar .list'), list.slice(first, first + RADAR_ROWS).map((g, j) => {
    const i = first + j;
    if (g.upd) return `<div class="rg ${i === radarFocus ? 'focus' : ''}">
      <div class="top"><span class="tag" style="background:var(--lime);color:#04222a">NEW</span><span>Update FantasyTV</span></div>
      <div class="sub">Version ${esc(update.versionName)}${update.notes ? ` · ${esc(update.notes)}` : ''}</div>
      <div class="pl"><span class="muted">OK to install now</span></div></div>`;
    if (g.redzone) return `<div class="rg rzrow ${redZone ? 'cur' : ''} ${i === radarFocus ? 'focus' : ''}">
      <div class="top"><span class="tag red">LIVE</span><span>NFL RedZone</span></div>
      <div class="sub">Every touchdown from every game, till 6:45 pm CT</div>
      <div class="pl"><span class="muted">AutoTune waits while you watch it</span></div>
      <div class="ch">▶ ${esc(redZoneChannel().name)}</div></div>`;
    const ch = (channelMap[g.id] || {}).name;
    const chan = g.state === 'in' ? `<div class="ch">${ch ? `▶ ${esc(ch)}` : '<span class="muted">Not found on your channels</span>'}</div>` : '';
    const pl = g.players.filter(p => !p.opp && !p.out).slice(0, 2).map(p => {
      const c = p.status === 'Red zone' ? 'rz' : p.status === 'On field' ? 'on' : 'muted';
      return `<div class="pl"><span>${esc(p.short)} <span class="muted">${p.pos}</span></span><span><span class="${c}">${esc(p.status)}</span> ${pts(p.pts)}</span></div>`;
    }).join('');
    return `<div class="rg ${g.id === auto.current ? 'cur' : ''} ${i === radarFocus ? 'focus' : ''} ${g.state !== 'in' || g.skip ? 'dim' : ''}">
      <div class="top">${bars(g.signal)}<span>${esc(g.away.abbr)}</span><span class="sc">${g.state === 'pre' ? '@' : `${g.away.score}–${g.home.score}`}</span><span>${esc(g.home.abbr)}</span>${HEART(g.fav)}</div>
      <div class="sub">${esc(statusLine(g))}${g.sit && g.sit.redZone ? `<span class="tag red">Red zone · ${esc(g.sit.poss || '')}</span>` : ''}${g.onBreak && g.state === 'in' ? `<span class="tag amber">${esc(g.breakWhy)}</span>` : ''}</div>
      ${pl || '<div class="pl"><span class="muted">None of your players</span></div>'}${chan}</div>`;
  }).join('') + (list.length > first + RADAR_ROWS ? `<div class="more">▼ ${list.length - first - RADAR_ROWS} more</div>` : ''));
}

/**
 * "You're watching": the last switches and why ("1:17 M. Nabers, 3rd & 4 at the NYJ 14"), ending with the game on
 * now and your top player's points. Slides in for 12 seconds after each switch, and stays while All Games is open.
 */
let tickerTimer = 0;
function renderTicker() {
  const g = game(auto.current);
  const time = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
  const items = auto.log.filter(l => l.game).slice(0, 5).reverse().map(l => `<span><b>${time(l.at)}</b> ${esc(l.label ? l.label + ', ' : '')}${esc(l.text)}</span>`);
  if (g) {
    const top = g.players.find(p => !p.opp);
    items.push(`<span class="now"><b>Now</b> ${esc(g.away.abbr)} at ${esc(g.home.abbr)}${top ? ` · ${esc(top.short)} ${pts(top.pts)}` : ''}</span>`);
  }
  setHtml($('#ticker .items'), items.join(''));
}
function showTicker() {
  renderTicker();
  $('#ticker').classList.add('on');
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(() => { if (!radarOpen) $('#ticker').classList.remove('on'); }, 12000);
}

// ---- Switch transition: slanted red and navy stripes sweep across with the new game and why, covering the second
// or two of black while its channel loads (like a network's stinger between segments).
function stinger(g, why) {
  const s = $('#stinger');
  const logo = t => `<img src="${esc(t.darkLogo || t.logo || '')}" alt="" onerror="this.remove()">`;
  s.innerHTML = '<i class="s1"></i><i class="s2"></i><i class="s3"></i>'
    + `<div class="in">${logo(g.away)}<b>${esc(g.away.abbr)}</b><span>@</span><b>${esc(g.home.abbr)}</b>${logo(g.home)}<em>${esc(why)}</em></div>`;
  s.classList.remove('on');
  void s.offsetWidth;   // restart the animation
  s.classList.add('on');
  clearTimeout(stinger.t);
  stinger.t = setTimeout(() => s.classList.remove('on'), 2600);
}

// ---- Points that count up: when a number goes up it rolls to the new value, and a "+gain" floats off it.
// Keyed by what it is (a player's points, a league's score) so the second-by-second redraws carry the roll on.
const rolls = {};   // key -> {from, to, at}
const ROLL_MS = 1400;
function rolled(key, value) {
  const r = rolls[key];
  if (!r) { rolls[key] = { from: value, to: value, at: 0 }; return value; }
  if (value > r.to + 0.04) { rolls[key] = { from: shownValue(r), to: value, at: Date.now() }; rollTick(); return rolls[key].from; }
  if (value < r.to - 0.04) rolls[key] = { from: value, to: value, at: 0 };   // corrections go straight there
  return shownValue(rolls[key]);
}
function shownValue(r) {
  const k = Math.min(1, (Date.now() - r.at) / ROLL_MS);
  return r.from + (r.to - r.from) * (1 - Math.pow(1 - k, 3));   // eases out
}
/** The number, with a floating "+gain" while it rolls. */
function rollHtml(key, value, gainAt) {
  const v = rolled(key, value), r = rolls[key], age = Date.now() - r.at;
  const gain = gainAt !== false && r.at && age < 2000 ? `<i class="gain" style="animation-delay:-${age}ms">+${pts(r.to - r.from)}</i>` : '';
  return `<span class="roll" data-roll="${esc(key)}">${pts(v)}</span>${gain}`;
}
/** A bar's width (percent) that slides to a new value, glowing while it moves. */
function rollBar(key, pct) {
  const r = rolls[key];
  if (r && Math.abs(pct - r.to) > 0.5) { rolls[key] = { from: shownValue(r), to: pct, at: Date.now() }; rollTick(); }
  else if (!r) rolls[key] = { from: pct, to: pct, at: 0 };
  const n = rolls[key], moving = n.at && Date.now() - n.at < ROLL_MS;
  return `<i data-roll-w="${esc(key)}" class="${moving ? 'moving' : ''}" style="width:${shownValue(n)}%"></i>`;
}
// The frame-by-frame updates run only while something is rolling (then stop, so the TV isn't redrawing for nothing).
let ticking = false;
function rollTick() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(function tick() {
    const now = Date.now();
    let any = false;
    for (const el of document.querySelectorAll('[data-roll]')) {
      const r = rolls[el.dataset.roll];
      if (r && r.at && now - r.at < ROLL_MS + 50) { el.textContent = pts(shownValue(r)); any = true; }
    }
    for (const el of document.querySelectorAll('[data-roll-w]')) {
      const r = rolls[el.dataset.rollW];
      if (r && r.at && now - r.at < ROLL_MS + 50) { el.style.width = shownValue(r) + '%'; any = true; }
      else el.classList.remove('moving');
    }
    if (any) requestAnimationFrame(tick); else ticking = false;
  });
}

/** Sets an element's HTML only when it changed: the second-by-second redraws then cost nothing while all is still. */
function setHtml(el, html) {
  if (!el || el._html === html) return false;
  el._html = html; el.innerHTML = html;
  return true;   // it was rewritten
}

// ---- Score flash: a team's score in the bug flips to the new number with a pulse of its colour.
const scoreSeen = {}, scoreAt = {};   // game:side -> last score / when it went up
function scoreClass(g, side) {
  const k = g.id + side, s = g[side].score;
  if (scoreSeen[k] != null && s > scoreSeen[k]) scoreAt[k] = Date.now();
  scoreSeen[k] = s;
  const age = Date.now() - (scoreAt[k] || 0);
  return age < 1600 ? { cls: 'flip', style: `--team:${g[side].color};animation-delay:-${age}ms` } : { cls: '', style: '' };
}

// ---- Drive tracker: under the score bug, how far the team with the ball has come toward the goal line.
function driveHtml(g) {
  if (g.state !== 'in' || !g.sit || g.sit.ytg == null || !g.sit.poss) return '';
  const off = g.sit.poss === g.home.abbr ? g.home : g.away;
  const pct = Math.max(2, Math.min(100, 100 - g.sit.ytg));
  const ball = Math.max(2, Math.min(97.5, pct));   // the ball stays on the bar at either end
  return `<div class="drive ${g.sit.ytg <= 20 ? 'rz' : ''}" style="--team:${off.color}">${rollBar('drive:' + g.id, pct)}<b style="left:${ball}%"></b></div>`;
}

// ---- Alerts beside the points popups: {kind: 'alert', tone: 'up' | 'down' | 'danger', big, line, sub, game?}.
function queueAlert(a) { popups.push({ kind: 'alert', showAt: Date.now(), team: { color: 'var(--cyan)' }, ...a }); }

// Injuries: one of your starters named in the same sentence as an injury in ESPN's play text ("D.Kincaid was injured
// during the play.", "Injury update: D.Kincaid is questionable to return."). A red alert, timed like the points popups
// (never before the play reaches your screen), once per player and game in 15 minutes.
const INJURY = /\b(?:injur(?:y|ed)|hurt|shaken up|questionable to return|doubtful to return|out for the (?:game|day|remainder)|ruled out|evaluated for a concussion|concussion protocol|carted off|(?:left|exited) the game)\b/i;
const injurySeen = {};   // player id + game -> when
function injuryFrom(g, text, mine, at) {
  if (settings.injuryAlerts === false || !INJURY.test(text)) return;
  const sentences = text.split(/(?<=[a-z0-9)])\.\s+/i);
  for (const p of mine) {
    if (p.team !== g.home.abbr && p.team !== g.away.abbr) continue;
    const n = espnName(p);
    if (!sentences.some(s => s.includes(n) && INJURY.test(s))) continue;
    const key = p.id + g.id;
    if (Date.now() - (injurySeen[key] || 0) < 15 * 60e3) continue;
    injurySeen[key] = Date.now();
    const watching = g.id === auto.current || (split && split.game === g.id);
    const why = (sentences.find(s => s.includes(n) && INJURY.test(s)) || '').match(/questionable to return|doubtful to return|ruled out|out for the \w+|concussion|carted off/i);
    popups.push({ kind: 'alert', tone: 'injury', showAt: at + popupWait(g, watching), game: g.id, team: p.team === g.home.abbr ? g.home : g.away,
      big: 'INJURY', line: `${p.short} ${!why ? 'is hurt' : /concussion/i.test(why[0]) ? 'being checked for a concussion' : /^out/i.test(why[0]) ? 'is ' + why[0].toLowerCase() : why[0].toLowerCase()}`,
      sub: `${g.away.abbr} @ ${g.home.abbr}` });
  }
}

// 1. Win-chance swings: a matchup's chance moving 20 points or more since the last alert (or since the TV started).
const swingBase = {};
setInterval(() => {
  if (!roster || settings.swingAlerts === false) return;
  for (const m of matchupsNow()) {
    if (m.win == null) continue;
    const b = swingBase[m.league];
    if (b == null) { swingBase[m.league] = m.win; continue; }
    if (Math.abs(m.win - b) < 0.2) continue;
    const up = m.win > b, pct = x => Math.round(x * 100) + '%';
    queueAlert({ tone: up ? 'up' : 'down', big: pct(m.win), line: `${m.league} · ${pct(b)} → ${pct(m.win)} to win`, sub: `vs ${m.opp}` });
    swingBase[m.league] = m.win;
  }
}, 5000);

// 2. Your opponents' starters: their touchdowns and 20+ yard plays, and their team reaching the red zone. Their game
// isn't the one on screen, so these come at once (the one on screen waits the popup delay); OK watches it.
const dangerSeen = {};   // game + possession + quarter -> red zone already called
function dangerFrom(g, before, text, at) {
  if (settings.dangerAlerts !== true || !roster.opponents) return;   // off unless you turn them on (busy)
  const opps = Object.values(roster.opponents).filter(p => !roster.players[p.id] && p.leagues.some(l => l.starter)
    && (p.team === g.home.abbr || p.team === g.away.abbr));
  if (!opps.length) return;
  const watching = g.id === auto.current || (split && split.game === g.id);
  const showAt = at + popupWait(g, watching);
  const vs = p => (p.leagues.find(l => l.starter) || p.leagues[0]).team;
  for (const p of opps) {
    const got = playPoints(p, text, g.sit.lastPlay.type);
    const yards = got ? +((/(-?\d+)-yd/.exec(got.what) || [])[1] || 0) : 0;
    if (!got || !(/touchdown/i.test(got.what) || yards >= 20)) continue;
    queueAlert({ tone: 'danger', big: `+${pts(got.pts)}`, line: `${p.short} · ${got.what}`, sub: `for ${vs(p)}`, game: g.id, showAt });
  }
  const key = `${g.id}:${g.sit.poss}:${g.period}`;
  if (g.sit.redZone && !(before && before.sit && before.sit.redZone) && !dangerSeen[key]) {
    const theirs = opps.filter(p => p.team === g.sit.poss && /QB|RB|WR|TE|K/.test(p.pos));
    if (theirs.length) {
      dangerSeen[key] = true;
      queueAlert({ tone: 'danger', big: 'RZ', line: `Red zone · ${g.sit.poss} ball · ${theirs.slice(0, 2).map(p => p.short).join(', ')}`,
        sub: `for ${vs(theirs[0])}`, game: g.id, showAt });
    }
  }
}

// 6. Final line card: one of your games just ended (when the end reaches your screen): your players' final lines.
const cardHit = {};   // player id -> {at, pts, color}: his play just reached the screen
let finals = [];
function spotFinals(prev, next) {
  for (const g of next.games) {
    const before = prev.games.find(x => x.id === g.id);
    if (!before || before.state !== 'in' || g.state !== 'post') continue;
    if (!Object.values(roster.players).some(p => p.leagues.some(l => l.starter) && (p.team === g.home.abbr || p.team === g.away.abbr))) continue;
    finals.push({ id: g.id, showAt: next.t + delayFor(g.id) * 1000 });
  }
}
setInterval(() => {
  const due = finals.find(f => f.showAt <= Date.now());
  if (!due) return;
  finals = finals.filter(f => f !== due);
  const g = game(due.id);
  if (!g) return;
  const mine = g.players.filter(p => !p.opp && !p.bench);
  if (!mine.length) return;
  $('#final').innerHTML = `<div class="hd"><span class="tag">FINAL</span>${bugTeam(g.away)}<b>${g.away.score}</b><span class="muted">–</span><b>${g.home.score}</b>${bugTeam(g.home, undefined, true)}</div>`
    + mine.slice(0, 5).map(p => `<div class="row"><span class="nm">${esc(p.short)} <small>${p.pos}</small></span><span class="ln">${esc(p.line) || '&nbsp;'}</span><b>${pts(p.pts)}</b></div>`).join('');
  $('#final').classList.add('on');
  setTimeout(() => $('#final').classList.remove('on'), 15000);
}, 1000);

// 3. Instant replay: OK on a points popup from the game on screen rewinds to just before the play, then back to
// live once it has aired again. (The rewind buffer keeps the last minute of the channel on screen.)
let replayOf = null;   // {until, espnAt, game}
function replay() {
  const r = replayOf;
  replayOf = null;
  // The play ended on screen about the channel's delay after ESPN posted it; start ~12 s before that.
  const back = Math.max(6, Math.min(58, Math.round((Date.now() - r.espnAt) / 1000 - delayFor(r.game) + 12)));
  rewindBy(back);
  toast('Instant replay');
  setTimeout(() => { if (behind > 0) rewindBy(0); }, 20000);
}

/**
 * His photo pops out of his card at three times the size, over everything, holds with TOUCHDOWN (or the points), then
 * drops back into the card. Returns false when there's no photo on his card to pop.
 */
// One pop-out at a time: a second touchdown waits for the first to finish, so each player gets his full moment.
const bigShotQueue = [];
let bigShotBusy = false;
function bigShot(p) {
  const card = $(`#rail .card[data-pid="${p.who.id}"]`), img = card && card.querySelector('.hs');
  if (!img || !img.naturalWidth) return false;
  if (bigShotBusy) { bigShotQueue.push(p); return true; }
  bigShotBusy = true;
  $('#ticker').classList.remove('on');   // "You're watching" steps aside for it
  const st = $('#stage').getBoundingClientRect(), s = st.width / 1920, r = img.getBoundingClientRect();
  const x = (r.left - st.left) / s, y = (r.top - st.top) / s, w = r.width / s, h = r.height / s;
  const W = w * 2.1, H = h * 2.1;   // about twice the card photo
  const top = (card.getBoundingClientRect().top - st.top) / s;
  const tx = 60, ty = top - H * .66;   // always the same spot: leaning out over the bar at the left, clear of the score bug
  const el = $('#bigShot'), labelLeft = false;
  el.className = labelLeft ? 'left' : '';
  el.style.cssText = `--team:${p.team.color};left:${tx}px;top:${ty}px;width:${W}px;height:${H}px`;
  el.innerHTML = `<i class="glow"></i><img src="${esc(img.src)}" alt="">`
    + `<div class="lbl"><b>${p.td ? 'TOUCHDOWN' : '+' + pts(p.pts)}</b><span>${esc(p.who.short)}${p.td ? ` <em>+${pts(p.pts)}</em>` : ''}</span></div>`;
  const small = `translate(${x - tx}px, ${y - ty}px) scale(${1 / 2.1})`;
  el.classList.add('on');
  el.getAnimations().forEach(a => a.cancel());
  // Easing per step (the timeline itself runs evenly): pop out, hold with a slight breath, drop back into the card.
  const out = 'cubic-bezier(.2,.9,.25,1.08)', inn = 'cubic-bezier(.55,0,.75,.2)', breathe = 'ease-in-out';
  el.animate([{ transform: small, easing: out }, { transform: 'none', offset: .15, easing: breathe }, { transform: 'scale(1.025)', offset: .48, easing: breathe },
    { transform: 'none', offset: .82, easing: inn }, { transform: small }], { duration: 4600, easing: 'linear', fill: 'forwards' });
  clearTimeout(bigShot.t);
  bigShot.t = setTimeout(() => {
    el.classList.remove('on');
    bigShotBusy = false;
    const next = bigShotQueue.shift();
    if (next) setTimeout(() => { if (!bigShot(next) && next.td) tdBanner(next); }, 250);   // the next one, after a beat
  }, 4600);
  return true;
}

// Your player's touchdown: a banner across the screen in his team's colours (about 4.5 s), photo and all.
function tdBanner(p) {
  const b = $('#tdBanner'), espn = p.who.espn;
  $('#ticker').classList.remove('on');   // "You're watching" steps aside for it
  b.style.setProperty('--team', p.team.color);
  b.style.setProperty('--team2', p.team.alt || '#fff');
  b.innerHTML = '<i class="s1"></i><i class="s2"></i><div class="in">'
    + (espn ? `<img src="https://a.espncdn.com/i/headshots/nfl/players/full/${espn}.png" alt="" onerror="this.remove()">` : '')
    + `<div class="tx"><b>TOUCHDOWN</b><span>${esc(p.who.short)} <em>+${pts(p.pts)}</em></span></div></div>`;
  b.classList.remove('on');
  void b.offsetWidth;
  b.classList.add('on');
  clearTimeout(tdBanner.t);
  tdBanner.t = setTimeout(() => b.classList.remove('on'), 4600);
}

// 4. Touchdown moment: your player scored, the bottom bar flashes the team's colour.
function flashTd(color) {
  const r = $('#rail');
  r.style.setProperty('--flash', color);
  r.classList.remove('td');
  void r.offsetWidth;
  r.classList.add('td');
}

// Popups stay up 12 seconds. OK acts on one at a time, the outlined one (the newest with an action, unless you've
// moved): while two or more have an action, Up and Down move the outline between them.
const POP_MS = 12000;
let popPickedAt = 0;   // when you last moved the outline with Up/Down
const actionPops = () => [...document.querySelectorAll('#pops .pop.on')].filter(el => el.act);   // newest first
function aimPop(el) {
  for (const o of document.querySelectorAll('#pops .pop')) o.classList.toggle('target', o === el);
  replayOf = null; jumpTo = null;
  if (!el) return;
  if (el.act.watch) jumpTo = { game: el.act.watch, until: el.hideAt, why: el.act.why };
  else replayOf = { until: el.hideAt, espnAt: el.act.espnAt, game: el.act.game };
}
function hidePop(el) {
  el.classList.remove('on');
  setTimeout(() => el.remove(), 500);
  if (el.classList.contains('target')) aimPop(actionPops()[0]);   // the outline moves to the newest one left
}

/** Every half second: popups that are due slide in on the right; ones whose time is up slide out. */
function showPopups() {
  const now = Date.now(), due = popups.filter(p => p.showAt <= now);
  for (const el of document.querySelectorAll('#pops .pop.on')) if (el.hideAt <= now) hidePop(el);
  popups = popups.filter(p => p.showAt > now && now - p.showAt < 120e3);
  for (const p of due) {
    playStats.shown++;
    // Your player in the game you're watching, with his card on screen: you saw the play and his card shows the
    // points, so no popup. His card still lights up, and a touchdown still gets its whole moment.
    const watching = p.game && (p.game === auto.current || (split && split.game === p.game));
    if (p.kind !== 'alert' && watching && $(`#rail .card[data-pid="${p.who.id}"]:not(.away)`)) {
      if (p.td) { flashTd(p.team.color); if (!bigShot(p)) tdBanner(p); }
      cardHit[p.who.id] = { at: Date.now(), pts: p.pts, color: p.team.color, td: !!p.td };
      continue;
    }
    const el = document.createElement('div');
    el.className = 'pop';
    el.style.setProperty('--team', p.team.color);
    // From another game: OK on the remote jumps there while it's up (the newest such popup wins).
    const elsewhere = p.game && p.game !== auto.current && (game(p.game) || {}).state === 'in';
    if (p.kind === 'alert') {
      el.classList.add('alert', p.tone);
      el.innerHTML = `<b class="pts">${esc(p.big)}</b><span class="who">${esc(p.line)}${p.sub ? ` <em>· ${esc(p.sub)}</em>` : ''}</span>`
        + (elsewhere ? '<span class="ok">OK · WATCH</span>' : '');
      if (elsewhere) el.act = { watch: p.game, why: p.line };
    } else {
      // From the game on screen: OK replays it (the TV app keeps the last minute).
      const canReplay = !elsewhere && native && p.espnAt && p.game === auto.current && !split;
      el.innerHTML = `<b class="pts">+${pts(p.pts)}</b><span class="who">${esc(p.who.short)}${p.teams > 1 ? ` ×${p.teams}` : ''} <em>· ${esc(p.what)}</em></span>`
        + (elsewhere ? '<span class="ok">OK · WATCH</span>' : canReplay ? '<span class="ok">OK · REPLAY</span>' : '');
      if (elsewhere) el.act = { watch: p.game, why: `${p.who.short}, ${p.what}` };
      else if (canReplay) el.act = { espnAt: p.espnAt, game: p.game };
      // Touchdowns only: his photo pops out of his card (other points get the card glow). A touchdown with no photo
      // to pop gets the banner instead.
      if (p.td) { flashTd(p.team.color); if (p.game !== auto.current || !bigShot(p)) tdBanner(p); }   // pop-out photo only for the game on screen
      cardHit[p.who.id] = { at: Date.now(), pts: p.pts, color: p.team.color, td: !!p.td };   // his card lights up with the gain
    }
    el.hideAt = now + POP_MS;
    $('#pops').prepend(el);   // the stack runs bottom-up: newest at the bottom, nearest your scores
    void el.offsetWidth;      // lay it out off-screen first, so adding .on slides it in (and marks it live at once)
    el.classList.add('on');
    // The newest with an action takes the outline, unless you picked one in the last few seconds.
    if (el.act && (now - popPickedAt > 6000 || !$('#pops .pop.target'))) aimPop(el);
    // At most four up at once: the oldest go first (never the one you picked).
    const live = [...document.querySelectorAll('#pops .pop.on')];
    for (const old of live.slice(4)) if (!old.classList.contains('target')) hidePop(old);
  }
}

/** Up/Down while two or more popups have an action: move the outline between them (Up = older, higher in the
 *  stack). Every popup up stays at least 6 more seconds so you have time to choose. True when it used the key. */
function stepPops(dir) {
  const list = actionPops();
  if (list.length < 2) return false;
  const now = Date.now();
  for (const el of document.querySelectorAll('#pops .pop.on')) el.hideAt = Math.max(el.hideAt, now + 6000);
  const at = list.findIndex(el => el.classList.contains('target'));
  aimPop(list[Math.max(0, Math.min(list.length - 1, at + dir))]);
  popPickedAt = now;
  return true;
}
setInterval(showPopups, 500);

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 4000);
}

async function pairCode() {
  let url = location.origin + '/remote.html';
  try { url = (await (await fetch('/api/info')).json()).remote; } catch { /* use this host */ }
  for (const el of document.querySelectorAll('.pairUrl, #pairUrl')) el.textContent = url.replace(/^https?:\/\//, '');
  if (!window.QRCode) return;
  for (const el of [$('#qr'), $('#idleQr')]) if (!el.children.length) new QRCode(el, { text: url, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' });
  if (!$('#setupQr').children.length) new QRCode($('#setupQr'), { text: url, width: 260, height: 260, colorDark: '#000', colorLight: '#fff' });
}

// ---- First-launch remote tour: once, the first time your players are on screen (or again from the phone). Each step
// dims the screen and outlines what it's about; OK goes on, Back skips the rest. Keep these in step with the keys below.
const TOUR = [
  { title: 'Welcome to FantasyTV', text: 'A quick tour of your remote. Press OK for the next tip, or Back to skip the tour.' },
  { key: '▲', target: '#atTag', title: 'Up: AutoTune on / off',
    text: 'AutoTune switches to the game that matters most to your lineup. Press Up to stay where you are; Up again turns it back on. Before a switch, a 5 second countdown shows: OK or Back cancels it.' },
  { key: '▼', target: '#radar', radar: true, right: true, title: 'Down: every game',
    text: 'All the live games, yours first. Up and Down move, OK watches a game, ▶ hearts it (AutoTune favors hearted games in close calls), Back closes the list. A game you pick stays on for 45 seconds (less if it goes to a commercial), then AutoTune takes over again. To stay on it, turn AutoTune off with Up.' },
  { key: '◀ ▶', target: '#bug .in', title: 'Left: rewind · Right: live',
    text: 'Left jumps back 10 seconds (again for more, up to a minute). Right goes back to live.' },
  { key: 'OK', target: '#pops .demo', demo: 1, title: 'OK on a popup',
    text: 'When your players score, a popup slides in. OK replays the play, or takes you to that game if it\'s on another channel.' },
  { key: '▲ ▼', target: '#pops .demo', demo: 3, title: 'Several popups? Pick one',
    text: 'With more than one up, Up and Down move the white outline. OK acts on the outlined one.' },
  { target: '#rail', title: 'Your players and matchups',
    text: 'A card glows when your starter scores, and a touchdown pops his photo out. On the right: each league\'s score and your chance to win.' },
  { key: '📱', qr: true, title: 'Your phone is the remote',
    text: 'Scan this code with your phone: settings, the channel for each game, rewind and more. It\'s also at the bottom of the game list (Down). Enjoy the games!' },
];
const tour = { on: false, at: 0 };
const tourDone = () => { try { return localStorage.getItem('ftv.tourDone') === '1'; } catch { return true; } };

function startTour() {
  tour.on = true; tour.at = 0;
  $('#tour').classList.add('on');
  showTourStep();
}
function endTour() {
  tourStepCleanup();
  tour.on = false;
  $('#tour').classList.remove('on');
  try { localStorage.setItem('ftv.tourDone', '1'); } catch { /* shows again next time; fine */ }
}
function tourStepCleanup() {
  for (const d of document.querySelectorAll('#pops .demo')) d.remove();
  if (radarOpen && tour.radar) { radarOpen = false; $('#radar').classList.remove('on'); $('#ticker').classList.remove('on'); }
  tour.radar = false;
}
function showTourStep() {
  tourStepCleanup();
  const s = TOUR[tour.at], t = $('#tour'), card = t.querySelector('.tcard');
  t.querySelector('.key').textContent = s.key || '';
  t.querySelector('.n').textContent = `${tour.at + 1} / ${TOUR.length}`;
  t.querySelector('h3').textContent = s.title;
  t.querySelector('p').textContent = s.text;
  t.querySelector('.nav span').innerHTML = `<b>OK</b> ${tour.at === TOUR.length - 1 ? 'done' : 'next'}`;
  card.classList.toggle('right', !!s.right);
  // The phone step: the same pairing code as the game list's, to scan right here.
  const qr = card.querySelector('.tqr');
  if (qr) qr.remove();
  const canvas = s.qr && $('#qr canvas'), img = s.qr && $('#qr img');
  const src = canvas ? canvas.toDataURL() : img && img.src;
  if (src) card.querySelector('p').insertAdjacentHTML('afterend', `<div class="tqr"><img src="${src}" alt=""><span>Scan with your phone camera (same Wi-Fi)</span></div>`);
  if (s.radar) { tour.radar = true; radarOpen = true; radarFocus = 0; $('#radar').classList.add('on'); renderRadar(); }
  // Sample popups to point at: the newest outlined, with its OK label.
  const samples = [['+6.8', 'Your WR', '12-yd catch, TOUCHDOWN', 'OK · REPLAY'], ['+1.4', 'Your RB', '9-yd run'], ['+0.6', 'Your QB', '14-yd pass']];
  for (let i = (s.demo || 0) - 1; i >= 0; i--) {
    const [p, who, what, ok] = samples[i], el = document.createElement('div');
    el.className = `pop on demo ${i === 0 ? 'target' : ''}`;
    el.style.setProperty('--team', 'var(--cyan)');
    el.innerHTML = `<b class="pts">${p}</b><span class="who">${who} <em>· ${what}</em></span>${i === 0 ? `<span class="ok">${ok || 'OK · WATCH'}</span>` : ''}`;
    $('#pops').prepend(el);
  }
  // Outline the target once it's in place (the game list slides in, so wait for it to finish).
  setTimeout(() => {
    if (!tour.on || TOUR[tour.at] !== s) return;
    // Everything the target names, as one box (all the sample popups, say).
    const rs = s.target ? [...document.querySelectorAll(s.target)].map(e => e.getBoundingClientRect()).filter(b => b.width && b.height) : [];
    const r = rs.length && { left: Math.min(...rs.map(b => b.left)), top: Math.min(...rs.map(b => b.top)),
      right: Math.max(...rs.map(b => b.right)), bottom: Math.max(...rs.map(b => b.bottom)) };
    if (r) { r.width = r.right - r.left; r.height = r.bottom - r.top; }
    const spot = t.querySelector('.spot'), on = !!r;
    t.classList.toggle('spotted', on); t.classList.toggle('nospot', !on);
    if (!on) return;
    const st = $('#stage').getBoundingClientRect(), k = st.width / 1920, pad = 10;
    Object.assign(spot.style, { left: `${(r.left - st.left) / k - pad}px`, top: `${(r.top - st.top) / k - pad}px`,
      width: `${r.width / k + pad * 2}px`, height: `${r.height / k + pad * 2}px` });
  }, s.radar ? 450 : 30);
}
function tourKey(k) {
  if (k === 'Enter' || k === 'ArrowRight') { if (++tour.at >= TOUR.length) endTour(); else showTourStep(); }
  else if (k === 'ArrowLeft' && tour.at > 0) { tour.at--; showTourStep(); }
  else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack') endTour();
}
// The first time your players are on screen after setup: the tour, once.
setInterval(() => {
  if (!tour.on && !tourDone() && $('#rail .card') && $('#splash').classList.contains('gone') && !$('#setup').classList.contains('on')) startTour();
}, 2000);

// ---- TV remote keys: arrows, OK (Enter), Back (Escape/Backspace), P to pause. The TV app sends them through
// ftvKey; Back only comes here while All Games is open or a switch is counting down (Android.setBack).
addEventListener('keydown', onKey);
window.ftvKey = key => onKey({ key, repeat: false, preventDefault() {} });
setInterval(() => native && native.setBack(tour.on || radarOpen || !!auto.pending || Date.now() < updateCardUntil), 250);

function onKey(e) {
  const k = e.key;
  if (e.repeat) return;
  if (tour.on) { tourKey(k); e.preventDefault(); return; }   // the remote tour has the keys while it's up
  // Welcome screen: OK opens "Install unknown apps" for FantasyTV until it's allowed.
  if ($('#setup').classList.contains('on')) {
    if (k === 'Enter' && native && native.canInstall && !native.canInstall()) native.allowInstalls();
    return;
  }
  if (auto.pending && (k === 'Enter' || k === 'Escape' || k === 'Backspace')) { auto.cancel(); loop(); e.preventDefault(); return; }
  // The update card: OK installs, Back puts it off.
  if (Date.now() < updateCardUntil && (k === 'Enter' || k === 'Escape' || k === 'Backspace')) {
    if (k === 'Enter') startUpdate(); else { $('#update').classList.remove('on'); updateCardUntil = 0; }
    e.preventDefault();
    return;
  }
  // Rewind (TV app), like a video player: Left rewinds 10 s (again for more), Right (or OK) goes back to live.
  // Down opens All Games.
  if (!radarOpen && native) {
    if (behind > 0 && (k === 'ArrowRight' || k === 'Enter')) { rewindBy(0); e.preventDefault(); return; }
    if (k === 'ArrowLeft' || k === 'MediaRewind') { rewindBy(10); e.preventDefault(); return; }
  }
  // OK while a popup from the game on screen is up: instant replay.
  if (!radarOpen && k === 'Enter' && replayOf && Date.now() < replayOf.until) { replay(); e.preventDefault(); return; }
  // OK while a popup from another game is up: watch that game (like picking it yourself).
  if (!radarOpen && k === 'Enter' && jumpTo && Date.now() < jumpTo.until) {
    const to = jumpTo.game;
    jumpTo = null;
    const r = auto.pick(to);
    if (r.switchTo) tune(r.switchTo, r.why);
    e.preventDefault();
    return;
  }
  if (!radarOpen && (k === 'ArrowUp' || k === 'ArrowDown') && stepPops(k === 'ArrowUp' ? 1 : -1)) { e.preventDefault(); return; }
  if (!radarOpen) {
    if (k === 'ArrowDown' || k === 'r' || k === 'ContextMenu') { radarOpen = true; radarFocus = 0; $('#radar').classList.add('on'); renderRadar(); }
    else if (k === 'ArrowUp' || k === 'p') handle({ type: 'pause', on: !auto.paused });   // ▲ turns AutoTune on and off
    return;
  }
  const list = radarList();
  if (k === 'ArrowDown') radarFocus = Math.min(list.length - 1, radarFocus + 1);
  else if (k === 'ArrowUp') radarFocus = Math.max(0, radarFocus - 1);
  else if (k === 'ArrowRight' && list[radarFocus] && !list[radarFocus].redzone && !list[radarFocus].upd) handle({ type: 'heart', id: list[radarFocus].id });
  else if (k === 'Enter' && list[radarFocus]) {
    if (list[radarFocus].upd) startUpdate();
    else if (list[radarFocus].redzone) watchRedZone();
    else if (list[radarFocus].state === 'in') handle({ type: 'pick', id: list[radarFocus].id });
    radarOpen = false;
    showTicker();   // All Games kept "You're watching" up; it goes after its usual 12 s
  }
  else if (k === 'p') handle({ type: 'pause', on: !auto.paused });
  else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack') { radarOpen = false; $('#ticker').classList.remove('on'); }
  $('#radar').classList.toggle('on', radarOpen);
  renderRadar();
  e.preventDefault();
}

start();
