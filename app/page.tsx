import { Dashboard } from "@/components/finance/dashboard";
import {
  accountBalanceAt,
  accountBalanceHistory,
  deriveInsights,
  incomeVsSpendByMonth,
  investProjection,
  notgroschenProjection,
  payeesByMonthCategory,
  spendByMonth,
  topCategoriesByYear,
  topPayees,
  topfBalances,
  trimLeadingZeroNav,
} from "@/lib/finance/analysis";
import { buildCycles } from "@/lib/finance/cycles";
import { DATA_DIR, loadFinance } from "@/lib/finance/load";
import type { FinanceData, Transaction } from "@/lib/finance/types";
import { loadIbkrSnapshot } from "@/lib/ibkr/load";
import type { IbkrSnapshot } from "@/lib/ibkr/types";

export const dynamic = "force-dynamic";

export type IbkrView = {
  source: "flex" | "manual";
  /** Short source label, e.g. "Live · IBKR Flex" or "Manuell · Screenshot". */
  sourceLabel: string;
  asOf: string;
  accountId: string;
  nav: number;
  cash: number;
  unrealized: number;
  position?: {
    symbol: string;
    name: string;
    quantity?: number;
    isin?: string;
    ter?: number;
    marketValueUsd?: number;
    marketValueBase: number;
  };
  /** Depotwert + cumulative deposits on the same dates. */
  history: { date: string; wert: number; eingezahlt: number }[];
  historyNote: string;
  dividends: { date: string; symbol: string; amount: number }[];
  trades: {
    date: string;
    symbol: string;
    quantity: number;
    amountBase: number;
  }[];
  /** Load error — card shows an error state, page still renders. */
  error?: string;
};

function buildIbkrView(
  finance: FinanceData,
  snap: IbkrSnapshot | null,
  error?: string
): IbkrView {
  if (snap) {
    const pos = snap.positions[0];
    return {
      source: snap.source,
      sourceLabel: `Live · IBKR Flex · Stand ${snap.asOf.split("-").reverse().join(".")}`,
      asOf: snap.asOf,
      accountId: snap.accountId,
      nav: snap.netLiquidation,
      cash: snap.cash,
      unrealized: snap.unrealizedPnl,
      position: pos && {
        symbol: pos.symbol,
        name: pos.description,
        quantity: pos.quantity,
        isin: pos.isin,
        marketValueUsd: pos.currency === "USD" ? pos.marketValue : undefined,
        marketValueBase: pos.marketValueBase,
      },
      history: trimLeadingZeroNav(snap.navHistory).map((h) => ({
        date: h.date,
        wert: h.nav,
        eingezahlt: snap.deposits
          .filter((d) => d.date <= h.date)
          .reduce((s, d) => s + d.amount, 0),
      })),
      historyNote: "Täglicher NAV aus dem Flex-Statement",
      dividends: snap.dividends.map((d) => ({
        date: d.date,
        symbol: d.symbol,
        amount: d.amount - d.withholdingTax,
      })),
      trades: snap.trades.map((t) => ({
        date: t.date,
        symbol: t.symbol,
        quantity: t.quantity,
        amountBase: t.amountBase,
      })),
      error,
    };
  }
  const m = finance.ibkr;
  const pos = m.positions[0];
  return {
    source: "manual",
    sourceLabel: `Manuell · Screenshot ${m.valueHistory.at(-1)?.date.split("-").reverse().join(".") ?? ""}`,
    asOf: m.valueHistory.at(-1)?.date ?? finance.asOf,
    accountId: m.accountId,
    nav: m.netLiquidationChf,
    cash: m.cashChf,
    unrealized: m.unrealizedPnlChf,
    position: pos && {
      symbol: pos.symbol,
      name: pos.name,
      isin: pos.isin,
      ter: pos.ter,
      marketValueUsd: pos.marketValueUsd,
      marketValueBase: pos.marketValueChf,
    },
    history: m.valueHistory.map((h) => ({
      date: h.date,
      wert: h.valueChf,
      eingezahlt: m.deposits
        .filter((d) => d.date <= h.date)
        .reduce((s, d) => s + d.amountChf, 0),
    })),
    historyNote: m.valueHistoryNote,
    dividends: [],
    trades: [],
    error,
  };
}

/**
 * Nettovermögen-Verlauf: each ZKB account contributes its anchor-derived
 * balance from its first transaction date on. Before its first row an account
 * contributes its (back-computed) opening balance — which is 0 for e.g.
 * steuern. Accounts with a non-zero opening gate the chart start (we don't
 * draw a flat line before their data begins); zero-opening accounts don't.
 */
function netWorthSeries(
  finance: FinanceData,
  txs: Transaction[],
  ibkrHistory: { date: string; nav: number }[]
) {
  const zkb = finance.accounts.filter((a) => a.institution === "ZKB");
  const asOf = finance.balancesAsOf;
  const perAccount = zkb.map((a) => {
    const rows = txs.filter((t) => t.account === a.id);
    return {
      id: a.id,
      history: accountBalanceHistory(rows, a.balance, asOf),
      opening: accountBalanceAt(
        rows,
        a.balance,
        asOf,
        "0000-01-01" // before any row → opening balance
      ),
    };
  });
  const start = perAccount
    .filter((h) => h.opening !== 0)
    .map((h) => h.history[0]?.date ?? "9999")
    .sort()
    .at(-1);
  if (!start) return [];

  const dates = [
    ...new Set([
      ...perAccount.flatMap((h) => h.history.map((p) => p.date)),
      ...ibkrHistory.map((p) => p.date),
    ]),
  ]
    .filter((d) => d >= start && d <= asOf)
    .sort();

  const lastBefore = (
    points: { date: string; balance?: number; nav?: number }[],
    d: string
  ) => points.filter((p) => p.date <= d).at(-1);

  return dates.map((date) => {
    const row: Record<string, number | string> = { date };
    for (const h of perAccount) {
      // Before the first row: the opening balance (0 for steuern).
      row[h.id] = lastBefore(h.history, date)?.balance ?? h.opening;
    }
    row.ibkr = lastBefore(ibkrHistory, date)?.nav ?? 0;
    return row;
  });
}

export default async function Page() {
  const { finance, transactions } = await loadFinance();
  const asOf = finance.balancesAsOf;
  const accountRows = (id: string) => transactions.filter((t) => t.account === id);

  // Optional live IBKR snapshot (written by scripts/ibkr-sync.ts).
  let snap: IbkrSnapshot | null = null;
  let ibkrError: string | undefined;
  try {
    snap = loadIbkrSnapshot(DATA_DIR);
  } catch (e) {
    ibkrError = e instanceof Error ? e.message : String(e);
  }
  const ibkr = buildIbkrView(finance, snap, ibkrError);

  const { cycles } = buildCycles(transactions, {
    account: "privat",
    budgetStart: finance.budgetStart,
  });
  const privat = accountRows("privat");
  const histories = Object.fromEntries(
    finance.accounts
      .filter((a) => a.institution === "ZKB")
      .map((a) => [
        a.id,
        accountBalanceHistory(accountRows(a.id), a.balance, asOf),
      ])
  );
  // Same series as histories.privat — one object, so it's serialized once.
  const daily = histories.privat;
  const ibkrNavHistory = snap
    ? trimLeadingZeroNav(snap.navHistory)
    : finance.ibkr.valueHistory.map((h) => ({ date: h.date, nav: h.valueChf }));
  const nwSeries = netWorthSeries(finance, transactions, ibkrNavHistory);

  const topfe = topfBalances(finance, transactions);
  const ngGoal = finance.goals.find((g) => g.id === "notgroschen");
  const ng = notgroschenProjection(
    ngGoal?.current ?? 0,
    ngGoal?.target ?? 0,
    ngGoal?.monthly ?? 0
  );
  const projection = investProjection(
    ibkr.nav,
    finance.plan.etf.monthlyPhase1,
    finance.plan.etf.monthlyPhase2 + finance.plan.pillar3a.monthlyPlaceholder
  );
  const lastComplete = [...cycles].reverse().find((c) => !c.open);
  const insights = deriveInsights(finance, lastComplete, topfe, ng);

  // Monthly aggregates for the Ausgaben "Verlauf" section — precomputed so the
  // client never re-derives them from the full 800-row list.
  const monthlySpend = spendByMonth(privat);
  const monthlyIncome = incomeVsSpendByMonth(privat);
  const yearlyTop = topCategoriesByYear(privat);
  const payees = topPayees(privat);
  const monthPayees = payeesByMonthCategory(privat);

  const uncat = transactions.filter((t) => t.category === "Unkategorisiert");
  const uncatSinceStart = uncat.filter(
    (t) => t.date >= finance.budgetStart
  ).length;

  // IBKR account balance inside finance.accounts is a manual snapshot; the live
  // NAV replaces it when present.
  const netWorth =
    finance.accounts
      .filter((a) => a.id !== "ibkr")
      .reduce((s, a) => s + a.balance, 0) + ibkr.nav;

  return (
    <Dashboard
      finance={finance}
      transactions={transactions}
      cycles={cycles}
      daily={daily}
      histories={histories}
      nwSeries={nwSeries}
      topfe={topfe}
      netWorth={Math.round(netWorth * 100) / 100}
      ng={ng}
      projection={projection}
      insights={insights}
      ibkr={ibkr}
      monthlySpend={monthlySpend}
      monthlyIncome={monthlyIncome}
      yearlyTop={yearlyTop}
      payees={payees}
      monthPayees={monthPayees}
      uncat={{ total: uncat.length, sinceStart: uncatSinceStart }}
    />
  );
}
