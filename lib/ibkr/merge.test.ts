import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIbkrSnapshot } from "./load";
import { mergeSnapshots } from "./merge";
import type { IbkrSnapshot } from "./types";

const base = (over: Partial<IbkrSnapshot>): IbkrSnapshot => ({
  source: "flex",
  fetchedAt: "2026-10-10T07:00:00.000Z",
  asOf: "2026-10-09",
  accountId: "U00000000",
  baseCurrency: "CHF",
  netLiquidation: 0,
  cash: 0,
  unrealizedPnl: 0,
  positions: [],
  navHistory: [],
  deposits: [],
  dividends: [],
  trades: [],
  ...over,
});

const vt = (marketValueBase: number) => ({
  symbol: "VT",
  description: "VANGUARD TOT WORLD STK ETF",
  quantity: 15,
  currency: "USD",
  markPrice: 132.4,
  marketValue: 1986,
  marketValueBase,
});

describe("mergeSnapshots", () => {
  // Yesterday's file covered an older window (incl. dates that have since dropped out of the 365-day query).
  const prev = base({
    fetchedAt: "2026-10-09T07:00:00.000Z",
    asOf: "2026-10-08",
    netLiquidation: 1691.5,
    cash: 128.9,
    positions: [vt(1562.6)],
    navHistory: [
      { date: "2025-10-08", nav: 0 },
      { date: "2026-10-07", nav: 1687.25 },
      { date: "2026-10-08", nav: 1690.9 },
    ],
    deposits: [
      { date: "2025-10-08", amount: 500 },
      { date: "2026-08-28", amount: 850 },
    ],
    dividends: [
      { date: "2025-12-20", symbol: "VT", amount: 1, withholdingTax: 0.15 },
      { date: "2026-09-24", symbol: "VT", amount: 5.12, withholdingTax: 0 },
    ],
    trades: [{ date: "2026-08-31", symbol: "VT", quantity: 8, price: 130.5, currency: "USD", commission: 1, amountBase: -836 }],
  });

  const next = base({
    netLiquidation: 1698.3,
    cash: 129.36,
    unrealizedPnl: 18.37,
    positions: [vt(1568.94)],
    navHistory: [
      { date: "2026-10-09", nav: 1698.3 },
      { date: "2026-10-08", nav: 1691.5 },
    ],
    deposits: [
      { date: "2026-09-25", amount: 850 },
      { date: "2026-08-28", amount: 850 },
    ],
    dividends: [{ date: "2026-09-24", symbol: "VT", amount: 5.12, withholdingTax: 0.77 }],
    trades: [
      { date: "2026-08-31", symbol: "VT", quantity: 8, price: 130.5, currency: "USD", commission: 1, amountBase: -836 },
      { date: "2026-09-28", symbol: "VT", quantity: 7, price: 131.25, currency: "USD", commission: 1, amountBase: -735.8 },
    ],
  });

  const merged = mergeSnapshots(prev, next);

  test("scalars and positions come from next", () => {
    expect(merged).toMatchObject({
      fetchedAt: next.fetchedAt,
      asOf: "2026-10-09",
      netLiquidation: 1698.3,
      cash: 129.36,
      unrealizedPnl: 18.37,
      positions: [vt(1568.94)],
    });
  });

  test("navHistory accumulates, is sorted and unique; next wins per date", () => {
    expect(merged.navHistory).toEqual([
      { date: "2025-10-08", nav: 0 },
      { date: "2026-10-07", nav: 1687.25 },
      { date: "2026-10-08", nav: 1691.5 },
      { date: "2026-10-09", nav: 1698.3 },
    ]);
  });

  test("deposits/dividends/trades keep old history and dedupe overlaps", () => {
    expect(merged.deposits).toEqual([
      { date: "2025-10-08", amount: 500 },
      { date: "2026-08-28", amount: 850 },
      { date: "2026-09-25", amount: 850 },
    ]);
    expect(merged.dividends).toEqual([
      { date: "2025-12-20", symbol: "VT", amount: 1, withholdingTax: 0.15 },
      { date: "2026-09-24", symbol: "VT", amount: 5.12, withholdingTax: 0.77 }, // updated row from next
    ]);
    expect(merged.trades.map((t) => t.date)).toEqual(["2026-08-31", "2026-09-28"]);
  });

  test("merging the same snapshot twice is idempotent", () => {
    expect(mergeSnapshots(merged, next)).toEqual(merged);
    expect(mergeSnapshots(mergeSnapshots(merged, next), next)).toEqual(merged);
  });

  test("two genuine same-day deposits of equal size are kept", () => {
    const twice = base({
      deposits: [
        { date: "2026-08-28", amount: 100 },
        { date: "2026-08-28", amount: 100 },
      ],
    });
    expect(mergeSnapshots(twice, twice).deposits).toHaveLength(2);
    expect(mergeSnapshots(base({ deposits: [{ date: "2026-08-28", amount: 100 }] }), twice).deposits).toHaveLength(2);
  });

  test("no previous snapshot returns next (sorted)", () => {
    expect(mergeSnapshots(null, next).navHistory.map((n) => n.date)).toEqual(["2026-10-08", "2026-10-09"]);
  });

  test("different account is refused", () => {
    expect(() => mergeSnapshots(base({ accountId: "U99999999" }), next)).toThrow(/Konto U99999999/);
  });
});

describe("loadIbkrSnapshot", () => {
  test("null when missing, parsed when present, error when malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibkr-load-"));
    try {
      expect(loadIbkrSnapshot(dir)).toBeNull();
      const snap = base({ netLiquidation: 1 });
      writeFileSync(join(dir, "ibkr.json"), JSON.stringify(snap));
      expect(loadIbkrSnapshot(dir)).toEqual(snap);
      writeFileSync(join(dir, "ibkr.json"), "{");
      expect(() => loadIbkrSnapshot(dir)).toThrow(/kein gültiges JSON/);
      writeFileSync(join(dir, "ibkr.json"), JSON.stringify({ hello: 1 }));
      expect(() => loadIbkrSnapshot(dir)).toThrow(/IbkrSnapshot/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
