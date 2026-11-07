"use client";

import {
  Fragment,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TxFilterSignal } from "./dashboard";
import { chf, chfSigned, dateShort, dayLabel } from "@/lib/finance/format";
import type { Transaction } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

const PAGE = 50;

type Sort = "neueste" | "aelteste" | "betrag";
type Preset = "monat" | "letzter" | "3m" | "jahr" | "alle";

const ACCOUNT_LABELS: Record<string, string> = {
  privat: "Privatkonto",
  notgroschen: "Notgroschen",
  steuern: "Steuern",
};

/** Row + its index in the (CSV-ordered) transactions array — the edit API's identity. */
type Row = { t: Transaction; index: number };

const firstOf = (y: number, m: number) =>
  `${y}-${String(m).padStart(2, "0")}-01`;
const lastOf = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** Calendar ranges for the preset chips. Returns [from, to] — ["", ""] = Alles. */
function presetRange(p: Preset, asOf: string): [string, string] {
  const [y, m] = asOf.split("-").map(Number);
  switch (p) {
    case "monat":
      return [firstOf(y, m), lastOf(y, m)];
    case "letzter": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return [firstOf(py, pm), lastOf(py, pm)];
    }
    case "3m": {
      const start = m > 2 ? [y, m - 2] : [y - 1, m + 10];
      return [firstOf(start[0], start[1]), lastOf(y, m)];
    }
    case "jahr":
      return [firstOf(y, 1), lastOf(y, 12)];
    case "alle":
      return ["", ""];
  }
}

const chipCls = (active: boolean) =>
  cn(
    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
    active
      ? "border-foreground/40 bg-muted text-foreground"
      : "text-muted-foreground hover:text-foreground"
  );

const DESKTOP = "(min-width: 640px)"; // Tailwind `sm`
/** True on viewports ≥ `sm` — decides which of the two row layouts renders. */
function useIsDesktop() {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(DESKTOP);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(DESKTOP).matches,
    () => false
  );
}

export function TxTable({
  transactions,
  asOf,
  categoryOptions,
  signal,
}: {
  transactions: Transaction[];
  asOf: string;
  categoryOptions: string[];
  signal: TxFilterSignal | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("alle");
  const [sign, setSign] = useState("alle");
  const [account, setAccount] = useState("privat");
  const [preset, setPreset] = useState<Preset | null>("3m");
  const [from, setFrom] = useState(() => presetRange("3m", asOf)[0]);
  const [to, setTo] = useState(() => presetRange("3m", asOf)[1]);
  const [sort, setSort] = useState<Sort>("neueste");
  const [shown, setShown] = useState(PAGE);
  const [editing, setEditing] = useState<number | null>(null);
  const isDesktop = useIsDesktop();
  const sentinelRef = useRef<HTMLDivElement>(null);

  // External "show me X" signal (e.g. Übersicht uncategorized, Verlauf drill):
  // adjust state during render when a new signal arrives.
  const [seen, setSeen] = useState(signal?.nonce);
  if (signal && signal.nonce !== seen) {
    setSeen(signal.nonce);
    if (signal.category) setCategory(signal.category);
    if (signal.from !== undefined || signal.to !== undefined) {
      setFrom(signal.from ?? "");
      setTo(signal.to ?? "");
      setPreset(null);
    } else if (signal.preset) {
      const p = signal.preset as Preset;
      setPreset(p);
      const [f, t] = presetRange(p, asOf);
      setFrom(f);
      setTo(t);
    }
    setShown(PAGE);
    setEditing(null);
  }

  const applyPreset = (p: Preset) => {
    setPreset(p);
    const [f, t] = presetRange(p, asOf);
    setFrom(f);
    setTo(t);
    setShown(PAGE);
  };

  const categories = useMemo(
    () => [...new Set(transactions.map((t) => t.category))].sort(),
    [transactions]
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = transactions
      .map((t, index): Row => ({ t, index }))
      .filter(({ t }) => {
        if (account !== "alle" && t.account !== account) return false;
        if (category !== "alle" && t.category !== category) return false;
        if (sign === "aus" && t.amount >= 0) return false;
        if (sign === "ein" && t.amount <= 0) return false;
        if (from && t.date < from) return false;
        if (to && t.date > to) return false;
        if (q && !`${t.payee} ${t.text} ${t.category}`.toLowerCase().includes(q))
          return false;
        return true;
      });
    if (sort === "betrag") return filtered.sort((a, b) => b.t.amount - a.t.amount);
    return filtered.sort((a, b) =>
      sort === "neueste"
        ? b.t.date.localeCompare(a.t.date) || b.index - a.index
        : a.t.date.localeCompare(b.t.date) || a.index - b.index
    );
  }, [transactions, query, category, sign, account, from, to, sort]);

  const visible = rows.slice(0, shown);
  const sum = rows.reduce((s, r) => s + r.t.amount, 0);

  // Day grouping only for date sorting — Betrag shows a flat list.
  const groups: { date: string; net: number; rows: Row[] }[] | null =
    sort === "betrag"
      ? null
      : visible.reduce<{ date: string; net: number; rows: Row[] }[]>((out, r) => {
          const g = out.at(-1);
          if (g && g.date === r.t.date) {
            g.rows.push(r);
            g.net += r.t.amount;
          } else {
            out.push({ date: r.t.date, net: r.t.amount, rows: [r] });
          }
          return out;
        }, []);

  const currentYear = Number(asOf.slice(0, 4));
  const showAccount = account === "alle";

  const amountCls = (n: number) =>
    cn("font-mono tabular-nums", n >= 0 ? "text-emerald-400" : "text-red-400");

  const presets: { id: Preset; label: string }[] = [
    { id: "monat", label: "Dieser Monat" },
    { id: "letzter", label: "Letzter Monat" },
    { id: "3m", label: "3 Monate" },
    { id: "jahr", label: "Dieses Jahr" },
    { id: "alle", label: "Alles" },
  ];
  const sorts: { id: Sort; label: string }[] = [
    { id: "neueste", label: "Neueste" },
    { id: "aelteste", label: "Älteste" },
    { id: "betrag", label: "Betrag ↓" },
  ];

  const editorFor = (row: Row) => (
    <CategoryEditor
      key={`${row.index}-${row.t.category}`}
      row={row}
      options={categoryOptions}
      onDone={() => {
        setEditing(null);
        router.refresh();
      }}
      onCancel={() => setEditing(null)}
    />
  );

  const rowTitle = (t: Transaction) =>
    t.valuta !== t.date
      ? `${t.payee} · Valuta ${dateShort(t.valuta)}`
      : t.payee;

  // Grow the list automatically while scrolling — the sentinel extends ~1200px
  // below the fold, so the next page lands before the user reaches the end.
  // The observer is re-created on every page: a fresh one reports the current
  // intersection immediately, so it chains while still within the margin.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          startTransition(() => setShown((n) => n + PAGE));
        }
      },
      { rootMargin: "0px 0px 1200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rows.length]);

  return (
    <Card>
      <CardContent className="px-0 py-0">
        <div className="grid gap-2 px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
              placeholder="Suche (Empfänger, Text, Kategorie)…"
              className="h-8 text-xs sm:max-w-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Select value={account} onValueChange={(v) => setAccount(v ?? "privat")}>
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue>
                    {(v) => ACCOUNT_LABELS[v as string] ?? "Alle Konten"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alle">Alle Konten</SelectItem>
                  <SelectItem value="privat">Privatkonto</SelectItem>
                  <SelectItem value="notgroschen">Notgroschen</SelectItem>
                  <SelectItem value="steuern">Steuern</SelectItem>
                </SelectContent>
              </Select>
              <Select value={category} onValueChange={(v) => setCategory(v ?? "alle")}>
                <SelectTrigger className="h-8 w-44 text-xs">
                  <SelectValue>
                    {(v) => (v === "alle" ? "Alle Kategorien" : String(v))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alle">Alle Kategorien</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sign} onValueChange={(v) => setSign(v ?? "alle")}>
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue>
                    {(v) =>
                      v === "aus"
                        ? "Ausgaben"
                        : v === "ein"
                          ? "Einnahmen"
                          : "Ein- & Ausgänge"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alle">Ein- & Ausgänge</SelectItem>
                  <SelectItem value="aus">Ausgaben</SelectItem>
                  <SelectItem value="ein">Einnahmen</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <span className="ml-auto self-center font-mono text-[10px] whitespace-nowrap text-muted-foreground">
              {rows.length} Buchungen · Summe CHF {chf(sum)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p.id)}
                className={chipCls(preset === p.id)}
              >
                {p.label}
              </button>
            ))}
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              von
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPreset(null);
                  setShown(PAGE);
                }}
                className="h-7 w-32 text-[11px]"
              />
              bis
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPreset(null);
                  setShown(PAGE);
                }}
                className="h-7 w-32 text-[11px]"
              />
            </span>
            <span className="ml-auto flex rounded-full border p-0.5">
              {sorts.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSort(s.id)}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[11px]",
                    sort === s.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </span>
          </div>
        </div>

        {/* Mobile: stacked list. */}
        {!isDesktop && (
          <div className="px-4 pb-3">
            {groups ? (
              groups.map((g) => (
                <div key={g.date}>
                  <div className="flex items-baseline justify-between pt-3 pb-1 text-[11px]">
                    <span className="text-muted-foreground">
                      {dayLabel(g.date, currentYear)}
                    </span>
                    {g.rows.length > 1 && (
                      <span className={amountCls(g.net)}>{chfSigned(g.net)}</span>
                    )}
                  </div>
                  <ul className="grid divide-y divide-border/40 border-t border-border/40">
                    {g.rows.map((r) => (
                      <li key={r.index}>
                        <button
                          className="flex w-full items-center justify-between gap-3 py-2 text-left"
                          onClick={() =>
                            setEditing(editing === r.index ? null : r.index)
                          }
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs" title={rowTitle(r.t)}>
                              {r.t.payee}
                            </div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {showAccount
                                ? (ACCOUNT_LABELS[r.t.account] ?? r.t.account)
                                : null}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span className={cn(amountCls(r.t.amount), "text-xs")}>
                              {chfSigned(r.t.amount)}
                            </span>
                            <Badge variant="secondary" className="text-[9px]">
                              {r.t.category}
                            </Badge>
                          </div>
                        </button>
                        {editing === r.index && editorFor(r)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <ul className="grid divide-y divide-border/40">
                {visible.map((r) => (
                  <li key={r.index}>
                    <button
                      className="flex w-full items-center justify-between gap-3 py-2 text-left"
                      onClick={() => setEditing(editing === r.index ? null : r.index)}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs" title={rowTitle(r.t)}>
                          {r.t.payee}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {dateShort(r.t.date)}
                          {showAccount &&
                            ` · ${ACCOUNT_LABELS[r.t.account] ?? r.t.account}`}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className={cn(amountCls(r.t.amount), "text-xs")}>
                          {chfSigned(r.t.amount)}
                        </span>
                        <Badge variant="secondary" className="text-[9px]">
                          {r.t.category}
                        </Badge>
                      </div>
                    </button>
                    {editing === r.index && editorFor(r)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Desktop: day-grouped table (flat list when sorting by Betrag). */}
        {isDesktop && (
          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  {sort === "betrag" && <TableHead className="pl-4">Datum</TableHead>}
                  <TableHead className={sort === "betrag" ? "" : "pl-4"}>
                    Empfänger
                  </TableHead>
                  <TableHead className="hidden md:table-cell">Text</TableHead>
                  {showAccount && <TableHead>Konto</TableHead>}
                  <TableHead>Kategorie</TableHead>
                  <TableHead className="pr-4 text-right">Betrag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups ? (
                  groups.map((g) => (
                    <Fragment key={g.date}>
                      <TableRow className="hover:bg-transparent">
                        <TableCell className="pt-4 pb-1 pl-4 text-[11px] text-muted-foreground">
                          {dayLabel(g.date, currentYear)}
                        </TableCell>
                        <TableCell colSpan={showAccount ? 3 : 2} />
                        <TableCell
                          className={cn(
                            amountCls(g.net),
                            "pr-4 text-right text-[11px]"
                          )}
                        >
                          {g.rows.length > 1 ? chfSigned(g.net) : null}
                        </TableCell>
                      </TableRow>
                      {g.rows.map((r) => (
                        <Fragment key={r.index}>
                          <TableRow>
                            <TableCell
                              className="max-w-52 truncate pl-4 text-xs"
                              title={rowTitle(r.t)}
                            >
                              {r.t.payee}
                            </TableCell>
                            <TableCell
                              className="hidden max-w-64 truncate text-xs text-muted-foreground md:table-cell"
                              title={r.t.text}
                            >
                              {r.t.text}
                            </TableCell>
                            {showAccount && (
                              <TableCell className="text-[10px] text-muted-foreground">
                                {ACCOUNT_LABELS[r.t.account] ?? r.t.account}
                              </TableCell>
                            )}
                            <TableCell>
                              <button
                                onClick={() =>
                                  setEditing(editing === r.index ? null : r.index)
                                }
                                title="Kategorie bearbeiten"
                              >
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] hover:bg-muted-foreground/20"
                                >
                                  {r.t.category}
                                </Badge>
                              </button>
                            </TableCell>
                            <TableCell
                              className={cn(
                                amountCls(r.t.amount),
                                "pr-4 text-right text-xs whitespace-nowrap"
                              )}
                            >
                              {chfSigned(r.t.amount)}
                            </TableCell>
                          </TableRow>
                          {editing === r.index && (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={showAccount ? 5 : 4} className="py-2 pl-4">
                                {editorFor(r)}
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      ))}
                    </Fragment>
                  ))
                ) : (
                  visible.map((r) => (
                    <Fragment key={r.index}>
                      <TableRow>
                        <TableCell className="pl-4 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                          {dateShort(r.t.date)}
                        </TableCell>
                        <TableCell
                          className="max-w-52 truncate text-xs"
                          title={rowTitle(r.t)}
                        >
                          {r.t.payee}
                        </TableCell>
                        <TableCell
                          className="hidden max-w-64 truncate text-xs text-muted-foreground md:table-cell"
                          title={r.t.text}
                        >
                          {r.t.text}
                        </TableCell>
                        {showAccount && (
                          <TableCell className="text-[10px] text-muted-foreground">
                            {ACCOUNT_LABELS[r.t.account] ?? r.t.account}
                          </TableCell>
                        )}
                        <TableCell>
                          <button
                            onClick={() =>
                              setEditing(editing === r.index ? null : r.index)
                            }
                            title="Kategorie bearbeiten"
                          >
                            <Badge
                              variant="secondary"
                              className="text-[10px] hover:bg-muted-foreground/20"
                            >
                              {r.t.category}
                            </Badge>
                          </button>
                        </TableCell>
                        <TableCell
                          className={cn(
                            amountCls(r.t.amount),
                            "pr-4 text-right text-xs whitespace-nowrap"
                          )}
                        >
                          {chfSigned(r.t.amount)}
                        </TableCell>
                      </TableRow>
                      {editing === r.index && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={showAccount ? 6 : 5} className="py-2 pl-4">
                            {editorFor(r)}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {rows.length > shown && <div ref={sentinelRef} aria-hidden />}

        {rows.length > shown && (
          <div className="flex justify-center px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() =>
                startTransition(() => setShown((n) => n + PAGE))
              }
            >
              Mehr anzeigen ({rows.length - shown} weitere)
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Inline editor: category select + optional "save as rule" pattern. */
function CategoryEditor({
  row,
  options,
  onDone,
  onCancel,
}: {
  row: Row;
  options: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState(row.t.category);
  const [saveRule, setSaveRule] = useState(row.t.category === "Unkategorisiert");
  const [pattern, setPattern] = useState(row.t.payee);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/transactions/category", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          index: row.index,
          date: row.t.date,
          account: row.t.account,
          amount: row.t.amount,
          payee: row.t.payee,
          text: row.t.text,
          category,
          createRule: saveRule && pattern ? { pattern } : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `Fehler ${res.status}`);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2 rounded-md border border-border/60 bg-muted/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={category} onValueChange={(v) => v && setCategory(v)}>
          <SelectTrigger className="h-7 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={saveRule}
            onChange={(e) => setSaveRule(e.target.checked)}
            className="size-3"
          />
          Als Regel speichern
        </label>
        <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={submit}>
          Speichern
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>
          Abbrechen
        </Button>
      </div>
      {saveRule && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Muster:</span>
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="h-7 w-64 text-xs"
          />
          <span className="text-[10px]">
            (gilt für weitere unkategorisierte Buchungen dieses Kontos)
          </span>
        </div>
      )}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
