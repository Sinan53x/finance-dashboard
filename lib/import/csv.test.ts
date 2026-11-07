import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAmountToCents, parseCsv, parseTransactionsCsv, serializeTransactionsCsv } from "./csv";
import type { Transaction } from "./types";

describe("transactions CSV", () => {
  test("round-trips quoting of commas, quotes and newlines", () => {
    const rows: Transaction[] = [
      { date: "2030-01-01", valuta: "2030-01-02", account: "privat", payee: 'Muster, "Max"', text: 'TWINT von MUSTER, MAX "Danke", merci', amount: 12.5, category: "Freizeit/Shopping" },
      { date: "2030-01-03", valuta: "2030-01-03", account: "notgroschen", payee: "L'Oro", text: "two\nlines", amount: -1234, category: "Unkategorisiert" },
    ];
    const csv = serializeTransactionsCsv(rows);
    expect(csv).toContain('privat,"Muster, ""Max""","TWINT von MUSTER, MAX ""Danke"", merci",12.50,');
    expect(parseTransactionsCsv(csv)).toEqual(rows);
  });

  test("re-serialises the fixture byte-identically", () => {
    const original = readFileSync(join(import.meta.dir, "fixtures/transactions.csv"), "utf8");
    expect(serializeTransactionsCsv(parseTransactionsCsv(original))).toBe(original);
  });
});

describe("parseCsv", () => {
  test("handles BOM, CRLF, semicolons and empty fields", () => {
    expect(parseCsv('\uFEFF"a";"";"c;d"\r\n"1";;"x""y"\r\n', ";")).toEqual([
      ["a", "", "c;d"],
      ["1", "", 'x"y'],
    ]);
  });
});

describe("parseAmountToCents", () => {
  test("parses apostrophe thousands separators", () => {
    expect(["1'049.90", "4’820.35", "-0.05", ""].map(parseAmountToCents)).toEqual([104990, 482035, -5, null]);
  });
});
