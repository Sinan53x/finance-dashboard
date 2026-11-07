import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBankFile, isZkbCsv, parseZkbCsv } from "./zkb-csv";

const content = decodeBankFile(readFileSync(join(import.meta.dir, "fixtures/zkb-export.csv")));

describe("parseZkbCsv", () => {
  const { transactions, warnings } = parseZkbCsv(content);

  test("detects the format", () => {
    expect(isZkbCsv(content)).toBe(true);
  });

  test("parses bookings chronologically and splits batch detail rows", () => {
    expect(transactions.map((t) => [t.date, t.valuta, t.payee, t.amount])).toEqual([
      ["2030-03-10", "2030-03-10", "KAFFEE BAR MUSTERDORF", -4.5],
      ["2030-03-10", "2030-03-10", "KAFFEE BAR MUSTERDORF", -4.5],
      ["2030-03-12", "2030-03-10", "Coop-9999 Musterdorf", -23.45],
      ["2030-03-15", "2030-03-15", "Visana Services AG", -342.10],
      ["2030-03-15", "2030-03-15", "SBB AG", -98],
      ["2030-03-15", "2030-03-15", "Max Muster", -120.65],
      ["2030-03-20", "2030-03-20", "Muster Vermieter AG", -250],
      ["2030-03-20", "2030-03-20", "ZVV", -50],
      ["2030-03-25", "2030-03-25", "Muster AG", 4820.35],
      ["2030-03-28", "2030-03-26", "IKEA AG Musterstadt", -1049.9],
    ]);
    expect(warnings).toEqual([]);
  });

  test("appends Zahlungszweck to the booking text", () => {
    expect(transactions.find((t) => t.amount === 4820.35)?.text).toBe("Gutschrift: Muster AG (Salär März 2030)");
  });

  test("keeps an unbalanced batch as one row with a warning", () => {
    const broken = parseZkbCsv(content.replace('"CHF";"50.00"', '"CHF";"40.00"'));
    expect([broken.transactions.filter((t) => t.date === "2030-03-20").map((t) => t.amount), broken.warnings.length]).toEqual([[-300], 1]);
  });
});

describe("decodeBankFile", () => {
  test("falls back to Windows-1252 for non-UTF-8 exports", () => {
    expect(decodeBankFile(new Uint8Array([0x66, 0xfc, 0x72]))).toBe("für");
  });
});
