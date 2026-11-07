"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { chf, chfSigned, dateShort, pct } from "@/lib/finance/format";
import type { FinanceData } from "@/lib/finance/types";
import { Section } from "./shared";

export function PlanView({ finance }: { finance: FinanceData }) {
  const { phases, pillar3a, etf } = finance.plan;
  const inc = finance.income;
  const freeMargin = inc.netMonthly - inc.budgetBase;
  const groups = finance.budget.groups.map((g) => ({
    label: g.label,
    total: g.categories.reduce((s, c) => s + c.monthly, 0),
  }));

  return (
    <div className="grid gap-6">
      <Section title="Phasen" sub="Aus dem Investitionsplan">
        <div className="relative grid gap-3 pl-5">
          <div className="absolute top-1 bottom-1 left-1.5 w-px bg-border" />
          {phases.map((p, i) => (
            <Card key={p.id} className="relative gap-1 py-4">
              <span className="absolute top-5 -left-5 size-2.5 rounded-full bg-emerald-400" />
              <CardHeader className="px-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {p.label}
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {p.from} → {p.to ?? "laufend"}
                  </Badge>
                  {i === 0 && (
                    <Badge className="bg-emerald-600 text-[10px]">aktiv</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 text-xs text-muted-foreground">
                {p.summary}
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Säule 3a" sub={pillar3a.provider}>
          <Card>
            <CardContent className="grid gap-2 px-4 text-xs">
              <Row k="Strategie" v={pillar3a.strategy} />
              <Row k="Start" v={`${pillar3a.start} (${dateShort("2027-01-25")})`} />
              <Row
                k="Einzahlungen 2026"
                v={`0 / ${chf(pillar3a.yearlyMax2026)} (Jahresmaximum)`}
                mono
              />
              <Row
                k="Monatlich ab 2027"
                v={`~${chf(pillar3a.monthlyPlaceholder)}`}
                mono
              />
              <Separator className="my-1" />
              <p className="text-muted-foreground">{pillar3a.note}</p>
            </CardContent>
          </Card>
        </Section>

        <Section title="ETF-Sparplan" sub={etf.broker}>
          <Card>
            <CardContent className="grid gap-2 px-4 text-xs">
              <Row k="ETF" v={`${etf.symbol} · ${etf.isin}`} />
              <Row k="Strategie" v={etf.strategy} />
              <Row k="Phase 1" v={`${chf(etf.monthlyPhase1)}/Mt`} mono />
              <Row k="Phase 2" v={`${chf(etf.monthlyPhase2)}/Mt`} mono />
            </CardContent>
          </Card>
        </Section>
      </div>

      <Section
        title="Geldfluss pro Monat"
        sub={`Auszahlung ${chf(inc.payout)} = Netto ${chf(inc.netMonthly)} + Spesen ${chf(inc.expensesAllowance)}`}
      >
        <Card>
          <CardContent className="grid gap-3 px-4">
            {groups.map((g) => {
              const share = g.total / inc.payout;
              return (
                <div key={g.label} className="grid gap-1">
                  <div className="flex justify-between text-xs">
                    <span>{g.label}</span>
                    <span className="font-mono tabular-nums">
                      {chf(g.total)}{" "}
                      <span className="text-muted-foreground">
                        ({pct(share, 0)})
                      </span>
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-emerald-500/70"
                      style={{ width: `${share * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {(
              [
                ["Freie Marge", freeMargin],
                ["Spesen-Pauschale", inc.expensesAllowance],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="grid gap-1">
                <div className="flex justify-between text-xs">
                  <span>{label}</span>
                  <span className="font-mono tabular-nums">{chf(v)}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-neutral-500/60"
                    style={{ width: `${(v / inc.payout) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Lohnabrechnung"
        sub={`${inc.employer} · Zahltag jeweils am ${inc.payday}.`}
      >
        <Card>
          <CardContent className="grid gap-2 px-4 text-xs">
            <Row k="Brutto" v={chf(inc.grossMonthly)} mono strong />
            {inc.deductions.map((d) => (
              <Row
                key={d.label}
                k={`${d.label}${d.rate ? ` (${pct(d.rate, 2)})` : ""}`}
                v={`−${chf(d.amount)}`}
                mono
              />
            ))}
            <Separator className="my-1" />
            <Row k="Netto" v={chf(inc.netMonthly)} mono strong />
            <Row k="Spesen" v={chfSigned(inc.expensesAllowance)} mono />
            <Separator className="my-1" />
            <Row k="Auszahlung" v={chf(inc.payout)} mono strong accent />
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}

function Row({
  k,
  v,
  mono,
  strong,
  accent,
}: {
  k: string;
  v: string;
  mono?: boolean;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? "font-medium" : "text-muted-foreground"}>
        {k}
      </span>
      <span
        className={`${mono ? "font-mono tabular-nums" : ""} ${strong ? "font-semibold" : ""} ${accent ? "text-emerald-400" : ""}`}
      >
        {v}
      </span>
    </div>
  );
}
