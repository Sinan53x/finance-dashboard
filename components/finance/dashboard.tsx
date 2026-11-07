"use client";

import { useMemo, useState } from "react";
import { DitherButton } from "@/components/dither-kit";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { IbkrView } from "@/app/page";
import {
  cumulativeSpend,
  type InvestProjectionPoint,
  type NotgroschenProjection,
  type TopfBalance,
} from "@/lib/finance/analysis";
import type { Cycle } from "@/lib/finance/cycles";
import { dateLong, dateShort } from "@/lib/finance/format";
import type { FinanceData, Transaction } from "@/lib/finance/types";
import { BudgetView } from "./budget";
import { Overview } from "./overview";
import { PlanView } from "./plan";
import { SpendingView } from "./spending";
import { WealthView } from "./wealth";

export type TxFilterSignal = {
  category?: string;
  preset?: string;
  /** Explicit date range (ISO) — overrides the preset when set. */
  from?: string;
  to?: string;
  nonce: number;
};

export type DashboardProps = {
  finance: FinanceData;
  transactions: Transaction[];
  cycles: Cycle[];
  daily: { date: string; balance: number }[];
  /** Anchor-based daily balance history per ZKB account id. */
  histories: Record<string, { date: string; balance: number }[]>;
  /** Net worth over time: one row per date with privat/notgroschen/steuern/ibkr. */
  nwSeries: Record<string, number | string>[];
  topfe: TopfBalance[];
  netWorth: number;
  ng: NotgroschenProjection;
  projection: InvestProjectionPoint[];
  insights: string[];
  ibkr: IbkrView;
  /** Precomputed monthly aggregates (privat only) for the Verlauf section. */
  monthlySpend: { month: string; byCategory: Record<string, number> }[];
  monthlyIncome: { month: string; ein: number; aus: number }[];
  yearlyTop: { year: string; items: { category: string; total: number }[] }[];
  payees: { payee: string; total: number; count: number }[];
  /** `"YYYY-MM|Kategorie"` → top payees, for the Verlauf detail panel. */
  monthPayees: Record<string, { payee: string; total: number }[]>;
  uncat: { total: number; sinceStart: number };
};

export function Dashboard({
  finance,
  transactions,
  cycles,
  daily,
  histories,
  nwSeries,
  topfe,
  netWorth,
  ng,
  projection,
  insights,
  ibkr,
  monthlySpend,
  monthlyIncome,
  yearlyTop,
  payees,
  monthPayees,
  uncat,
}: DashboardProps) {
  const open = cycles.find((c) => c.open) ?? cycles.at(-1);
  const lastTxDate =
    [...transactions].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ??
    finance.asOf;
  const [tab, setTab] = useState("uebersicht");
  const [cycleKey, setCycleKey] = useState(open?.key ?? "");
  const cycle = cycles.find((c) => c.key === cycleKey) ?? open;
  const lastComplete = [...cycles].reverse().find((c) => !c.open);
  const [txSignal, setTxSignal] = useState<TxFilterSignal | null>(null);

  const cumulative = useMemo(
    () =>
      cycle?.start
        ? cumulativeSpend(
            cycle.rows,
            finance.budget.livingTotal,
            cycle.start,
            cycle.open ? null : cycle.end
          )
        : [],
    [cycle, finance.budget.livingTotal]
  );

  const selector = (
    <ScrollArea className="w-full">
      <div className="flex gap-2 pb-1">
        {cycles.map((c) => (
          <DitherButton
            key={c.key}
            color={c.key === cycleKey ? "blue" : "grey"}
            variant={c.key === cycleKey ? "gradient" : "dotted"}
            className="shrink-0 px-3 py-1 whitespace-nowrap"
            onClick={() => setCycleKey(c.key)}
          >
            {c.label}
          </DitherButton>
        ))}
      </div>
    </ScrollArea>
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16">
      <header className="sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 backdrop-blur">
        <div className="flex h-14 items-center justify-between gap-3">
          <h1 className="text-sm font-semibold">Finanzen</h1>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            Stand {dateLong(finance.asOf)} · letzte Buchung{" "}
            {dateShort(lastTxDate)}
            <span className="hidden sm:inline">
              {" "}
              · {transactions.length} Buchungen
            </span>
          </span>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <TabsList className="sticky top-[57px] z-20 flex w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-5 sm:overflow-hidden">
          <TabsTrigger value="uebersicht" className="flex-none px-3 sm:px-1.5">
            Übersicht
          </TabsTrigger>
          <TabsTrigger value="budget" className="flex-none px-3 sm:px-1.5">
            Budget
          </TabsTrigger>
          <TabsTrigger value="ausgaben" className="flex-none px-3 sm:px-1.5">
            Ausgaben
          </TabsTrigger>
          <TabsTrigger value="vermoegen" className="flex-none px-3 sm:px-1.5">
            <span className="sm:hidden">Vermögen</span>
            <span className="hidden sm:inline">Vermögen & Investitionen</span>
          </TabsTrigger>
          <TabsTrigger value="plan" className="flex-none px-3 sm:px-1.5">
            Plan
          </TabsTrigger>
        </TabsList>

        <TabsContent value="uebersicht" className="mt-4">
          <Overview
            finance={finance}
            netWorth={netWorth}
            daily={daily}
            lastComplete={lastComplete}
            openCycle={open}
            ng={ng}
            insights={insights}
            ibkr={ibkr}
            uncat={uncat}
            onShowUnkategorisiert={() => {
              setTxSignal({
                category: "Unkategorisiert",
                preset: "alle",
                nonce: Date.now(),
              });
              setTab("ausgaben");
            }}
          />
        </TabsContent>

        <TabsContent value="budget" className="mt-4 grid grid-cols-1 gap-4">
          {selector}
          <BudgetView finance={finance} cycle={cycle} topfe={topfe} />
        </TabsContent>

        <TabsContent value="ausgaben" className="mt-4 grid grid-cols-1 gap-4">
          {selector}
          <SpendingView
            finance={finance}
            transactions={transactions}
            cycle={cycle}
            cumulative={cumulative}
            monthlySpend={monthlySpend}
            monthlyIncome={monthlyIncome}
            yearlyTop={yearlyTop}
            payees={payees}
            monthPayees={monthPayees}
            txSignal={txSignal}
            onTxSignal={setTxSignal}
          />
        </TabsContent>

        <TabsContent value="vermoegen" className="mt-4">
          <WealthView
            finance={finance}
            projection={projection}
            histories={histories}
            nwSeries={nwSeries}
            ibkr={ibkr}
          />
        </TabsContent>

        <TabsContent value="plan" className="mt-4">
          <PlanView finance={finance} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
