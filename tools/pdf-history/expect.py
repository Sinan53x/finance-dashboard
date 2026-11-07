"""Expected external figures for verify.py / report.py.

Loaded from data/private/pdf-history-expect.json (gitignored — these are real
reconciliation figures and must not be committed). A missing file or missing
key disables the corresponding check instead of failing it.

Shape: { "<account>": { "<kind>": { "<period>": "<decimal string>" } } }
"""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXPECT_PATH = ROOT / "data" / "private" / "pdf-history-expect.json"


def load_expect(path: Path = EXPECT_PATH) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return {}


def expected(expect: dict, account: str, kind: str, key: str) -> Decimal | None:
    v = expect.get(account, {}).get(kind, {}).get(key)
    return Decimal(v) if v is not None else None
