import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCamt053 } from "./camt";
import { categorize, loadRules, type Rule } from "./rules";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
// The fixture's own-account IBAN is fake, so prepend a rule for it to the
// committed fictional rules.
const rules: Rule[] = [
  { category: "Notgroschen", iban: "CH0000700000000000002" },
  ...loadRules(join(import.meta.dir, "../../data/test-fixtures/rules.json")),
];

describe("parseCamt053 (.001.08, default namespace)", () => {
  const { transactions, warnings } = parseCamt053(fixture("camt053-v08.xml"));

  test("parses card purchase, split batch, salary and own-account transfer", () => {
    const own = "CH0000700000000000001";
    expect(transactions).toEqual([
      { date: "2030-03-12", valuta: "2030-03-10", payee: "Coop-9999 Musterdorf", text: "Einkauf ZKB Visa Debit Card Nr. xxxx 1234, Coop-9999 Musterdorf 0815", amount: -23.45, accountIban: own },
      { date: "2030-03-15", valuta: "2030-03-15", payee: "Visana Services AG", text: "Prämie März 2030", amount: -342.10, iban: "CH0000700000000000011", accountIban: own },
      { date: "2030-03-15", valuta: "2030-03-15", payee: "SBB AG", text: "Halbtax Verlängerung", amount: -98, iban: "CH0000700000000000012", accountIban: own },
      { date: "2030-03-15", valuta: "2030-03-15", payee: "Max Muster", text: "Anteil Ferienwohnung", amount: -120.65, iban: "CH0000700000000000013", accountIban: own },
      { date: "2030-03-25", valuta: "2030-03-25", payee: "Muster AG", text: "Gutschrift Salär März 2030", amount: 4820.35, iban: "CH0000700000000000021", accountIban: own },
      { date: "2030-03-26", valuta: "2030-03-26", payee: "Erika Beispiel", text: "Kontoübertrag Sparkonto", amount: -500, iban: "CH0000700000000000002", accountIban: own },
    ]);
    expect(warnings).toEqual([]);
  });

  test("batch split amounts sum to the entry total", () => {
    const batch = transactions.filter((t) => t.date === "2030-03-15");
    expect(Math.round(batch.reduce((sum, t) => sum + t.amount, 0) * 100)).toBe(-56075);
  });

  test("categorises rows, including the IBAN-matched transfer", () => {
    expect(transactions.map((t) => categorize(rules, t))).toEqual([
      "Essen/Alltag",
      "Krankenkasse",
      "ÖV/Mobilität",
      "Unkategorisiert",
      "Lohn",
      "Notgroschen",
    ]);
  });
});

describe("parseCamt053 (.001.04, prefixed namespace)", () => {
  test("reads Cdtr/Nm, DtTm dates, strips Auftrags-Nr. and skips pending entries", () => {
    const { transactions, warnings } = parseCamt053(fixture("camt053-v04.xml"));
    expect({ transactions, warnings: warnings.length }).toEqual({
      transactions: [
        {
          date: "2030-04-02",
          valuta: "2030-04-02",
          payee: "Muster & Partner GmbH",
          text: "Belastung Mobile Banking: Muster & Partner GmbH",
          amount: -1000,
          iban: "CH0000700000000000031",
          accountIban: "CH0000700000000000001",
        },
      ],
      warnings: 1,
    });
  });

  test("refuses files with several accounts unless one is selected", () => {
    const xml = fixture("camt053-v04.xml").replace(
      "</ns2:BkToCstmrStmt>",
      "<ns2:Stmt><ns2:Acct><ns2:Id><ns2:IBAN>CH0000700000000000099</ns2:IBAN></ns2:Id></ns2:Acct></ns2:Stmt></ns2:BkToCstmrStmt>",
    );
    expect(() => parseCamt053(xml)).toThrow("several accounts");
    expect(parseCamt053(xml, { account: "CH00 0070 0000 0000 0000 1" }).transactions).toHaveLength(1);
  });
});
