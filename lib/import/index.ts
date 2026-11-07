import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { isCamt053, parseCamt053 } from "./camt";
import { parseTransactionsCsv, serializeTransaction, TRANSACTIONS_HEADER } from "./csv";
import { dedupe, mergeByDate } from "./dedupe";
import { categorize, loadRules } from "./rules";
import { decodeBankFile, isZkbCsv, parseZkbCsv } from "./zkb-csv";
import type { ParsedTransaction, ParseResult, Transaction } from "./types";

const normalizeIban = (iban: string) => iban.replace(/\s/g, "").toUpperCase();

export interface ImportOptions {
  csvPath: string;
  rulesPath: string;
  dryRun?: boolean;
  /** Target account id (from finance.json `accounts[].id`). Required for ZKB CSV files. */
  account?: string;
  /**
   * finance.json accounts with IBANs: `id -> iban`. camt.053 rows are assigned to the account whose
   * IBAN matches `Stmt/Acct/Id/IBAN` (spaces ignored). Unknown IBANs raise an error.
   */
  accountIbans?: Record<string, string>;
}

export interface FileReport {
  file: string;
  format: "camt" | "zkb-csv";
  parsed: number;
  added: Transaction[];
  skipped: ParsedTransaction[];
  warnings: string[];
}

export interface ImportResult {
  added: Transaction[];
  written: boolean;
  totalRows: number;
  files: FileReport[];
}

export function detectFormat(content: string, filename: string): "camt" | "zkb-csv" {
  if (isCamt053(content)) return "camt";
  if (isZkbCsv(content)) return "zkb-csv";
  throw new Error(`${filename}: unrecognised format (expected camt.053 XML or a ZKB CSV export)`);
}

function parseBankFile(content: string, filename: string, iban?: string): ParseResult {
  const format = detectFormat(content, filename);
  return format === "camt" ? parseCamt053(content, { account: iban, allowMulti: !iban }) : parseZkbCsv(content);
}

function resolveAccount(tx: ParsedTransaction, format: "camt" | "zkb-csv", options: ImportOptions, file: string): string {
  if (format === "zkb-csv") {
    if (!options.account) throw new Error(`${file}: ZKB CSV has no IBAN; pass --account <id>`);
    return options.account;
  }
  const ibanToId = new Map(
    Object.entries(options.accountIbans ?? {}).map(([id, iban]) => [normalizeIban(iban), id]),
  );
  const id = tx.accountIban !== undefined ? ibanToId.get(normalizeIban(tx.accountIban)) : undefined;
  if (!id) throw new Error(`${file}: unknown statement IBAN ${tx.accountIban ?? "(none)"} — add it to finance.json accounts`);
  return id;
}

/**
 * Parses bank export files, categorises them and appends new rows to the transactions CSV.
 * With `dryRun` nothing is written; `result.added` still reports what would be appended.
 */
export function importFiles(files: string[], options: ImportOptions): ImportResult {
  const rules = loadRules(options.rulesPath);
  const existing = readFileSync(options.csvPath, "utf8");
  let rows = parseTransactionsCsv(existing);

  const result: ImportResult = { added: [], written: false, totalRows: 0, files: [] };
  for (const file of files) {
    const content = decodeBankFile(readFileSync(file));
    const format = detectFormat(content, file);
    // camt: when an account id is requested, filter statements by its IBAN (falling back to the
    // raw value so a literal IBAN still works).
    const iban =
      format === "camt" && options.account
        ? normalizeIban(options.accountIbans?.[options.account] ?? options.account)
        : undefined;
    const parsed = parseBankFile(content, file, iban);
    const deduped = dedupe(
      rows,
      parsed.transactions.map((tx) => ({
        ...tx,
        account: resolveAccount(tx, format, options, basename(file)),
      })),
    );
    const added: Transaction[] = deduped.added.map((tx) => {
      const { iban: cpIban, account, ...rest } = tx;
      delete rest.accountIban;
      return { ...rest, account, category: categorize(rules, { ...rest, iban: cpIban, account }) };
    });
    rows = mergeByDate(rows, added);
    result.added.push(...added);
    result.files.push({
      file: basename(file),
      format,
      parsed: parsed.transactions.length,
      added,
      skipped: deduped.skipped,
      warnings: parsed.warnings,
    });
  }

  if (!options.dryRun && result.added.length > 0) {
    // Existing lines are kept verbatim and in place; new rows are spliced in by date order
    // (`mergeByDate` preserves object identity, so a Set lookup tells them apart).
    const addedSet = new Set<Transaction>(result.added);
    const body = existing.split("\n").slice(1).filter((l) => l !== "");
    const out: string[] = [TRANSACTIONS_HEADER.join(",")];
    let ei = 0;
    for (const row of rows) {
      out.push(addedSet.has(row) ? serializeTransaction(row) : body[ei++]);
    }
    writeFileSync(options.csvPath, out.join("\n") + "\n");
    result.written = true;
  }
  result.totalRows = rows.length;
  return result;
}
