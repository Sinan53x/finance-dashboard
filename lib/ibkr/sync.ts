import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { redactToken } from "./errors";
import { fetchFlexStatement, type FetchFlexOptions } from "./flex";
import { readFlexCredentials, KeychainMissingError, type SpawnFn } from "./keychain";
import { IBKR_FILE, loadIbkrSnapshot } from "./load";
import { mergeSnapshots } from "./merge";
import { parseFlexXml } from "./parse";
import type { IbkrSnapshot } from "./types";

export const USAGE = "Aufruf: bun scripts/ibkr-sync.ts [--from-file <flex.xml>] [--dry-run] [--data-dir <dir>]";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_KEYCHAIN = 2;

// Both the CLI (`bun run ibkr-sync`) and the Next.js server have the repo as
// cwd; import.meta.dir is a Bun-only API and undefined when bundled.
const PROJECT_ROOT = process.cwd();

export type SyncDeps = {
  spawn?: SpawnFn;
  fetch?: FetchFlexOptions["fetch"];
  sleep?: FetchFlexOptions["sleep"];
  now?: () => Date;
  env?: Record<string, string | undefined>;
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

type Args = { fromFile?: string; dryRun: boolean; dataDir?: string; help: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--from-file" || arg === "--data-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} braucht einen Wert.\n${USAGE}`);
      if (arg === "--from-file") args.fromFile = value;
      else args.dataDir = value;
    } else throw new Error(`Unbekannte Option ${arg}\n${USAGE}`);
  }
  return args;
}

/** Write via temp file + rename so readers never see a half-written ibkr.json. */
export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${IBKR_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Swiss formatting (1'698.30) without depending on the ICU build. */
export function formatMoney(value: number): string {
  const [int, frac] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "−" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${frac}`;
}

export function summaryLine(snapshot: IbkrSnapshot): string {
  return (
    `IBKR ${snapshot.accountId}: Stand ${snapshot.asOf} · NAV ${snapshot.baseCurrency} ${formatMoney(snapshot.netLiquidation)}` +
    ` · Positionen ${snapshot.positions.length} · NAV-Tage ${snapshot.navHistory.length}`
  );
}

/** CLI entry point; returns the process exit code (0 ok, 1 error, 2 keychain credentials missing). */
export async function runSync(argv: string[], deps: SyncDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return EXIT_ERROR;
  }
  if (args.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const dataDir = args.dataDir
    ? resolve(cwd, args.dataDir)
    : env.FINANCE_DATA_DIR
      ? resolve(cwd, env.FINANCE_DATA_DIR)
      : join(PROJECT_ROOT, "data", "private");

  try {
    let xml: string;
    if (args.fromFile) {
      xml = readFileSync(/* turbopackIgnore: true */ resolve(cwd, args.fromFile), "utf8");
    } else {
      const { token, queryId } = readFlexCredentials(deps.spawn);
      xml = await fetchFlexStatement({ token, queryId, fetch: deps.fetch, sleep: deps.sleep, log: err });
    }

    const next = parseFlexXml(xml, { now: now() });
    const prev = loadIbkrSnapshot(dataDir);
    if (prev && next.asOf < prev.asOf) {
      err(`Warnung: Report-Stand ${next.asOf} ist älter als der gespeicherte Stand ${prev.asOf}.`);
    }
    const merged = mergeSnapshots(prev, next);
    const file = join(dataDir, IBKR_FILE);

    if (args.dryRun) {
      out(`${summaryLine(merged)} (Probelauf – ${file} unverändert)`);
    } else {
      writeJsonAtomic(file, merged);
      out(`${summaryLine(merged)} → ${file}`);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof KeychainMissingError) {
      err(error.message);
      return EXIT_KEYCHAIN;
    }
    const message = redactToken(error instanceof Error ? error.message : String(error));
    err(`IBKR-Sync fehlgeschlagen: ${message}`);
    return EXIT_ERROR;
  }
}
