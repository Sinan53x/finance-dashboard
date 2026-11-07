import { formatAmount } from "./csv";

interface Keyed {
  account: string;
  date: string;
  amount: number;
}

export const dedupeKey = (t: Keyed) => `${t.account}|${t.date}|${formatAmount(t.amount)}`;

/**
 * Multiset dedupe on `account|date|amount`: for each key only the imported rows beyond the number
 * already present are new. Re-importing an overlapping period is therefore idempotent, while genuine
 * same-day same-amount purchases within one file are all kept.
 */
export function dedupe<T extends Keyed>(existing: Keyed[], imported: T[]): { added: T[]; skipped: T[] } {
  const remaining = new Map<string, number>();
  for (const t of existing) remaining.set(dedupeKey(t), (remaining.get(dedupeKey(t)) ?? 0) + 1);
  const added: T[] = [];
  const skipped: T[] = [];
  for (const t of imported) {
    const key = dedupeKey(t);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
      skipped.push(t);
    } else {
      added.push(t);
    }
  }
  return { added, skipped };
}

/** Stable merge by date: existing rows keep their order and come first for equal dates. */
export function mergeByDate<T extends { date: string }>(existing: T[], added: T[]): T[] {
  const pending = [...added].sort((a, b) => a.date.localeCompare(b.date));
  const merged: T[] = [];
  let i = 0;
  for (const row of existing) {
    while (i < pending.length && pending[i].date < row.date) merged.push(pending[i++]);
    merged.push(row);
  }
  return merged.concat(pending.slice(i));
}
