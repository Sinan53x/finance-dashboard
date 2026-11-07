import { XMLParser } from "fast-xml-parser";
import { parseAmountToCents } from "./csv";
import { addressFreeName, cleanText, payeeFromBookingText } from "./text";
import type { ParsedTransaction, ParseResult } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- walking untyped parsed XML */
type Node = any;

const ARRAY_TAGS = new Set(["Stmt", "Ntry", "NtryDtls", "TxDtls", "Ustrd", "AddtlTxInf", "AddtlNtryInf"]);

const parser = new XMLParser({
  // Namespace-agnostic: camt.053.001.04 … .08 differ only in namespace and a few paths handled below.
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const asArray = (value: Node): Node[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

/** Text content of an element that may carry attributes (e.g. `<Amt Ccy="CHF">12.30</Amt>`). */
function textOf(node: Node): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && "#text" in node) return String(node["#text"]);
  return undefined;
}

function joinText(nodes: Node): string | undefined {
  const parts = asArray(nodes).map(textOf).filter((s): s is string => !!s && s.trim() !== "");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function dateOf(node: Node): string | undefined {
  const value = textOf(node?.Dt) ?? textOf(node?.DtTm);
  return value?.slice(0, 10);
}

function amountCents(node: Node): number | undefined {
  const raw = textOf(node);
  return raw === undefined ? undefined : (parseAmountToCents(raw) ?? undefined);
}

function currencyOf(node: Node): string | undefined {
  return typeof node === "object" && node !== null ? node["@_Ccy"] : undefined;
}

/** Party name for .04–.07 (`Cdtr/Nm`) and .08 (`Cdtr/Pty/Nm`). */
function partyName(party: Node): string | undefined {
  return textOf(party?.Nm) ?? textOf(party?.Pty?.Nm);
}

function counterparty(tx: Node, isDebit: boolean): { name?: string; iban?: string } {
  const parties = tx?.RltdPties;
  const side = isDebit ? "Cdtr" : "Dbtr";
  const ultimate = isDebit ? "UltmtCdtr" : "UltmtDbtr";
  return {
    name: partyName(parties?.[side]) ?? partyName(parties?.[ultimate]),
    iban: textOf(parties?.[`${side}Acct`]?.Id?.IBAN),
  };
}

function isBooked(entry: Node): boolean {
  const status = textOf(entry.Sts) ?? textOf(entry.Sts?.Cd);
  return status === undefined || status === "BOOK";
}

function accountId(stmt: Node): string {
  const id = stmt?.Acct?.Id;
  return (textOf(id?.IBAN) ?? textOf(id?.Othr?.Id) ?? "unknown").replace(/\s/g, "").toUpperCase();
}

export interface CamtOptions {
  /** Only import statements for this account IBAN. Required when the file contains several accounts. */
  account?: string;
  /** Permit files containing several accounts; each row then carries its statement's `accountIban`. */
  allowMulti?: boolean;
}

export function isCamt053(content: string): boolean {
  return /<([\w-]+:)?BkToCstmrStmt[\s>]/.test(content);
}

export function parseCamt053(xml: string, options: CamtOptions = {}): ParseResult {
  const doc = parser.parse(xml);
  const root = doc?.Document?.BkToCstmrStmt;
  if (!root) throw new Error("camt.053: no Document/BkToCstmrStmt element found");

  const warnings: string[] = [];
  let statements: Node[] = asArray(root.Stmt);
  const accounts = [...new Set(statements.map(accountId))];
  if (options.account) {
    const wanted = options.account.replace(/\s/g, "").toUpperCase();
    statements = statements.filter((s) => accountId(s) === wanted);
    if (statements.length === 0) throw new Error(`camt.053: no statement for account ${wanted} (found ${accounts.join(", ")})`);
  } else if (accounts.length > 1 && !options.allowMulti) {
    throw new Error(`camt.053: file contains several accounts (${accounts.join(", ")}); pass --account <IBAN>`);
  }

  const transactions: ParsedTransaction[] = [];
  for (const stmt of statements) {
    for (const entry of asArray(stmt.Ntry)) {
      const date = dateOf(entry.BookgDt);
      const entryCents = amountCents(entry.Amt);
      const indicator = textOf(entry.CdtDbtInd);
      const where = `Ntry ${textOf(entry.NtryRef) ?? textOf(entry.AcctSvcrRef) ?? date}`;
      if (!isBooked(entry)) {
        warnings.push(`${where}: skipped non-booked entry`);
        continue;
      }
      if (!date || entryCents === undefined || (indicator !== "DBIT" && indicator !== "CRDT")) {
        warnings.push(`${where}: skipped, missing date, amount or CdtDbtInd`);
        continue;
      }
      const currency = currencyOf(entry.Amt);
      if (currency && currency !== "CHF") warnings.push(`${where}: amount in ${currency}, imported as CHF`);

      const isDebit = indicator === "DBIT";
      const valuta = dateOf(entry.ValDt) ?? date;
      const entryInfo = joinText(entry.AddtlNtryInf);
      const txs: Node[] = asArray(entry.NtryDtls).flatMap((d: Node) => asArray(d.TxDtls));
      const signed = (cents: number) => (isDebit ? -cents : cents) / 100;

      const rowFor = (tx: Node | undefined, cents: number, batch: boolean): ParsedTransaction => {
        const stmtIban = accountId(stmt);
        const party = counterparty(tx, isDebit);
        const txInfo = joinText(tx?.AddtlTxInf) ?? joinText(tx?.RmtInf?.Ustrd);
        // Batch children share the entry's AddtlNtryInf ("Belastungen Mobile Banking (3)"), so prefer their own text.
        const rawText = (batch ? (txInfo ?? entryInfo) : (entryInfo ?? txInfo)) ?? party.name ?? "";
        const text = cleanText(rawText);
        const payee = party.name ? addressFreeName(cleanText(party.name)) : payeeFromBookingText(rawText);
        return {
          date,
          valuta,
          payee,
          text,
          amount: signed(cents),
          accountIban: stmtIban,
          ...(party.iban ? { iban: party.iban.replace(/\s/g, "").toUpperCase() } : {}),
        };
      };

      if (txs.length <= 1) {
        transactions.push(rowFor(txs[0], entryCents, false));
        continue;
      }

      const parts = txs.map((tx) => amountCents(tx.AmtDtls?.TxAmt?.Amt) ?? amountCents(tx.Amt));
      const total = parts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
      if (parts.some((c) => c === undefined) || total !== entryCents) {
        warnings.push(`${where}: batch of ${txs.length} not split (detail amounts ${total / 100} ≠ ${entryCents / 100})`);
        transactions.push(rowFor(undefined, entryCents, false));
        continue;
      }
      txs.forEach((tx, i) => transactions.push(rowFor(tx, parts[i] ?? 0, true)));
    }
  }
  return { transactions, warnings };
}
