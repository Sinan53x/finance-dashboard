import type { Transaction } from "./types";

export const TRANSACTIONS_HEADER = ["date", "valuta", "account", "payee", "text", "amount", "category"] as const;

/** RFC 4180 parser (quoted fields may contain delimiters, quotes and newlines). Strips a UTF-8 BOM. */
export function parseCsv(input: string, delimiter = ","): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
      fieldStarted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      fieldStarted = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (fieldStarted || field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new Error("CSV: unterminated quoted field");
  if (fieldStarted || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parses "1'234.50", "1’234.50", "-12.3" or "" into integer cents (null when empty). */
export function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.replace(/['’\s]/g, "");
  if (cleaned === "") return null;
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) throw new Error(`Invalid amount: "${raw}"`);
  return Math.round(Number(cleaned) * 100);
}

export function formatAmount(amount: number): string {
  const fixed = (Math.round(amount * 100) / 100).toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
}

export function parseTransactionsCsv(input: string): Transaction[] {
  const [header, ...rows] = parseCsv(input);
  if (!header || header.join(",") !== TRANSACTIONS_HEADER.join(",")) {
    throw new Error(`transactions.csv: unexpected header "${header?.join(",")}"`);
  }
  return rows.map((fields, index) => {
    if (fields.length !== TRANSACTIONS_HEADER.length) {
      throw new Error(`transactions.csv: row ${index + 2} has ${fields.length} fields`);
    }
    const [date, valuta, account, payee, text, amount, category] = fields;
    const cents = parseAmountToCents(amount);
    if (cents === null) throw new Error(`transactions.csv: row ${index + 2} has no amount`);
    return { date, valuta, account, payee, text, amount: cents / 100, category };
  });
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteIfNeeded(value: string): string {
  return /[",\r\n]/.test(value) ? quote(value) : value;
}

/** Serialises one row in the file's existing style: `text` always quoted, other fields only when needed. */
export function serializeTransaction(t: Transaction): string {
  return [
    quoteIfNeeded(t.date),
    quoteIfNeeded(t.valuta),
    quoteIfNeeded(t.account),
    quoteIfNeeded(t.payee),
    quote(t.text),
    formatAmount(t.amount),
    quoteIfNeeded(t.category),
  ].join(",");
}

export function serializeTransactionsCsv(transactions: Transaction[]): string {
  return [TRANSACTIONS_HEADER.join(","), ...transactions.map(serializeTransaction)].join("\n") + "\n";
}
