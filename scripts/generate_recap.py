#!/usr/bin/env python3
"""
HMPFL Weekly Recap Generator
=============================
Runs on a schedule via GitHub Actions (.github/workflows/weekly-recap.yml).

What it does:
1. Pulls the current Sleeper league + finds the just-completed week.
2. Gathers that week's matchup results and top individual performances.
3. Sends a compact summary to the Anthropic API and asks for a prose recap
   written in the site's "HMPFL / prison" voice.
4. Saves the recap as JSON under recaps/, and updates recaps/index.json.

Required environment variables (set as GitHub repo secrets):
  ANTHROPIC_API_KEY   - your Anthropic API key
  SLEEPER_LEAGUE_ID   - the current season's Sleeper league ID
"""
import os
import sys
import json
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

SLEEPER_API = "https://api.sleeper.app/v1"
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
SLEEPER_LEAGUE_ID = os.environ.get("SLEEPER_LEAGUE_ID")
MODEL = os.environ.get("RECAP_MODEL", "claude-sonnet-5")
RECAPS_DIR = os.path.join(os.path.dirname(__file__), "..", "recaps")


def http_get_json(url, retries=3):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def get_current_league():
    """Walk the league's previous_league_id chain to find the *current* season's league."""
    league = http_get_json(f"{SLEEPER_API}/league/{SLEEPER_LEAGUE_ID}")
    return league


def user_display_name(u):
    meta = u.get("metadata") or {}
    return meta.get("team_name") or u.get("display_name") or u.get("username") or "Unknown"


def roster_owner_name(roster_id, rosters, users):
    roster = next((r for r in rosters if r["roster_id"] == roster_id), None)
    if not roster:
        return f"Roster {roster_id}"
    user = next((u for u in users if u["user_id"] == roster.get("owner_id")), None)
    return user_display_name(user) if user else f"Roster {roster_id}"


def determine_target_week(league):
    """Figure out which week to recap: the most recently completed week."""
    state = http_get_json(f"{SLEEPER_API}/state/nfl")
    current_week = state.get("week") or 1
    # Recap the week that most recently finished.
    target = max(current_week - 1, 1)
    return target


def build_week_summary(league, week, rosters, users):
    matchups = http_get_json(f"{SLEEPER_API}/league/{league['league_id']}/matchups/{week}")
    by_matchup = {}
    for entry in matchups:
        mid = entry.get("matchup_id")
        if mid is None:
            continue
        by_matchup.setdefault(mid, []).append(entry)

    games = []
    all_player_scores = []  # (owner, player_points_dict)

    for mid, pair in by_matchup.items():
        if len(pair) != 2:
            continue
        a, b = pair
        owner_a = roster_owner_name(a["roster_id"], rosters, users)
        owner_b = roster_owner_name(b["roster_id"], rosters, users)
        pts_a = a.get("points", 0) or 0
        pts_b = b.get("points", 0) or 0
        games.append({
            "owner_a": owner_a, "pts_a": round(pts_a, 2),
            "owner_b": owner_b, "pts_b": round(pts_b, 2),
            "margin": round(abs(pts_a - pts_b), 2),
            "winner": owner_a if pts_a > pts_b else (owner_b if pts_b > pts_a else "Tie"),
        })
        for entry, owner in ((a, owner_a), (b, owner_b)):
            pp = entry.get("players_points") or {}
            for player_id, pts in pp.items():
                all_player_scores.append({"owner": owner, "player_id": player_id, "points": pts})

    games.sort(key=lambda g: g["margin"])
    all_player_scores.sort(key=lambda p: p["points"] or 0, reverse=True)

    return {
        "games": games,
        "top_players": all_player_scores[:10],
    }


def fetch_player_names(player_ids):
    """Sleeper's full player list is large; fetch once and cache within this run."""
    all_players = http_get_json(f"{SLEEPER_API}/players/nfl")
    names = {}
    for pid in player_ids:
        p = all_players.get(pid)
        if p:
            names[pid] = f"{p.get('first_name','')} {p.get('last_name','')}".strip() + \
                         (f" ({p.get('position','')}-{p.get('team') or 'FA'})" if p.get("position") else "")
        else:
            names[pid] = pid
    return names


def call_claude(summary_text, week, season):
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    prompt = f"""You are writing the Week {week} ({season} season) recap for a fantasy football league
called HMPFL — "His Majesty's Prison Fantasy League" — a league with a running prison/corrections
theme (cell blocks, booking numbers, wardens, "doing time," etc). Keep the prison theme playful and
light, never mean-spirited toward real people beyond good-natured ribbing.

Write a fun, punchy recap of the week below, covering: the closest game, the biggest blowout, the
standout player performances, and any other storylines worth calling out. Use the managers' actual
names as given. Keep it to about 300-450 words, written in enthusiastic sports-recap prose broken into
short paragraphs with a few subheadings. Do not use markdown code fences.

DATA:
{summary_text}
"""
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 1200,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    text_blocks = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
    return "\n".join(text_blocks).strip()


def main():
    if not SLEEPER_LEAGUE_ID:
        print("SLEEPER_LEAGUE_ID not set — aborting.", file=sys.stderr)
        sys.exit(1)

    league = get_current_league()
    season = league["season"]
    week = determine_target_week(league)

    rosters = http_get_json(f"{SLEEPER_API}/league/{league['league_id']}/rosters")
    users = http_get_json(f"{SLEEPER_API}/league/{league['league_id']}/users")
    summary = build_week_summary(league, week, rosters, users)

    if not summary["games"]:
        print(f"No completed games found for week {week} — skipping recap.")
        return

    player_ids = [p["player_id"] for p in summary["top_players"]]
    names = fetch_player_names(player_ids)
    for p in summary["top_players"]:
        p["player_name"] = names.get(p["player_id"], p["player_id"])

    summary_text = json.dumps({
        "games": summary["games"],
        "top_performers": [
            {"owner": p["owner"], "player": p["player_name"], "points": round(p["points"] or 0, 2)}
            for p in summary["top_players"]
        ],
    }, indent=2)

    recap_text = call_claude(summary_text, week, season)

    os.makedirs(RECAPS_DIR, exist_ok=True)
    filename = f"{season}-week{week}.json"
    filepath = os.path.join(RECAPS_DIR, filename)
    with open(filepath, "w") as f:
        json.dump({
            "season": season,
            "week": week,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "recap_text": recap_text,
            "games": summary["games"],
            "top_performers": [
                {"owner": p["owner"], "player": p["player_name"], "points": round(p["points"] or 0, 2)}
                for p in summary["top_players"][:5]
            ],
        }, f, indent=2)

    index_path = os.path.join(RECAPS_DIR, "index.json")
    index = []
    if os.path.exists(index_path):
        with open(index_path) as f:
            try:
                index = json.load(f)
            except json.JSONDecodeError:
                index = []
    index = [e for e in index if not (e["season"] == season and e["week"] == week)]
    index.append({"season": season, "week": week, "file": filename})
    index.sort(key=lambda e: (e["season"], e["week"]), reverse=True)
    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)

    print(f"Wrote recap for {season} week {week} -> {filepath}")


if __name__ == "__main__":
    main()
