#!/usr/bin/env python3
"""
Frontend-to-backend bridge verifier.

Proves the live API returns the exact JSON shape the frontend expects AND that
CORS is configured so a browser at the Vite dev origin can actually read the
responses (the failure mode that produced "Couldn't reach your data").

Usage (with the backend running):
    python scripts/verify_bridge.py
    python scripts/verify_bridge.py --base http://localhost:8000 --origin http://127.0.0.1:5174

Stdlib only — no deps. Exit code 0 = all checks pass, 1 = a check failed.

Equivalent one-line curl for the CORS header (browser simulation):
    curl -s -i -H "Origin: http://localhost:5173" http://localhost:8000/api/dashboard | grep -i access-control-allow-origin
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, str, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((PASS if ok else FAIL, name, detail))


def _req(url: str, method: str = "GET", headers: dict | None = None):
    r = urllib.request.Request(url, method=method, headers=headers or {})
    return urllib.request.urlopen(r, timeout=10)


# ── Expected shape (mirrors the frontend TS interfaces in useDashboard.ts) ────
# (key, python type or tuple of types). None means "may be null".
SCORES_KEYS = {"day_score": int, "composite": float, "pillar_scores": dict,
               "pillar_weights": dict, "unassigned_weight": (int, float), "pillars": dict}
PILLAR_BLOCK_KEYS = {"score", "core_composite", "blocks", "dropped", "habit_weight", "habit_rate"}
DAY_KEYS = {"date", "morning_readiness", "sleep_hours", "rhr", "hrv", "training_done",
            "workout_rpe", "deep_work_hours", "macro_adherence", "caloric_variance_pct",
            "discretionary_spend", "morning_done", "evening_done", "due_count",
            "completed_count", "habit_completion_ratio"}
SCORE_POINT_KEYS = {"date", "day_score", "health", "fitness", "finance"}
DASH_KEYS = {"from_date", "to_date", "days", "today_scores", "score_series",
             "latest_bodyweight", "weekly_bodyweight"}


def check_shape(body: dict) -> None:
    missing = DASH_KEYS - set(body)
    record("dashboard: top-level keys", not missing, f"missing={missing}" if missing else "all 7 present")

    ts = body.get("today_scores", {})
    bad = [k for k, t in SCORES_KEYS.items() if k not in ts or not isinstance(ts[k], t)]
    record("dashboard: today_scores shape", not bad, f"bad/missing={bad}" if bad else "ok")

    # score_series is the new field most likely to be missing/mismatched.
    ss = body.get("score_series")
    record("dashboard: score_series is a list", isinstance(ss, list),
           f"got {type(ss).__name__}")
    if isinstance(ss, list) and ss:
        p = ss[0]
        bad = SCORE_POINT_KEYS - set(p)
        type_ok = isinstance(p.get("day_score"), int)
        record("dashboard: score_series[0] shape", not bad and type_ok,
               f"missing={bad} day_score_int={type_ok}")
    else:
        record("dashboard: score_series[0] shape", True, "empty series (no logged days) — shape N/A")

    days = body.get("days")
    record("dashboard: days is a list", isinstance(days, list), f"got {type(days).__name__}")
    if isinstance(days, list) and days:
        bad = DAY_KEYS - set(days[0])
        record("dashboard: days[0] v_daily_analysis shape", not bad, f"missing={bad}" if bad else "all 16 fields")

    pillars = ts.get("pillars", {})
    if pillars:
        name, ps = next(iter(pillars.items()))
        bad = PILLAR_BLOCK_KEYS - set(ps)
        record(f"dashboard: pillar '{name}' block decomposition", not bad,
               f"missing={bad}" if bad else "score/blocks/dropped present")
    else:
        record("dashboard: pillar decomposition", True, "no scorable pillar yet — N/A")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--origin", default="http://localhost:5173",
                    help="Browser origin to simulate for the CORS check")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    # 1) Reachability
    try:
        h = _req(f"{base}/healthz")
        record("server reachable (/healthz)", h.status == 200, f"status={h.status}")
    except (urllib.error.URLError, OSError) as e:
        record("server reachable (/healthz)", False, f"{e} — is uvicorn running on {base}?")
        return report()

    # 2) Dashboard JSON shape
    try:
        resp = _req(f"{base}/api/dashboard?days=30", headers={"Origin": args.origin})
        raw = resp.read().decode()
        body = json.loads(raw)
        record("GET /api/dashboard returns 200 JSON", resp.status == 200, f"status={resp.status}")
        check_shape(body)
        # 3) CORS: the browser can read the response only if ACAO echoes the origin
        acao = resp.headers.get("access-control-allow-origin")
        record("CORS: Access-Control-Allow-Origin present for browser origin",
               acao in (args.origin, "*"), f"ACAO={acao!r} for Origin={args.origin!r}")
    except urllib.error.HTTPError as e:
        record("GET /api/dashboard returns 200 JSON", False, f"HTTP {e.code}: {e.read().decode()[:200]}")
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        record("GET /api/dashboard returns 200 JSON", False, str(e))

    # 4) CORS preflight for a JSON POST (morning log)
    try:
        pre = _req(
            f"{base}/api/logs/morning",
            method="OPTIONS",
            headers={
                "Origin": args.origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        acao = pre.headers.get("access-control-allow-origin")
        methods = (pre.headers.get("access-control-allow-methods") or "").upper()
        ok = pre.status in (200, 204) and acao in (args.origin, "*") and ("POST" in methods or "*" in methods)
        record("CORS preflight (OPTIONS) allows POST", ok,
               f"status={pre.status} ACAO={acao!r} allow-methods={methods!r}")
    except urllib.error.HTTPError as e:
        # Some stacks return the preflight as an error code; inspect headers anyway.
        acao = e.headers.get("access-control-allow-origin")
        record("CORS preflight (OPTIONS) allows POST", acao in (args.origin, "*"),
               f"HTTP {e.code} ACAO={acao!r}")
    except (urllib.error.URLError, OSError) as e:
        record("CORS preflight (OPTIONS) allows POST", False, str(e))

    return report()


def report() -> int:
    print("\n  VIVID bridge verification")
    print("  " + "-" * 60)
    failed = 0
    for status, name, detail in results:
        mark = "[OK]  " if status == PASS else "[FAIL]"
        if status == FAIL:
            failed += 1
        print(f"  {mark} {name}" + (f"  ->  {detail}" if detail else ""))
    print("  " + "-" * 60)
    print(f"  {len(results) - failed}/{len(results)} checks passed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
