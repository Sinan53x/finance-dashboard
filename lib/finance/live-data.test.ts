import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { accountBalanceAt } from "./analysis";
import { loadFinance } from "./load";

// Sanity check against the live CSV: only invariants, which hold regardless of
// how many rows imports add. Assertions stay literal-free so this file carries
// no personal data.
const LIVE = join(import.meta.dir, "../../data/private");
const hasLive =
  existsSync(join(LIVE, "transactions.csv")) &&
  existsSync(join(LIVE, "finance.json"));
const t = hasLive ? test : test.skip;
if (!hasLive) {
  // biome-ignore lint/suspicious/noConsole: test-environment notice
  console.warn("live-data.test: data/private missing — skipped");
}

const { finance, transactions: txs } = hasLive
  ? await loadFinance(LIVE)
  : { finance: undefined, transactions: [] };

describe("live data anchors", () => {
  const asOf = finance?.balancesAsOf ?? "";
  const acc = (id: string) => finance!.accounts.find((a) => a.id === id)!;
  const rows = (id: string) => txs.filter((r) => r.account === id);
  const at = (id: string, date: string) =>
    accountBalanceAt(rows(id), acc(id).balance, asOf, date);

  t("privat: pre-first-row balance equals the anchor minus the full-history sum", () => {
    const first = rows("privat")[0].date;
    const dayBefore = new Date(Date.parse(first) - 86400e3)
      .toISOString()
      .slice(0, 10);
    const sum = rows("privat")
      .filter((r) => r.date <= asOf)
      .reduce((s, r) => s + r.amount, 0);
    expect(at("privat", dayBefore)).toBe(
      Math.round((acc("privat").balance - sum) * 100) / 100,
    );
  });

  t("every account lands back on its anchor balance at balancesAsOf", () => {
    for (const a of finance!.accounts) {
      expect(at(a.id, asOf)).toBe(a.balance);
    }
  });
});
