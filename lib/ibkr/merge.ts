import type { IbkrSnapshot } from "./types";

type Dated = { date: string };

const byDate = <T extends Dated>(a: T, b: T) => a.date.localeCompare(b.date);

const depositKey = (d: IbkrSnapshot["deposits"][number]) => `${d.date}|${d.amount}`;
const dividendKey = (d: IbkrSnapshot["dividends"][number]) => `${d.date}|${d.symbol}`;
const tradeKey = (t: IbkrSnapshot["trades"][number]) => `${t.date}|${t.symbol}|${t.quantity}|${t.price}`;

/**
 * Union of two event lists. Rows with identical keys are treated as the same event; the
 * multiplicity is the max of both sides so two genuine same-day deposits of equal size survive.
 */
function unionEvents<T extends Dated>(prev: T[], next: T[], key: (row: T) => string): T[] {
  const nextCounts = new Map<string, number>();
  for (const row of next) nextCounts.set(key(row), (nextCounts.get(key(row)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const extra: T[] = [];
  for (const row of prev) {
    const k = key(row);
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    if (count > (nextCounts.get(k) ?? 0)) extra.push(row);
  }
  return [...next, ...extra].sort(byDate);
}

/**
 * Merge a freshly fetched snapshot into the stored one so history accumulates beyond the
 * 365-day Flex window. Scalars and positions always come from `next`.
 */
export function mergeSnapshots(prev: IbkrSnapshot | null, next: IbkrSnapshot): IbkrSnapshot {
  const sorted: IbkrSnapshot = {
    ...next,
    navHistory: [...next.navHistory].sort(byDate),
    deposits: [...next.deposits].sort(byDate),
    dividends: [...next.dividends].sort(byDate),
    trades: [...next.trades].sort(byDate),
  };
  if (!prev) return sorted;

  if (prev.accountId !== next.accountId) {
    throw new Error(
      `ibkr.json gehört zu Konto ${prev.accountId}, der neue Report zu ${next.accountId} – Datei prüfen bzw. entfernen.`,
    );
  }
  if (prev.baseCurrency !== next.baseCurrency) {
    throw new Error(
      `Basiswährung geändert (${prev.baseCurrency} → ${next.baseCurrency}) – Historie nicht kombinierbar, ibkr.json prüfen.`,
    );
  }

  const nav = new Map<string, number>();
  for (const row of prev.navHistory) nav.set(row.date, row.nav);
  for (const row of next.navHistory) nav.set(row.date, row.nav);
  const navHistory = [...nav.entries()].map(([date, value]) => ({ date, nav: value })).sort(byDate);

  return {
    ...sorted,
    navHistory,
    deposits: unionEvents(prev.deposits, sorted.deposits, depositKey),
    dividends: unionEvents(prev.dividends, sorted.dividends, dividendKey),
    trades: unionEvents(prev.trades, sorted.trades, tradeKey),
  };
}
