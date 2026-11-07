import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTransactionsCsv } from "@/lib/import/csv";
import { POST } from "./route";

const SEED_CSV = [
  "date,valuta,account,payee,text,amount,category",
  '2026-10-01,2026-10-01,privat,Migros,"Lebensmittel",-20.50,Essen/Alltag',
  '2026-10-02,2026-10-02,privat,Unbekannt AG,"Rechnung",-99.00,Unkategorisiert',
  '2026-10-03,2026-10-03,privat,Unbekannt AG,"Rechnung 2",-50.00,Unkategorisiert',
  '2026-10-04,2026-10-04,privat,Unbekannt AG,"Schon zugeordnet",-10.00,Technik/Abos',
  "",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fd-cat-"));
  writeFileSync(join(dir, "transactions.csv"), SEED_CSV);
  writeFileSync(join(dir, "rules.json"), "[]\n");
  process.env.FINANCE_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.FINANCE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/transactions/category", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

const identity = (index: number) => {
  const r = parseTransactionsCsv(SEED_CSV)[index];
  return {
    index,
    date: r.date,
    account: r.account,
    amount: r.amount,
    payee: r.payee,
    text: r.text,
  };
};

const readRows = () =>
  parseTransactionsCsv(readFileSync(join(dir, "transactions.csv"), "utf8"));

describe("POST /api/transactions/category", () => {
  test("updates the category and returns ok", async () => {
    const res = await post({ ...identity(1), category: "Freizeit/Shopping" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, index: 1 });
    expect(readRows()[1].category).toBe("Freizeit/Shopping");
  });

  test("returns 409 when the identity does not match", async () => {
    const res = await post({
      ...identity(1),
      amount: -123.45,
      category: "Essen/Alltag",
    });
    expect(res.status).toBe(409);
    expect(readRows()[1].category).toBe("Unkategorisiert");
  });

  test("createRule prepends the rule and re-categorises only Unkategorisiert rows", async () => {
    const res = await post({
      ...identity(1),
      category: "Gesundheit/Franchise",
      createRule: { pattern: "Unbekannt" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      ruleCreated: true,
      recategorized: 1,
    });
    const rows = readRows();
    expect(rows.map((r) => r.category)).toEqual([
      "Essen/Alltag",
      "Gesundheit/Franchise",
      "Gesundheit/Franchise",
      "Technik/Abos", // already categorised — untouched
    ]);
    const rules = JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"));
    expect(rules[0]).toEqual({
      category: "Gesundheit/Franchise",
      patterns: ["Unbekannt"],
      accounts: ["privat"],
    });
  });
});
