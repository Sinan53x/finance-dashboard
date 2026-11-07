import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IbkrSnapshot } from "./types";

export const IBKR_FILE = "ibkr.json";

/** Minimal structural check so a truncated/foreign file fails loudly instead of rendering garbage. */
export function isIbkrSnapshot(value: unknown): value is IbkrSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.source === "flex" || v.source === "manual") &&
    typeof v.accountId === "string" &&
    typeof v.baseCurrency === "string" &&
    typeof v.asOf === "string" &&
    typeof v.netLiquidation === "number" &&
    Array.isArray(v.positions) &&
    Array.isArray(v.navHistory) &&
    Array.isArray(v.deposits) &&
    Array.isArray(v.dividends) &&
    Array.isArray(v.trades)
  );
}

/** Read `<dataDir>/ibkr.json`; `null` if it does not exist. Throws if the file is malformed. */
export function loadIbkrSnapshot(dataDir: string): IbkrSnapshot | null {
  const file = join(dataDir, IBKR_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isIbkrSnapshot(parsed)) throw new Error(`${file} hat nicht das erwartete IbkrSnapshot-Format.`);
  return parsed;
}
