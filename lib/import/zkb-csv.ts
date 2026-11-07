import { parseAmountToCents, parseCsv } from "./csv";
import { addressFreeName, cleanText, payeeFromBookingText } from "./text";
import type { ParsedTransaction, ParseResult } from "./types";

const REQUIRED_COLUMNS = ["Datum", "Buchungstext", "Belastung CHF", "Gutschrift CHF", "Valuta"] as const;

/** Decodes UTF-8 (with or without BOM), falling back to Windows-1252/Latin-1 for older exports. */
export function decodeBankFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function isZkbCsv(content: string): boolean {
  const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return firstLine.includes(";") && firstLine.includes("Buchungstext") && firstLine.includes("Datum");
}

/** "06.07.2026" -> "2026-07-06". */
function isoDate(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined;
}

interface Booking {
  row: ParsedTransaction;
  cents: number;
  details: { cents: number; payee: string; text: string }[];
  line: number;
}

/**
 * Parses a ZKB e-banking CSV export (semicolon separated, German headers, newest first).
 * Detail sub-rows (only `Betrag Detail` set, no Belastung/Gutschrift) are split out of their batch booking.
 * Returns bookings in chronological order.
 */
export function parseZkbCsv(content: string): ParseResult {
  const [header, ...rows] = parseCsv(content, ";");
  if (!header) throw new Error("ZKB CSV: empty file");
  const columns = header.map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) throw new Error(`ZKB CSV: missing columns ${missing.join(", ")}`);
  const col = (fields: string[], name: string) => (fields[columns.indexOf(name)] ?? "").trim();

  const warnings: string[] = [];
  const bookings: Booking[] = [];

  rows.forEach((fields, index) => {
    const line = index + 2;
    if (fields.every((f) => f.trim() === "")) return;
    const debit = parseAmountToCents(col(fields, "Belastung CHF"));
    const credit = parseAmountToCents(col(fields, "Gutschrift CHF"));
    const detail = parseAmountToCents(col(fields, "Betrag Detail"));
    const bookingText = col(fields, "Buchungstext");
    const purpose = cleanText(col(fields, "Zahlungszweck"));
    const details = cleanText(col(fields, "Details"));
    const text = cleanText(purpose && !bookingText.includes(purpose) ? `${bookingText} (${purpose})` : bookingText);
    const payee = details ? addressFreeName(details) : payeeFromBookingText(bookingText);

    if (debit === null && credit === null) {
      const parent = bookings.at(-1);
      if (detail === null || !parent) {
        warnings.push(`line ${line}: skipped row without amount`);
        return;
      }
      const currency = col(fields, "Whg");
      if (currency && currency !== "CHF") warnings.push(`line ${line}: detail amount in ${currency}`);
      parent.details.push({ cents: Math.abs(detail), payee, text });
      return;
    }

    const date = isoDate(col(fields, "Datum"));
    if (!date) {
      warnings.push(`line ${line}: skipped, invalid Datum "${col(fields, "Datum")}"`);
      return;
    }
    const cents = (credit ?? 0) - (debit ?? 0);
    bookings.push({
      row: { date, valuta: isoDate(col(fields, "Valuta")) ?? date, payee, text, amount: cents / 100 },
      cents,
      details: [],
      line,
    });
  });

  const transactions: ParsedTransaction[] = [];
  // Exports list newest first; reverse so same-day bookings keep chronological order.
  for (const booking of bookings.reverse()) {
    const { row, cents, details } = booking;
    if (details.length === 0) {
      transactions.push(row);
      continue;
    }
    const total = details.reduce((sum, d) => sum + d.cents, 0);
    if (total !== Math.abs(cents)) {
      warnings.push(`line ${booking.line}: batch not split (details ${total / 100} ≠ ${Math.abs(cents) / 100})`);
      transactions.push(row);
      continue;
    }
    const sign = cents < 0 ? -1 : 1;
    for (const d of details) {
      transactions.push({ ...row, payee: d.payee || row.payee, text: d.text || row.text, amount: (sign * d.cents) / 100 });
    }
  }
  return { transactions, warnings };
}
