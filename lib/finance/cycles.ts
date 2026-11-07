import type { Transaction } from "./types";

export type CategoryKind =
  | "income"
  | "savings"
  | "reserve"
  | "passThrough"
  | "transfer"
  | "spending";

const INCOME = new Set(["Lohn", "Rückerstattungen", "Zinsen"]);
const SAVINGS = new Set(["Notgroschen", "ETF IBKR"]);
const RESERVE = new Set(["Steuern"]);
const PASS_THROUGH = new Set(["Spesen"]);
const TRANSFERS = new Set(["Übertrag", "Familie"]);

/** Unknown categories (e.g. `Unkategorisiert` from future imports) are spending. */
export function categoryKind(category: string): CategoryKind {
  if (INCOME.has(category)) return "income";
  if (SAVINGS.has(category)) return "savings";
  if (RESERVE.has(category)) return "reserve";
  if (PASS_THROUGH.has(category)) return "passThrough";
  if (TRANSFERS.has(category)) return "transfer";
  return "spending";
}

export type Cycle = {
  /** Start date (a Lohn date), or "vor" for the pre-first-Lohn bucket. */
  key: string;
  label: string;
  start: string | null;
  /** Day before the next Lohn, or null while the cycle is open. */
  end: string | null;
  open: boolean;
  rows: Transaction[];
  /** Net sum per category (signed). */
  byCategory: Record<string, number>;
  /** Lohn received in this cycle (0 for Vor-Zyklus). */
  lohn: number;
  /** −sum of spending categories. */
  livingSpend: number;
  /** −(Notgroschen + ETF IBKR). */
  savingsChf: number;
  /** savingsChf / lohn, null without Lohn. */
  savingsRate: number | null;
  /** Net per pass-through category (should net to ~0). */
  passThrough: Record<string, number>;
};

const MONTH_DE = [
  "Jan",
  "Feb",
  "Mär",
  "Apr",
  "Mai",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Okt",
  "Nov",
  "Dez",
];

function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function parseDay(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function addDays(iso: string, days: number): string {
  const d = parseDay(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

function ddmm(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
}

function cycleLabel(start: string, end: string | null): string {
  // Named after the salary month it starts in — 25.08. is the August payslip.
  const d = parseDay(start);
  const monat = `${MONTH_DE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const range = `${ddmm(start)}–${end ? ddmm(end) : "laufend"}`;
  return `${monat} · ${range}`;
}

function summarise(
  key: string,
  label: string,
  start: string | null,
  end: string | null,
  open: boolean,
  rows: Transaction[]
): Cycle {
  const byCategory: Record<string, number> = {};
  const passThrough: Record<string, number> = {};
  let lohn = 0;
  let spend = 0;
  let savings = 0;
  for (const tx of rows) {
    byCategory[tx.category] = round2((byCategory[tx.category] ?? 0) + tx.amount);
    switch (categoryKind(tx.category)) {
      case "income":
        if (tx.category === "Lohn") lohn += tx.amount;
        break;
      case "spending":
        spend += tx.amount;
        break;
      case "savings":
        savings += tx.amount;
        break;
      case "passThrough":
        passThrough[tx.category] = round2(
          (passThrough[tx.category] ?? 0) + tx.amount
        );
        break;
      case "reserve":
      case "transfer":
        break;
    }
  }
  return {
    key,
    label,
    start,
    end,
    open,
    rows,
    byCategory,
    lohn: round2(lohn),
    livingSpend: round2(-spend),
    savingsChf: round2(-savings),
    savingsRate: lohn > 0 ? -savings / lohn : null,
    passThrough,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Sorted dates of Lohn transactions on/after `from` — the cycle boundaries. */
export function lohnDates(txs: Transaction[], from?: string): string[] {
  return [
    ...new Set(
      txs.filter((t) => t.category === "Lohn" && (!from || t.date >= from)).map((t) => t.date)
    ),
  ].sort();
}

/**
 * Split transactions into pay cycles on the Privatkonto. A cycle runs from one Lohn date
 * (inclusive) to the next (exclusive); rows before the first boundary form the
 * "Vor-Zyklus" bucket (shown in history, excluded from budget math).
 * Only `account` rows and Lohn dates on/after `budgetStart` count — older salary
 * history or savings accounts never create budget cycles.
 */
export function buildCycles(
  allTxs: Transaction[],
  opts: { account?: string; budgetStart?: string } = {}
): {
  vor: Cycle | null;
  cycles: Cycle[];
} {
  const txs = opts.account ? allTxs.filter((t) => t.account === opts.account) : allTxs;
  const boundaries = lohnDates(txs, opts.budgetStart);
  const vorRows = txs.filter(
    (t) => boundaries.length > 0 && t.date < boundaries[0]
  );
  const vor =
    vorRows.length > 0
      ? summarise("vor", `Vor-Zyklus · bis ${ddmm(addDays(boundaries[0], -1))}`, null, boundaries.length > 0 ? addDays(boundaries[0], -1) : null, false, vorRows)
      : null;

  const cycles = boundaries.map((start, i) => {
    const nextStart = boundaries[i + 1] ?? null;
    const end = nextStart ? addDays(nextStart, -1) : null;
    const rows = txs.filter(
      (t) => t.date >= start && (nextStart === null || t.date < nextStart)
    );
    return summarise(start, cycleLabel(start, end), start, end, nextStart === null, rows);
  });
  return { vor, cycles };
}
