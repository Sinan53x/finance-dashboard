import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTransactionsCsv } from "../import/csv";
import type { FinanceData, Transaction } from "./types";

const PRIVATE_DIR = path.join(process.cwd(), "data", "private");
const DEMO_DIR = path.join(process.cwd(), "data", "demo");

/**
 * `FINANCE_DATA_DIR` wins; otherwise the real private data dir; on a fresh
 * clone (no data/private) the committed demo dataset so the app still runs.
 */
export function dataDir(): string {
  return (
    process.env.FINANCE_DATA_DIR ??
    (existsSync(path.join(PRIVATE_DIR, "finance.json")) ? PRIVATE_DIR : DEMO_DIR)
  );
}

/** Injectable for tests/importers: defaults to the resolved data dir. */
export const DATA_DIR = dataDir();

/** Loaded at request time so a CSV re-import shows without a rebuild. */
export async function loadFinance(dir = DATA_DIR): Promise<{
  finance: FinanceData;
  transactions: Transaction[];
}> {
  const [json, csv] = await Promise.all([
    readFile(path.join(dir, "finance.json"), "utf8"),
    readFile(path.join(dir, "transactions.csv"), "utf8"),
  ]);
  return {
    finance: JSON.parse(json) as FinanceData,
    transactions: parseTransactionsCsv(csv),
  };
}
