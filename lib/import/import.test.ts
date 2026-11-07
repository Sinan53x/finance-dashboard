import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTransactionsCsv } from "./csv";
import { dedupe, mergeByDate } from "./dedupe";
import { importFiles, type ImportOptions } from "./index";
import { categorize, loadRules } from "./rules";

const root = join(import.meta.dir, "../..");
const camt = join(import.meta.dir, "fixtures/camt053-v08.xml");
const zkb = join(import.meta.dir, "fixtures/zkb-export.csv");

let dir: string;
let options: ImportOptions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finance-import-"));
  options = {
    csvPath: join(dir, "transactions.csv"),
    rulesPath: join(root, "data/test-fixtures/rules.json"),
    account: "privat",
    accountIbans: { privat: "CH0000700000000000001" },
  };
  copyFileSync(join(root, "data/test-fixtures/transactions.csv"), options.csvPath);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => readFileSync(options.csvPath, "utf8");

describe("importFiles", () => {
  test("re-importing the same file adds nothing", () => {
    const first = importFiles([camt], options);
    const afterFirst = read();
    const second = importFiles([camt], options);
    expect([first.added.length, second.added.length, second.files[0].skipped.length, second.written, read() === afterFirst]).toEqual([
      6,
      0,
      6,
      false,
      true,
    ]);
  });

  test("an overlapping file only adds the bookings not yet present", () => {
    importFiles([camt], options);
    const result = importFiles([zkb], options);
    expect([result.added.map((t) => `${t.date} ${t.amount}`), result.files[0].skipped.length]).toEqual([
      ["2030-03-10 -4.5", "2030-03-10 -4.5", "2030-03-20 -250", "2030-03-20 -50", "2030-03-28 -1049.9"],
      5,
    ]);
  });

  test("overlapping files in one run are deduplicated against each other", () => {
    expect(importFiles([camt, zkb], options).added).toHaveLength(11);
  });

  test("keeps genuine same-day same-amount purchases on first import", () => {
    const result = importFiles([zkb], options);
    expect(result.added.filter((t) => t.date === "2030-03-10" && t.amount === -4.5)).toHaveLength(2);
  });

  test("appends categorised rows after the existing ones, preserving them byte-for-byte", () => {
    const before = read();
    importFiles([camt], options);
    const after = read();
    expect([after.startsWith(before), parseTransactionsCsv(after).slice(-6).map((t) => t.category)]).toEqual([
      true,
      ["Essen/Alltag", "Krankenkasse", "ÖV/Mobilität", "Unkategorisiert", "Lohn", "Notgroschen"],
    ]);
  });

  test("dry run leaves the CSV untouched", () => {
    const before = read();
    const result = importFiles([camt, zkb], { ...options, dryRun: true });
    expect([result.added.length, result.written, read() === before]).toEqual([11, false, true]);
  });
});

describe("dedupe", () => {
  test("only adds imported rows beyond the existing count per account, date and amount", () => {
    const existing = [{ account: "privat", date: "2030-01-01", amount: -4.5 }];
    const imported = [
      { account: "privat", date: "2030-01-01", amount: -4.5, id: "a" },
      { account: "privat", date: "2030-01-01", amount: -4.5, id: "b" },
      { account: "privat", date: "2030-01-01", amount: 4.5, id: "c" },
      { account: "notgroschen", date: "2030-01-01", amount: -4.5, id: "d" },
    ];
    expect(dedupe(existing, imported).added.map((t) => t.id)).toEqual(["b", "c", "d"]);
  });
});

describe("categorisation", () => {
  test("reproduces the stored category of every row in transactions.csv", () => {
    const rules = loadRules(options.rulesPath);
    const rows = parseTransactionsCsv(readFileSync(join(root, "data/test-fixtures/transactions.csv"), "utf8"));
    const mismatches = rows
      .map((t) => {
        const { category, account, ...input } = t;
        return { got: categorize(rules, { ...input, account }), want: category, t };
      })
      .filter((m) => m.got !== m.want);
    expect(mismatches.map((m) => `${m.t.date} ${m.t.payee}: ${m.got} ≠ ${m.want}`)).toEqual([]);
  });
});

describe("account resolution", () => {
  test("camt.053 rows are assigned via the statement IBAN", () => {
    const result = importFiles([camt], options);
    expect(new Set(result.added.map((t) => t.account))).toEqual(new Set(["privat"]));
  });

  test("an unknown statement IBAN fails", () => {
    expect(() => importFiles([camt], { ...options, account: undefined, accountIbans: {} })).toThrow("unknown statement IBAN");
  });

  test("ZKB CSV requires --account", () => {
    expect(() => importFiles([zkb], { ...options, account: undefined })).toThrow("--account");
  });
});

describe("mergeByDate", () => {
  test("inserts by date with existing rows first for equal dates", () => {
    const existing = [{ date: "2030-01-01", id: "e1" }, { date: "2030-01-03", id: "e2" }];
    const added = [{ date: "2030-01-03", id: "n2" }, { date: "2030-01-02", id: "n1" }, { date: "2029-12-31", id: "n0" }];
    expect(mergeByDate(existing, added).map((t) => t.id)).toEqual(["n0", "e1", "n1", "e2", "n2"]);
  });
});
