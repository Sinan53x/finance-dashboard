"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DitherButton } from "@/components/dither-kit";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { chfSigned, dateShort } from "@/lib/finance/format";
import type { Transaction } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

type Preview = {
  format: string;
  parsed: number;
  added: number;
  skipped: number;
  written: boolean;
  rows: Transaction[];
  uncategorized: Transaction[];
  warnings: string[];
};

/** Guess the account from the filename: an IBAN, or a name fragment. */
function guessAccount(name: string, accounts: { id: string; name: string; iban?: string; type?: string }[]): string {
  const norm = name.replace(/\s/g, "").toUpperCase();
  const byIban = accounts.find((a) => a.iban && norm.includes(a.iban.replace(/\s/g, "").toUpperCase()));
  if (byIban) return byIban.id;
  const lower = name.toLowerCase();
  const byName = accounts.find((a) =>
    a.name.toLowerCase().split(/\s+/).some((w) => w.length > 4 && lower.includes(w))
  );
  return byName?.id ?? "privat";
}

export function ImportCard({
  accounts,
}: {
  accounts: { id: string; name: string; iban?: string; type?: string }[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const zkb = accounts.filter((a) => a.type !== "brokerage");
  const [file, setFile] = useState<File | null>(null);
  const [account, setAccount] = useState("privat");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  async function send(f: File, mode: "preview" | "commit", acc: string) {
    const form = new FormData();
    form.set("file", f);
    form.set("account", acc);
    const res = await fetch(`/api/import?mode=${mode}`, {
      method: "POST",
      body: form,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as Preview;
  }

  async function onFile(f: File | null) {
    if (!f) return;
    const acc = guessAccount(f.name, accounts);
    setFile(f);
    setAccount(acc);
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      setPreview(await send(f, "preview", acc));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rePreview(acc: string) {
    setAccount(acc);
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await send(file, "preview", acc));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await send(file, "commit", account);
      setFile(null);
      setPreview(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="grid gap-3 px-4">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            onFile(e.dataTransfer.files[0] ?? null);
          }}
          className={cn(
            "flex h-24 w-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground transition-colors",
            drag ? "border-foreground/60 bg-muted/40" : "border-border"
          )}
        >
          {busy
            ? "Analysiere…"
            : file
              ? file.name
              : "Kontoauszug hierhin ziehen oder wählen (.xml / .csv)"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".xml,.csv"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />

        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Konto</span>
          <Select value={account} onValueChange={(v) => v && rePreview(v)}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue>
                {(v) => zkb.find((a) => a.id === v)?.name ?? "Konto"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {zkb.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {file?.name.toLowerCase().endsWith(".csv") && (
            <span className="text-[10px] text-muted-foreground">
              (CSV hat keine IBAN — Konto wählen)
            </span>
          )}
          {preview && preview.rows[0] && (
            <span className="text-[10px] text-muted-foreground">
              → erkannt: {zkb.find((a) => a.id === preview.rows[0].account)?.name ?? preview.rows[0].account}
            </span>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        {preview && (
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">
              {preview.format}: {preview.parsed} gelesen, {preview.added} neu,{" "}
              {preview.skipped} bereits vorhanden.
              {preview.warnings.map((w, i) => (
                <span key={i} className="block text-amber-400">
                  {w}
                </span>
              ))}
            </p>
            {preview.rows.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-md border">
                <ul className="grid divide-y text-xs">
                  {preview.rows.map((t, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2 px-3 py-1.5"
                    >
                      <span className="min-w-0 truncate">
                        <span className="mr-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {dateShort(t.date)}
                        </span>
                        {t.payee}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="text-[9px]">
                          {t.account}
                        </Badge>
                        <Badge
                          variant={
                            t.category === "Unkategorisiert"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-[9px]"
                        >
                          {t.category}
                        </Badge>
                        <span
                          className={cn(
                            "font-mono tabular-nums",
                            t.amount >= 0 ? "text-emerald-400" : "text-red-400"
                          )}
                        >
                          {chfSigned(t.amount)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.uncategorized.length > 0 && (
              <p className="text-xs text-amber-400">
                {preview.uncategorized.length} Buchung(en) unkategorisiert —
                Regeln in rules.json ergänzen.
              </p>
            )}
            <div className="flex gap-2">
              <DitherButton
                color="green"
                onClick={commit}
                disabled={busy || preview.added === 0}
              >
                Übernehmen ({preview.added})
              </DitherButton>
              <DitherButton
                color="grey"
                variant="dotted"
                onClick={() => {
                  setFile(null);
                  setPreview(null);
                }}
              >
                Verwerfen
              </DitherButton>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
