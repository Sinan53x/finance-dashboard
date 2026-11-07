"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Area,
  AreaChart,
  DitherButton,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/dither-kit";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { IbkrView } from "@/app/page";
import type { InvestProjectionPoint } from "@/lib/finance/analysis";
import { chf, chfSigned, dateAxis, dateShort, pct } from "@/lib/finance/format";
import type { FinanceData } from "@/lib/finance/types";
import { Section } from "./shared";

type Range = "12m" | "alle";

const MONTH_MS = 31 * 86400e3;

/** Whole-franc grouping (1'000) for budget figures. */
const chf0 = (n: number) =>
  Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");

// Fixed config objects — a fresh literal each render would replay the
// entrance animation of every chart whenever e.g. the sync state toggles.
const DONUT_CONFIG = {
  Privatkonto: { color: "blue" },
  Notgroschen: { color: "green" },
  Steuern: { color: "orange" },
  IBKR: { color: "purple" },
} as const;
const DEPOT_CONFIG = {
  wert: { label: "Depotwert", color: "purple" },
  eingezahlt: { label: "Eingezahlt", color: "grey" },
} as const;
const NG_CONFIG = {
  balance: { label: "Notgroschen", color: "green" },
} as const;
const NW_CONFIG = {
  privat: { label: "Privatkonto", color: "blue" },
  notgroschen: { label: "Notgroschen", color: "green" },
  steuern: { label: "Steuern", color: "orange" },
  ibkr: { label: "IBKR", color: "purple" },
} as const;
const PROJ_CONFIG = {
  eingezahlt: { label: "Eingezahlt (0 %)", color: "grey" },
  r4: { label: "4 % p.a.", color: "blue" },
  r7: { label: "7 % p.a.", color: "purple" },
} as const;

export function WealthView({
  finance,
  projection,
  histories,
  nwSeries,
  ibkr,
}: {
  finance: FinanceData;
  projection: InvestProjectionPoint[];
  histories: Record<string, { date: string; balance: number }[]>;
  nwSeries: Record<string, number | string>[];
  ibkr: IbkrView;
}) {
  const router = useRouter();
  const pos = ibkr.position;
  const ngTarget = finance.goals.find((g) => g.id === "notgroschen")?.target;
  const ngSince = histories.notgroschen?.[0]?.date.slice(0, 4);
  const investP1 = finance.plan.etf.monthlyPhase1;
  const investP2 =
    finance.plan.etf.monthlyPhase2 + finance.plan.pillar3a.monthlyPlaceholder;
  const acc = (id: string) =>
    finance.accounts.find((a) => a.id === id)?.balance ?? 0;
  const [nwRange, setNwRange] = useState<Range>("12m");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [syncNeedsKeychain, setSyncNeedsKeychain] = useState(false);

  const donutRows = useMemo(
    () => [
      { name: "Privatkonto", value: acc("privat") },
      { name: "Notgroschen", value: acc("notgroschen") },
      { name: "Steuern", value: acc("steuern") },
      { name: "IBKR", value: ibkr.nav },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acc reads finance.accounts
    [finance.accounts, ibkr.nav]
  );

  const nwCutoff =
    nwRange === "12m"
      ? new Date(Date.parse(finance.balancesAsOf) - 12 * MONTH_MS)
          .toISOString()
          .slice(0, 10)
      : null;
  const nwRows = useMemo(
    () =>
      nwCutoff
        ? nwSeries.filter((r) => String(r.date) >= nwCutoff)
        : nwSeries,
    [nwSeries, nwCutoff]
  );
  const projData = useMemo(() => projRows(projection), [projection]);

  const sync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncNeedsKeychain(false);
    try {
      const res = await fetch("/api/ibkr/sync", { method: "POST" });
      const body = await res.json();
      if (body.ok) {
        setSyncResult(body.line ?? "Synchronisiert.");
        router.refresh();
      } else {
        setSyncResult(body.error ?? "Sync fehlgeschlagen.");
        setSyncNeedsKeychain(Boolean(body.keychain));
      }
    } catch (e) {
      setSyncResult(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Zusammensetzung" sub={`Stand ${dateShort(finance.asOf)}`}>
          <Card>
            <CardContent className="h-64 px-2">
              <PieChart
                data={donutRows}
                config={DONUT_CONFIG}
                dataKey="value"
                nameKey="name"
                innerRadius={0.62}
              >
                <Pie variant="gradient" />
                <Tooltip
                  labelKey="name"
                  valueFormatter={(v) => `CHF ${chf(v)}`}
                />
                <Legend align="center" />
              </PieChart>
            </CardContent>
          </Card>
        </Section>

        <Section
          title="Interactive Brokers"
          sub={`Konto ${ibkr.accountId}`}
        >
          <Card>
            <CardContent className="grid gap-2 px-4 text-xs">
              <div className="flex flex-wrap items-center gap-2 sm:justify-between">
                <Badge
                  variant={ibkr.source === "flex" ? "secondary" : "outline"}
                  className="text-[10px]"
                >
                  {ibkr.sourceLabel}
                </Badge>
                <DitherButton
                  color="purple"
                  variant="dotted"
                  className="px-2.5 py-0.5 text-[11px]"
                  disabled={syncing}
                  onClick={sync}
                >
                  {syncing ? "Synchronisiere…" : "Jetzt synchronisieren"}
                </DitherButton>
              </div>
              {ibkr.error && (
                <p className="rounded border border-red-400/40 bg-red-400/10 px-2 py-1.5 text-[11px] text-red-300">
                  ibkr.json konnte nicht gelesen werden: {ibkr.error}
                </p>
              )}
              {syncResult && (
                <div className="rounded border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                  <p className="whitespace-pre-wrap">{syncResult}</p>
                  {syncNeedsKeychain && (
                    <p className="mt-1">
                      Setup:{" "}
                      <code className="font-mono">
                        security add-generic-password -s
                        finance-dashboard-ibkr-flex -a token -w
                      </code>{" "}
                      und{" "}
                      <code className="font-mono">-a query-id -w</code> — Details
                      in <code className="font-mono">lib/ibkr/SETUP.de.md</code>.
                    </p>
                  )}
                </div>
              )}
              {pos && (
                <>
                  <Row
                    k="Position"
                    v={`${pos.quantity !== undefined ? `${pos.quantity} ` : ""}${pos.symbol} — ${pos.name}`}
                  />
                  <Row
                    k="ISIN / TER"
                    v={`${pos.isin ?? "—"}${pos.ter !== undefined ? ` · ${pct(pos.ter, 2)}` : ""}`}
                    mono
                  />
                  <Row
                    k="Marktwert"
                    v={
                      pos.marketValueUsd !== undefined
                        ? `$ ${chf(pos.marketValueUsd)} · CHF ${chf(pos.marketValueBase)}`
                        : `CHF ${chf(pos.marketValueBase)}`
                    }
                    mono
                  />
                </>
              )}
              <Row k="Cash" v={`CHF ${chf(ibkr.cash)}`} mono />
              <Row
                k="Unrealisiert"
                v={`${chfSigned(ibkr.unrealized)} CHF`}
                mono
                accent={ibkr.unrealized >= 0 ? "pos" : "neg"}
              />
              {ibkr.dividends.length > 0 && (
                <Row
                  k="Dividenden"
                  v={`${ibkr.dividends.length}× · netto CHF ${chf(ibkr.dividends.reduce((s, d) => s + d.amount, 0))}`}
                  mono
                />
              )}
              {ibkr.trades.length > 0 && (
                <Row
                  k="Trades"
                  v={`${ibkr.trades.length}× · zuletzt ${dateShort(ibkr.trades.at(-1)!.date)}`}
                  mono
                />
              )}
              <Separator className="my-1" />
              <Row
                k="Nettoliquidation"
                v={`CHF ${chf(ibkr.nav)}`}
                mono
              />
            </CardContent>
          </Card>
        </Section>
      </div>

      <Section
        title="Depotwert vs. Einzahlungen"
        sub={ibkr.historyNote}
      >
        <Card>
          <CardContent className="h-64 px-2">
            <LineChart
              data={ibkr.history}
              config={DEPOT_CONFIG}
            >
              <XAxis
                dataKey="date"
                tickFormatter={(v) => {
                  const s = String(v);
                  return `${s.slice(8, 10)}.${s.slice(5, 7)}.`;
                }}
              />
              <YAxis />
              <Tooltip
                labelKey="date"
                labelFormatter={(v) => dateShort(v)}
                valueFormatter={(v) => `CHF ${chf(v)}`}
              />
              <Legend />
              <Line dataKey="wert" />
              <Line dataKey="eingezahlt" strokeVariant="dashed" />
            </LineChart>
          </CardContent>
        </Card>
      </Section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section
          title="Notgroschen-Verlauf"
          sub={`Seit ${ngSince ?? "…"}${ngTarget !== undefined ? ` · Ziel ${chf(ngTarget)}` : ""}`}
        >
          <Card>
            <CardContent className="h-64 px-2">
              <AreaChart
                data={histories.notgroschen ?? []}
                config={NG_CONFIG}
                yMax={ngTarget}
              >
                <XAxis
                  dataKey="date"
                  maxTicks={8}
                  tickFormatter={(v) => dateAxis(String(v))}
                />
                <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                <Tooltip
                  labelKey="date"
                  labelFormatter={(v) => dateShort(v)}
                  valueFormatter={(v) => `CHF ${chf(v)}`}
                />
                {ngTarget !== undefined && (
                  <ReferenceLine y={ngTarget} label={`Ziel ${chf(ngTarget)}`} />
                )}
                <Area dataKey="balance" variant="gradient" />
              </AreaChart>
            </CardContent>
          </Card>
        </Section>

        <Section
          title="Nettovermögen über Zeit"
          sub="ZKB-Konten + IBKR"
        >
          <Card>
            <CardContent className="px-2">
              <div className="flex gap-2 pb-1 pl-2">
                {(["12m", "alle"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setNwRange(r)}
                    className={
                      nwRange === r
                        ? "rounded-full border border-foreground/40 bg-muted px-2.5 py-0.5 text-[11px]"
                        : "rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    }
                  >
                    {r === "12m" ? "12M" : "Alles"}
                  </button>
                ))}
              </div>
              <div className="h-56">
                <AreaChart
                  data={nwRows}
                  config={NW_CONFIG}
                  stackType="stacked"
                >
                  <XAxis
                    dataKey="date"
                    maxTicks={8}
                    tickFormatter={(v) => dateAxis(String(v))}
                  />
                  <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                  <Tooltip
                    labelKey="date"
                    labelFormatter={(v) => dateShort(v)}
                    valueFormatter={(v) => `CHF ${chf(v)}`}
                  />
                  <Legend />
                  <Area dataKey="privat" />
                  <Area dataKey="notgroschen" />
                  <Area dataKey="steuern" />
                  <Area dataKey="ibkr" />
                </AreaChart>
              </div>
            </CardContent>
          </Card>
        </Section>
      </div>

      <Section
        title="Projektion bis 2036"
        sub={`Annahmen, keine Prognose — ${chf0(investP1)}/Mt bis Dez 2026, dann ${chf0(investP2)}/Mt (VT + 3a)`}
      >
        <Card>
          <CardContent className="h-72 px-2">
            <LineChart
              data={projData}
              config={PROJ_CONFIG}
              bloom="low"
            >
              <XAxis
                dataKey="date"
                maxTicks={11}
                tickFormatter={(v) => String(v).slice(0, 4)}
              />
              <YAxis
                tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
              />
              <Tooltip
                labelKey="date"
                labelFormatter={(v) => dateShort(v)}
                valueFormatter={(v) => `CHF ${chf(v)}`}
              />
              <Legend align="center" />
              <Line dataKey="eingezahlt" strokeVariant="dashed" />
              <Line dataKey="r4" />
              <Line dataKey="r7" />
            </LineChart>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          Annahmen: monatliche Einzahlung am 25., konstante Rendite, keine
          Steuern/Gebühren, kein Rebalancing. Endwerte {dateShort("2036-12-25")}:
          0 % → {chf(projection.at(-1)?.r0 ?? 0)}, 4 % →{" "}
          {chf(projection.at(-1)?.r4 ?? 0)}, 7 % → {chf(projection.at(-1)?.r7 ?? 0)}.
        </p>
      </Section>
    </div>
  );
}

function projRows(projection: InvestProjectionPoint[]) {
  return projection.map((p) => ({
    date: p.date,
    eingezahlt: p.r0,
    r4: p.r4,
    r7: p.r7,
  }));
}

function Row({
  k,
  v,
  mono,
  accent,
}: {
  k: string;
  v: string;
  mono?: boolean;
  accent?: "pos" | "neg";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span
        className={
          (mono ? "font-mono tabular-nums " : "") +
          (accent === "pos" ? "text-emerald-400" : accent === "neg" ? "text-red-400" : "")
        }
      >
        {v}
      </span>
    </div>
  );
}
