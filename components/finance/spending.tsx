"use client";

import { useMemo } from "react";
import {
  BlockLegend,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/dither-kit";
import { Card, CardContent } from "@/components/ui/card";
import type { TxFilterSignal } from "./dashboard";
import { categoryKind, type Cycle } from "@/lib/finance/cycles";
import { spendByCategory } from "@/lib/finance/analysis";
import { chartConfigFor } from "@/lib/finance/colors";
import { chf, dateShort, pct } from "@/lib/finance/format";
import type { FinanceData, Transaction } from "@/lib/finance/types";
import { Section } from "./shared";
import { ImportCard } from "./import-card";
import { TxTable } from "./tx-table";
import { Verlauf } from "./verlauf";

/** Fixed chart configs — a fresh literal each render replays the entrance. */
const CUM_CONFIG = {
  ist: { label: "Ist", color: "orange" },
  budget: { label: "Budget", color: "grey" },
} as const;

export function SpendingView({
  finance,
  transactions,
  cycle,
  cumulative,
  monthlySpend,
  monthlyIncome,
  yearlyTop,
  payees,
  monthPayees,
  txSignal,
  onTxSignal,
}: {
  finance: FinanceData;
  transactions: Transaction[];
  cycle: Cycle | undefined;
  cumulative: { date: string; ist: number; budget: number }[];
  monthlySpend: { month: string; byCategory: Record<string, number> }[];
  monthlyIncome: { month: string; ein: number; aus: number }[];
  yearlyTop: { year: string; items: { category: string; total: number }[] }[];
  payees: { payee: string; total: number; count: number }[];
  monthPayees: Record<string, { payee: string; total: number }[]>;
  txSignal: TxFilterSignal | null;
  onTxSignal: (s: TxFilterSignal) => void;
}) {
  // Donut of the selected cycle's spending — memoized so unrelated renders
  // (filter signal, table edits) don't replay the entrance animation.
  const donutRows = useMemo(() => {
    const spend = spendByCategory(cycle?.rows ?? []);
    return Object.entries(spend)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [cycle]);
  const donutConfig = useMemo(
    () => chartConfigFor(donutRows.map((r) => ({ key: r.name }))),
    [donutRows]
  );

  // All known categories for the per-row edit select: budget categories,
  // income/transfer kinds, plus anything already used, plus Unkategorisiert.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of finance.budget.groups)
      for (const c of g.categories) set.add(c.name);
    for (const c of finance.budget.nonBudget.income) set.add(c);
    for (const c of ["Zinsen", "Übertrag", "Familie", "Spesen", "Unkategorisiert"])
      set.add(c);
    for (const t of transactions) set.add(t.category);
    return [...set].sort((a, b) => a.localeCompare(b, "de"));
  }, [finance, transactions]);

  // Pass-through rows (currently only Spesen), grouped per payee.
  const passThrough = useMemo(() => {
    const by = new Map<string, { ein: number; aus: number }>();
    for (const t of transactions) {
      if (categoryKind(t.category) !== "passThrough") continue;
      const e = by.get(`${t.category} (${t.payee})`) ?? { ein: 0, aus: 0 };
      if (t.amount < 0) e.aus += t.amount;
      else e.ein += t.amount;
      by.set(`${t.category} (${t.payee})`, e);
    }
    return [...by.entries()].map(([name, v]) => ({
      name,
      aus: Math.round(v.aus * 100) / 100,
      ein: Math.round(v.ein * 100) / 100,
    }));
  }, [transactions]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Ausgaben nach Kategorie" sub={cycle?.label}>
          <Card>
            <CardContent className="px-2">
              {donutRows.length > 0 ? (
                <>
                  <div className="h-56">
                    <PieChart
                      data={donutRows}
                      config={donutConfig}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={0.62}
                    >
                      <Pie variant="gradient" />
                      <Tooltip
                        labelKey="name"
                        valueFormatter={(v) => `CHF ${chf(v)}`}
                      />
                    </PieChart>
                  </div>
                  <BlockLegend
                    config={donutConfig}
                    values={Object.fromEntries(
                      donutRows.map((r) => [r.name, r.value])
                    )}
                    valueFormatter={(v) =>
                      `CHF ${chf(v)} (${pct(v / donutRows.reduce((s2, r) => s2 + r.value, 0), 0)})`
                    }
                  />
                </>
              ) : (
                <p className="p-6 text-xs text-muted-foreground">
                  Keine Ausgaben in diesem Zyklus.
                </p>
              )}
            </CardContent>
          </Card>
        </Section>

        <Section
          title="Kumulierte Ausgaben"
          sub="vs. linearer Budgetverlauf (Lebenshaltung)"
        >
          <Card>
            <CardContent className="h-64 px-2">
              <LineChart data={cumulative} config={CUM_CONFIG}>
                <XAxis dataKey="date" tickFormatter={(v) => String(v).slice(8)} />
                <YAxis />
                <Tooltip
                  labelKey="date"
                  labelFormatter={(v) => dateShort(v)}
                  valueFormatter={(v) => `CHF ${chf(v)}`}
                />
                <Legend />
                <Line dataKey="ist" />
                <Line dataKey="budget" strokeVariant="dashed" />
              </LineChart>
            </CardContent>
          </Card>
        </Section>
      </div>

      <Verlauf
        monthlySpend={monthlySpend}
        monthlyIncome={monthlyIncome}
        yearlyTop={yearlyTop}
        monthPayees={monthPayees}
        onTxSignal={onTxSignal}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Top-Empfänger" sub="Nach Ausgabensumme, gesamte Historie">
          <Card>
            <CardContent className="px-4">
              <ul className="grid gap-2">
                {payees.map((p) => (
                  <li
                    key={p.payee}
                    className="flex items-baseline justify-between gap-3 text-xs"
                  >
                    <span
                      className={`truncate${p.payee.trim() ? "" : " text-muted-foreground"}`}
                    >
                      {p.payee.trim() || "(ohne Empfänger)"}
                    </span>
                    <span className="flex items-baseline gap-2">
                      <span className="text-[10px] text-muted-foreground">
                        {p.count}×
                      </span>
                      <span className="font-mono tabular-nums">
                        {chf(p.total)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </Section>

        <Section title="Pass-through" sub="Einnahmen/Ausgaben, die sich aufheben">
          <Card>
            <CardContent className="grid gap-2 px-4 text-xs">
              <p className="text-muted-foreground">
                {finance.budget.nonBudget.passThroughNote}
              </p>
              {passThrough.map((p) => (
                <div
                  key={p.name}
                  className="flex items-baseline justify-between gap-3 font-mono tabular-nums"
                >
                  <span>{p.name}</span>
                  <span className="text-muted-foreground">
                    <span className="text-red-400">{chf(p.aus)}</span>
                    {" / "}
                    <span className="text-emerald-400">+{chf(p.ein)}</span>
                    {" = "}
                    {chf(p.ein + p.aus)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </Section>
      </div>

      <Section
        title="Kontoauszug importieren"
        sub="camt.053 (XML) oder ZKB-CSV — Vorschau vor dem Übernehmen"
      >
        <ImportCard accounts={finance.accounts} />
      </Section>

      <div id="alle-buchungen" className="scroll-mt-36">
        <Section title="Alle Buchungen">
          <TxTable
            transactions={transactions}
            asOf={finance.asOf}
            categoryOptions={categoryOptions}
            signal={txSignal}
          />
        </Section>
      </div>
    </div>
  );
}
