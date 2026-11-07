#!/usr/bin/env bun
/**
 * Imports ZKB e-banking exports (camt.053 XML or CSV) into <dataDir>/transactions.csv.
 * camt.053 statements are assigned via their IBAN (finance.json accounts); ZKB CSV exports
 * carry no IBAN and need --account <id> (privat | notgroschen | steuern).
 * The data dir is FINANCE_DATA_DIR, else data/private, else data/demo on a fresh clone.
 *
 *   bun scripts/import.ts <file...> [--dry-run] [--account <id>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatAmount } from "../lib/import/csv";
import { importFiles } from "../lib/import";
import { UNCATEGORISED, type Transaction } from "../lib/import/types";

const USAGE = "Usage: bun scripts/import.ts <file...> [--dry-run] [--account <id>]";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const files: string[] = [];
let dryRun = false;
let account: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run" || arg === "-n") dryRun = true;
  else if (arg === "--account") account = args[++i];
  else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (arg.startsWith("-")) {
    console.error(`Unknown option ${arg}\n${USAGE}`);
    process.exit(1);
  } else files.push(arg);
}
if (files.length === 0 || (args.includes("--account") && !account)) {
  console.error(USAGE);
  process.exit(1);
}

const formatRow = (t: Transaction) =>
  `  ${t.date}  ${t.account.padEnd(11)}  ${formatAmount(t.amount).padStart(10)}  ${t.category.padEnd(22)}  ${t.payee}  |  ${t.text}`;

const privateDir = join(root, "data/private");
const dataDir = process.env.FINANCE_DATA_DIR
  ? resolve(process.cwd(), process.env.FINANCE_DATA_DIR)
  : existsSync(join(privateDir, "finance.json"))
    ? privateDir
    : join(root, "data/demo");

const finance = JSON.parse(readFileSync(join(dataDir, "finance.json"), "utf8")) as {
  accounts?: { id: string; iban?: string }[];
};
const accountIbans = Object.fromEntries(
  (finance.accounts ?? []).filter((a) => a.iban).map((a) => [a.id, a.iban as string]),
);

try {
  const result = importFiles(files, {
    csvPath: join(dataDir, "transactions.csv"),
    rulesPath: join(dataDir, "rules.json"),
    dryRun,
    account,
    accountIbans,
  });

  for (const report of result.files) {
    console.log(`${report.file} (${report.format}): ${report.parsed} parsed, ${report.added.length} new, ${report.skipped.length} already present`);
    for (const warning of report.warnings) console.warn(`  warning: ${warning}`);
  }

  if (result.added.length === 0) {
    console.log("\nNothing to add.");
  } else {
    console.log(`\n${dryRun ? "Would add" : "Added"} ${result.added.length} row(s):`);
    result.added.forEach((t) => console.log(formatRow(t)));
  }

  const uncategorised = result.added.filter((t) => t.category === UNCATEGORISED);
  if (uncategorised.length > 0) {
    console.log(`\n${uncategorised.length} row(s) ${UNCATEGORISED} (add rules to ${dataDir}/rules.json):`);
    uncategorised.forEach((t) => console.log(formatRow(t)));
  }

  console.log(
    dryRun
      ? "\nDry run: transactions.csv unchanged."
      : `\ntransactions.csv ${result.written ? "updated" : "unchanged"}: ${result.totalRows} rows total.`,
  );
} catch (error) {
  console.error(`Import failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
