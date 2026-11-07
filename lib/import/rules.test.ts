import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTransactionsCsv } from "./csv";
import { categorize, loadRules, validateRules, type Rule } from "./rules";

// Frozen fictional fixtures (data/test-fixtures, from scripts/generate-demo.ts)
// — the live transactions.csv grows on every import, so the regression runs
// against this snapshot + its matching rules.json.
const fixtures = join(import.meta.dir, "../../data/test-fixtures");
const hasFixtures =
  existsSync(join(fixtures, "transactions.csv")) &&
  existsSync(join(fixtures, "rules.json"));
if (!hasFixtures) {
  // biome-ignore lint/suspicious/noConsole: test-environment notice
  console.warn("rules.test: data/test-fixtures missing — skipped");
}
const rules = hasFixtures ? loadRules(join(fixtures, "rules.json")) : [];
const existing = hasFixtures
  ? parseTransactionsCsv(
      readFileSync(join(fixtures, "transactions.csv"), "utf8")
    )
  : [];

describe("rules.json regression", () => {
  (hasFixtures ? test : test.skip)(
    "reproduces the category of every fixture transactions.csv row",
    () => {
    const mismatches = existing
      .map((row) => ({ row, got: categorize(rules, row) }))
      .filter(({ row, got }) => got !== row.category)
      .map(({ row, got }) => `${row.date} ${row.payee} ${row.amount}: expected ${row.category}, got ${got}`);
    expect(existing.length).toBeGreaterThanOrEqual(53);
    expect(mismatches).toEqual([]);
  });
});

describe("categorize", () => {
  const sample: Rule[] = [
    { category: "Own", iban: "CH00 0070 0000 0000 0000 2" },
    { category: "Exact", patterns: ["Alex Muster"], minAmount: 1500, maxAmount: 1500 },
    { category: "Credit", patterns: ["acme"], sign: "credit" },
    { category: "Debit", patterns: ["acme"], sign: "debit" },
  ];

  test("matches IBAN ignoring spaces and case", () => {
    expect(categorize(sample, { payee: "x", text: "y", amount: -1, iban: "ch0000700000000000002" })).toBe("Own");
  });

  test("applies exact absolute amount bounds", () => {
    expect([1500, -1500, -1499.99, 1500.01].map((amount) => categorize(sample, { payee: "Alex Muster", text: "", amount }))).toEqual([
      "Exact",
      "Exact",
      "Unkategorisiert",
      "Unkategorisiert",
    ]);
  });

  test("respects sign and matches case-insensitively across payee and text", () => {
    expect([10, -10].map((amount) => categorize(sample, { payee: "Foo", text: "ACME Corp", amount }))).toEqual(["Credit", "Debit"]);
  });

  test("rejects rules without conditions", () => {
    expect(() => validateRules([{ category: "Broken" }])).toThrow("needs patterns or iban");
  });
});
