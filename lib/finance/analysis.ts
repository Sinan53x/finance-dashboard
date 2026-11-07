import { categoryKind, lohnDates, round2, type Cycle } from "./cycles";
import { chf, chfSigned, dateShort } from "./format";
import type { BudgetCategory, FinanceData, Transaction } from "./types";

const sumThrough = (txs: Transaction[], date: string) =>
  txs.filter((t) => t.date <= date).reduce((s, t) => s + t.amount, 0);

/**
 * End-of-day balance of one account on `date`, anchored at the known `balance`
 * on `asOf`: anchor + Σ(tx ≤ date) − Σ(tx ≤ asOf). Works even with incomplete history.
 */
export function accountBalanceAt(
  txs: Transaction[],
  anchorBalance: number,
  asOf: string,
  date: string
): number {
  return round2(anchorBalance + sumThrough(txs, date) - sumThrough(txs, asOf));
}

/**
 * Daily end-of-day balance of one account from its first transaction date to
 * `asOf` (never extrapolated before the first row).
 */
export function accountBalanceHistory(
  txs: Transaction[],
  anchorBalance: number,
  asOf: string
): { date: string; balance: number }[] {
  const byDay = new Map<string, number>();
  for (const tx of txs) {
    if (tx.date > asOf) continue;
    byDay.set(tx.date, (byDay.get(tx.date) ?? 0) + tx.amount);
  }
  const days = [...byDay.keys()].sort();
  const sumAtAsOf = sumThrough(txs, asOf);
  let cum = 0;
  return days.map((date) => {
    cum = round2(cum + (byDay.get(date) ?? 0));
    return { date, balance: round2(anchorBalance + cum - sumAtAsOf) };
  });
}

export function netWorth(finance: FinanceData): number {
  return round2(finance.accounts.reduce((s, a) => s + a.balance, 0));
}

export type TopfBalance = {
  name: string;
  monthly: number;
  yearlyTarget?: number;
  note?: string;
  /** Accumulated pot balance (fundedBy → real account balance). */
  balance: number;
  cyclesFunded: number;
  /** Net category spend (positive) on the Privatkonto since `budgetStart`. */
  spendSinceStart: number;
  /** First future 25th after `asOf` where the pot is ≥ 0 again (negative pots only). */
  recoveryDate?: string;
};

/** The date of the nth 25th strictly after `from`. */
export function nth25thAfter(from: string, n: number): string {
  let [y, m] = from.split("-").map(Number);
  if (from.slice(8) >= "25") {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  m += n - 1;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-25`;
}

/**
 * Sinking-fund balances: monthly × cycles started since `budgetStart` + net
 * Privatkonto spend in the category since then. `Steuern` (fundedBy) shows the
 * real ZKB account balance.
 */
export function topfBalances(
  finance: FinanceData,
  txs: Transaction[]
): TopfBalance[] {
  const start = finance.budgetStart;
  const privat = txs.filter((t) => t.account === "privat");
  const nCycles = lohnDates(privat, start).length;
  const topf = finance.budget.groups.find((g) => g.id === "topf");
  const accountBy = (id?: string) =>
    finance.accounts.find((a) => a.id === id)?.balance;

  return (topf?.categories ?? []).map((cat: BudgetCategory) => {
    const net = privat
      .filter((t) => t.category === cat.name && t.date >= start)
      .reduce((s, t) => s + t.amount, 0);
    const funded = accountBy(cat.fundedBy);
    const balance = round2(funded ?? cat.monthly * nCycles + net);
    const recoveryDate =
      balance < 0 && cat.monthly > 0
        ? nth25thAfter(finance.balancesAsOf, Math.ceil(-balance / cat.monthly))
        : undefined;
    return {
      name: cat.name,
      monthly: cat.monthly,
      yearlyTarget: cat.yearlyTarget,
      note: cat.note,
      balance,
      cyclesFunded: nCycles,
      spendSinceStart: round2(-net) || 0,
      recoveryDate,
    };
  });
}

export type NotgroschenProjection = {
  target: number;
  current: number;
  reachedDate: string;
  lastPayment: number;
  steps: { date: string; value: number; payment: number }[];
};

/** +monthly on each future `day`th, starting at `firstDate`, capped at target. */
export function notgroschenProjection(
  current: number,
  target: number,
  monthly: number,
  firstDate = "2026-10-25"
): NotgroschenProjection {
  const steps: NotgroschenProjection["steps"] = [];
  let value = current;
  const [y0, m0, d] = firstDate.split("-").map(Number);
  let y = y0;
  let m = m0;
  while (value < target) {
    const payment = Math.min(monthly, round2(target - value));
    value = round2(value + payment);
    const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    steps.push({ date, value, payment });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const last = steps[steps.length - 1];
  return {
    target,
    current,
    reachedDate: last?.date ?? firstDate,
    lastPayment: last?.payment ?? 0,
    steps,
  };
}

export type InvestProjectionPoint = {
  date: string;
  r0: number;
  r4: number;
  r7: number;
};

/**
 * Monthly steps on the 25th starting 2026-10-25 through 2036-12-25.
 * value = value × (1+r)^(1/12) + contribution; the start value enters the
 * first step ungrown. The contribution schedule comes from the plan:
 * `contributionBefore2027` until Dec 2026, `contributionFrom2027` after.
 * Assumptions, not a forecast.
 */
export function investProjection(
  startValue: number,
  contributionBefore2027: number,
  contributionFrom2027: number,
  firstDate = "2026-10-25",
  lastDate = "2036-12-25"
): InvestProjectionPoint[] {
  const points: InvestProjectionPoint[] = [];
  const v = [0, 0.04, 0.07].map(() => startValue);
  let [y, m] = firstDate.split("-").map(Number);
  const [ly, lm] = lastDate.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    const c = y >= 2027 ? contributionFrom2027 : contributionBefore2027;
    for (let i = 0; i < 3; i++) {
      const r = [0, 0.04, 0.07][i];
      v[i] = v[i] * (1 + r) ** (1 / 12) + c;
    }
    points.push({
      date: `${y}-${String(m).padStart(2, "0")}-25`,
      r0: round2(v[0]),
      r4: round2(v[1]),
      r7: round2(v[2]),
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return points;
}

/** Cumulative living spend per day within a cycle + linear budget line. */
export function cumulativeSpend(
  rows: Transaction[],
  budgetTotal: number,
  cycleStart: string,
  cycleEnd: string | null
): { date: string; ist: number; budget: number }[] {
  const spend = rows.filter((t) => categoryKind(t.category) === "spending");
  const byDay = new Map<string, number>();
  for (const t of spend) {
    byDay.set(t.date, (byDay.get(t.date) ?? 0) - t.amount);
  }
  const days: string[] = [];
  let d = cycleStart;
  const last = cycleEnd ?? [...byDay.keys()].sort().at(-1) ?? cycleStart;
  while (d <= last) {
    days.push(d);
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }
  let cum = 0;
  return days.map((date, i) => {
    cum = round2(cum + (byDay.get(date) ?? 0));
    return {
      date,
      ist: cum,
      budget: round2((budgetTotal * (i + 1)) / days.length),
    };
  });
}

/** Spending per category for a set of transactions (positive numbers). */
export function spendByCategory(rows: Transaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of rows) {
    if (categoryKind(t.category) !== "spending") continue;
    out[t.category] = round2((out[t.category] ?? 0) - t.amount);
  }
  return out;
}

/** Monthly living-spend buckets (calendar months, positive CHF per category). */
export function spendByMonth(rows: Transaction[]): { month: string; byCategory: Record<string, number> }[] {
  const buckets = new Map<string, Record<string, number>>();
  for (const t of rows) {
    if (categoryKind(t.category) !== "spending") continue;
    const month = t.date.slice(0, 7);
    const b = buckets.get(month) ?? {};
    b[t.category] = round2((b[t.category] ?? 0) - t.amount);
    buckets.set(month, b);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, byCategory]) => ({ month, byCategory }));
}

/** Monthly income vs. living spend (positive CHF) — calendar months. */
export function incomeVsSpendByMonth(
  rows: Transaction[]
): { month: string; ein: number; aus: number }[] {
  const buckets = new Map<string, { ein: number; aus: number }>();
  for (const t of rows) {
    const kind = categoryKind(t.category);
    const b = buckets.get(t.date.slice(0, 7)) ?? { ein: 0, aus: 0 };
    if (kind === "income" && t.amount > 0) b.ein = round2(b.ein + t.amount);
    else if (kind === "spending") b.aus = round2(b.aus - t.amount);
    buckets.set(t.date.slice(0, 7), b);
  }
  return [...buckets.entries()]
    .filter(([, v]) => v.ein > 0 || v.aus > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, ...v }));
}

/** Top payees per month×category — `"YYYY-MM|Kategorie"` → list (spending only). */
export function payeesByMonthCategory(
  rows: Transaction[],
  n = 5
): Record<string, { payee: string; total: number }[]> {
  const buckets = new Map<string, Map<string, number>>();
  for (const t of rows) {
    if (categoryKind(t.category) !== "spending" || t.amount >= 0) continue;
    const key = `${t.date.slice(0, 7)}|${t.category}`;
    const m = buckets.get(key) ?? new Map<string, number>();
    m.set(t.payee, round2((m.get(t.payee) ?? 0) - t.amount));
    buckets.set(key, m);
  }
  const out: Record<string, { payee: string; total: number }[]> = {};
  for (const [key, m] of buckets) {
    out[key] = [...m.entries()]
      .map(([payee, total]) => ({ payee, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, n);
  }
  return out;
}

/** Top spending categories per calendar year (positive CHF). */
export function topCategoriesByYear(
  rows: Transaction[],
  n = 4
): { year: string; items: { category: string; total: number }[] }[] {
  const byYear = new Map<string, Map<string, number>>();
  for (const t of rows) {
    if (categoryKind(t.category) !== "spending" || t.amount >= 0) continue;
    const y = t.date.slice(0, 4);
    const m = byYear.get(y) ?? new Map<string, number>();
    m.set(t.category, round2((m.get(t.category) ?? 0) - t.amount));
    byYear.set(y, m);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, m]) => ({
      year,
      items: [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([category, total]) => ({ category, total })),
    }));
}

/** Auto-derived hints for the Übersicht "Hinweise" card. */
export function deriveInsights(
  finance: FinanceData,
  lastComplete: Cycle | undefined,
  topfe: TopfBalance[],
  ng: NotgroschenProjection
): string[] {
  const out: string[] = [];
  if (lastComplete) {
    // Monthly flags only for monthly-budgeted categories — Töpfe are judged on the year.
    const budgeted = finance.budget.groups
      .filter((g) => g.id !== "topf")
      .flatMap((g) => g.categories);
    for (const c of budgeted) {
      const ist = -(lastComplete.byCategory[c.name] ?? 0);
      // Only flag a real overshoot: more than CHF 10 or 5 % over budget.
      if (ist > c.monthly + Math.max(10, c.monthly * 0.05)) {
        out.push(
          `${c.name}: CHF ${chf(ist)} vs. Budget ${chf(c.monthly)} im letzten abgeschlossenen Zyklus (${lastComplete.label}).`
        );
      }
    }
  }
  for (const t of topfe) {
    if (t.balance < 0 && t.recoveryDate) {
      const annual = finance.annualPayments.find((p) => p.category === t.name);
      const effective = annual ? round2(annual.amount / annual.coversMonths) : null;
      out.push(
        `${t.name}: ${annual ? `${annual.note} – ` : ""}Topf ${chfSigned(t.balance)}, mit ${chf(t.monthly)}/Mt am ${dateShort(t.recoveryDate)} ausgeglichen` +
          (effective !== null ? `; effektiv ${chf(effective)}/Mt` : "") +
          "."
      );
    }
    if (t.yearlyTarget !== undefined && t.spendSinceStart > t.yearlyTarget) {
      out.push(
        `Topf ${t.name}: Jahresausgaben ${chf(t.spendSinceStart)} über dem Jahresziel ${chf(t.yearlyTarget)}.`
      );
    }
  }
  if (ng.lastPayment < ng.steps[0]?.payment) {
    out.push(
      `Notgroschen erreicht das Ziel früher: am ${dateShort(ng.reachedDate)} genügen ${chf(ng.lastPayment)} — die restlichen ${chf(ng.steps[0].payment - ng.lastPayment)} könnten in VT fliessen.`
    );
  }
  return out;
}

export function topPayees(
  rows: Transaction[],
  n = 8
): { payee: string; total: number; count: number }[] {
  const by = new Map<string, { total: number; count: number }>();
  for (const t of rows) {
    if (categoryKind(t.category) !== "spending" || t.amount >= 0) continue;
    const e = by.get(t.payee) ?? { total: 0, count: 0 };
    e.total = round2(e.total - t.amount);
    e.count += 1;
    by.set(t.payee, e);
  }
  return [...by.entries()]
    .map(([payee, v]) => ({ payee, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

/**
 * NAV histories from the Flex statement start at account opening and sit at 0
 * until the first deposit. Drop the leading zero run but keep the last zero
 * day, so the chart shows the step up from 0 instead of months of flat line.
 */
export function trimLeadingZeroNav<T extends { nav: number }>(history: T[]): T[] {
  const first = history.findIndex((h) => h.nav !== 0);
  if (first <= 0) return history;
  return history.slice(first - 1);
}
