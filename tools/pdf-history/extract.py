#!/usr/bin/env python3
"""Extract the booking history from ZKB PDF statements into staging CSVs.

Usage:
    .venv/bin/python extract.py [PDF_DIR]        (default PDF_DIR: /tmp/zkbzip)

Outputs (all under data/private/staging/):
    privat-history.csv, notgroschen-history.csv   booking rows
    statements.json                               per-statement printed figures, checks and rows
    REPORT.md                                     human readable report

Principles
    * Rows are rebuilt from word coordinates (pdfplumber), using the x-ranges of the
      column header `Datum | Geschäftsvorgang | Preis | Belastung | Gutschrift | Valuta | Saldo`.
    * Every number written comes straight from the PDF. Nothing is inferred or "fixed":
      a statement that does not reconcile is marked failed and its rows are NOT emitted.
    * Idempotent: no timestamps, deterministic ordering, so reruns give identical files.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "private" / "staging"
EXISTING_CSV = ROOT / "data" / "private" / "transactions.csv"
DEFAULT_SRC = Path("/tmp/zkbzip")

# Account mapping lives in the gitignored data dir so this file carries no real
# IBANs: data/private/pdf-history-accounts.json ->
#   { "<IBAN>": {"account": "<id>", "kontoNr": "<Konto-Nr.>"}, ... }
_ACCOUNTS_FILE = ROOT / "data" / "private" / "pdf-history-accounts.json"
if not _ACCOUNTS_FILE.exists():
    raise SystemExit(f"missing {_ACCOUNTS_FILE} (IBAN -> account id + Konto-Nr. mapping)")
_ACCOUNTS_CFG = json.loads(_ACCOUNTS_FILE.read_text())
ACCOUNTS = {iban: cfg["account"] for iban, cfg in _ACCOUNTS_CFG.items()}
KONTO_NR = {iban: cfg["kontoNr"] for iban, cfg in _ACCOUNTS_CFG.items()}
STATEMENT_TYPES = {"Kontoauszug", "Kontoabschluss"}
SKIPPED_TYPES = {"Gutschrift", "Steuerausweis", "Abrechnung"}

FNAME_RE = re.compile(r"^(\d{6})_(\S+) (.+?) (CH\d{19})_(\d+)_(.+)\.pdf$")
AMOUNT_RE = re.compile(r"^-?\d{1,3}(?:'\d{3})*\.\d{2}-?$")
DATE_SHORT_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{2})$")
DATE_LONG_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")
CSV_HEADER = ["date", "valuta", "account", "payee", "text", "amount", "category"]
CENT = Decimal("0.01")


# --------------------------------------------------------------------------- helpers
class ParseError(Exception):
    pass


def amt(s: str) -> Decimal:
    if not AMOUNT_RE.match(s):
        raise ParseError(f"not an amount: {s!r}")
    neg = s.startswith("-") or s.endswith("-")
    v = Decimal(s.strip("-").replace("'", ""))
    return -v if neg else v


def d_short(s: str) -> date:
    m = DATE_SHORT_RE.match(s)
    if not m:
        raise ParseError(f"not a dd.mm.yy date: {s!r}")
    return date(2000 + int(m.group(3)), int(m.group(2)), int(m.group(1)))


def d_long(s: str) -> date:
    m = DATE_LONG_RE.match(s)
    if not m:
        raise ParseError(f"not a dd.mm.yyyy date: {s!r}")
    return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))


def fmt(v: Decimal | None) -> str | None:
    return None if v is None else f"{v.quantize(CENT):.2f}"


def chf(v: Decimal | None) -> str:
    if v is None:
        return "–"
    s = f"{abs(v):,.2f}".replace(",", "'")
    return ("-" if v < 0 else "") + s


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def lines_of(page, tol: float = 2.5):
    """Group words into visual lines by their top coordinate."""
    words = page.extract_words(x_tolerance=1.5, y_tolerance=2, keep_blank_chars=False)
    words.sort(key=lambda w: (w["top"], w["x0"]))
    lines: list[list[dict]] = []
    for w in words:
        if lines and abs(w["top"] - lines[-1][0]["top"]) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
    for ln in lines:
        ln.sort(key=lambda w: w["x0"])
    return lines


def text_of(ws) -> str:
    return " ".join(w["text"] for w in ws)


# --------------------------------------------------------------------------- model
@dataclass
class Booking:
    date: date
    lines: list[str]
    preis: Decimal | None = None
    bel: Decimal | None = None
    gut: Decimal | None = None
    valuta: date | None = None
    saldo: Decimal | None = None
    page: int = 0


@dataclass
class Statement:
    path: Path
    file: str
    ftype: str
    product: str
    iban: str
    account: str
    sha: str
    cover: dict = field(default_factory=dict)
    auszug_per: date | None = None
    vortrag_date: date | None = None
    vortrag: Decimal | None = None
    bookings: list[Booking] = field(default_factory=list)
    subtotals: list[tuple[int, Decimal, Decimal, Decimal]] = field(default_factory=list)  # (n_bookings_before, preis, bel, gut)
    additionen: tuple[Decimal, Decimal, Decimal] | None = None
    schluss: Decimal | None = None
    abschluss_items: list[tuple[str, Decimal]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    checks: list[dict] = field(default_factory=list)
    rows: list[dict] = field(default_factory=list)


# --------------------------------------------------------------------------- PDF parsing
COLS = ["Datum", "Geschäftsvorgang", "Preis", "Belastung", "Gutschrift", "Valuta", "Saldo"]


def find_header(line) -> dict | None:
    texts = [w["text"] for w in line]
    if not all(c in texts for c in COLS):
        return None
    return {w["text"]: (w["x0"], w["x1"]) for w in line if w["text"] in COLS}


def parse_saldo_phrase(words: list[str]) -> Decimal:
    """'Schlusssaldo zu Ihren Gunsten 1'234.56' -> +; 'zu unseren Gunsten' -> -"""
    value = amt(words[-1])
    phrase = " ".join(words[:-1])
    if "zu Ihren Gunsten" in phrase:
        return value
    if "zu unseren Gunsten" in phrase or "zu Ihren Lasten" in phrase:
        return -value
    raise ParseError(f"unknown saldo phrase: {phrase!r}")


def parse_statement(path: Path, ftype: str, product: str, iban: str) -> Statement:
    st = Statement(path=path, file=path.name, ftype=ftype, product=product, iban=iban,
                   account=ACCOUNTS[iban], sha=sha256(path))
    with pdfplumber.open(path) as pdf:
        pages = [lines_of(p) for p in pdf.pages]
        heights = [p.height for p in pdf.pages]

    # ---- IBAN on the document must match the file name
    # (the oldest statements print only the Konto-Nr., not the IBAN)
    iban_seen, konto_seen = set(), set()
    for pl in pages:
        for ln in pl:
            t = [w["text"] for w in ln]
            if t and t[0] == "IBAN":
                iban_seen.add("".join(t[1:]))
            if t and t[0] == "Konto-Nr.":
                konto_seen.add("".join(t[1:]))
    if not (iban_seen or konto_seen) or iban_seen - {iban} or konto_seen - {KONTO_NR[iban]}:
        st.errors.append(f"account on document IBAN {sorted(iban_seen)} / Konto-Nr. {sorted(konto_seen)} "
                         f"does not match file name {iban}")

    # ---- cover page
    for ln in pages[0]:
        t = [w["text"] for w in ln]
        if t[:2] == ["Anfangssaldo", "per"] and len(t) >= 4:
            st.cover["anfang_date"] = d_long(t[2])
            st.cover["anfang"] = amt(t[-1]) if len(t) == 4 else parse_saldo_phrase(t[3:])
        elif t[:2] == ["Total", "Gutschriften"]:
            st.cover["total_gut"] = amt(t[-1])
        elif t[:2] == ["Total", "Belastungen"]:
            st.cover["total_bel"] = amt(t[-1])
        elif t[:1] == ["Schlusssaldo"]:
            st.cover["schluss"] = parse_saldo_phrase(t[1:])
    for k in ("anfang_date", "anfang", "total_gut", "total_bel", "schluss"):
        if k not in st.cover:
            st.errors.append(f"cover page: '{k}' not found")

    # ---- booking table
    cols = None
    in_table = False
    done = False
    cur: Booking | None = None
    for pi, pl in enumerate(pages):
        if done:
            break
        bottom = heights[pi] - 78  # footer (bank name, barcodes, page numbers) lives below
        start_top = None
        for ln in pl:
            h = find_header(ln)
            if h:
                cols = h
                in_table = True
                start_top = ln[0]["top"]
                break
        if not in_table:
            continue
        if start_top is None:
            # continuation page without a repeated column header: skip the letterhead block
            for ln in pl:
                if ln[0]["text"] == "Zürich,":
                    start_top = ln[0]["top"]
                    break
            if start_top is None:
                st.errors.append(f"page {pi + 1}: cannot locate table start")
                break
        for ln in pl:
            # "Auszug per" appears above the header on the first table page
            t = [w["text"] for w in ln]
            if t[:2] == ["Auszug", "per"] and len(t) == 3:
                st.auszug_per = d_long(t[2])
        desc_x0 = cols["Geschäftsvorgang"][0]
        num_x0 = cols["Preis"][0] - 15
        rights = {c: cols[c][1] for c in ("Preis", "Belastung", "Gutschrift", "Saldo")}
        val_x = cols["Valuta"]
        for ln in pl:
            top = ln[0]["top"]
            if top <= start_top + 1:
                continue
            if top >= bottom:
                if any(DATE_SHORT_RE.match(w["text"]) and w["x1"] < desc_x0 for w in ln):
                    st.errors.append(f"page {pi + 1}: dated line below footer cut-off: {text_of(ln)!r}")
                continue
            datew = [w for w in ln if w["x1"] <= desc_x0 - 1]
            descw = [w for w in ln if w["x0"] >= desc_x0 - 1 and w["x0"] < num_x0]
            numw = [w for w in ln if w["x0"] >= num_x0]
            if len(datew) + len(descw) + len(numw) != len(ln):
                st.errors.append(f"page {pi + 1}: unassigned words in {text_of(ln)!r}")
            nums: dict[str, Decimal] = {}
            valuta = None
            for w in numw:
                if DATE_SHORT_RE.match(w["text"]) and w["x0"] >= val_x[0] - 8 and w["x1"] <= val_x[1] + 8:
                    valuta = d_short(w["text"])
                    continue
                if not AMOUNT_RE.match(w["text"]):
                    st.errors.append(f"page {pi + 1}: unexpected token in amount columns: {w['text']!r} in {text_of(ln)!r}")
                    continue
                col = min(rights, key=lambda c: abs(rights[c] - w["x1"]))
                if abs(rights[col] - w["x1"]) > 6:
                    st.errors.append(f"page {pi + 1}: amount {w['text']!r} not aligned to a column")
                    continue
                if col in nums:
                    st.errors.append(f"page {pi + 1}: two amounts in column {col}: {text_of(ln)!r}")
                nums[col] = amt(w["text"])
            desc = text_of(descw)
            first = descw[0]["text"] if descw else ""

            if datew:
                if len(datew) != 1 or not DATE_SHORT_RE.match(datew[0]["text"]):
                    st.errors.append(f"page {pi + 1}: bad date cell {text_of(datew)!r}")
                    continue
                bdate = d_short(datew[0]["text"])
                if first == "Saldovortrag":
                    if st.vortrag is not None:
                        st.errors.append("second Saldovortrag")
                    st.vortrag_date = bdate
                    st.vortrag = nums.get("Saldo")
                    if nums.get("Preis", Decimal(0)) != 0 or "Belastung" in nums or "Gutschrift" in nums:
                        st.errors.append(f"Saldovortrag line carries amounts: {text_of(ln)!r}")
                    cur = None
                    continue
                cur = Booking(date=bdate, lines=[desc], preis=nums.get("Preis"), bel=nums.get("Belastung"),
                              gut=nums.get("Gutschrift"), valuta=valuta, saldo=nums.get("Saldo"), page=pi + 1)
                st.bookings.append(cur)
                if cur.bel is None and cur.gut is None and not cur.preis:
                    st.errors.append(f"booking without amount: {text_of(ln)!r}")
                if cur.bel is not None and cur.gut is not None:
                    st.errors.append(f"booking with debit AND credit: {text_of(ln)!r}")
                continue

            if first in ("Zwischenadditionen", "Additionen"):
                trip = (nums.get("Preis"), nums.get("Belastung"), nums.get("Gutschrift"))
                if None in trip:
                    st.errors.append(f"incomplete {first} line: {text_of(ln)!r}")
                    continue
                if first == "Additionen":
                    st.additionen = trip
                else:
                    st.subtotals.append((len(st.bookings), *trip))
                cur = None
                continue
            if first == "Schlusssaldo":
                words = [w["text"] for w in descw] + [w["text"] for w in numw]
                st.schluss = parse_saldo_phrase(words)
                done = True
                break
            if not descw and not numw:
                continue
            if numw or valuta:
                st.errors.append(f"page {pi + 1}: amounts on an undated line: {text_of(ln)!r}")
                continue
            if cur is None:
                st.errors.append(f"page {pi + 1}: continuation line without booking: {desc!r}")
                continue
            cur.lines.append(desc)

    if not done:
        st.errors.append("table end (Schlusssaldo) not found")

    # ---- Abschluss detail page (Kontoabschluss only): components of the Abschlussbuchung
    for pl in pages:
        texts = [[w["text"] for w in ln] for ln in pl]
        if not any(t[:2] == ["Abschluss", "Valuta"] for t in texts):
            continue
        hdr = next((ln for ln in pl if [w["text"] for w in ln] == ["Datum", "Belastung", "Gutschrift"]), None)
        if hdr is None:
            st.errors.append("Abschluss page without Datum/Belastung/Gutschrift header")
            continue
        bel_r, gut_r = hdr[1]["x1"], hdr[2]["x1"]
        collecting = False
        for ln in pl:
            t = [w["text"] for w in ln]
            if t[:2] == ["Aktueller", "Abschluss"]:
                collecting = True
                continue
            if not collecting:
                continue
            if "Additionen" in t or "Abschlussbuchung" in t:
                break
            label = " ".join(w["text"] for w in ln if not AMOUNT_RE.match(w["text"]))
            amts = [w for w in ln if AMOUNT_RE.match(w["text"])]
            if len(amts) != 1 or not label:
                st.errors.append(f"Abschluss page: cannot read component line {t!r}")
                continue
            w = amts[0]
            sign = -1 if abs(w["x1"] - bel_r) < abs(w["x1"] - gut_r) else 1
            st.abschluss_items.append((label, sign * amt(w["text"])))
    return st


# --------------------------------------------------------------------------- payee / text
LEGAL = {"AG", "N.V.", "NV", "GMBH", "SA", "SARL", "SÀRL", "LTD", "LTD.", "INC", "INC.", "LLC", "KG", "BV", "B.V.", "SE", "PLC", "GENOSSENSCHAFT"}
STREET_SUFFIX = re.compile(
    r"(stra(?:ss|ß|s)e|str\.|straat|weg|gasse|platz|allee|promenade|rain|ring|quai|graben|halde|matt|hof|steig|"
    r"road|street|st\.|blvd|avenue|ave|lane|rue|via|chemin|route)$", re.I)
STANDALONE_STREET = re.compile(r"^(strasse|allee|road|street|st\.|blvd|avenue|ave|lane)$", re.I)
HOUSE_NO = re.compile(r"^\d{1,4}(?:[-/]\d{1,4})?[A-Za-z]?,?$")
PHONE = re.compile(r"^(?:\+|00)\d{9,15},?$|^0\d{9},?$")
CARD_RE = re.compile(r"^(?P<kind>.*?)\s*ZKB (?:Visa Debit Card Nr\. xxxx \d{4}|Maestro-Karte Nr\. \d+)\s*(?P<rest>.*)$")
FX_CUT = re.compile(r"(?:^|\s)(?:[A-Z]{3},?\s+)?(?:[A-Z]{3}\s+[\d']+\.\d{2}\s+abgerechnet|Kommission\s+CHF).*$")
AUFTRAG_RE = re.compile(r",?\s*Auftrags-Nr\.\s*\S+")


def clean_text(lines: list[str]) -> str:
    s = " ".join(lines)
    s = AUFTRAG_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+,", ",", s)
    s = re.sub(r",(\s*,)+", ",", s)
    return s.strip(" ,")


def split_name_address(s: str) -> str:
    """Return the name part of 'Name Street 12 8000 City'."""
    toks = s.split()
    cut = None
    for i in range(len(toks) - 1):
        if STREET_SUFFIX.search(toks[i].rstrip(",")) and HOUSE_NO.match(toks[i + 1]):
            cut = i - 1 if STANDALONE_STREET.match(toks[i].rstrip(",")) and i >= 2 else i
            break
    if cut is None:
        for i in range(1, len(toks) - 1):  # 'Name 8000 Zuerich' / 'Name CH-8000 Zuerich'
            if re.match(r"^(?:CH-)?\d{4}$", toks[i]) and toks[i + 1][:1].isalpha() and i >= 1:
                cut = i
                break
    for tok in ("Postfach", "POSTFACH"):
        if tok in toks[:cut]:
            cut = toks.index(tok)
    if cut is not None and cut > 0:
        toks = toks[:cut]
    # a legal form followed by more words: the rest is address
    for i, t in enumerate(toks):
        if t.strip(",").upper() in LEGAL and 0 < i < len(toks) - 1:
            toks = toks[: i + 1]
            break
    return " ".join(toks).strip(" ,")


def card_merchant(rest: str) -> str:
    s = FX_CUT.sub("", rest).strip(" ,")
    toks = s.split()
    while toks and re.match(r"^[A-Z]{3},$", toks[-1]):  # trailing ISO country ('NLD,')
        toks.pop()
    idx = [i for i, t in enumerate(toks) if re.match(r"^\d{4,5}$", t)]
    if idx and idx[-1] > 0:
        toks = toks[: idx[-1]]
    while len(toks) > 1 and re.match(r"^\d{4,5},?$", toks[-1]):
        toks.pop()
    return " ".join(toks).strip(" ,")


def tidy(s: str) -> str:
    return re.sub(r"\s+[-/]$", "", s.strip(" ,")).strip(" ,")


def derive(b: Booking) -> tuple[str, str]:
    """(payee, text) for a booking."""
    text = clean_text(b.lines)
    first = re.sub(r"\s+", " ", b.lines[0]).strip()
    cont = [re.sub(r"\s+", " ", x).strip() for x in b.lines[1:]]
    joined = " ".join([first] + cont)

    if first.startswith("Abschlussbuchung"):
        return "ZKB", text
    if first.startswith("Zahlungsverkehrspreise"):
        return "ZKB Gebühr", text
    m = CARD_RE.match(AUFTRAG_RE.sub("", joined))
    if m:
        kind = m.group("kind")
        if kind.startswith("Bezug"):
            return "Bargeldbezug", text
        if kind.startswith("Einzahlung"):
            return "Bareinzahlung", text
        return tidy(card_merchant(m.group("rest"))), text
    if "TWINT:" in first:
        s = AUFTRAG_RE.sub("", joined.split("TWINT:", 1)[1])
        toks = [t for t in s.split() if not PHONE.match(t)]
        s = " ".join(toks)
        s = split_name_address(s)
        s = re.sub(r"\s+na,?$", "", s)
        return tidy(s), text
    # transfers / salary: counterparty on the first continuation line
    for line in cont:
        line = AUFTRAG_RE.sub("", line).strip(" ,")
        if re.search(r"[A-Za-zÄÖÜäöü]{2}", line) and not FX_CUT.search(" " + line):
            return tidy(split_name_address(line)), text
    return "", text


# --------------------------------------------------------------------------- rows + checks
def build_rows(st: Statement) -> None:
    rows = []
    for b in st.bookings:
        payee, text = derive(b)
        if b.bel is not None:
            amount = -b.bel
        elif b.gut is not None:
            amount = b.gut
        else:
            amount = Decimal(0)
        comp = st.abschluss_items if b.lines[0].startswith("Abschlussbuchung") else []
        base = {"date": b.date, "valuta": b.valuta, "account": st.account, "payee": payee, "text": text,
                "saldo": b.saldo, "page": b.page}
        if comp and sum(a for _, a in comp) == amount:
            if len(comp) == 1:
                rows.append({**base, "text": f"{text} ({comp[0][0]})", "amount": amount})
            else:  # several components that sum exactly: one row each, saldo on the last
                for i, (label, a) in enumerate(comp):
                    rows.append({**base, "text": f"{text} ({label})", "amount": a,
                                 "saldo": b.saldo if i == len(comp) - 1 else None})
        else:
            if comp:
                st.errors.append(f"Abschluss components {comp} do not sum to booking {amount}")
            rows.append({**base, "amount": amount})
        if b.preis:
            # fee: own row. Placement relative to the booking is confirmed by the Saldo check.
            rows.append({**base, "payee": "ZKB Gebühr", "text": f"Preis: {text}", "amount": -b.preis})
            rows[-2]["saldo"] = None
    st.rows = rows


def check(st: Statement, name: str, ok: bool, detail: str) -> None:
    st.checks.append({"check": name, "ok": bool(ok), "detail": detail})


def reconcile(st: Statement) -> None:
    c = st.cover
    for e in st.errors:
        check(st, "parse", False, e)
    if st.vortrag is None or st.schluss is None or st.additionen is None:
        check(st, "structure", False, "missing Saldovortrag / Additionen / Schlusssaldo")
        return
    check(st, "opening: Saldovortrag == cover Anfangssaldo",
          c.get("anfang") == st.vortrag and c.get("anfang_date") == st.vortrag_date,
          f"{chf(st.vortrag)} per {st.vortrag_date} vs {chf(c.get('anfang'))} per {c.get('anfang_date')}")
    check(st, "closing: table Schlusssaldo == cover Schlusssaldo", c.get("schluss") == st.schluss,
          f"{chf(st.schluss)} vs {chf(c.get('schluss'))}")
    total = sum((r["amount"] for r in st.rows), Decimal(0))
    check(st, "inv1: opening + sum(rows) == closing", st.vortrag + total == st.schluss,
          f"{chf(st.vortrag)} + {chf(total)} = {chf(st.vortrag + total)} vs {chf(st.schluss)}")
    run = st.vortrag
    bad = []
    n_saldo = 0
    for r in st.rows:
        run += r["amount"]
        if r.get("saldo") is not None:
            n_saldo += 1
            if run != r["saldo"]:
                bad.append(f"{r['date']} {r['text'][:40]!r}: running {chf(run)} vs printed {chf(r['saldo'])}")
    check(st, "inv2: running balance == every printed Saldo", not bad,
          f"{n_saldo} printed saldi checked" + ("; " + "; ".join(bad[:5]) if bad else ""))
    deb = sum((b.bel for b in st.bookings if b.bel is not None), Decimal(0))
    cre = sum((b.gut for b in st.bookings if b.gut is not None), Decimal(0))
    fee = sum((b.preis for b in st.bookings if b.preis), Decimal(0))
    ap, ab, ag = st.additionen
    check(st, "inv3: Additionen (Preis, Belastung, Gutschrift)", (fee, deb, cre) == (ap, ab, ag),
          f"rows {chf(fee)}/{chf(deb)}/{chf(cre)} vs printed {chf(ap)}/{chf(ab)}/{chf(ag)}")
    check(st, "inv3: cover Total Belastungen / Gutschriften",
          c.get("total_bel") == deb + fee and c.get("total_gut") == cre,
          f"rows {chf(deb + fee)}/{chf(cre)} vs cover {chf(c.get('total_bel'))}/{chf(c.get('total_gut'))}")
    for n, sp, sb, sg in st.subtotals:
        bs = st.bookings[:n]
        t = (sum((b.preis or Decimal(0) for b in bs), Decimal(0)),
             sum((b.bel for b in bs if b.bel is not None), Decimal(0)),
             sum((b.gut for b in bs if b.gut is not None), Decimal(0)))
        check(st, "inv3: Zwischenadditionen", t == (sp, sb, sg),
              f"first {n} bookings {chf(t[0])}/{chf(t[1])}/{chf(t[2])} vs printed {chf(sp)}/{chf(sb)}/{chf(sg)}")
    if st.auszug_per is None:
        check(st, "structure", False, "'Auszug per' date not found")
    for r in st.rows:
        if not (st.vortrag_date <= r["date"] <= (st.auszug_per or r["date"])):
            check(st, "row date within statement period", False, f"{r['date']} outside {st.vortrag_date}..{st.auszug_per}")
            break


def reconciled(st: Statement) -> bool:
    return bool(st.checks) and all(x["ok"] for x in st.checks)


# --------------------------------------------------------------------------- coverage
def choose_coverage(stmts: list[Statement]) -> tuple[list[Statement], list[dict]]:
    """Monthly Kontoauszug first; Kontoabschluss only where no monthly period overlaps it."""
    notes = []
    ok = [s for s in stmts if reconciled(s)]
    chosen = [s for s in ok if s.ftype == "Kontoauszug"]

    def overlaps(a, b):
        return a.vortrag_date < b.auszug_per and b.vortrag_date < a.auszug_per

    for s in sorted((s for s in ok if s.ftype == "Kontoabschluss"), key=lambda s: s.vortrag_date):
        clash = [m.file for m in chosen if overlaps(s, m)]
        if clash:
            notes.append({"file": s.file, "used": False, "reason": f"overlaps {clash}"})
        else:
            chosen.append(s)
    chosen.sort(key=lambda s: (s.vortrag_date, s.auszug_per))
    return chosen, notes


def chain(chosen: list[Statement]) -> list[dict]:
    out = []
    for a, b in zip(chosen, chosen[1:]):
        item = {"from": a.file, "to": b.file, "a_end": a.auszug_per, "b_start": b.vortrag_date,
                "a_close": a.schluss, "b_open": b.vortrag}
        if a.auszug_per < b.vortrag_date:
            item["kind"] = "gap"
        elif a.auszug_per > b.vortrag_date:
            item["kind"] = "overlap"
        elif a.schluss != b.vortrag:
            item["kind"] = "balance mismatch"
        else:
            item["kind"] = "ok"
        out.append(item)
    return out


# --------------------------------------------------------------------------- output
def csv_text(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(CSV_HEADER)
    for r in rows:
        w.writerow([r["date"].isoformat(), r["valuta"].isoformat() if r["valuta"] else "", r["account"],
                    r["payee"], r["text"], fmt(r["amount"]), ""])
    return buf.getvalue()


def write_if_changed(p: Path, content: str) -> None:
    if not p.exists() or p.read_text(encoding="utf-8") != content:
        p.write_text(content, encoding="utf-8")


def jsonable(o):
    if isinstance(o, Decimal):
        return fmt(o)
    if isinstance(o, date):
        return o.isoformat()
    raise TypeError(type(o))


def statement_json(st: Statement, used: bool, reason: str) -> dict:
    return {
        "file": st.file, "sha256": st.sha, "type": st.ftype, "product": st.product, "account": st.account,
        "iban": st.iban, "period_start": st.vortrag_date, "period_end": st.auszug_per,
        "opening": st.vortrag, "closing": st.schluss,
        "cover": {k: v for k, v in sorted(st.cover.items())},
        "additionen": None if st.additionen is None else dict(zip(("preis", "belastung", "gutschrift"), st.additionen)),
        "zwischenadditionen": [{"after_bookings": n, "preis": p, "belastung": b, "gutschrift": g} for n, p, b, g in st.subtotals],
        "bookings": [{"date": b.date, "valuta": b.valuta, "preis": b.preis, "belastung": b.bel, "gutschrift": b.gut,
                      "saldo": b.saldo, "page": b.page, "lines": b.lines} for b in st.bookings],
        "rows": [{"date": r["date"], "valuta": r["valuta"], "payee": r["payee"], "text": r["text"],
                  "amount": r["amount"], "saldo": r.get("saldo")} for r in st.rows],
        "checks": st.checks, "reconciled": reconciled(st), "used": used, "used_reason": reason,
    }


def main(argv: list[str]) -> int:
    src = Path(argv[1]) if len(argv) > 1 else DEFAULT_SRC
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(src.glob("*.pdf"))
    stmts: list[Statement] = []
    skipped: Counter = Counter()
    unknown = []
    for p in files:
        m = FNAME_RE.match(p.name)
        if not m:
            unknown.append(p.name)
            continue
        _, ftype, product, iban, _, _ = m.groups()
        if ftype in SKIPPED_TYPES:
            skipped[ftype] += 1
            continue
        if ftype not in STATEMENT_TYPES or iban not in ACCOUNTS:
            unknown.append(p.name)
            continue
        try:
            st = parse_statement(p, ftype, product, iban)
        except ParseError as e:
            st = Statement(path=p, file=p.name, ftype=ftype, product=product, iban=iban,
                           account=ACCOUNTS[iban], sha=sha256(p))
            st.errors.append(f"fatal: {e}")
        build_rows(st)
        reconcile(st)
        stmts.append(st)

    result = {"source_dir": str(src), "files_total": len(files), "skipped": dict(sorted(skipped.items())),
              "unknown_files": unknown, "accounts": {}, "statements": []}
    all_rows = {}
    for acct in sorted(set(ACCOUNTS.values())):
        ss = sorted((s for s in stmts if s.account == acct), key=lambda s: (s.vortrag_date or date.min, s.file))
        chosen, notes = choose_coverage(ss)
        chosen_files = {s.file for s in chosen}
        note_by = {n["file"]: n["reason"] for n in notes}
        rows = []
        for s in chosen:
            rows.extend(s.rows)
        rows.sort(key=lambda r: r["date"])  # stable: statement order kept within a date
        all_rows[acct] = rows
        links = chain(chosen)
        result["accounts"][acct] = {
            "csv": f"{acct}-history.csv",
            "rows": len(rows),
            "coverage_start": chosen[0].vortrag_date if chosen else None,
            "coverage_end": chosen[-1].auszug_per if chosen else None,
            "opening": chosen[0].vortrag if chosen else None,
            "closing": chosen[-1].schluss if chosen else None,
            "used_files": [s.file for s in chosen],
            "chain": links,
        }
        for s in ss:
            if s.file in chosen_files:
                reason = "monthly statement" if s.ftype == "Kontoauszug" else "no monthly statement covers this period"
            elif not reconciled(s):
                reason = "not reconciled"
            else:
                reason = note_by.get(s.file, "")
            result["statements"].append(statement_json(s, s.file in chosen_files, reason))
        write_if_changed(OUT_DIR / f"{acct}-history.csv", csv_text(rows))

    js = json.dumps(result, default=jsonable, ensure_ascii=False, indent=1, sort_keys=False) + "\n"
    write_if_changed(OUT_DIR / "statements.json", js)
    import report  # local module; runs verify.py on the files just written
    write_if_changed(OUT_DIR / "REPORT.md", report.render(json.loads(js), all_rows, EXISTING_CSV))

    n_ok = sum(1 for s in stmts if reconciled(s))
    print(f"statements: {len(stmts)}  reconciled: {n_ok}  failed: {len(stmts) - n_ok}  skipped: {dict(skipped)}  unknown: {len(unknown)}")
    for s in stmts:
        if not reconciled(s):
            print("FAILED", s.file)
            for c in s.checks:
                if not c["ok"]:
                    print("   ", c["check"], "|", c["detail"])
    for acct, info in result["accounts"].items():
        print(f"{acct}: {info['rows']} rows, {info['coverage_start']} .. {info['coverage_end']}, "
              f"chain issues: {[l for l in info['chain'] if l['kind'] != 'ok']}")
    return 0 if n_ok == len(stmts) else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main(sys.argv))
