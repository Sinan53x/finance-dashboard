"use client";

import { useMemo } from "react";

import {
  Bar,
  BarChart,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/dither-kit";
import { PALETTE, rgb } from "@/components/dither-kit/palette";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { chf, chfSigned, dateShort, pct } from "@/lib/finance/format";
import { categoryColor } from "@/lib/finance/colors";
import type { TopfBalance } from "@/lib/finance/analysis";
import type { Cycle } from "@/lib/finance/cycles";
import type {
  AnnualPayment,
  BudgetCategory,
  BudgetGroup,
  FinanceData,
} from "@/lib/finance/types";
import { cn } from "@/lib/utils";
import { Section } from "./shared";

const BUDGET_IST_CONFIG = {
  budget: { label: "Budget", color: "grey" },
  ist: { label: "Ist", color: "blue" },
} as const;

const SHORT: Record<string, string> = {
  Krankenkasse: "Krankenk.",
  "Gesundheit/Franchise": "Gesundheit",
  "ÖV/Mobilität": "ÖV",
  "Technik/Abos": "Technik",
  "Jahreskosten/Diverses": "Diverses",
  "Essen/Alltag": "Essen",
  "Freizeit/Shopping": "Freizeit",
  Notgroschen: "Notgroschen",
  "ETF IBKR": "ETF",
};
const short = (name: string) => SHORT[name] ?? name;

function istOf(cycle: Cycle | undefined, category: string): number {
  const v = cycle?.byCategory[category] ?? 0;
  return v < 0 ? -v : 0;
}

const addMonths = (iso: string, months: number) => {
  const [y, m] = iso.split("-").map(Number);
  const mm = m + months;
  return `${String(((mm - 1) % 12) + 1).padStart(2, "0")}.${y + Math.floor((mm - 1) / 12)}`;
};

/** Payday-of-the-month index (25th boundaries) for a date or cycle key. */
const cycleIndex = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return y * 12 + m - 1 + (d >= 25 ? 1 : 0);
};

/** Annual-payment footnote under a Töpfe row. */
function annualNote(p: AnnualPayment): string {
  return `${p.note} · gültig bis ${addMonths(p.date, p.coversMonths)} · effektiv ${chf(p.amount / p.coversMonths)}/Mt`;
}

/**
 * Bullet bar on a 0–150 % scale: fill = Ist/Budget in the category colour,
 * the portion beyond 100 % is red, tick at 100 %, "›" when capped.
 */
function BulletBar({
  ist,
  budget,
  category,
}: {
  ist: number;
  budget: number;
  category: string;
}) {
  const ratio = budget > 0 ? (ist / budget) * 100 : ist > 0 ? 150 : 0;
  const capped = Math.min(ratio, 150);
  const over = ratio > 100;
  const baseW = (Math.min(capped, 100) / 150) * 100;
  const overW = over ? ((capped - 100) / 150) * 100 : 0;
  const fill = rgb(PALETTE[categoryColor(category)].fill);
  return (
    <div className="relative h-2.5 w-full rounded-full bg-muted/60">
      <div
        className="absolute top-0 left-0 h-full rounded-l-full"
        style={{ width: `${baseW}%`, background: fill }}
      />
      {over && (
        <div
          className="absolute top-0 h-full bg-red-500/80"
          style={{ left: `${100 / 1.5}%`, width: `${overW}%` }}
        />
      )}
      <div
        className="absolute top-[-2px] bottom-[-2px] w-px bg-foreground/70"
        style={{ left: `${100 / 1.5}%` }}
      />
      {ratio >= 150 && (
        <span className="absolute top-1/2 right-0.5 -translate-y-1/2 font-mono text-[9px] leading-none text-red-400">
          ›
        </span>
      )}
    </div>
  );
}

function BarLabel({
  ist,
  budget,
  savings,
}: {
  ist: number;
  budget: number;
  savings?: boolean;
}) {
  if (savings && ist >= budget) {
    return <span className="text-emerald-400">erfüllt</span>;
  }
  const rest = budget - ist;
  return rest >= 0 ? (
    <span className="text-muted-foreground">{chf(rest)} übrig</span>
  ) : (
    <span className="text-red-400">{chf(-rest)} über</span>
  );
}

export function BudgetView({
  finance,
  cycle,
  topfe,
}: {
  finance: FinanceData;
  cycle: Cycle | undefined;
  topfe: TopfBalance[];
}) {
  const groups: BudgetGroup[] = finance.budget.groups;
  const topfByName = new Map(topfe.map((t) => [t.name, t]));
  const annualByCategory = new Map(finance.annualPayments.map((p) => [p.category, p]));
  const steuern = topfe.find((t) => t.name === "Steuern");
  const freeMargin = finance.income.netMonthly - finance.income.budgetBase;

  // Chart: all monthly-scoped categories — savings get the compact strip;
  // the yearly Töpfe scope lives in the table below. Annual payments are
  // spread over their covered cycles so a big Jahresabo doesn't
  // crush the scale (only in this chart; the table keeps the real Ist).
  const curIdx = cycle?.start ? cycleIndex(cycle.start) : -1;
  const chartIst = (name: string) => {
    let ist = istOf(cycle, name);
    const p = annualByCategory.get(name);
    if (!p || curIdx < 0) return ist;
    if (cycleIndex(p.date) === curIdx) ist -= p.amount;
    const within =
      curIdx >= cycleIndex(p.date) && curIdx < cycleIndex(p.date) + p.coversMonths;
    if (within) ist += p.amount / p.coversMonths;
    return Math.round(ist * 100) / 100;
  };
  const chartRows = useMemo(
    () =>
      groups
        .filter((g) => g.id !== "sparen")
        .flatMap((g) =>
          g.categories.map((c) => ({
            name: short(c.name),
            budget: c.monthly,
            ist: chartIst(c.name),
          }))
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, cycle]
  );

  const sparen = groups.find((g) => g.id === "sparen");
  const savingsRows = (sparen?.categories ?? []).map((c) => ({
    name: c.name,
    budget: c.monthly,
    ist: istOf(cycle, c.name),
  }));
  const savingsB = savingsRows.reduce((s, r) => s + r.budget, 0);
  const savingsI = savingsRows.reduce((s, r) => s + r.ist, 0);

  return (
    <div className="grid grid-cols-1 gap-6">
      <Section
        title="Budget vs. Ist"
        sub={`${cycle?.label ?? "—"} · monatliche Budgets (ohne Sparen) · Jahreszahlungen auf 12 Monate verteilt`}
      >
        <Card>
          <CardContent className="h-80 px-2 sm:h-[420px]">
            <BarChart
              data={chartRows}
              config={BUDGET_IST_CONFIG}
            >
              <XAxis dataKey="name" tickMargin={8} maxTicks={chartRows.length} />
              <YAxis />
              <Tooltip
                labelKey="name"
                valueFormatter={(v) => `CHF ${chf(v)}`}
              />
              <Legend />
              <Bar dataKey="budget" variant="dotted" />
              <Bar dataKey="ist" variant="gradient" />
            </BarChart>
          </CardContent>
        </Card>
        {sparen && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-3 py-2 text-xs">
            <span className="font-medium">Sparen</span>
            <span className="font-mono tabular-nums">
              {chf(savingsI)} / {chf(savingsB)}
            </span>
            {savingsI >= savingsB && <span className="text-emerald-400">✓</span>}
            <span className="text-muted-foreground">
              {savingsRows.map((r) => `${short(r.name)} ${chf(r.ist)}`).join(" · ")}
            </span>
          </div>
        )}
      </Section>

      <Section
        title="Kategorien"
        sub="Skala 0–150 % des Budgets · Töpfe auf Jahressicht"
      >
        <Card>
          <CardContent className="px-0 py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Kategorie</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Budget</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Ist</TableHead>
                  <TableHead className="hidden w-[35%] sm:table-cell" />
                  <TableHead className="hidden pr-4 text-right sm:table-cell"> </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <GroupRows
                    key={g.id}
                    group={g}
                    cycle={cycle}
                    finance={finance}
                    topfByName={topfByName}
                    annualByCategory={annualByCategory}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          Budgetbasis {chf(finance.income.budgetBase)} vs. Netto-Lohn{" "}
          {chf(finance.income.netMonthly)} →{" "}
          <span className="text-emerald-400">
            {chfSigned(freeMargin)} freie Marge
          </span>
          .
        </p>
      </Section>

      <Section
        title="Töpfe (Sinking Funds)"
        sub={`Jahressicht seit ${dateShort(finance.budgetStart)} · Saldo = ${topfe[0]?.cyclesFunded ?? 0} Zyklen × Monatsbetrag − Ausgaben`}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {topfe.map((t) => {
            const neg = t.balance < 0;
            const annual = annualByCategory.get(t.name);
            return (
              <Card key={t.name} className="gap-1 py-3">
                <CardHeader className="px-3">
                  <CardTitle className="text-xs font-medium text-muted-foreground">
                    {t.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3">
                  <div
                    className={cn(
                      "font-mono text-lg font-semibold tabular-nums",
                      neg ? "text-red-400" : "text-emerald-400"
                    )}
                  >
                    {chfSigned(t.balance)}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {chf(t.monthly)}/Mt
                    {t.yearlyTarget ? ` · Ziel ${chf(t.yearlyTarget)}/Jahr` : ""}
                    {neg && t.recoveryDate
                      ? ` · ausgeglichen am ${dateShort(t.recoveryDate)}`
                      : ""}
                  </div>
                  {t.yearlyTarget && (
                    <Progress
                      value={Math.max(
                        0,
                        Math.min(100, (t.spendSinceStart / t.yearlyTarget) * 100)
                      )}
                      className={cn(
                        "mt-2 h-1",
                        t.spendSinceStart > t.yearlyTarget &&
                          "[&_[data-slot=progress-indicator]]:bg-red-400"
                      )}
                    />
                  )}
                  {annual && (
                    <div className="mt-2 text-[10px] leading-snug text-muted-foreground">
                      {annualNote(annual)}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {steuern && (
          <p className="text-xs text-muted-foreground">
            Steuern-Topf: {chf(steuern.balance)} von{" "}
            {chf(steuern.yearlyTarget ?? 0)} Jahresziel (
            {pct((steuern.balance ?? 0) / (steuern.yearlyTarget ?? 1), 0)}) —
            separates ZKB Sparkonto.
          </p>
        )}
      </Section>
    </div>
  );
}

function GroupRows({
  group,
  cycle,
  finance,
  topfByName,
  annualByCategory,
}: {
  group: BudgetGroup;
  cycle: Cycle | undefined;
  finance: FinanceData;
  topfByName: Map<string, TopfBalance>;
  annualByCategory: Map<string, AnnualPayment>;
}) {
  const yearly = group.id === "topf";
  const ist = (c: BudgetCategory) =>
    yearly ? (topfByName.get(c.name)?.spendSinceStart ?? 0) : istOf(cycle, c.name);
  const budget = (c: BudgetCategory) =>
    yearly ? (c.yearlyTarget ?? c.monthly * 12) : c.monthly;
  const gB = group.categories.reduce((s, c) => s + budget(c), 0);
  const gI = group.categories.reduce((s, c) => s + ist(c), 0);

  return (
    <>
      <TableRow className="bg-muted/40">
        <TableCell className="pl-4 font-medium">
          {group.label}
          {yearly && (
            <span className="ml-2 text-[10px] font-normal text-muted-foreground">
              Jahressicht seit {dateShort(finance.budgetStart)}
            </span>
          )}
          <div className="mt-1.5 font-normal sm:hidden">
            <BulletBar
              ist={gI}
              budget={gB}
              category={group.categories[0]?.name ?? ""}
            />
            <div className="mt-0.5 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
              <span>
                {chf(gI)} / {chf(gB)}
              </span>
              <BarLabel ist={gI} budget={gB} savings={group.id === "sparen"} />
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">
          {chf(gB)}
        </TableCell>
        <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">
          {chf(gI)}
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <BulletBar ist={gI} budget={gB} category={group.categories[0]?.name ?? ""} />
        </TableCell>
        <TableCell className="hidden pr-4 text-right font-mono text-xs tabular-nums sm:table-cell">
          <BarLabel ist={gI} budget={gB} savings={group.id === "sparen"} />
        </TableCell>
      </TableRow>
      {group.categories.map((c) => {
        const i = ist(c);
        const b = budget(c);
        const annual = annualByCategory.get(c.name);
        const topf = topfByName.get(c.name);
        return (
          <TableRow key={c.name}>
            <TableCell className="pl-6 align-top">
              <div>{c.name}</div>
              {c.note && (
                <div className="text-[10px] text-muted-foreground">{c.note}</div>
              )}
              {annual && (
                <div className="text-[10px] text-muted-foreground">
                  {annualNote(annual)}
                </div>
              )}
              {yearly && topf && (
                <Badge
                  variant={topf.balance < 0 ? "destructive" : "secondary"}
                  className="mt-1 font-mono text-[9px]"
                >
                  Saldo {chfSigned(topf.balance)}
                </Badge>
              )}
              <div className="mt-1.5 sm:hidden">
                <BulletBar ist={i} budget={b} category={c.name} />
                <div className="mt-0.5 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                  <span>
                    {chf(i)} / {chf(b)}
                  </span>
                  <BarLabel ist={i} budget={b} savings={group.id === "sparen"} />
                </div>
              </div>
            </TableCell>
            <TableCell className="hidden text-right font-mono tabular-nums align-top sm:table-cell">
              {chf(b)}
            </TableCell>
            <TableCell className="hidden text-right font-mono tabular-nums align-top sm:table-cell">
              {chf(i)}
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <BulletBar ist={i} budget={b} category={c.name} />
            </TableCell>
            <TableCell className="hidden pr-4 text-right font-mono text-xs tabular-nums sm:table-cell">
              <BarLabel ist={i} budget={b} savings={group.id === "sparen"} />
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
