import { describe, expect, test } from "bun:test";
import { cleanText, payeeFromBookingText } from "./text";

describe("payeeFromBookingText", () => {
  test("strips ZKB booking prefixes, terminal numbers and addresses", () => {
    expect(
      [
        "Einkauf ZKB Visa Debit Card Nr. xxxx 1234, Volg Laden Musterdorf 0842",
        "Online-Einkauf ZKB Visa Debit Card Nr. xxxx 1234, SUMUP  *MUSTER CAFE 0000",
        "Belastung TWINT: , MAX +41790000000",
        "Belastung Mobile Banking: Muster GmbH, Industriestrasse 26, 8404",
        "Gutschrift: Muster AG",
        "Belastungen Mobile Banking (3)",
      ].map(payeeFromBookingText),
    ).toEqual(["Volg Laden Musterdorf", "SUMUP *MUSTER CAFE", "MAX +41790000000", "Muster GmbH", "Muster AG", "Belastungen Mobile Banking (3)"]);
  });
});

describe("cleanText", () => {
  test("collapses whitespace and strips Auftrags-Nr.", () => {
    expect(cleanText("  Zahlung\n  Muster,  Auftrags-Nr.: Z123 Rest ")).toBe("Zahlung Muster Rest");
  });
});
