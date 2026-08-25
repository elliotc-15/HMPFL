/* ===========================================================
   HMPFL — App logic
   - Renders historical data (from data.js, sourced from league spreadsheet)
   - Fetches live data from Sleeper's public API client-side
   =========================================================== */

const SLEEPER_API = 'https://api.sleeper.app/v1';

// ---------- Utilities ----------
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return e;
}
function fmt(n, d = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtInt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Math.round(n);
}
async function sleeperFetch(path) {
  const res = await fetch(`${SLEEPER_API}${path}`);
  if (!res.ok) throw new Error(`Sleeper API error ${res.status} on ${path}`);
  return res.json();
}
// NFL's /state/nfl endpoint keeps counting "week" through the preseason,
// so a raw week number is meaningless without checking season_type first —
// otherwise preseason week 3 reads as if the real Week 3 had already happened.
function isRegularSeasonLive(state) {
  return !!state && state.season_type === 'regular';
}

// ---------- Sleeper history walker ----------
// Walks previous_league_id chain to gather all Sleeper-era seasons for this league.
let sleeperHistoryCache = null;
async function loadSleeperHistory() {
  if (sleeperHistoryCache) return sleeperHistoryCache;
  const seasons = [];
  let currentId = SLEEPER_LEAGUE_ID;
  let hops = 0;
  while (currentId && hops < 8) {
    hops++;
    let league;
    try {
      league = await sleeperFetch(`/league/${currentId}`);
    } catch (e) {
      break;
    }
    if (!league || !league.league_id) break;
    const [users, rosters] = await Promise.all([
      sleeperFetch(`/league/${currentId}/users`).catch(() => []),
      sleeperFetch(`/league/${currentId}/rosters`).catch(() => []),
    ]);
    let draft = null, picks = [];
    if (league.draft_id) {
      draft = await sleeperFetch(`/draft/${league.draft_id}`).catch(() => null);
      picks = await sleeperFetch(`/draft/${league.draft_id}/picks`).catch(() => []);
    }
    seasons.push({ league, users, rosters, draft, picks, matchups: null });
    currentId = league.previous_league_id || null;
  }
  seasons.sort((a, b) => Number(a.league.season) - Number(b.league.season));
  sleeperHistoryCache = seasons;
  return seasons;
}

async function loadMatchupsForSeason(seasonObj, maxWeek = 17) {
  if (seasonObj.matchups) return seasonObj.matchups;
  const weeks = [];
  for (let w = 1; w <= maxWeek; w++) weeks.push(w);
  const results = await Promise.all(
    weeks.map(w => sleeperFetch(`/league/${seasonObj.league.league_id}/matchups/${w}`).catch(() => []))
  );
  seasonObj.matchups = results; // index 0 = week 1
  return results;
}

// For every player who appeared in any lineup that season: total fantasy
// points scored (per this league's own scoring, straight from Sleeper's
// matchup data), how many weeks they started, and how many of those starts
// were in a game their team won.
let playerSeasonStatsCache = new WeakMap();
async function buildPlayerSeasonStats(season) {
  if (playerSeasonStatsCache.has(season)) return playerSeasonStatsCache.get(season);
  const matchups = await loadMatchupsForSeason(season, 17);
  const stats = {};
  const touch = (pid) => (stats[pid] = stats[pid] || { points: 0, starts: 0, startsInWins: 0 });
  matchups.forEach(week => {
    if (!week || !week.length) return;
    const byMatch = {};
    week.forEach(entry => {
      if (entry.matchup_id === null || entry.matchup_id === undefined) return;
      (byMatch[entry.matchup_id] = byMatch[entry.matchup_id] || []).push(entry);
    });
    week.forEach(entry => {
      const pair = byMatch[entry.matchup_id] || [];
      const opp = pair.find(e => e !== entry);
      const won = !!opp && entry.points > opp.points;
      Object.entries(entry.players_points || {}).forEach(([pid, pts]) => {
        touch(pid).points += pts || 0;
      });
      (entry.starters || []).forEach(pid => {
        if (!pid || pid === '0') return;
        const s = touch(pid);
        s.starts += 1;
        if (won) s.startsInWins += 1;
      });
    });
  });
  playerSeasonStatsCache.set(season, stats);
  return stats;
}

function userDisplayName(u) {
  return (u.metadata && u.metadata.team_name) || u.display_name || u.username || 'Unknown';
}
function rosterOwnerName(rosterId, season) {
  const roster = season.rosters.find(r => r.roster_id === rosterId);
  if (!roster) return `Roster ${rosterId}`;
  const user = season.users.find(u => u.user_id === roster.owner_id);
  return user ? userDisplayName(user) : `Roster ${rosterId}`;
}

// ---------- MANAGER NAME MAPPING ----------
// Maps a spreadsheet owner's name (e.g. "Elliot") to the Sleeper display/team
// name(s) they've used, so Sleeper-era data can be folded into the same
// career totals rather than showing up as a separate "person".
// Sourced from the manager/team-name spreadsheet (2023-2025 Sleeper-era team
// names, plus known nicknames). Past players who left before the Sleeper
// switch (Clarence, Callum, Pete, Midge) have no Sleeper-era names and are
// intentionally omitted.
const MANAGER_MAP = {
  "Elliot": ["Deebo-Lution", "Steed MalBroncos", "Njoku and the Thief"],
  "Josh": ["L.A. Knights (YEAH!)", "Skol Campbell", "Maydeday Parade"],
  "Matthew": ["Deej", "Diamond Dallas Cowboys", "Vincent Tannehill", "Fleetwood Mack"],
  "Ashley": ["The 619ers", "Michu in the Playoffs", "Green Day Packers"],
  "James": ["Russelmania", "Titus BramBills", "My Chemical Romo"],
  "Joe": ["Big Bosa Man", "Amon Ra Scott Brown", "Red Hot Jabrill Peppers"],
  "Mike": ["Brock Bottom", "Dirk KuytBoys", "Koo Fighters"],
  "Carter": ["Dan", "The Tribal Chiefs", "Papiss Demba Breece", "Born to Run the Damn Ball"],
  "Dylan": ["Doc", "You Can't CeeDee Me", "Warnockin' the pocket", "System of a Brown"],
  "Morgan": ["Binky", "Deandre the Giant", "LamArsenal", "Kmetallica"],
  "Jack": ["Jev", "A real Religious Team", "David N'Gog Birds", "Manning Glory"],
  "Rhys": ["Bearman", "Stone Cold Tavon Austin", "Green Ray Parlours", "Iron Jayden"],
};
function canonicalOwnerName(sleeperName) {
  for (const [canonical, aliases] of Object.entries(MANAGER_MAP)) {
    if (aliases.includes(sleeperName)) return canonical;
  }
  return sleeperName; // no mapping yet — use the raw Sleeper name as-is
}

// ---------- LIVE SEASON MERGE ----------
// Any Sleeper season not yet in the spreadsheet-derived SEASON_DATA (e.g. a
// just-finished season, or the season currently in progress) gets computed
// live from Sleeper and merged in, so the Home / Seasons / Fame / Inmates
// tabs all pick it up automatically. Loops every Sleeper season rather than
// just the latest, since more than one season can be missing at once (a
// completed-but-unmerged season plus the new one already under way).
let liveMergeDone = false;
async function ensureLiveSeasonMerged() {
  if (liveMergeDone) return;
  const seasons = await loadSleeperHistory();
  for (const season of seasons) {
    const yr = String(season.league.season);
    if (SEASON_DATA[yr] && Object.keys(SEASON_DATA[yr]).length) continue;

    const entries = {};
    const standings = season.rosters.map(r => {
      const name = canonicalOwnerName(rosterOwnerName(r.roster_id, season));
      const s = r.settings || {};
      return {
        name,
        wins: s.wins || 0, losses: s.losses || 0,
        pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
        pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      };
    }).sort((a, b) => b.wins - a.wins || b.pf - a.pf);

    standings.forEach((s, i) => {
      entries[s.name] = {
        wins: s.wins, losses: s.losses, pf: s.pf, pa: s.pa,
        league_winner: i === 0, // best regular-season record
        overall_winner: false, scoring_title: false,
        playoff_wins: null, playoff_losses: null,
      };
    });

    try {
      const bracket = await sleeperFetch(`/league/${season.league.league_id}/winners_bracket`);
      const finalMatch = (bracket || []).find(m => m.p === 1);
      if (finalMatch && finalMatch.w) {
        const champName = canonicalOwnerName(rosterOwnerName(finalMatch.w, season));
        if (entries[champName]) entries[champName].overall_winner = true;
      }
    } catch (e) { /* bracket may not exist yet if season is in progress */ }

    SEASON_DATA[yr] = entries;
  }
  liveMergeDone = true;
}

// ---------- TAB ROUTING ----------
const renderedTabs = new Set();
function activateTab(name) {
  document.querySelectorAll('.overlay-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  if (name !== 'live' && liveScoresInterval) { clearInterval(liveScoresInterval); liveScoresInterval = null; }
  if (!renderedTabs.has(name)) {
    renderedTabs.add(name);
    renderers[name] && renderers[name]();
  }
}
document.getElementById('tabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.overlay-btn');
  if (!btn) return;
  activateTab(btn.dataset.tab);
  closeMenu();
});

// ---------- HAMBURGER MENU ----------
const menuToggle = document.getElementById('menuToggle');
const menuClose = document.getElementById('menuClose');
const tabOverlay = document.getElementById('tabOverlay');
function openMenu() {
  tabOverlay.classList.add('open');
  tabOverlay.setAttribute('aria-hidden', 'false');
  menuToggle.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  tabOverlay.classList.remove('open');
  tabOverlay.setAttribute('aria-hidden', 'true');
  menuToggle.setAttribute('aria-expanded', 'false');
}
menuToggle.addEventListener('click', openMenu);
menuClose.addEventListener('click', closeMenu);
tabOverlay.addEventListener('click', (e) => { if (e.target === tabOverlay) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------- LOGO = HOME BUTTON ----------
const homeLogoBtn = document.getElementById('homeLogoBtn');
function goHome() {
  activateTab('home');
  closeMenu();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
homeLogoBtn.addEventListener('click', goHome);
homeLogoBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });

// ---------- SORTABLE TABLE HELPER ----------
function makeSortable(table) {
  const ths = table.querySelectorAll('th[data-key]');
  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const type = th.dataset.type || 'num';
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      ths.forEach(t => delete t.dataset.dir);
      th.dataset.dir = dir;
      rows.sort((a, b) => {
        let va = a.dataset[key], vb = b.dataset[key];
        if (type === 'num') { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

// ===========================================================
// TAB 1: HOME
// ===========================================================
const HOME_BLURB = 'Est. 2014, His Majesty’s Prison Fantasy League has processed sixteen inmates through more than a decade of fantasy football, waiver-wire heists, trade-deadline plea bargains, and one unforgivable last-place sentence handed down every single year. Started on NFL.com, transferred to Sleeper in the 2023 intake. Welcome to the block. Nobody gets out clean.';

async function renderHome() {
  const root = document.getElementById('tab-home');
  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 01' }, [
    el('h2', { class: 'section-title' }, 'Booking Report'),
    el('p', { class: 'recap-prose', style: 'font-size:14px;' }, HOME_BLURB),
  ]));

  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 01A' }, [
    el('h2', { class: 'section-title' }, 'League at a Glance'),
    el('div', { class: 'stat-grid' }, [
      statCard(alltimeTotalSeasons(), 'Seasons Served'),
      statCard(ALLTIME.length, 'Inmates Booked'),
      statCard('—', 'Reigning Champion', true, 'reigningChampionVal'),
      statCard('—', 'This Week’s Top Scorer', true, 'topScorerVal'),
    ]),
  ]));

  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 01B' }, [
    el('h2', { class: 'section-title' }, 'Current Standings'),
    el('p', { class: 'section-desc' }, 'Live from Sleeper — pulled fresh every time this page loads.'),
    el('div', { id: 'homeStatus' }, el('div', { class: 'status-msg' }, ['Contacting the warden\u2019s office', el('span', { class: 'blink' }, '...')])),
  ]));

  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 01C' }, [
    el('h2', { class: 'section-title' }, 'This Week’s Matchups'),
    el('div', { id: 'homeMatchups' }, el('div', { class: 'status-msg' }, ['Checking the visitation schedule', el('span', { class: 'blink' }, '...')])),
  ]));

  try {
    await ensureLiveSeasonMerged();
    const champVal = document.getElementById('reigningChampionVal');
    if (champVal) champVal.textContent = reigningChampion();
    const seasons = await loadSleeperHistory();
    const latest = seasons[seasons.length - 1];
    renderHomeStandings(latest);
    await renderHomeMatchups(latest);
  } catch (e) {
    document.getElementById('homeStatus').innerHTML = '';
    document.getElementById('homeStatus').appendChild(
      el('div', { class: 'status-msg error' }, 'Could not reach Sleeper right now. The cell doors are jammed — try refreshing.')
    );
  }
}
function statCard(val, lbl, isText, id) {
  const valDiv = el('div', { class: 'val' }, String(val));
  if (id) valDiv.id = id;
  return el('div', { class: 'stat-card' }, [valDiv, el('div', { class: 'lbl' }, lbl)]);
}
function reigningChampion() {
  const years = Object.keys(SEASON_DATA).filter(y => Object.keys(SEASON_DATA[y]).length).sort((a, b) => b - a);
  for (const y of years) {
    const champ = Object.entries(SEASON_DATA[y]).find(([, s]) => s.overall_winner);
    if (champ) return `${champ[0]} (${y})`;
  }
  return '—';
}
async function renderHomeMatchups(latest) {
  const holder = document.getElementById('homeMatchups');
  if (!latest) { holder.innerHTML = ''; holder.appendChild(el('div', { class: 'status-msg' }, 'No active season found.')); return; }
  try {
    const state = await sleeperFetch('/state/nfl');
    holder.innerHTML = '';
    if (!isRegularSeasonLive(state)) {
      holder.appendChild(el('p', { class: 'section-desc' }, `${latest.league.season} season`));
      holder.appendChild(el('div', { class: 'status-msg' }, 'Preseason — matchups begin once Week 1 kicks off.'));
      updateTopScorer(null);
      return;
    }
    const week = state.week || 1;
    const matchups = await sleeperFetch(`/league/${latest.league.league_id}/matchups/${week}`);
    const byMatch = {};
    (matchups || []).forEach(entry => {
      if (entry.matchup_id === null || entry.matchup_id === undefined) return;
      (byMatch[entry.matchup_id] = byMatch[entry.matchup_id] || []).push(entry);
    });
    const pairs = Object.values(byMatch).filter(p => p.length === 2);
    holder.appendChild(el('p', { class: 'section-desc' }, `Week ${week} · ${latest.league.season}`));
    if (!pairs.length) {
      holder.appendChild(el('div', { class: 'status-msg' }, 'No matchups found for the current week yet.'));
      updateTopScorer(null);
      return;
    }
    let top = null;
    const grid = el('div', { class: 'mug-grid' });
    pairs.forEach(([a, b]) => {
      const nameA = rosterOwnerName(a.roster_id, latest);
      const nameB = rosterOwnerName(b.roster_id, latest);
      const ptsA = a.points || 0, ptsB = b.points || 0;
      if (!top || ptsA > top.pts) top = { name: nameA, pts: ptsA };
      if (!top || ptsB > top.pts) top = { name: nameB, pts: ptsB };
      const leading = ptsA > ptsB ? nameA : (ptsB > ptsA ? nameB : null);
      grid.appendChild(el('div', { class: 'mug-card', style: 'cursor:default' }, [
        el('div', { style: 'padding:16px;' }, [
          matchupRow(nameA, ptsA.toFixed(2), leading === nameA),
          el('div', { style: 'text-align:center;color:var(--brass);font-family:IBM Plex Mono,monospace;font-size:10px;margin:6px 0;' }, 'VS'),
          matchupRow(nameB, ptsB.toFixed(2), leading === nameB),
        ]),
      ]));
    });
    holder.appendChild(grid);
    updateTopScorer(top);
  } catch (e) {
    holder.innerHTML = '';
    holder.appendChild(el('div', { class: 'status-msg error' }, 'Could not load this week’s matchups.'));
    updateTopScorer(null);
  }
}
function updateTopScorer(top) {
  const valDiv = document.getElementById('topScorerVal');
  if (!valDiv) return;
  valDiv.textContent = top ? `${top.name} (${fmt(top.pts)})` : '—';
}
function alltimeTotalSeasons() {
  return Math.max(...ALLTIME.map(o => o.seasons || 0));
}
function renderHomeStandings(season) {
  const status = document.getElementById('homeStatus');
  status.innerHTML = '';
  if (!season) {
    status.appendChild(el('div', { class: 'status-msg' }, 'No Sleeper season found yet for this league ID.'));
    return;
  }
  const rows = season.rosters
    .map(r => {
      const user = season.users.find(u => u.user_id === r.owner_id);
      const name = user ? userDisplayName(user) : `Roster ${r.roster_id}`;
      const s = r.settings || {};
      return { name, wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0, fpts: (s.fpts || 0) + (s.fpts_decimal || 0) / 100, fpa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100 };
    })
    .sort((a, b) => b.wins - a.wins || b.fpts - a.fpts);

  const table = el('div', { class: 'table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'Cellmate'), el('th', {}, 'W'), el('th', {}, 'L'), el('th', {}, 'T'), el('th', {}, 'PF'), el('th', {}, 'PA')
    ])),
    el('tbody', {}, rows.map((r, i) => el('tr', {}, [
      el('td', { class: 'owner-cell' }, `${i + 1}. ${r.name}`),
      el('td', {}, String(r.wins)), el('td', {}, String(r.losses)), el('td', {}, String(r.ties)),
      el('td', { class: 'num-cell' }, fmt(r.fpts)), el('td', { class: 'num-cell' }, fmt(r.fpa)),
    ]))),
  ]));
  status.appendChild(el('p', { class: 'section-desc' }, `Season ${season.league.season} · League: ${season.league.name}`));
  status.appendChild(table);
}

// ===========================================================
// TAB 2: ALL-TIME LEADERBOARD
// ===========================================================
function renderAlltime() {
  const root = document.getElementById('tab-alltime');
  const rows = [...ALLTIME].sort((a, b) => b.wins - a.wins);
  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      th('Inmate', 'owner', 'str'), th('Seasons', 'seasons'), th('W', 'wins'), th('L', 'losses'),
      th('Win %', 'winpct'), th('Championships', 'overall_winner'),
      th('Scoring Titles', 'scoring_titles'), th('PF', 'pf'), th('PA', 'pa'), th('Playoff W-L', 'playoff_wins'),
    ])),
    el('tbody', {}, rows.map(o => {
      const winpct = o.wins / (o.wins + o.losses) || 0;
      const ownerLink = el('span', { class: 'owner-link' }, o.owner);
      ownerLink.addEventListener('click', () => { activateTab('teams'); renderTeamDetail(o.owner); });
      const tr = el('tr', {}, [
        el('td', { class: 'owner-cell' }, ownerLink),
        el('td', { class: 'num-cell' }, fmtInt(o.seasons)),
        el('td', { class: 'num-cell' }, fmtInt(o.wins)),
        el('td', { class: 'num-cell' }, fmtInt(o.losses)),
        el('td', { class: 'num-cell' }, (winpct * 100).toFixed(1) + '%'),
        el('td', { class: 'num-cell' }, o.overall_winner ? el('span', { class: 'pill pill-gold' }, `🏆 ${o.overall_winner}`) : '0'),
        el('td', { class: 'num-cell' }, fmtInt(o.scoring_titles)),
        el('td', { class: 'num-cell' }, fmt(o.pf, 0)),
        el('td', { class: 'num-cell' }, fmt(o.pa, 0)),
        el('td', { class: 'num-cell' }, `${fmtInt(o.playoff_wins)}-${fmtInt(o.playoff_losses)}`),
      ]);
      tr.dataset.owner = o.owner; tr.dataset.seasons = o.seasons; tr.dataset.wins = o.wins; tr.dataset.losses = o.losses;
      tr.dataset.winpct = winpct; tr.dataset.overall_winner = o.overall_winner;
      tr.dataset.scoring_titles = o.scoring_titles; tr.dataset.pf = o.pf; tr.dataset.pa = o.pa; tr.dataset.playoff_wins = o.playoff_wins;
      return tr;
    })),
  ]);
  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 02' }, [
    el('h2', { class: 'section-title' }, 'All-Time Leaderboard'),
    el('p', { class: 'section-desc' }, `Career records across all ${alltimeTotalSeasons()} seasons of the league\u2019s history. Click a column header to sort.`),
    el('div', { class: 'table-wrap' }, table),
  ]));
  makeSortable(table);
}
function th(label, key, type) {
  const t = el('th', { 'data-key': key }, label);
  if (type) t.dataset.type = type;
  return t;
}

// ===========================================================
// TAB 3: SEASON BY SEASON
// ===========================================================
async function renderSeasons() {
  const root = document.getElementById('tab-seasons');
  const loadingMsg = el('div', { class: 'status-msg' }, ['Pulling the latest intake records', el('span', { class: 'blink' }, '...')]);
  root.appendChild(loadingMsg);
  try { await ensureLiveSeasonMerged(); } catch (e) { /* fall back to spreadsheet-only years */ }
  root.removeChild(loadingMsg);

  const years = Object.keys(SEASON_DATA).filter(y => Object.keys(SEASON_DATA[y]).length).sort((a, b) => b - a);
  const panel = el('div', { class: 'panel', 'data-file-no': 'FILE 03' }, [
    el('h2', { class: 'section-title' }, 'Season-by-Season History'),
    el('p', { class: 'section-desc' }, 'Pick a season to view full standings for that year.'),
  ]);
  const select = el('select', { id: 'seasonSelect' }, years.map(y => el('option', { value: y }, y)));
  panel.appendChild(el('div', { class: 'control-row' }, [el('label', {}, 'Season:'), select]));
  const tableHolder = el('div', { id: 'seasonTableHolder' });
  panel.appendChild(tableHolder);
  root.appendChild(panel);

  function renderYear(y) {
    tableHolder.innerHTML = '';
    const data = SEASON_DATA[y] || {};
    const rows = Object.entries(data).map(([owner, s]) => ({ owner, ...s }))
      .sort((a, b) => (b.wins || 0) - (a.wins || 0) || (b.pf || 0) - (a.pf || 0));
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, ['Inmate', 'W', 'L', 'PF', 'PA', 'Playoffs', 'Honors'].map(h => el('th', {}, h)))),
      el('tbody', {}, rows.map(r => {
        const honors = [];
        if (r.overall_winner) honors.push(el('span', { class: 'pill pill-gold' }, '🏆 Champion'));
        if (r.league_winner) honors.push(el('span', { class: 'pill pill-gold' }, '📋 Reg. Season #1'));
        if (r.scoring_title) honors.push(el('span', { class: 'pill pill-gold' }, '📈 Top Scorer'));
        return el('tr', {}, [
          el('td', { class: 'owner-cell' }, r.owner),
          el('td', {}, fmtInt(r.wins)), el('td', {}, fmtInt(r.losses)),
          el('td', { class: 'num-cell' }, fmt(r.pf)), el('td', { class: 'num-cell' }, fmt(r.pa)),
          el('td', {}, (r.playoff_wins || r.playoff_losses) ? `${fmtInt(r.playoff_wins)}-${fmtInt(r.playoff_losses)}` : '—'),
          el('td', {}, honors.length ? honors : '—'),
        ]);
      })),
    ]);
    tableHolder.appendChild(el('div', { class: 'table-wrap' }, table));
  }
  select.addEventListener('change', () => renderYear(select.value));
  renderYear(years[0]);
}

// ===========================================================
// TAB 4: HALL OF FAME / WALL OF SHAME
// ===========================================================
async function renderFame() {
  const root = document.getElementById('tab-fame');
  const loadingMsg = el('div', { class: 'status-msg' }, ['Checking the latest bookings', el('span', { class: 'blink' }, '...')]);
  root.appendChild(loadingMsg);
  try { await ensureLiveSeasonMerged(); } catch (e) { /* fall back to spreadsheet-only years */ }
  root.removeChild(loadingMsg);

  const years = Object.keys(SEASON_DATA).filter(y => Object.keys(SEASON_DATA[y]).length).sort((a, b) => a - b);

  const hofRows = [], wosRows = [];
  years.forEach(y => {
    const data = SEASON_DATA[y];
    const entries = Object.entries(data);
    const champ = entries.find(([, s]) => s.overall_winner);
    const worst = [...entries].sort((a, b) => (a[1].wins || 0) - (b[1].wins || 0) || (a[1].pf || 0) - (b[1].pf || 0))[0];
    if (champ) hofRows.push({ year: y, owner: champ[0], wins: champ[1].wins, losses: champ[1].losses });
    if (worst) wosRows.push({ year: y, owner: worst[0], wins: worst[1].wins, losses: worst[1].losses });
  });

  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 04A' }, [
    el('h2', { class: 'section-title' }, 'Wall of Fame — Champions'),
    el('p', { class: 'section-desc' }, 'Every league champion, cell block by cell block.'),
    el('div', { class: 'era-list' }, hofRows.reverse().map(r => el('div', { class: 'era-row champion-row' }, [
      el('span', { class: 'yr' }, r.year), el('span', { class: 'who' }, `🏆 ${r.owner}`), el('span', { class: 'rec' }, `${fmtInt(r.wins)}-${fmtInt(r.losses)}`)
    ]))),
  ]));

  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 04B' }, [
    el('h2', { class: 'section-title' }, 'Wall of Shame — Bottom of the Cell Block'),
    el('p', { class: 'section-desc' }, 'Lowest win total each season (ties broken by points for).'),
    el('div', { class: 'era-list' }, wosRows.reverse().map(r => el('div', { class: 'era-row shame' }, [
      el('span', { class: 'yr' }, r.year), el('span', { class: 'who' }, `⛓️ ${r.owner}`), el('span', { class: 'rec' }, `${fmtInt(r.wins)}-${fmtInt(r.losses)}`)
    ]))),
  ]));
}

// ===========================================================
// TAB 5: RULES — live breakdown of Sleeper league settings
// ===========================================================
const SCORING_LABELS = {
  // Passing
  pass_yd: ['Passing Yard', 'Passing'], pass_td: ['Passing TD', 'Passing'], pass_int: ['Interception Thrown', 'Passing'],
  pass_2pt: ['Passing 2pt Conversion', 'Passing'], pass_cmp: ['Completion', 'Passing'], pass_inc: ['Incompletion', 'Passing'],
  pass_40p_td: ['40+ Yard Passing TD (bonus)', 'Passing'], pass_50p_yds: ['50+ Yard Passing Game (bonus)', 'Passing'],
  // Rushing
  rush_yd: ['Rushing Yard', 'Rushing'], rush_td: ['Rushing TD', 'Rushing'], rush_2pt: ['Rushing 2pt Conversion', 'Rushing'],
  rush_40p_td: ['40+ Yard Rushing TD (bonus)', 'Rushing'], rush_att: ['Rushing Attempt', 'Rushing'],
  // Receiving
  rec: ['Reception (PPR)', 'Receiving'], rec_yd: ['Receiving Yard', 'Receiving'], rec_td: ['Receiving TD', 'Receiving'],
  rec_2pt: ['Receiving 2pt Conversion', 'Receiving'], bonus_rec_te: ['TE Reception Bonus', 'Receiving'],
  rec_40p_td: ['40+ Yard Receiving TD (bonus)', 'Receiving'], rec_0_4: ['Short Reception (0-4 yd)', 'Receiving'],
  // Misc offense
  fum: ['Fumble', 'Misc Offense'], fum_lost: ['Fumble Lost', 'Misc Offense'], fum_rec_td: ['Fumble Recovery TD', 'Misc Offense'],
  // Kicking
  fgm_0_19: ['FG Made 0–19 yd', 'Kicking'], fgm_20_29: ['FG Made 20–29 yd', 'Kicking'], fgm_30_39: ['FG Made 30–39 yd', 'Kicking'],
  fgm_40_49: ['FG Made 40–49 yd', 'Kicking'], fgm_50p: ['FG Made 50+ yd', 'Kicking'], fgmiss: ['FG Missed', 'Kicking'],
  xpm: ['Extra Point Made', 'Kicking'], xpmiss: ['Extra Point Missed', 'Kicking'],
  // Defense/Special Teams
  def_td: ['Defensive TD', 'Defense/Special Teams'], def_st_td: ['Special Teams TD', 'Defense/Special Teams'],
  sack: ['Sack', 'Defense/Special Teams'], int: ['Interception (Defense)', 'Defense/Special Teams'],
  fum_rec: ['Fumble Recovery', 'Defense/Special Teams'], safe: ['Safety', 'Defense/Special Teams'],
  blk_kick: ['Blocked Kick', 'Defense/Special Teams'], def_2pt: ['Defensive 2pt Return', 'Defense/Special Teams'],
  st_td: ['Kick/Punt Return TD', 'Defense/Special Teams'], st_fum_rec: ['Special Teams Fumble Recovery', 'Defense/Special Teams'],
  pts_allow_0: ['0 Points Allowed', 'Defense/Special Teams'], pts_allow_1_6: ['1–6 Points Allowed', 'Defense/Special Teams'],
  pts_allow_7_13: ['7–13 Points Allowed', 'Defense/Special Teams'], pts_allow_14_20: ['14–20 Points Allowed', 'Defense/Special Teams'],
  pts_allow_21_27: ['21–27 Points Allowed', 'Defense/Special Teams'], pts_allow_28_34: ['28–34 Points Allowed', 'Defense/Special Teams'],
  pts_allow_35p: ['35+ Points Allowed', 'Defense/Special Teams'],
  // IDP (in case league uses them)
  idp_tkl: ['Tackle (IDP)', 'IDP'], idp_tkl_solo: ['Solo Tackle (IDP)', 'IDP'], idp_sack: ['Sack (IDP)', 'IDP'],
  idp_int: ['Interception (IDP)', 'IDP'], idp_fum_rec: ['Fumble Recovery (IDP)', 'IDP'], idp_pass_def: ['Pass Defended (IDP)', 'IDP'],
  idp_qb_hit: ['QB Hit (IDP)', 'IDP'], idp_tkl_loss: ['Tackle for Loss (IDP)', 'IDP'],
};
function scoringLabel(key) {
  return SCORING_LABELS[key] || [key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), 'Other'];
}
const ROSTER_LABELS = {
  QB: 'Quarterback', RB: 'Running Back', WR: 'Wide Receiver', TE: 'Tight End',
  FLEX: 'Flex (RB/WR/TE)', SUPER_FLEX: 'Superflex (QB/RB/WR/TE)', WRRB_FLEX: 'Flex (RB/WR)', REC_FLEX: 'Flex (WR/TE)',
  DEF: 'Team Defense/ST', K: 'Kicker', BN: 'Bench', IR: 'Injured Reserve', TAXI: 'Taxi Squad',
  DL: 'Defensive Line', LB: 'Linebacker', DB: 'Defensive Back', IDP_FLEX: 'IDP Flex',
};

async function renderRules() {
  const root = document.getElementById('tab-rules');
  const holder = el('div', { class: 'panel', 'data-file-no': 'FILE 05' }, [
    el('h2', { class: 'section-title' }, 'Inmate Handbook — League Rules'),
    el('p', { class: 'section-desc' }, 'Live from Sleeper league settings — roster construction and scoring.'),
    el('div', { id: 'rulesHolder' }, el('div', { class: 'status-msg' }, ['Reviewing the intake paperwork', el('span', { class: 'blink' }, '...')])),
  ]);
  root.appendChild(holder);
  try {
    const seasons = await loadSleeperHistory();
    const latest = seasons[seasons.length - 1];
    const h = document.getElementById('rulesHolder');
    h.innerHTML = '';
    if (!latest) {
      h.appendChild(el('div', { class: 'status-msg' }, 'Could not load league settings from Sleeper yet.'));
      return;
    }
    const league = latest.league;
    const settings = league.settings || {};
    const scoring = league.scoring_settings || {};
    const positions = league.roster_positions || [];

    // ---- League format stat cards ----
    h.appendChild(el('div', { class: 'stat-grid' }, [
      statCard(league.total_rosters || settings.num_teams || '—', 'Teams'),
      statCard(positions.length, 'Roster Spots'),
      statCard(settings.playoff_teams ?? '—', 'Playoff Teams'),
      statCard(settings.playoff_week_start ? `Wk ${settings.playoff_week_start}` : '—', 'Playoffs Start'),
      statCard((settings.type === 2) ? 'Dynasty' : (settings.type === 1 ? 'Keeper' : 'Redraft'), 'League Type'),
      statCard(scoring.rec ? `${scoring.rec} PPR` : (scoring.rec === 0 ? 'Standard' : '—'), 'Scoring Format'),
    ]));

    // ---- Roster composition ----
    const counts = {};
    positions.forEach(p => { counts[p] = (counts[p] || 0) + 1; });
    const rosterRows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    h.appendChild(el('h2', { class: 'section-title', style: 'font-size:18px;margin-top:4px' }, 'Roster Composition'));
    h.appendChild(el('p', { class: 'section-desc' }, `${positions.length} total roster spots per team.`));
    h.appendChild(el('div', { class: 'table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['Slot', 'Position', 'Count'].map(x => el('th', {}, x)))),
      el('tbody', {}, rosterRows.map(([pos, count]) => el('tr', {}, [
        el('td', { class: 'owner-cell' }, pos),
        el('td', {}, ROSTER_LABELS[pos] || pos),
        el('td', { class: 'num-cell' }, String(count)),
      ]))),
    ])));

    // ---- Scoring settings, grouped ----
    h.appendChild(el('h2', { class: 'section-title', style: 'font-size:18px;margin-top:24px' }, 'Scoring Rules'));
    const grouped = {};
    Object.entries(scoring).forEach(([key, val]) => {
      const [label, category] = scoringLabel(key);
      (grouped[category] = grouped[category] || []).push({ label, val });
    });
    const categoryOrder = ['Passing', 'Rushing', 'Receiving', 'Misc Offense', 'Kicking', 'Defense/Special Teams', 'IDP', 'Other'];
    categoryOrder.forEach(cat => {
      if (!grouped[cat] || !grouped[cat].length) return;
      h.appendChild(el('h2', { class: 'section-title', style: 'font-size:14px;margin-top:16px;color:var(--brass)' }, cat));
      const rows = grouped[cat].sort((a, b) => a.label.localeCompare(b.label));
      h.appendChild(el('div', { class: 'table-wrap' }, el('table', {}, [
        el('tbody', {}, rows.map(r => el('tr', {}, [
          el('td', {}, r.label),
          el('td', { class: 'num-cell' }, (r.val > 0 ? '+' : '') + r.val),
        ]))),
      ])));
    });

    // ---- League operations ----
    h.appendChild(el('h2', { class: 'section-title', style: 'font-size:18px;margin-top:24px' }, 'League Operations'));
    const opsRows = [
      ['Waiver Type', settings.waiver_type === 2 ? 'FAAB Budget' : (settings.waiver_type === 1 ? 'Reverse Standings' : 'Rolling List')],
      ['FAAB Budget', settings.waiver_budget ? `$${settings.waiver_budget}` : '—'],
      ['Trade Deadline', settings.trade_deadline ? `Week ${settings.trade_deadline}` : 'None set'],
      ['Playoff Teams', settings.playoff_teams ?? '—'],
      ['Playoff Start Week', settings.playoff_week_start ?? '—'],
      ['Regular Season Length', settings.playoff_week_start ? `${settings.playoff_week_start - 1} weeks` : '—'],
    ];
    h.appendChild(el('div', { class: 'table-wrap' }, el('table', {}, [
      el('tbody', {}, opsRows.map(([label, val]) => el('tr', {}, [
        el('td', { class: 'owner-cell' }, label), el('td', {}, String(val)),
      ]))),
    ])));
  } catch (e) {
    const h = document.getElementById('rulesHolder');
    h.innerHTML = '';
    h.appendChild(el('div', { class: 'status-msg error' }, 'Could not load league rules from Sleeper right now.'));
  }
}

// ===========================================================
// TAB 7: HEAD TO HEAD
// ===========================================================
async function renderH2H() {
  const root = document.getElementById('tab-h2h');
  const panel = el('div', { class: 'panel', 'data-file-no': 'FILE 07' }, [
    el('h2', { class: 'section-title' }, 'Head-to-Head Records'),
    el('p', { class: 'section-desc' }, 'Computed from Sleeper matchup data (Sleeper-era seasons only — earlier NFL.com seasons did not export matchup-level detail).'),
    el('div', { id: 'h2hHolder' }, el('div', { class: 'status-msg' }, ['Cross-referencing the rap sheets', el('span', { class: 'blink' }, '...')])),
  ]);
  root.appendChild(panel);
  try {
    const seasons = await loadSleeperHistory();
    const h = document.getElementById('h2hHolder');
    h.innerHTML = '';
    const record = {}; // "A|B" -> {aWins, bWins}
    const nameSet = new Set();

    for (const season of seasons) {
      const maxWeek = season.league.settings?.playoff_week_start ? season.league.settings.playoff_week_start - 1 : 14;
      const matchups = await loadMatchupsForSeason(season, Math.max(maxWeek, 14));
      matchups.forEach(week => {
        const byMatch = {};
        (week || []).forEach(entry => {
          if (!entry.matchup_id) return;
          (byMatch[entry.matchup_id] = byMatch[entry.matchup_id] || []).push(entry);
        });
        Object.values(byMatch).forEach(pair => {
          if (pair.length !== 2) return;
          const [a, b] = pair;
          const nameA = rosterOwnerName(a.roster_id, season);
          const nameB = rosterOwnerName(b.roster_id, season);
          nameSet.add(nameA); nameSet.add(nameB);
          const key = [nameA, nameB].sort().join('|');
          record[key] = record[key] || { [nameA]: 0, [nameB]: 0 };
          record[key][nameA] = record[key][nameA] || 0;
          record[key][nameB] = record[key][nameB] || 0;
          if (a.points > b.points) record[key][nameA]++;
          else if (b.points > a.points) record[key][nameB]++;
        });
      });
    }
    const names = Array.from(nameSet).sort();
    if (!names.length) {
      h.appendChild(el('div', { class: 'status-msg' }, 'No matchup data available yet.'));
      return;
    }
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, '')].concat(names.map(n => el('th', {}, n))))),
      el('tbody', {}, names.map(rowName => el('tr', {}, [el('td', { class: 'owner-cell' }, rowName)].
        concat(names.map(colName => {
          if (rowName === colName) return el('td', { class: 'num-cell' }, '—');
          const key = [rowName, colName].sort().join('|');
          const rec = record[key];
          if (!rec) return el('td', { class: 'num-cell' }, '—');
          return el('td', { class: 'num-cell' }, `${rec[rowName] || 0}-${rec[colName] || 0}`);
        }))
      ))),
    ]);
    h.appendChild(el('p', {}, el('em', {}, 'Reading the grid: row vs. column, row\u2019s win-loss record.')));
    h.appendChild(el('div', { class: 'table-wrap' }, table));
  } catch (e) {
    document.getElementById('h2hHolder').innerHTML = '';
    document.getElementById('h2hHolder').appendChild(el('div', { class: 'status-msg error' }, 'Could not compute head-to-head records right now.'));
  }
}

// ===========================================================
// TAB 8: RECORDS BOOK
// ===========================================================
async function renderRecords() {
  const root = document.getElementById('tab-records');
  const panel = el('div', { class: 'panel', 'data-file-no': 'FILE 08' }, [
    el('h2', { class: 'section-title' }, 'The Records Book'),
    el('p', { class: 'section-desc' }, 'Highest weekly scores across Sleeper-era seasons.'),
    el('div', { id: 'recordsHolder' }, el('div', { class: 'status-msg' }, ['Digging through the archive', el('span', { class: 'blink' }, '...')])),
  ]);
  root.appendChild(panel);
  try {
    const seasons = await loadSleeperHistory();
    const h = document.getElementById('recordsHolder');
    h.innerHTML = '';
    const weeklyScores = [];
    for (const season of seasons) {
      const matchups = await loadMatchupsForSeason(season, 17);
      matchups.forEach((week, wi) => {
        (week || []).forEach(entry => {
          if (typeof entry.points === 'number' && entry.points > 0) {
            weeklyScores.push({
              owner: rosterOwnerName(entry.roster_id, season),
              points: entry.points,
              week: wi + 1,
              season: season.league.season,
            });
          }
        });
      });
    }
    weeklyScores.sort((a, b) => b.points - a.points);
    const top10 = weeklyScores.slice(0, 10);
    const bottom10 = [...weeklyScores].sort((a, b) => a.points - b.points).slice(0, 10);

    h.appendChild(el('h2', { class: 'section-title', style: 'font-size:16px' }, 'Highest Single-Week Scores'));
    h.appendChild(recordsTable(top10));
    h.appendChild(el('h2', { class: 'section-title', style: 'font-size:16px;margin-top:24px' }, 'Lowest Single-Week Scores'));
    h.appendChild(recordsTable(bottom10));
  } catch (e) {
    document.getElementById('recordsHolder').innerHTML = '';
    document.getElementById('recordsHolder').appendChild(el('div', { class: 'status-msg error' }, 'Could not load records right now.'));
  }
}
function recordsTable(rows) {
  return el('div', { class: 'table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, ['#', 'Inmate', 'Points', 'Week', 'Season'].map(x => el('th', {}, x)))),
    el('tbody', {}, rows.map((r, i) => el('tr', {}, [
      el('td', {}, String(i + 1)), el('td', { class: 'owner-cell' }, r.owner),
      el('td', { class: 'num-cell' }, fmt(r.points)), el('td', {}, String(r.week)), el('td', {}, String(r.season)),
    ]))),
  ]));
}

// ===========================================================
// TAB 6: DRAFT (current board + browsable past drafts + pick analysis)
// ===========================================================
async function renderDraft() {
  const root = document.getElementById('tab-draft');
  const panel = el('div', { class: 'panel', 'data-file-no': 'FILE 06' }, [
    el('h2', { class: 'section-title' }, 'Draft'),
    el('p', { class: 'section-desc' }, 'Current year\u2019s draft board, plus every browsable past Sleeper-era draft. Pick slot alongside the manager\u2019s eventual season record shows value returned per pick.'),
    el('div', { id: 'draftHolder' }, el('div', { class: 'status-msg' }, ['Reviewing the intake photos', el('span', { class: 'blink' }, '...')])),
  ]);
  root.appendChild(panel);
  try {
    const seasons = await loadSleeperHistory();
    const h = document.getElementById('draftHolder');
    h.innerHTML = '';
    const draftSeasons = seasons.filter(s => s.draft && s.picks && s.picks.length);
    if (!draftSeasons.length) {
      h.appendChild(el('div', { class: 'status-msg' }, 'No draft data available yet from Sleeper for this league.'));
      return;
    }
    const select = el('select', {}, draftSeasons.map(s => el('option', { value: s.league.season }, s.league.season)));
    h.appendChild(el('div', { class: 'control-row' }, [el('label', {}, 'Season:'), select]));
    const tableHolder = el('div');
    h.appendChild(tableHolder);

    async function renderForSeason(seasonYear) {
      const season = draftSeasons.find(s => s.league.season === seasonYear);
      tableHolder.innerHTML = '';
      tableHolder.appendChild(el('div', { class: 'status-msg' }, ['Pulling each player’s box scores', el('span', { class: 'blink' }, '...')]));
      let playerStats = {};
      try { playerStats = await buildPlayerSeasonStats(season); } catch (e) { /* fall back to draft-slot-only view */ }
      tableHolder.innerHTML = '';
      const rows = season.picks.sort((a, b) => a.pick_no - b.pick_no).map(p => {
        const owner = rosterOwnerName(p.roster_id, season);
        const roster = season.rosters.find(r => r.roster_id === p.roster_id);
        const finishWins = roster ? (roster.settings?.wins || 0) : null;
        const player = p.metadata ? `${p.metadata.first_name || ''} ${p.metadata.last_name || ''} (${p.metadata.team || 'FA'})` : p.player_id;
        const pos = p.metadata ? p.metadata.position : '';
        const stats = playerStats[p.player_id];
        return { pick: p.pick_no, round: p.round, owner, player, pos, finishWins, stats };
      });
      const table = el('table', {}, [
        el('thead', {}, el('tr', {}, ['Pick', 'Rd', 'Manager', 'Player', 'Pos', 'Season Pts', 'Starts', 'Starts in Wins', 'Manager Season Wins'].map(x => el('th', {}, x)))),
        el('tbody', {}, rows.map(r => el('tr', {}, [
          el('td', {}, String(r.pick)), el('td', {}, String(r.round)), el('td', { class: 'owner-cell' }, r.owner),
          el('td', {}, r.player), el('td', {}, r.pos || '—'),
          el('td', { class: 'num-cell' }, r.stats ? fmt(r.stats.points) : '—'),
          el('td', { class: 'num-cell' }, r.stats ? String(r.stats.starts) : '—'),
          el('td', { class: 'num-cell' }, r.stats ? String(r.stats.startsInWins) : '—'),
          el('td', { class: 'num-cell' }, r.finishWins === null ? '—' : String(r.finishWins)),
        ]))),
      ]);
      tableHolder.appendChild(el('div', { class: 'table-wrap' }, table));
      tableHolder.appendChild(el('p', { class: 'section-desc' }, '"Season Pts" is the player\u2019s total fantasy points under this league\u2019s own scoring that season. "Starts" counts weeks they were in their manager\u2019s starting lineup; "Starts in Wins" counts how many of those starts came in a game that manager won. "Manager Season Wins" is separate \u2014 the drafting manager\u2019s overall record that year, regardless of this specific player.'));
    }
    select.addEventListener('change', () => renderForSeason(select.value));
    renderForSeason(draftSeasons[draftSeasons.length - 1].league.season);
  } catch (e) {
    document.getElementById('draftHolder').innerHTML = '';
    document.getElementById('draftHolder').appendChild(el('div', { class: 'status-msg error' }, 'Could not load draft data right now.'));
  }
}

// ===========================================================
// TAB 9: TEAM / INMATE PAGES
// ===========================================================
function renderTeams() {
  const root = document.getElementById('tab-teams');
  const gridPanel = el('div', { class: 'panel', 'data-file-no': 'FILE 09' }, [
    el('h2', { class: 'section-title' }, 'Inmate Roster'),
    el('p', { class: 'section-desc' }, 'Select an inmate to view their full case file.'),
  ]);
  const grid = el('div', { class: 'mug-grid' });
  const sorted = [...ALLTIME].sort((a, b) => b.wins - a.wins);
  sorted.forEach((o, i) => {
    const card = el('div', { class: 'mug-card' }, [
      el('div', { class: 'mug-photo' }, [el('div', { class: 'height-lines' }), o.owner.charAt(0)]),
      el('div', { class: 'mug-name' }, o.owner),
      el('div', { class: 'mug-sub' }, `# ${String(i + 1).padStart(3, '0')}`),
    ]);
    card.addEventListener('click', () => renderTeamDetail(o.owner));
    grid.appendChild(card);
  });
  gridPanel.appendChild(grid);
  root.appendChild(gridPanel);
  root.appendChild(el('div', { id: 'teamDetailHolder' }));
}
async function renderTeamDetail(owner) {
  const holder = document.getElementById('teamDetailHolder');
  holder.innerHTML = '';
  const o = ALLTIME.find(x => x.owner === owner);
  if (!o) return;
  holder.appendChild(el('div', { class: 'status-msg' }, ['Pulling the case file', el('span', { class: 'blink' }, '...')]));
  try { await ensureLiveSeasonMerged(); } catch (e) { /* fall back to spreadsheet-only years */ }
  holder.innerHTML = '';

  const years = Object.keys(SEASON_DATA).sort();
  const history = years.map(y => ({ year: y, ...(SEASON_DATA[y][owner] || {}) })).filter(r => r.wins !== undefined);

  const panel = el('div', { class: 'panel', 'data-file-no': `CASE #${owner.toUpperCase()}` });
  const backBtn = el('button', { class: 'back-link' }, '\u2190 Back to Cell Block');
  backBtn.addEventListener('click', () => { holder.innerHTML = ''; window.scrollTo({ top: document.getElementById('tab-teams').offsetTop - 80, behavior: 'smooth' }); });
  panel.appendChild(backBtn);
  panel.appendChild(el('h2', { class: 'section-title' }, owner));
  panel.appendChild(el('div', { class: 'stat-grid' }, [
    statCard(fmtInt(o.seasons), 'Seasons'),
    statCard(`${fmtInt(o.wins)}-${fmtInt(o.losses)}`, 'Career Record'),
    statCard(o.overall_winner, 'Championships'),
    statCard(o.league_winner, 'Reg. Season Titles'),
    statCard(o.scoring_titles, 'Scoring Titles'),
    statCard(`${fmtInt(o.playoff_wins)}-${fmtInt(o.playoff_losses)}`, 'Playoff Record'),
    statCard(fmt(o.pf, 0), 'Career Points For'),
    statCard(fmt(o.pa, 0), 'Career Points Against'),
  ]));

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, ['Season', 'W', 'L', 'PF', 'PA', 'Honors'].map(x => el('th', {}, x)))),
    el('tbody', {}, history.map(r => {
      const honors = [];
      if (r.overall_winner) honors.push('🏆');
      if (r.league_winner) honors.push('📋');
      if (r.scoring_title) honors.push('📈');
      return el('tr', {}, [
        el('td', { class: 'owner-cell' }, r.year), el('td', {}, fmtInt(r.wins)), el('td', {}, fmtInt(r.losses)),
        el('td', { class: 'num-cell' }, fmt(r.pf)), el('td', { class: 'num-cell' }, fmt(r.pa)),
        el('td', {}, honors.join(' ') || '—'),
      ]);
    })),
  ]);
  panel.appendChild(el('h2', { class: 'section-title', style: 'font-size:16px;margin-top:10px' }, 'Season-by-Season'));
  panel.appendChild(el('div', { class: 'table-wrap' }, table));
  holder.appendChild(panel);
  holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===========================================================
// TAB 10: LIVE SCORES
// ===========================================================
let liveScoresInterval = null;
async function renderLive() {
  const root = document.getElementById('tab-live');
  root.appendChild(el('div', { class: 'panel', 'data-file-no': 'FILE 10' }, [
    el('h2', { class: 'section-title' }, [el('span', { class: 'live-dot' }), 'Live Scores']),
    el('p', { class: 'section-desc' }, 'Refreshes automatically every 30 seconds while this tab is open.'),
    el('div', { id: 'liveHolder' }, el('div', { class: 'status-msg' }, ['Checking the scoreboard', el('span', { class: 'blink' }, '...')])),
  ]));
  await refreshLiveScores();
  if (liveScoresInterval) clearInterval(liveScoresInterval);
  liveScoresInterval = setInterval(refreshLiveScores, 30000);
}
async function refreshLiveScores() {
  const holder = document.getElementById('liveHolder');
  if (!holder) { clearInterval(liveScoresInterval); return; }
  try {
    const state = await sleeperFetch('/state/nfl');
    const seasons = await loadSleeperHistory();
    const current = seasons[seasons.length - 1];
    if (!current) { holder.innerHTML = ''; holder.appendChild(el('div', { class: 'status-msg' }, 'No active season found.')); return; }
    if (!isRegularSeasonLive(state)) {
      holder.innerHTML = '';
      holder.appendChild(el('p', { class: 'section-desc' }, `${current.league.season} season`));
      holder.appendChild(el('div', { class: 'status-msg' }, 'Preseason — live scores begin once Week 1 kicks off.'));
      return;
    }
    const week = state.week || 1;
    const matchups = await sleeperFetch(`/league/${current.league.league_id}/matchups/${week}`);
    const byMatch = {};
    (matchups || []).forEach(entry => {
      if (entry.matchup_id === null || entry.matchup_id === undefined) return;
      (byMatch[entry.matchup_id] = byMatch[entry.matchup_id] || []).push(entry);
    });
    holder.innerHTML = '';
    holder.appendChild(el('p', { class: 'section-desc' }, `Week ${week} · ${current.league.season} · Last checked ${new Date().toLocaleTimeString()}`));
    const pairs = Object.values(byMatch).filter(p => p.length === 2);
    if (!pairs.length) {
      holder.appendChild(el('div', { class: 'status-msg' }, 'No matchups found for the current week yet.'));
      return;
    }
    const grid = el('div', { class: 'mug-grid' });
    pairs.forEach(([a, b]) => {
      const nameA = rosterOwnerName(a.roster_id, current);
      const nameB = rosterOwnerName(b.roster_id, current);
      const ptsA = (a.points || 0).toFixed(2);
      const ptsB = (b.points || 0).toFixed(2);
      const leading = a.points > b.points ? nameA : (b.points > a.points ? nameB : null);
      grid.appendChild(el('div', { class: 'mug-card', style: 'cursor:default' }, [
        el('div', { style: 'padding:16px;' }, [
          matchupRow(nameA, ptsA, leading === nameA),
          el('div', { style: 'text-align:center;color:var(--brass);font-family:IBM Plex Mono,monospace;font-size:10px;margin:6px 0;' }, 'VS'),
          matchupRow(nameB, ptsB, leading === nameB),
        ]),
      ]));
    });
    holder.appendChild(grid);
  } catch (e) {
    holder.innerHTML = '';
    holder.appendChild(el('div', { class: 'status-msg error' }, 'Could not load live scores right now.'));
  }
}
function matchupRow(name, pts, leading) {
  return el('div', { style: `display:flex;justify-content:space-between;padding:4px 0;${leading ? 'color:var(--jumpsuit-bright);font-weight:600;' : ''}` }, [
    el('span', {}, name), el('span', { style: 'font-family:IBM Plex Mono,monospace;' }, pts),
  ]);
}

// ===========================================================
// TAB 11: WEEKLY RECAP (AI-generated, via GitHub Actions)
// ===========================================================
async function renderRecap() {
  const root = document.getElementById('tab-recap');
  const panel = el('div', { class: 'panel', 'data-file-no': 'FILE 11' }, [
    el('h2', { class: 'section-title' }, 'Weekly Recap'),
    el('p', { class: 'section-desc' }, 'AI-written recap, generated automatically each week.'),
    el('div', { id: 'recapHolder' }, el('div', { class: 'status-msg' }, ['Pulling the warden\u2019s weekly report', el('span', { class: 'blink' }, '...')])),
  ]);
  root.appendChild(panel);
  const h = document.getElementById('recapHolder');
  try {
    const res = await fetch('recaps/index.json');
    if (!res.ok) throw new Error('no index');
    const index = await res.json();
    h.innerHTML = '';
    if (!index.length) {
      h.appendChild(el('div', { class: 'status-msg' }, 'No recaps have been generated yet — the first one lands after Week 1 wraps up.'));
      return;
    }
    const select = el('select', {}, index.map(e => el('option', { value: e.file }, `${e.season} — Week ${e.week}`)));
    h.appendChild(el('div', { class: 'control-row' }, [el('label', {}, 'Week:'), select]));
    const recapHolder = el('div');
    h.appendChild(recapHolder);

    async function loadRecap(file) {
      recapHolder.innerHTML = '';
      recapHolder.appendChild(el('div', { class: 'status-msg' }, 'Loading...'));
      try {
        const r = await fetch(`recaps/${file}`);
        const data = await r.json();
        recapHolder.innerHTML = '';
        recapHolder.appendChild(el('div', { class: 'recap-prose' }, data.recap_text));
        if (data.top_performers && data.top_performers.length) {
          recapHolder.appendChild(el('h2', { class: 'section-title', style: 'font-size:14px;margin-top:20px;color:var(--brass)' }, 'Top Performers'));
          recapHolder.appendChild(recordsTable(data.top_performers.map(p => ({ owner: p.owner, points: p.points, week: data.week, season: data.season }))));
        }
      } catch (e) {
        recapHolder.innerHTML = '';
        recapHolder.appendChild(el('div', { class: 'status-msg error' }, 'Could not load that recap.'));
      }
    }
    select.addEventListener('change', () => loadRecap(select.value));
    loadRecap(index[0].file);
  } catch (e) {
    h.innerHTML = '';
    h.appendChild(el('div', { class: 'status-msg' }, 'No recaps available yet — check back once the weekly automation has run.'));
  }
}

// ---------- REGISTER RENDERERS ----------
const renderers = {
  home: renderHome,
  alltime: renderAlltime,
  seasons: renderSeasons,
  fame: renderFame,
  rules: renderRules,
  draft: renderDraft,
  h2h: renderH2H,
  records: renderRecords,
  teams: renderTeams,
  live: renderLive,
  recap: renderRecap,
};

// ---------- INIT ----------
document.addEventListener('DOMContentLoaded', () => {
  const hdrSeasons = document.getElementById('hdrSeasons');
  const hdrInmates = document.getElementById('hdrInmates');
  if (hdrSeasons) hdrSeasons.textContent = alltimeTotalSeasons();
  if (hdrInmates) hdrInmates.textContent = ALLTIME.length;
  activateTab('home');
});
