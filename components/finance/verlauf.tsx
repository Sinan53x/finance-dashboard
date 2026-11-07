"use client";

import { useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/dither-kit";
import { PALETTE, rgb } from "@/components/dither-kit/palette";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TxFilterSignal } from "./dashboard";
import { categoryColor } from "@/lib/finance/colors";
import { chf, monthLong, monthShort, pct } from "@/lib/finance/format";
import { cn } from "@/lib/utils";
import { Section } from "./shared";

type Range = "12m" | "24m" | "alle";
const RANGE_LABELS: Record<Range, string> = {
  "12m": "12M",
  "24m": "24M",
  alle: "Alles",
};
const RANGE_MONTHS: Record<Range, number | null> = {
  "12m": 12,
  "24m": 24,
  alle: null,
};

const chipCls = (active: boolean) =>
  cn(
    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
    active
      ? "border-foreground/40 bg-muted text-foreground"
      : "text-muted-foreground hover:text-foreground"
  );

/** Fixed config objects — a fresh literal each render would replay the chart. */
const INCOME_CONFIG = {
  ein: { label: "Einnahmen", color: "green" },
  aus: { label: "Ausgaben", color: "orange" },
} as const;

/**
 * Monthly spend bar chart + selection detail. All chart `data`/`config`
 * references are memoized: dither-kit replays its entrance whenever `data`
 * changes identity, so hover state (sel) must never reach them.
 */
export function Verlauf({
  monthlySpend,
  monthlyIncome,
  yearlyTop,
  monthPayees,
  onTxSignal,
}: {
  monthlySpend: { month: string; byCategory: Record<string, number> }[];
  monthlyIncome: { month: string; ein: number; aus: number }[];
  yearlyTop: { year: string; items: { category: string; total: number }[] }[];
  monthPayees: Record<string, { payee: string; total: number }[]>;
  onTxSignal: (s: TxFilterSignal) => void;
}) {
  const [range, setRange] = useState<Range>("12m");
  const [chip, setChip] = useState<string | null>(null);
  /** Selected month index into `months`; -1 → latest. */
  const [sel, setSel] = useState(-1);
  const nonceRef = useRef(0);

  const months = useMemo(() => {
    const n = RANGE_MONTHS[range];
    return n ? monthlySpend.slice(-n) : monthlySpend;
  }, [monthlySpend, range]);

  // Top 8 categories within the visible range → trend chips.
  const chips = useMemo(() => {
    const totalsByCat = new Map<string, number>();
    for (const m of months)
      for (const [c, v] of Object.entries(m.byCategory))
        totalsByCat.set(c, (totalsByCat.get(c) ?? 0) + v);
    return [...totalsByCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c]) => c);
  }, [months]);

  // Chart input — memoized on months+chip only; `sel` changes the marker, not
  // the data, so the bars never replay their entrance while hovering.
  const series = useMemo(
    () =>
      months.map((m) => ({
        month: m.month,
        label: monthShort(`${m.month}-01`),
        v: chip
          ? (m.byCategory[chip] ?? 0)
          : Math.round(
              Object.values(m.byCategory).reduce((s, v) => s + v, 0) * 100
            ) / 100,
      })),
    [months, chip]
  );
  const seriesConfig = useMemo(
    () => ({
      v: {
        label: chip ?? "Lebenshaltung",
        color: chip ? categoryColor(chip) : ("blue" as const),
      },
    }),
    [chip]
  );

  const selIdx = Math.min(sel < 0 ? series.length - 1 : sel, series.length - 1);
  const selMonth = months[selIdx];
  const selValue = series[selIdx]?.v ?? 0;
  const prevValue = series[selIdx - 1]?.v;
  const avg12 =
    series.slice(-12).reduce((s, m) => s + m.v, 0) /
    Math.max(1, Math.min(series.length, 12));

  // Detail rows: categories of the selected month, or payees of the selected
  // category+month when a chip is active.
  const detail = chip
    ? (monthPayees[`${selMonth?.month}|${chip}`] ?? []).map((p) => ({
        key: p.payee,
        name: p.payee,
        total: p.total,
      }))
    : Object.entries(selMonth?.byCategory ?? {})
        .filter(([, v]) => v > 0)
        .map(([category, total]) => ({ key: category, name: category, total }))
        .sort((a, b) => b.total - a.total);
  const detailMax = detail[0]?.total ?? 1;

  const incomeRows = useMemo(() => {
    const n = RANGE_MONTHS[range];
    return (n ? monthlyIncome.slice(-n) : monthlyIncome).map((m) => ({
      ...m,
      label: monthShort(`${m.month}-01`),
    }));
  }, [monthlyIncome, range]);

  const drill = (category?: string) => {
    if (!selMonth || !category) return;
    const [y, m] = selMonth.month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    onTxSignal({
      category,
      from: `${selMonth.month}-01`,
      to: `${selMonth.month}-${String(lastDay).padStart(2, "0")}`,
      nonce: ++nonceRef.current,
    });
    document
      .getElementById("alle-buchungen")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <Section
      title="Verlauf"
      sub="Privatkonto · Kalendermonate · nur Lebenshaltung"
    >
      <Card>
        <CardContent className="grid gap-3 px-4 lg:grid-cols-[3fr_2fr]">
          <div>
            <div className="flex flex-wrap gap-1.5 pb-2">
              <button
                onClick={() => setChip(null)}
                className={chipCls(chip === null)}
              >
                Alle
              </button>
              {chips.map((c) => (
                <button
                  key={c}
                  onClick={() => setChip(chip === c ? null : c)}
                  className={chipCls(chip === c)}
                >
                  <span
                    className="mr-1 inline-block size-2 rounded-[2px] align-middle"
                    style={{ background: rgb(PALETTE[categoryColor(c)].fill) }}
                  />
                  {c}
                </button>
              ))}
              <span className="ml-auto flex gap-2">
                {(["12m", "24m", "alle"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRange(r)}
                    className={chipCls(range === r)}
                  >
                    {RANGE_LABELS[r]}
                  </button>
                ))}
              </span>
            </div>
            <div className="h-60">
              <BarChart
                data={series}
                config={seriesConfig}
                markerIndex={selIdx}
                onHoverChange={(i) => {
                  if (i != null) setSel(i);
                }}
              >
                <XAxis dataKey="label" maxTicks={10} />
                <YAxis />
                <Tooltip
                  labelKey="label"
                  valueFormatter={(v) => `CHF ${chf(v)}`}
                />
                <Bar dataKey="v" variant={chip ? "gradient" : "solid"} />
              </BarChart>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Monat auswählen: über die Balken fahren.
            </p>
          </div>

          <div>
            <p className="text-xs font-medium">
              {selMonth
                ? `${monthLong(`${selMonth.month}-01`)} · CHF ${chf(selValue)}`
                : "—"}
              {chip ? ` · ${chip}` : ""}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {prevValue !== undefined &&
                `${selValue >= prevValue ? "+" : "−"}${chf(Math.abs(selValue - prevValue))} vs. ${monthShort(`${months[selIdx - 1].month}-01`)}`}
              {prevValue !== undefined && " · "}
              {`${selValue >= avg12 ? "+" : "−"}${chf(Math.abs(selValue - avg12))} vs. Ø 12 Monate`}
            </p>
            <ul className="mt-2 grid gap-1.5">
              {detail.map((d) => {
                const w = (d.total / detailMax) * 100;
                return (
                  <li key={d.key}>
                    <button
                      className="w-full text-left"
                      onClick={() => drill(chip ?? d.key)}
                      title="In Alle Buchungen filtern"
                    >
                      <span className="flex items-baseline justify-between gap-2 text-[11px]">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {!chip && (
                            <span
                              className="inline-block size-2 shrink-0 rounded-[2px]"
                              style={{
                                background: rgb(
                                  PALETTE[categoryColor(d.key)].fill
                                ),
                              }}
                            />
                          )}
                          <span className="truncate">{d.name}</span>
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {chf(d.total)}
                          <span className="ml-1 text-muted-foreground">
                            {selValue > 0 ? pct(d.total / selValue, 0) : "—"}
                          </span>
                        </span>
                      </span>
                      <span className="mt-0.5 block h-1.5 w-full rounded-full bg-muted/50">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${w}%`,
                            background: rgb(
                              PALETTE[categoryColor(chip ?? d.key)].fill
                            ),
                          }}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
              {detail.length === 0 && (
                <li className="text-[11px] text-muted-foreground">
                  Keine Ausgaben in diesem Monat.
                </li>
              )}
            </ul>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardContent className="h-56 px-2">
            <p className="pl-2 pb-1 text-xs text-muted-foreground">
              Einnahmen vs. Ausgaben
            </p>
            <BarChart data={incomeRows} config={INCOME_CONFIG}>
              <XAxis dataKey="label" maxTicks={8} />
              <YAxis />
              <Tooltip
                labelKey="label"
                valueFormatter={(v) => `CHF ${chf(v)}`}
              />
              <Legend />
              <Bar dataKey="ein" />
              <Bar dataKey="aus" variant="hatched" />
            </BarChart>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="px-0 py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Jahr</TableHead>
                  <TableHead className="pr-4">Top-Kategorien</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {yearlyTop.map((y) => (
                  <TableRow key={y.year}>
                    <TableCell className="pl-4 font-mono text-xs tabular-nums">
                      {y.year}
                    </TableCell>
                    <TableCell className="max-w-0 truncate pr-4 text-[11px] text-muted-foreground">
                      {y.items
                        .map((i) => `${i.category} ${chf(i.total)}`)
                        .join(" · ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </Section>
  );
}
