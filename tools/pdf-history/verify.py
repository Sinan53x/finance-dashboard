#!/usr/bin/env python3
"""Independent re-check of the staging output written by extract.py.

Reads only data/private/staging/statements.json and the *-history.csv files (it does not
import extract.py) and re-verifies the hard invariants:

  1. per statement: opening + sum(rows) == printed closing (and == cover page values)
  2. running balance == every printed Saldo
  3. sum(debits)/sum(credits)/sum(fees) == Additionen, Zwischenadditionen, cover totals
  4. per account, the used statements chain: end date == next start date and
     closing == next opening (gaps / overlaps are reported)
  5. no double counting: used periods never overlap; a Kontoabschluss is only used where no
     reconciled monthly Kontoauszug overlaps it
  +  the CSVs are exactly the rows of the used statements (same order, same values),
     well-formed (header, ISO dates, 2-decimal amounts, empty category, sorted by date)
  +  known external figures (Notgroschen 2025) from
    data/private/pdf-history-expect.json (skipped when the file is absent)

Exit code 0 only if everything passes.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

from expect import EXPECT_PATH, load_expect, expected as exp_value

ROOT = Path(__file__).resolve().parents[2]
STAGING = ROOT / "data" / "private" / "staging"
HEADER = ["date", "valuta", "account", "payee", "text", "amount", "category"]
EXPECT = load_expect()  # real figures, kept out of the repo on purpose

failures: list[str] = []
counts = defaultdict(int)


def D(x) -> Decimal | None:
    return None if x is None else Decimal(x)


def ok(cond: bool, msg: str) -> None:
    counts["checks"] += 1
    if not cond:
        failures.append(msg)


def main() -> int:
    global STAGING
    if len(sys.argv) > 2 and sys.argv[1] == "--staging":  # for testing against a copy
        STAGING = Path(sys.argv[2])
    data = json.loads((STAGING / "statements.json").read_text(encoding="utf-8"))
    stmts = data["statements"]
    src = Path(data["source_dir"])

    # ------------------------------------------------------------ per statement
    n_ok = 0
    for s in stmts:
        f = s["file"]
        before = len(failures)
        if src.exists() and (src / f).exists():
            ok(hashlib.sha256((src / f).read_bytes()).hexdigest() == s["sha256"], f"{f}: PDF changed since extraction")
        opening, closing = D(s["opening"]), D(s["closing"])
        cover = s["cover"]
        if opening is None or closing is None or s["additionen"] is None:
            ok(False, f"{f}: missing opening/closing/Additionen")
            continue
        ok(D(cover.get("anfang")) == opening, f"{f}: Saldovortrag {opening} != cover Anfangssaldo {cover.get('anfang')}")
        ok(cover.get("anfang_date") == s["period_start"], f"{f}: Anfangssaldo date != Saldovortrag date")
        ok(D(cover.get("schluss")) == closing, f"{f}: closing {closing} != cover Schlusssaldo {cover.get('schluss')}")
        rows = s["rows"]
        total = sum((D(r["amount"]) for r in rows), Decimal(0))
        ok(opening + total == closing, f"{f}: inv1 {opening} + {total} != {closing}")
        run = opening
        for r in rows:
            run += D(r["amount"])
            if r["saldo"] is not None:
                counts["saldi"] += 1
                ok(run == D(r["saldo"]), f"{f}: inv2 {r['date']} running {run} != printed {r['saldo']}")
        bks = s["bookings"]
        ok(sum(1 for b in bks if b["saldo"] is not None) == sum(1 for r in rows if r["saldo"] is not None),
           f"{f}: printed saldi lost between bookings and rows")
        bel = sum((D(b["belastung"]) for b in bks if b["belastung"] is not None), Decimal(0))
        gut = sum((D(b["gutschrift"]) for b in bks if b["gutschrift"] is not None), Decimal(0))
        fee = sum((D(b["preis"]) for b in bks if b["preis"] is not None), Decimal(0))
        ok(gut - bel - fee == total, f"{f}: rows {total} != bookings {gut} - {bel} - {fee}")
        a = s["additionen"]
        ok((fee, bel, gut) == (D(a["preis"]), D(a["belastung"]), D(a["gutschrift"])),
           f"{f}: inv3 Additionen {a} vs rows {fee}/{bel}/{gut}")
        ok(D(cover.get("total_bel")) == bel + fee and D(cover.get("total_gut")) == gut,
           f"{f}: inv3 cover totals {cover.get('total_bel')}/{cover.get('total_gut')} vs {bel + fee}/{gut}")
        for z in s["zwischenadditionen"]:
            sub = bks[: z["after_bookings"]]
            t = (sum((D(b["preis"]) or Decimal(0) for b in sub), Decimal(0)),
                 sum((D(b["belastung"]) for b in sub if b["belastung"] is not None), Decimal(0)),
                 sum((D(b["gutschrift"]) for b in sub if b["gutschrift"] is not None), Decimal(0)))
            ok(t == (D(z["preis"]), D(z["belastung"]), D(z["gutschrift"])), f"{f}: inv3 Zwischenadditionen {z} vs {t}")
        for r in rows:
            ok(s["period_start"] <= r["date"] <= s["period_end"], f"{f}: row {r['date']} outside statement period")
        good = len(failures) == before
        ok(good == s["reconciled"], f"{f}: reconciled flag {s['reconciled']} disagrees with re-check ({good})")
        n_ok += good

    # ------------------------------------------------------------ per account
    lines = []
    for acct, info in sorted(data["accounts"].items()):
        mine = [s for s in stmts if s["account"] == acct]
        used = sorted((s for s in mine if s["used"]), key=lambda s: (s["period_start"], s["period_end"]))
        for s in used:
            ok(s["reconciled"], f"{acct}: unreconciled statement used: {s['file']}")
        gaps, overlaps = [], []
        for x, y in zip(used, used[1:]):
            if x["period_end"] < y["period_start"]:
                gaps.append(f"{x['period_end']} .. {y['period_start']}")
            elif x["period_end"] > y["period_start"]:
                overlaps.append(f"{x['file']} / {y['file']}")
            else:
                ok(x["closing"] == y["opening"],
                   f"{acct}: inv4 {x['file']} closing {x['closing']} != {y['file']} opening {y['opening']}")
        ok(not overlaps, f"{acct}: inv5 overlapping used statements {overlaps}")
        monthly = [s for s in mine if s["type"] == "Kontoauszug" and s["reconciled"]]
        for s in used:
            if s["type"] == "Kontoabschluss":
                clash = [m["file"] for m in monthly
                         if m["period_start"] < s["period_end"] and s["period_start"] < m["period_end"]]
                ok(not clash, f"{acct}: inv5 Kontoabschluss {s['file']} used although monthly statements cover it: {clash}")
        for m in monthly:
            ok(m["used"], f"{acct}: reconciled monthly statement not used: {m['file']}")

        # CSV == rows of used statements, stable-sorted by date
        expected = []
        for s in used:
            for r in s["rows"]:
                expected.append([r["date"], r["valuta"] or "", acct, r["payee"], r["text"], r["amount"], ""])
        expected.sort(key=lambda r: r[0])
        path = STAGING / info["csv"]
        raw = path.read_text(encoding="utf-8")
        got = list(csv.reader(raw.splitlines()))
        ok(got[0] == HEADER, f"{path.name}: header {got[0]}")
        body = got[1:]
        ok(body == expected, f"{path.name}: rows differ from used statements' rows "
                             f"({len(body)} vs {len(expected)})")
        for i, r in enumerate(body, 2):
            good = (len(r) == 7 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", r[0]) and re.fullmatch(r"(\d{4}-\d{2}-\d{2})?", r[1])
                    and r[2] == acct and re.fullmatch(r"-?\d+\.\d{2}", r[5]) and r[6] == "" and "\n" not in r[4])
            ok(bool(good), f"{path.name}:{i}: malformed row {r}")
        ok([r[0] for r in body] == sorted(r[0] for r in body), f"{path.name}: not sorted by date")
        ok(raw.endswith("\n") and "\r" not in raw, f"{path.name}: line endings")
        bal = D(used[0]["opening"]) + sum((Decimal(r[5]) for r in body), Decimal(0)) if used else None
        ok(bal == D(used[-1]["closing"]), f"{acct}: CSV opening + sum != last closing ({bal} vs {used[-1]['closing']})")
        lines.append(f"{acct:12s} statements used {len(used):3d}  rows {len(body):4d}  "
                     f"{used[0]['period_start']} .. {used[-1]['period_end']}  "
                     f"opening {used[0]['opening']:>9s}  closing {used[-1]['closing']:>9s}  "
                     f"gaps {gaps or 'none'}  overlaps {overlaps or 'none'}")

        if acct == "notgroschen":
            close = next((s["closing"] for s in used if s["period_end"] == "2025-12-31"), None)
            cr = sum((Decimal(r[5]) for r in body if r[0].startswith("2025") and Decimal(r[5]) > 0), Decimal(0))
            db = -sum((Decimal(r[5]) for r in body if r[0].startswith("2025") and Decimal(r[5]) < 0), Decimal(0))
            exp_close = exp_value(EXPECT, acct, "closing", "2025-12-31")
            exp_cr = exp_value(EXPECT, acct, "credits", "2025")
            exp_db = exp_value(EXPECT, acct, "debits", "2025")
            if exp_close is None and exp_cr is None and exp_db is None:
                lines.append(f"{'':12s} external checks skipped ({EXPECT_PATH.name} missing or incomplete)")
            else:
                if exp_close is not None:
                    ok(D(close) == exp_close, f"notgroschen end-2025 closing {close} != {exp_close}")
                if exp_cr is not None:
                    ok(cr == exp_cr, f"notgroschen 2025 credits {cr} != {exp_cr}")
                if exp_db is not None:
                    ok(db == exp_db, f"notgroschen 2025 debits {db} != {exp_db}")
                lines.append(f"{'':12s} external: end-2025 closing {close} (expect {exp_close}), 2025 credits {cr} "
                             f"(expect {exp_cr}), 2025 debits {db} (expect {exp_db})")

    print(f"statements: {len(stmts)}  re-verified OK: {n_ok}  failed: {len(stmts) - n_ok}")
    for ln in lines:
        print(ln)
    print(f"checks run: {counts['checks']}  printed saldi compared: {counts['saldi']}")
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for x in failures:
            print("  -", x)
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
