"""Render data/private/staging/REPORT.md (called by extract.py)."""
from __future__ import annotations

import csv
import subprocess
import sys
from collections import Counter, defaultdict
from itertools import combinations
from datetime import date
from decimal import Decimal
from pathlib import Path

from expect import expected, load_expect

HERE = Path(__file__).resolve().parent

# Real reconciliation figures live in the gitignored pdf-history-expect.json;
# absent values render as "–" and mark the check as skipped.
EXPECT = load_expect()


def chf(v) -> str:
    if v is None:
        return "–"
    v = Decimal(v)
    s = f"{abs(v):,.2f}".replace(",", "'")
    return ("-" if v < 0 else "") + s


def short(name: str) -> str:
    # 230131_Kontoauszug Jugendprivatkonto CH28..._id_Max Muster.pdf -> 230131 Kontoauszug Jugendprivatkonto
    head = name.split(" CH", 1)[0]
    return head.replace("_", " ", 1)


def load_existing(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        out = []
        for r in csv.DictReader(fh):
            r["amount"] = Decimal(r["amount"])
            out.append(r)
        return out


def iso(d) -> str:
    return d.isoformat() if hasattr(d, "isoformat") else (d or "")


def strict_match(ours: list[dict], theirs: list[dict]):
    """Multiset match on (date, amount). Order independent."""
    left = list(theirs)
    matched, only_ours = [], []
    for r in ours:
        k = (iso(r["date"]), r["amount"])
        hit = next((t for t in left if (t["date"], t["amount"]) == k), None)
        if hit is None:
            only_ours.append(r)
        else:
            left.remove(hit)
            matched.append((r, hit))
    return matched, only_ours, left


def explain(only_ours: list[dict], only_theirs: list[dict], max_days: int = 5):
    """Pair leftovers of equal amount by the closest date (either side's date or valuta), then look
    for statement rows whose amount equals the sum of 2-4 leftover rows on the same date/valuta."""
    def dist(r, t):
        rd = [date.fromisoformat(x) for x in (iso(r["date"]), iso(r["valuta"])) if x]
        td = [date.fromisoformat(x) for x in (t["date"], t["valuta"]) if x]
        return min(abs((x - y).days) for x in rd for y in td)
    cands = sorted(((dist(r, t), i, j) for i, r in enumerate(only_ours) for j, t in enumerate(only_theirs)
                    if r["amount"] == t["amount"]), key=lambda x: x)
    used_o, used_t, pairs = set(), set(), []
    for dd, i, j in cands:
        if dd <= max_days and i not in used_o and j not in used_t:
            used_o.add(i); used_t.add(j)
            r, t = only_ours[i], only_theirs[j]
            if t["date"] == iso(r["valuta"]) or t["valuta"] == iso(r["date"]) or t["valuta"] == iso(r["valuta"]):
                why = "same amount; dates differ but a valuta lines up"
            else:
                why = f"same amount, dates {dd} day(s) apart"
            pairs.append((r, t, why))
    rest_o = [r for i, r in enumerate(only_ours) if i not in used_o]
    rest_t = [t for j, t in enumerate(only_theirs) if j not in used_t]
    batches = []
    for r in list(rest_o):
        keys = {iso(r["date"]), iso(r["valuta"])}
        same = [t for t in rest_t if t["date"] in keys or t["valuta"] in keys]
        for k in range(2, min(4, len(same)) + 1):
            found = next((c for c in combinations(same, k) if sum(t["amount"] for t in c) == r["amount"]), None)
            if found:
                batches.append((r, list(found)))
                rest_o.remove(r)
                for t in found:
                    rest_t.remove(t)
                break
    return pairs, batches, rest_o, rest_t


def compare_md(w, ours, theirs, windows):
    """Strict (date, amount) matching over the whole common period; explanations are searched over the
    whole period too (so a pair straddling a window edge is still explained); rendering per window,
    each row placed by its own date."""
    matched, only_o, only_t = strict_match(ours, theirs)
    pairs, batches, rest_o, rest_t = explain(only_o, only_t)
    expl = {}
    for r, t, why in pairs:
        expl[id(r)] = f"pairs with transactions.csv {t['date']} (valuta {t['valuta']}): {why}"
        expl[id(t)] = f"pairs with statement {iso(r['date'])} (valuta {iso(r['valuta'])}): {why}"
    for r, ts in batches:
        expl[id(r)] = "batch total = " + " + ".join(f"{t['payee']} {chf(t['amount'])}" for t in ts) + " in transactions.csv"
        for t in ts:
            expl[id(t)] = f"part of statement batch {iso(r['date'])} {chf(r['amount'])} ({r['text']})"
    for label, lo, hi in windows:
        inw = lambda x: lo <= iso(x["date"]) <= hi
        o_w = [r for r in ours if inw(r)]
        t_w = [t for t in theirs if inw(t)]
        m_w = [m for m in matched if inw(m[0])]
        uo = [r for r in only_o if inw(r)]
        ut = [t for t in only_t if inw(t)]
        w(f"**{label}**: statements {len(o_w)} rows, transactions.csv {len(t_w)} rows → matched on (date, amount): "
          f"**{len(m_w)}**; not matched: **{len(uo)}** statement rows / **{len(ut)}** transactions.csv rows; "
          f"of these unexplained: **{sum(1 for r in uo if id(r) not in expl)}** / **{sum(1 for t in ut if id(t) not in expl)}**.")
        w("")
        if not uo and not ut:
            continue
        w("| source | date | valuta | amount | payee | text | explanation |")
        w("|---|---|---|---:|---|---|---|")
        rows = [("statements", r) for r in uo] + [("transactions.csv", t) for t in ut]
        rows.sort(key=lambda x: (iso(x[1]["date"]), x[0]))
        for src, r in rows:
            w(f"| {src} | {iso(r['date'])} | {iso(r['valuta'])} | {chf(r['amount'])} | {r['payee']} | {r['text'][:70]} | "
              f"{expl.get(id(r), '**unexplained**')} |")
        w("")
    return matched, only_o, only_t, rest_o, rest_t


def row_md(r, ours=True) -> str:
    if ours:
        return f"| {r['date']} | {r['valuta'] or ''} | {chf(r['amount'])} | {r['payee']} | {r['text'][:90]} |"
    return f"| {r['date']} | {r['valuta']} | {chf(r['amount'])} | {r['payee']} | {r['text'][:90]} |"


def render(result: dict, rows: dict[str, list[dict]], existing_csv: Path) -> str:
    out: list[str] = []
    w = out.append
    stmts = result["statements"]
    n_ok = sum(1 for s in stmts if s["reconciled"])
    w("# ZKB PDF history – staging report")
    w("")
    w("Generated by `tools/pdf-history/extract.py` (deterministic; rerun gives identical output). "
      "Re-checked by `tools/pdf-history/verify.py` (output at the end).")
    w("")
    w(f"- Source: `{result['source_dir']}` – {result['files_total']} PDFs; statements parsed: {len(stmts)} "
      f"(reconciled ✓ {n_ok}, failed ✗ {len(stmts) - n_ok}); skipped by type: "
      + ", ".join(f"{k} {v}" for k, v in result["skipped"].items())
      + (f"; unrecognised file names: {len(result['unknown_files'])}" if result["unknown_files"] else ""))
    for acct, info in result["accounts"].items():
        w(f"- `{info['csv']}`: **{info['rows']} rows**, {info['coverage_start']} → {info['coverage_end']}, "
          f"opening {chf(info['opening'])} → closing {chf(info['closing'])}")
    w(f"- Total rows: **{sum(i['rows'] for i in result['accounts'].values())}**")
    w("- Layout: every Kontoauszug and Kontoabschluss in this set uses the `Auszug per` table "
      "(`Datum | Geschäftsvorgang | Preis | Belastung | Gutschrift | Valuta | Saldo`, Saldovortrag, Saldo on every booking) "
      "plus a cover page with Anfangssaldo / Total Gutschriften / Total Belastungen / Schlusssaldo. "
      "The dd.mm.yyyy `Buchungstext`/`Saldo per` layout does not occur in these files.")
    w("")

    # ---------------------------------------------------------------- per file
    w("## Per-file reconciliation")
    w("")
    w("Checks per statement: Saldovortrag = cover Anfangssaldo; opening + Σrows = Schlusssaldo (= cover); running balance = every printed Saldo; "
      "Σ Preis/Belastung/Gutschrift = Additionen (and Zwischenadditionen, cover totals); row dates inside the period.")
    w("")
    w("| File | Type | Account | Period (Saldovortrag → Auszug per) | Rows | Opening | Closing | Saldi checked | Reconciled | Used |")
    w("|---|---|---|---|---:|---:|---:|---:|---|---|")
    for s in sorted(stmts, key=lambda s: (s["account"], s["period_start"] or "", s["file"])):
        nsal = sum(1 for r in s["rows"] if r["saldo"] is not None)
        bad = [c for c in s["checks"] if not c["ok"]]
        rec = "✓" if s["reconciled"] else "✗ " + "; ".join(f"{c['check']}: {c['detail']}" for c in bad)
        used = "yes" if s["used"] else f"no ({s['used_reason']})"
        w(f"| {short(s['file'])} | {s['type']} | {s['account']} | {s['period_start']} → {s['period_end']} | "
          f"{len(s['rows'])} | {chf(s['opening'])} | {chf(s['closing'])} | {nsal} | {rec} | {used} |")
    w("")

    # ---------------------------------------------------------------- coverage
    w("## Coverage timeline")
    w("")
    for acct, info in result["accounts"].items():
        w(f"### {acct}")
        w("")
        used = [s for s in stmts if s["account"] == acct and s["used"]]
        used.sort(key=lambda s: s["period_start"])
        issues = [l for l in info["chain"] if l["kind"] != "ok"]
        w(f"Covered continuously from balance date **{info['coverage_start']}** (opening {chf(info['opening'])}) to "
          f"**{info['coverage_end']}** (closing {chf(info['closing'])}) by {len(used)} statements. "
          f"Gaps/overlaps/balance breaks: **{'none' if not issues else len(issues)}**.")
        w("")
        for l in issues:
            w(f"- {l['kind']}: {short(l['from'])} (ends {l['a_end']}, closing {chf(l['a_close'])}) → "
              f"{short(l['to'])} (starts {l['b_start']}, opening {chf(l['b_open'])})")
        # months without their own statement (covered by the following one)
        multi = []
        for s in used:
            a, b = date.fromisoformat(s["period_start"]), date.fromisoformat(s["period_end"])
            months = (b.year - a.year) * 12 + b.month - a.month
            if months > 1:
                multi.append(f"{short(s['file'])} spans {s['period_start']} → {s['period_end']}")
        if used and all(s["type"] == "Kontoabschluss" for s in used):
            w("Only year-end Kontoabschluss statements exist for this account (one per calendar year, full-year booking list).")
            w("")
            multi = []
        if multi:
            w("Statements spanning more than one month (the bank issued no separate statement for a month without "
              "bookings; the next statement starts at the previous closing date and balance, so the chain is continuous):")
            w("")
            for m in multi:
                w(f"- {m}")
            w("")
        w("| # | Statement | From | To | Opening | Closing | Rows |")
        w("|---:|---|---|---|---:|---:|---:|")
        for i, s in enumerate(used, 1):
            w(f"| {i} | {short(s['file'])} | {s['period_start']} | {s['period_end']} | {chf(s['opening'])} | "
              f"{chf(s['closing'])} | {len(s['rows'])} |")
        w("")
        notused = [s for s in stmts if s["account"] == acct and not s["used"]]
        if notused:
            w("Not used: " + "; ".join(f"{short(s['file'])} ({s['used_reason']})" for s in notused))
            w("")

    # ---------------------------------------------------------------- cross-checks
    existing = load_existing(existing_csv)
    w("## Cross-checks")
    w("")
    # Notgroschen
    ng = rows.get("notgroschen", [])
    ng_used = [s for s in stmts if s["account"] == "notgroschen" and s["used"]]
    close25 = next((s for s in ng_used if s["period_end"] == "2025-12-31"), None)
    cr25 = sum((r["amount"] for r in ng if r["date"].year == 2025 and r["amount"] > 0), Decimal(0))
    db25 = -sum((r["amount"] for r in ng if r["date"].year == 2025 and r["amount"] < 0), Decimal(0))
    w("### 1. Notgroschen year-end 2025")
    w("")
    exp_close = expected(EXPECT, "notgroschen", "closing", "2025-12-31")
    exp_cr = expected(EXPECT, "notgroschen", "credits", "2025")
    exp_db = expected(EXPECT, "notgroschen", "debits", "2025")
    mark = lambda got, exp: "–" if exp is None else ("✓" if got == exp else "✗")
    w("| Figure | Expected | Extracted rows | Printed (Kontoabschluss 2025 cover) | |")
    w("|---|---:|---:|---:|---|")
    if close25:
        c = close25["cover"]
        w(f"| Schlusssaldo 31.12.2025 | {chf(exp_close)} | {chf(close25['closing'])} | {chf(c['schluss'])} | "
          f"{mark(Decimal(close25['closing']), exp_close)} |")
        w(f"| Total Gutschriften 2025 | {chf(exp_cr)} | {chf(cr25)} | {chf(c['total_gut'])} | {mark(cr25, exp_cr)} |")
        w(f"| Total Belastungen 2025 | {chf(exp_db)} | {chf(db25)} | {chf(c['total_bel'])} | {mark(db25, exp_db)} |")
    else:
        w("| (no 2025 Kontoabschluss used) | | | | ✗ |")
    w("")

    # Privat opening 2026-08-20
    pv = rows.get("privat", [])
    pv_used = sorted((s for s in stmts if s["account"] == "privat" and s["used"]), key=lambda s: s["period_start"])
    pv_open = expected(EXPECT, "privat", "balance", "2026-08-20")
    w(f"### 2. Privatkonto balance around 2026-08-20 vs existing opening {chf(pv_open)}")
    w("")
    if pv_used:
        bal = Decimal(pv_used[0]["opening"])
        bal_19 = None
        trail = []
        for r in pv:
            if r["date"] <= date(2026, 8, 19):
                bal += r["amount"]
                bal_19 = bal
            elif r["date"] == date(2026, 8, 20):
                bal += r["amount"]
                trail.append((r, bal))
        if pv_open is None:
            w("- No expected opening in `data/private/pdf-history-expect.json` — comparison skipped.")
        else:
            w(f"- Balance at end of **2026-08-19** per statements: **{chf(bal_19)}** "
              f"(difference to {chf(pv_open)}: {chf(bal_19 - pv_open) if bal_19 is not None else '–'}).")
            for r, b in trail:
                w(f"- 2026-08-20 {chf(r['amount'])} {r['payee'] or r['text'][:50]!s} → running balance {chf(b)}"
                  + (f" ← equals {chf(pv_open)}" if b == pv_open else ""))
            hit = next((r for r, b in trail if b == pv_open), None)
            if bal_19 == pv_open:
                w(f"- {chf(pv_open)} equals the balance at the end of 2026-08-19.")
            elif hit is not None:
                w(f"- {chf(pv_open)} is **not** the balance at the end of 2026-08-19; it is the balance *after* the "
                  f"2026-08-20 booking `{hit['text']}` ({chf(hit['amount'])}). The opening in transactions.csv is "
                  f"therefore only consistent if that booking is not in transactions.csv (see the unmatched list below).")
            else:
                w(f"- {chf(pv_open)} does not occur as a balance on 2026-08-19/20.")
    w("")
    last_end = date.fromisoformat(pv_used[-1]["period_end"]) if pv_used else date(2026, 8, 31)
    ex_p = [r for r in existing if r["account"] == "privat" and "2026-08-20" <= r["date"] <= last_end.isoformat()]
    ours_p = [r for r in pv if date(2026, 8, 20) <= r["date"] <= last_end]
    w("Matching key is each file's own `date` column. transactions.csv often carries the card/transaction date where the "
      "statement carries the booking date, so equal-amount rows whose dates differ are listed with an explanation "
      "(searched across the whole common period up to the last statement), never counted as matches. "
      f"transactions.csv rows after {last_end} are ignored.")
    w("")
    compare_md(w, ours_p, ex_p, [("20.08.–31.08.2026 (requested window)", "2026-08-20", "2026-08-31"),
                                 (f"01.09.–{last_end:%d.%m.%Y} (extra: the last statement also covers September)",
                                  "2026-09-01", last_end.isoformat())])

    # Notgroschen vs existing e-banking rows
    ex_n = [r for r in existing if r["account"] == "notgroschen"]
    cov_end = result["accounts"]["notgroschen"]["coverage_end"]
    cov_start = result["accounts"]["notgroschen"]["coverage_start"]
    ex_in = [r for r in ex_n if str(cov_start) < r["date"] <= str(cov_end)]
    ex_out = [r for r in ex_n if r not in ex_in]
    w("### 3. Notgroschen: statements vs the 34 e-banking rows in transactions.csv")
    w("")
    w(f"transactions.csv has {len(ex_n)} notgroschen rows; {len(ex_in)} fall inside the statement coverage "
      f"({cov_start} → {cov_end}), {len(ex_out)} are later (no Sparkonto statement after 31.12.2025 in the set).")
    w("")
    compare_md(w, ng, ex_in, [(f"{cov_start} → {cov_end}", str(cov_start), str(cov_end))])
    if ex_out:
        w("transactions.csv rows after the last statement (not comparable): "
          + ", ".join(f"{t['date']} {chf(t['amount'])}" for t in ex_out))
        w("")

    # ---------------------------------------------------------------- payees
    w("## Top 30 payees (both accounts)")
    w("")
    cnt: Counter = Counter()
    tot: dict = defaultdict(Decimal)
    accts: dict = defaultdict(set)
    for acct, rs in rows.items():
        for r in rs:
            p = r["payee"] or "(empty)"
            cnt[p] += 1
            tot[p] += r["amount"]
            accts[p].add(acct)
    w("| # | Payee | Count | Total CHF | Account(s) |")
    w("|---:|---|---:|---:|---|")
    for i, (p, n) in enumerate(sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:30], 1):
        w(f"| {i} | {p} | {n} | {chf(tot[p])} | {', '.join(sorted(accts[p]))} |")
    w("")

    # ---------------------------------------------------------------- decisions
    w("## Decisions / conventions")
    w("")
    for d in DECISIONS:
        w(f"- {d}")
    w("")

    # ---------------------------------------------------------------- verify
    w("## verify.py output")
    w("")
    w("```")
    out_text = run_verify()
    w(out_text.rstrip())
    w("```")
    w("")
    return "\n".join(out)


def run_verify() -> str:
    # run as a separate process on the files just written (extract.py writes CSV + JSON before the report)
    p = subprocess.run([sys.executable, str(HERE / "verify.py")], capture_output=True, text=True)
    return p.stdout + (p.stderr or "")


DECISIONS = [
    "`date` = booking date (Datum column), `valuta` = Valuta column. Rows are stable-sorted by date; within a date the statement order is kept.",
    "Amount sign: Belastung → negative, Gutschrift → positive. No statement in this set has a non-zero `Preis`; the code would emit a separate `ZKB Gebühr` row and the Saldo check would confirm its effect.",
    "`text` = all printed lines of the booking (first line plus continuation lines: counterparty/address, FX details), whitespace collapsed, `Auftrags-Nr. …` removed.",
    "`payee`: card bookings → merchant (text after the card number up to the trailing terminal/postcode number and city, country code and FX part removed); TWINT → name after `TWINT:` with phone numbers and street addresses removed; transfers/salary → first continuation line with the address cut off (street + house number, postcode, or everything after a legal form such as AG/GmbH/LTD).",
    "Cash: `Bezug … Visa Debit Card` → payee `Bargeldbezug`, `Einzahlung CHF Noten …` → payee `Bareinzahlung` (ATM location stays in `text`). `Zahlungsverkehrspreise` → payee `ZKB Gebühr`. `Abschlussbuchung` → payee `ZKB`, text enriched with its components from the Abschluss page (here always only `Guthabenzins`).",
    "Payee left empty where the statement prints no counterparty: on the Privatkonto, outgoing e-banking payments and standing orders (`Belastung (1) eBanking [Mobile]`, `Belastung (1) Mobile Banking`, `Belastung (1) Dauerauftrag`) never print the beneficiary; all batch bookings `Belastung (n>1) …` (no sub-payees/sub-amounts are printed anywhere in this set, so no batch was split); TWINT lines showing only a phone number; and one FX payment whose continuation line is only the exchange rate. These rows will need rules based on amount/date or manual categorisation.",
    "Coverage: all reconciled monthly Kontoauszüge are used; a Kontoabschluss is used only if no monthly statement overlaps its period. In this set the privat Kontoabschluss files cover only the last month(s) of each year (from the last monthly statement's end to 31.12), so all are used without overlap; the Sparkonto Kontoabschluss files are the only Notgroschen source and cover full years.",
    "A statement that fails any check would be excluded from the CSV (gap) rather than repaired. None failed.",
    "The oldest statements (2021 – early 2022) print only the Konto-Nr. (1148-3901.439), not the IBAN; account identity is checked against IBAN or Konto-Nr.",
]
