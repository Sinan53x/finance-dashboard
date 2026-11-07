"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  DitherGradient,
  Sparkline,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/dither-kit";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronRight, Circle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import type { IbkrView } from "@/app/page";
import { chf, dateAxis, dateLong, dateShort, pct } from "@/lib/finance/format";
import type { Cycle } from "@/lib/finance/cycles";
import type { NotgroschenProjection } from "@/lib/finance/analysis";
import type { FinanceData } from "@/lib/finance/types";
import { KpiCard, Section } from "./shared";

const MONTH_MS = 31 * 86400e3;
const BALANCE_CONFIG = {
  balance: { label: "Kontostand", color: "blue" },
} as const;
type Range = "3m" | "12m" | "alle";
const RANGE_LABELS: Record<Range, string> = {
  "3m": "3M",
  "12m": "12M",
  alle: "Alles",
};

export type OverviewProps = {
  finance: FinanceData;
  netWorth: number;
  daily: { date: string; balance: number }[];
  lastComplete: Cycle | undefined;
  openCycle: Cycle | undefined;
  ng: NotgroschenProjection;
  insights: string[];
  uncat: { total: number; sinceStart: number };
  onShowUnkategorisiert: () => void;
};

export function Overview({
  finance,
  netWorth,
  daily,
  lastComplete,
  openCycle,
  ng,
  insights,
  uncat,
  onShowUnkategorisiert,
  ibkr,
}: OverviewProps & { ibkr: IbkrView }) {
  const balance = finance.accounts.find((a) => a.id === "privat")?.balance ?? 0;
  const rate = openCycle?.savingsRate ?? lastComplete?.savingsRate ?? 0;
  const target = finance.budget.targetSavingsRate;
  const [range, setRange] = useState<Range>("12m");

  const deposited = ibkr.history.at(-1)?.eingezahlt ?? 0;
  const cutoff =
    range === "alle"
      ? null
      : new Date(
          Date.parse(finance.balancesAsOf) - (range === "3m" ? 3 : 12) * MONTH_MS
        )
          .toISOString()
          .slice(0, 10);
  const dailyRows = useMemo(
    () => (cutoff ? daily.filter((d) => d.date >= cutoff) : daily),
    [daily, cutoff]
  );
  const sparkData = useMemo(
    () => daily.slice(-365).map((d) => d.balance),
    [daily]
  );

  return (
    <div className="grid gap-6">
      <div className="relative overflow-hidden rounded-xl border bg-card p-6 sm:p-8">
        <DitherGradient from="blue" direction="up" opacity={0.35} />
        <div className="relative">
          <p className="text-xs font-medium text-muted-foreground">
            Nettovermögen
          </p>
          <p className="mt-2 font-mono text-4xl font-semibold tabular-nums sm:text-5xl">
            {chf(netWorth)}
            <span className="ml-2 text-base text-muted-foreground">CHF</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Stand {dateLong(finance.asOf)} ·{" "}
            {finance.accounts.length} Konten
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          title="Privatkonto"
          value={chf(balance)}
          sub="ZKB · letzte 12 Monate"
        >
          <div className="mt-2 h-10">
            <Sparkline
              data={sparkData}
              color="blue"
            />
          </div>
        </KpiCard>
        <KpiCard
          title="Sparquote"
          value={pct(rate)}
          sub={`Ziel ${pct(target, 0)} · laufender Zyklus`}
        >
          <Progress value={rate * 100} className="mt-3 h-1.5" />
        </KpiCard>
        <KpiCard
          title="Notgroschen"
          value={chf(ng.current)}
          sub={`von ${chf(ng.target)} · Ziel am ${ng.reachedDate.split("-").reverse().join(".")}`}
        >
          <Progress
            value={(ng.current / ng.target) * 100}
            className="mt-3 h-1.5"
          />
        </KpiCard>
        <KpiCard
          title="Investiert (IBKR)"
          value={chf(ibkr.nav)}
          sub={
            <>
              eingezahlt {chf(deposited)} ·{" "}
              <span
                className={
                  ibkr.unrealized >= 0 ? "text-emerald-400" : "text-red-400"
                }
              >
                {ibkr.unrealized >= 0 ? "+" : ""}
                {chf(ibkr.unrealized)}
              </span>{" "}
              unrealisiert
            </>
          }
        />
      </div>

      <Section
        title="Kontostand Privatkonto"
        sub={`Täglicher Schlussstand seit ${dateShort(daily[0]?.date ?? finance.asOf)}`}
      >
        <Card>
          <CardContent className="px-2">
            <div className="flex gap-2 pb-1 pl-2">
              {(["3m", "12m", "alle"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={
                    range === r
                      ? "rounded-full border border-foreground/40 bg-muted px-2.5 py-0.5 text-[11px]"
                      : "rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  }
                >
                  {RANGE_LABELS[r]}
                </button>
              ))}
            </div>
            <div className="h-52 sm:h-60">
              <AreaChart
                data={dailyRows}
                config={BALANCE_CONFIG}
                bloom="low"
              >
                <XAxis
                  dataKey="date"
                  maxTicks={8}
                  tickFormatter={(v) =>
                    range === "alle"
                      ? dateAxis(String(v))
                      : `${String(v).slice(8)}.${String(v).slice(5, 7)}.`
                  }
                />
                <YAxis
                  tickFormatter={(v) => `${Math.round(v / 100) / 10}k`}
                />
                <Tooltip
                  labelKey="date"
                  labelFormatter={(v) => dateShort(v)}
                  valueFormatter={(v) => `CHF ${chf(v)}`}
                />
                <Area dataKey="balance" variant="gradient" />
              </AreaChart>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Hinweise" sub="Automatisch abgeleitet">
        <Card>
          <CardContent className="px-4">
            <ul className="grid gap-2 text-xs leading-relaxed">
              {insights.map((t, i) => (
                <li key={i} className="flex gap-2">
                  <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>{t}</span>
                </li>
              ))}
              {uncat.total > 0 && (
                <li className="flex gap-2">
                  <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    <button
                      onClick={onShowUnkategorisiert}
                      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    >
                      {uncat.total} Buchungen unkategorisiert
                    </button>{" "}
                    (davon {uncat.sinceStart} seit Budgetstart)
                  </span>
                </li>
              )}
            </ul>
            <Separator className="my-3" />
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Offene To-dos
            </p>
            <ul className="grid gap-2 text-xs leading-relaxed">
              {finance.todos.map((t, i) => (
                <li key={i} className="flex gap-2">
                  <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
