#!/usr/bin/env python3
"""
HMPFL Acca Auto-Settler
=======================
Runs on a schedule via GitHub Actions (.github/workflows/settle-accas.yml),
early on Monday mornings UK time.

For every bets/<season>-week<N>.json whose result is still "pending", it pulls
ESPN's public NFL scoreboard and box scores for that week and settles each
pending leg that has a `live: { player, stat, line }` spec, using the same rules
as the live tracker in app.js:
  - overs win once the stat is above the line, lose at the final whistle otherwise
  - unders (`side: "under"`) lose once the stat passes the line, win at the final
  - game totals and spreads settle on the final score
Legs whose game isn't final yet, or that have no live spec, are left pending for
manual settlement. No API key is needed.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ESPN_NFL_API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
BETS_DIR = os.path.join(os.path.dirname(__file__), "..", "bets")

STAT_LABELS = {
    "pass_yds": "pass yds", "pass_cmp": "completions", "pass_att": "pass attempts",
    "pass_td": "pass TDs", "int": "INTs", "rush_yds": "rush yds", "rush_att": "carries",
    "rush_long": "yd longest rush", "rec_yds": "rec yds", "rec_long": "yd longest reception",
    "rec": "receptions", "rush_rec_yds": "rush + rec yds", "tds": "TDs",
    "longest_pass": "yd longest completion (team)", "game_total": "total points",
    "tackles": "tackles + assists", "game_rush_yds": "total rushing yds (both teams)",
}


def get_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "HMPFL-acca-settler"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.URLError, urllib.error.HTTPError):
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def norm_name(s):
    s = re.sub(r"[.'’]", "", str(s or "").lower())
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", s)
    return re.sub(r"[^a-z]+", " ", s).strip()


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def parse_box(summary):
    """Flatten an ESPN summary box score into {norm_name: {team, passing, rushing, receiving}}."""
    players = {}
    for team_block in (summary.get("boxscore") or {}).get("players") or []:
        team = (team_block.get("team") or {}).get("id")
        for cat in team_block.get("statistics") or []:
            keys = cat.get("keys") or []
            for a in cat.get("athletes") or []:
                key = norm_name((a.get("athlete") or {}).get("displayName"))
                if not key:
                    continue
                rec = players.setdefault(key, {"team": team})
                stats = a.get("stats") or []
                rec[cat.get("name")] = {k: (stats[i] if i < len(stats) else None) for i, k in enumerate(keys)}
    return players


def stat_value(box, player, stat):
    p = box.get(norm_name(player), {})
    pas, rush, recv = p.get("passing", {}), p.get("rushing", {}), p.get("receiving", {})
    cmp_att = str(pas.get("completions/passingAttempts") or "0/0").split("/")
    if stat == "pass_yds": return num(pas.get("passingYards"))
    if stat == "pass_cmp": return num(cmp_att[0])
    if stat == "pass_att": return num(cmp_att[1] if len(cmp_att) > 1 else 0)
    if stat == "pass_td": return num(pas.get("passingTouchdowns"))
    if stat == "int": return num(pas.get("interceptions"))
    if stat == "rush_yds": return num(rush.get("rushingYards"))
    if stat == "rush_att": return num(rush.get("rushingAttempts"))
    if stat == "rush_long": return num(rush.get("longRushing"))
    if stat == "rec_yds": return num(recv.get("receivingYards"))
    if stat == "rec_long": return num(recv.get("longReception"))
    if stat == "tackles": return num((p.get("defensive") or {}).get("totalTackles"))
    if stat == "game_rush_yds": return sum(num(o["rushing"].get("rushingYards")) for o in box.values() if o.get("rushing"))
    if stat == "rec": return num(recv.get("receptions"))
    if stat == "rush_rec_yds": return num(rush.get("rushingYards")) + num(recv.get("receivingYards"))
    if stat == "tds": return num(rush.get("rushingTouchdowns")) + num(recv.get("receivingTouchdowns"))
    if stat == "longest_pass":
        # ESPN has no per-QB longest completion: use the longest catch by the QB's team.
        return max([num(o["receiving"].get("longReception")) for o in box.values()
                    if o.get("team") == p.get("team") and o.get("receiving")] or [0])
    return None


def find_event(events, game_label):
    label = str(game_label).lower()
    for ev in events:
        comps = ((ev.get("competitions") or [{}])[0]).get("competitors") or []
        names = [str((c.get("team") or {}).get("name") or "???").lower() for c in comps]
        if len(names) == 2 and all(n in label for n in names):
            return ev
    return None


def fmt(v):
    return str(int(v)) if float(v).is_integer() else str(v)


def settle_leg(leg, events, boxes):
    """Settle one pending leg in place if its game is final. Returns True if it was settled."""
    spec = leg["live"]
    ev = find_event(events, leg["game"])
    if not ev or ((ev.get("status") or {}).get("type") or {}).get("state") != "post":
        print(f"  - {leg['owner']}: game not final yet, left pending")
        return False
    comps = ev["competitions"][0]["competitors"]
    stat = spec["stat"]
    if stat == "game_total":
        value = sum(num(c.get("score")) for c in comps)
        actual = f"{fmt(value)} total points"
    elif stat == "spread":
        mine = next((c for c in comps if str(c["team"]["name"]).lower() == str(spec["team"]).lower()), None)
        theirs = next((c for c in comps if c is not mine), None)
        if not mine or not theirs:
            print(f"  - {leg['owner']}: couldn't find {spec['team']} in the game, left pending")
            return False
        value = num(mine.get("score")) - num(theirs.get("score"))
        actual = f"{spec['team']} {fmt(num(mine.get('score')))}-{fmt(num(theirs.get('score')))}"
    else:
        if ev["id"] not in boxes:
            boxes[ev["id"]] = parse_box(get_json(f"{ESPN_NFL_API}/summary?event={ev['id']}"))
        if not boxes[ev["id"]]:
            # A final game with an empty box score is a feed glitch, not a row of zeros.
            print(f"  - {leg['owner']}: box score not available yet, left pending")
            return False
        value = stat_value(boxes[ev["id"]], spec.get("player"), stat)
        if value is None:
            print(f"  - {leg['owner']}: unsupported stat {stat}, left pending")
            return False
        actual = f"{fmt(value)} {STAT_LABELS.get(stat, stat)}"
    if stat == "spread":
        won = value + spec["line"] > 0
    elif spec.get("side") == "under":
        won = value < spec["line"]
    else:
        won = value > spec["line"]
    leg["result"] = "won" if won else "lost"
    leg["actual"] = actual
    leg["auto_settled"] = True
    print(f"  - {leg['owner']}: {leg['pick']} -> {actual} -> {leg['result'].upper()}")
    return True


def settle_week(week):
    """Settle what can be settled in one week's bet dict in place. Returns True if anything changed."""
    pending = [leg for leg in week["legs"] if leg.get("result") == "pending" and leg.get("live")]
    if not pending:
        return False
    sb = get_json(f"{ESPN_NFL_API}/scoreboard?seasontype=2&week={week['week']}&dates={week['season']}")
    events = sb.get("events") or []
    boxes = {}
    changed = False
    for leg in pending:
        try:
            changed = settle_leg(leg, events, boxes) or changed
        except Exception as e:  # one malformed leg must never block the rest of the week
            print(f"  ! {leg['owner']}: couldn't settle ({e!r}), left pending")

    results = [leg.get("result") for leg in week["legs"]]
    if "lost" in results:
        week["result"] = "lost"
    elif all(r in ("won", "void") for r in results):
        week["result"] = "won"
        week.setdefault("returns", week.get("potential_returns"))
    if changed:
        note = "Results auto-settled from ESPN box scores."
        if note not in (week.get("note") or ""):
            week["note"] = f"{week['note']} {note}".strip() if week.get("note") else note
    return changed


def main():
    with open(os.path.join(BETS_DIR, "index.json")) as f:
        index = json.load(f)
    any_changed = False
    for entry in index:
        path = os.path.join(BETS_DIR, entry["file"])
        with open(path) as f:
            week = json.load(f)
        # A week can already be "lost" while some legs' games were still running,
        # so look at the legs, not the week result.
        if not any(leg.get("result") == "pending" and leg.get("live") for leg in week["legs"]):
            continue
        print(f"Settling {entry['season']} week {entry['week']}...")
        try:
            changed = settle_week(week)
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            print(f"  ! ESPN unreachable ({e}); leaving week as is")
            continue
        if changed:
            with open(path, "w") as f:
                f.write(json.dumps(week, indent=2, ensure_ascii=False) + "\n")
            any_changed = True
            print(f"  -> week result: {week['result']}")
    if not any_changed:
        print("Nothing to settle.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
