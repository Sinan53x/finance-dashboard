import { XMLParser } from "fast-xml-parser";
import { flexErrorFromCode, FlexError } from "./errors";
import type { IbkrSnapshot } from "./types";

/*
 * Parser for IBKR Activity Flex Query XML (Flex Web Service v3).
 *
 * Element / attribute names (IBKR Reporting Reference → Activity Flex Query Reference):
 *   FlexQueryResponse > FlexStatements > FlexStatement[accountId, fromDate, toDate, whenGenerated]
 *     AccountInformation[accountId, currency]                                  (currency = base)
 *     EquitySummaryInBase > EquitySummaryByReportDateInBase[reportDate, cash, total, currency]
 *     OpenPositions > OpenPosition[symbol, description, isin, currency, fxRateToBase, position,
 *       markPrice, positionValue, costBasisMoney, fifoPnlUnrealized, multiplier, levelOfDetail, conid]
 *     CashTransactions > CashTransaction[type, currency, fxRateToBase, amount, dateTime,
 *       reportDate, settleDate, symbol, levelOfDetail]
 *     Trades > Trade[tradeDate, dateTime, symbol, assetCategory, quantity, tradePrice, currency,
 *       ibCommission, netCash, proceeds, taxes, fxRateToBase, levelOfDetail]
 *     CashReport > CashReportCurrency[currency="BASE_SUMMARY", endingCash]          (cash fallback)
 * Error/status envelope: FlexStatementResponse > Status, ErrorCode, ErrorMessage, ReferenceCode, Url
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- walking untyped parsed XML */
type Node = any;

const ARRAY_TAGS = new Set([
  "FlexStatement",
  "EquitySummaryByReportDateInBase",
  "OpenPosition",
  "CashTransaction",
  "Trade",
  "CashReportCurrency",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const asArray = (value: Node): Node[] =>
  value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value];

const attr = (node: Node, name: string): string | undefined => {
  const value = node?.[`@_${name}`];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
};

/** IBKR numbers may contain thousands separators ("1,234.56"). Empty → undefined. */
export function parseFlexNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[,'\s]/g, "");
  if (cleaned === "" || cleaned === "--") return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

const num = (node: Node, name: string) => parseFlexNumber(attr(node, name));

/** Round to cents, avoiding binary artefacts and negative zero. */
export function round2(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-9) / 100;
  return rounded === 0 ? 0 : rounded;
}

const clean = (value: number) => (value === 0 ? 0 : value);

/**
 * Normalise a Flex date / date-time to `YYYY-MM-DD`.
 * Supports `yyyyMMdd`, `yyyy-MM-dd`, optionally followed by a time after `;`, `,`, space or `T`
 * (e.g. `20260925;143000`, `2026-09-25, 14:30:00`).
 */
export function normalizeFlexDate(value: string): string {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|[;,\sT])/.exec(value.trim());
  if (match) {
    const [, y, m, d] = match;
    const month = Number(m);
    const day = Number(d);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${y}-${m}-${d}`;
  }
  throw new FlexError(
    `Unbekanntes Datumsformat "${value}" – in der Flex Query unter General Configuration "Date Format" auf yyyyMMdd stellen.`,
  );
}

const dateAttr = (node: Node, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = attr(node, name);
    if (value) return normalizeFlexDate(value);
  }
  return undefined;
};

/** Find a child element case-insensitively (IBKR documents both `<Url>` and `<url>`). */
function child(node: Node, name: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const key = Object.keys(node).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) return undefined;
  const value = node[key];
  const text = typeof value === "object" && value !== null ? value["#text"] : value;
  return text === undefined || text === null ? undefined : String(text).trim();
}

export type FlexStatementResponse = {
  status: string;
  referenceCode?: string;
  url?: string;
  errorCode?: number;
  errorMessage?: string;
};

/** Parse the `<FlexStatementResponse>` status envelope, or `null` if the XML is something else. */
export function parseFlexStatementResponse(xml: string): FlexStatementResponse | null {
  let doc: Node;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const root = doc?.FlexStatementResponse;
  if (root === undefined) return null;
  const errorCode = child(root, "ErrorCode");
  return {
    status: child(root, "Status") ?? "",
    referenceCode: child(root, "ReferenceCode"),
    url: child(root, "Url"),
    errorCode: errorCode !== undefined && /^\d+$/.test(errorCode) ? Number(errorCode) : undefined,
    errorMessage: child(root, "ErrorMessage"),
  };
}

type Position = IbkrSnapshot["positions"][number];

function fxOf(node: Node, currency: string, baseCurrency: string, section: string): number {
  const fx = num(node, "fxRateToBase");
  if (fx !== undefined) return fx;
  if (currency === baseCurrency) return 1;
  throw new FlexError(
    `Feld "FX Rate to Base" (fxRateToBase) fehlt im Abschnitt ${section} für ${currency} – in der Flex Query aktivieren.`,
  );
}

function parseNav(rows: Node[], baseCurrency: string) {
  // One row per report date; prefer rows in base currency (or without currency attribute).
  const byDate = new Map<string, { nav: number; cash?: number; rank: number }>();
  for (const row of rows) {
    const reportDate = attr(row, "reportDate");
    const total = num(row, "total");
    if (!reportDate || total === undefined) continue;
    const date = normalizeFlexDate(reportDate);
    const currency = attr(row, "currency");
    const rank = currency === undefined || currency === baseCurrency ? 2 : currency === "BASE_SUMMARY" ? 1 : 0;
    const existing = byDate.get(date);
    if (existing && existing.rank > rank) continue;
    byDate.set(date, { nav: round2(total), cash: num(row, "cash"), rank });
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { nav, cash }]) => ({ date, nav, cash }));
}

function parsePositions(rows: Node[], baseCurrency: string): Position[] {
  // Open Positions can be delivered at SUMMARY and/or LOT level; prefer SUMMARY, else aggregate lots.
  const hasSummary = rows.some((r) => attr(r, "levelOfDetail")?.toUpperCase() === "SUMMARY");
  const selected = hasSummary ? rows.filter((r) => attr(r, "levelOfDetail")?.toUpperCase() === "SUMMARY") : rows;

  type Acc = {
    symbol: string;
    isin?: string;
    description: string;
    currency: string;
    fx: number;
    quantity: number;
    markPrice: number;
    marketValue: number;
    costBasis?: number;
    unrealized?: number;
  };
  const byKey = new Map<string, Acc>();
  for (const row of selected) {
    const symbol = attr(row, "symbol") ?? attr(row, "conid") ?? "?";
    const currency = attr(row, "currency") ?? baseCurrency;
    const fx = fxOf(row, currency, baseCurrency, "Open Positions");
    const quantity = num(row, "position") ?? 0;
    const markPrice = num(row, "markPrice") ?? 0;
    const multiplier = num(row, "multiplier") ?? 1;
    const marketValue = num(row, "positionValue") ?? quantity * markPrice * multiplier;
    const costBasis = num(row, "costBasisMoney");
    const unrealized = num(row, "fifoPnlUnrealized");
    const key = `${attr(row, "conid") ?? symbol}|${currency}`;
    const acc = byKey.get(key);
    if (!acc) {
      byKey.set(key, {
        symbol,
        isin: attr(row, "isin"),
        description: attr(row, "description") ?? symbol,
        currency,
        fx,
        quantity,
        markPrice,
        marketValue,
        costBasis,
        unrealized,
      });
    } else {
      acc.quantity += quantity;
      acc.marketValue += marketValue;
      acc.costBasis = costBasis === undefined ? acc.costBasis : (acc.costBasis ?? 0) + costBasis;
      acc.unrealized = unrealized === undefined ? acc.unrealized : (acc.unrealized ?? 0) + unrealized;
    }
  }

  return [...byKey.values()]
    .filter((p) => p.quantity !== 0)
    .map((p) => {
      const marketValueBase = round2(p.marketValue * p.fx);
      const costBasisBase = p.costBasis === undefined ? undefined : round2(p.costBasis * p.fx);
      const unrealizedPnlBase =
        p.unrealized !== undefined
          ? round2(p.unrealized * p.fx)
          : costBasisBase !== undefined
            ? round2(marketValueBase - costBasisBase)
            : undefined;
      const position: Position = {
        symbol: p.symbol,
        ...(p.isin ? { isin: p.isin } : {}),
        description: p.description,
        quantity: p.quantity,
        currency: p.currency,
        markPrice: p.markPrice,
        marketValue: round2(p.marketValue),
        marketValueBase,
        ...(costBasisBase !== undefined ? { costBasisBase } : {}),
        ...(unrealizedPnlBase !== undefined ? { unrealizedPnlBase } : {}),
      };
      return position;
    })
    .sort((a, b) => b.marketValueBase - a.marketValueBase);
}

const DEPOSIT_TYPES = new Set(["deposits/withdrawals", "deposits & withdrawals"]);
const DIVIDEND_TYPES = new Set(["dividends", "payment in lieu of dividends"]);
const WITHHOLDING_TYPES = new Set(["withholding tax"]);

function parseCashTransactions(rows: Node[], baseCurrency: string) {
  // Avoid double counting when both DETAIL and SUMMARY rows are delivered.
  const hasDetail = rows.some((r) => attr(r, "levelOfDetail")?.toUpperCase() === "DETAIL");
  const selected = hasDetail ? rows.filter((r) => attr(r, "levelOfDetail")?.toUpperCase() !== "SUMMARY") : rows;

  const deposits: IbkrSnapshot["deposits"] = [];
  const dividends = new Map<string, { date: string; symbol: string; amount: number; withholdingTax: number }>();

  for (const row of selected) {
    const type = attr(row, "type")?.toLowerCase();
    if (!type) continue;
    const isDeposit = DEPOSIT_TYPES.has(type);
    const isDividend = DIVIDEND_TYPES.has(type);
    const isWithholding = WITHHOLDING_TYPES.has(type);
    if (!isDeposit && !isDividend && !isWithholding) continue;

    const amount = num(row, "amount");
    const date = dateAttr(row, "dateTime", "reportDate", "settleDate");
    if (amount === undefined || !date) continue;
    const currency = attr(row, "currency") ?? baseCurrency;
    const amountBase = amount * fxOf(row, currency, baseCurrency, "Cash Transactions");

    if (isDeposit) {
      deposits.push({ date, amount: round2(amountBase) });
      continue;
    }
    const symbol = attr(row, "symbol") ?? attr(row, "underlyingSymbol") ?? "";
    const key = `${date}|${symbol}`;
    const entry = dividends.get(key) ?? { date, symbol, amount: 0, withholdingTax: 0 };
    if (isDividend) entry.amount += amountBase;
    else entry.withholdingTax -= amountBase; // IBKR books withholding as a negative amount
    dividends.set(key, entry);
  }

  deposits.sort((a, b) => a.date.localeCompare(b.date));
  return {
    deposits,
    dividends: [...dividends.values()]
      .map((d) => ({ ...d, amount: round2(d.amount), withholdingTax: round2(d.withholdingTax) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol)),
  };
}

function parseTrades(rows: Node[], baseCurrency: string): IbkrSnapshot["trades"] {
  const trades: IbkrSnapshot["trades"] = [];
  for (const row of rows) {
    const level = attr(row, "levelOfDetail")?.toUpperCase();
    if (level && level !== "EXECUTION") continue;
    // FX conversions (e.g. USD.CHF) are reported as trades with assetCategory CASH; not securities trades.
    if (attr(row, "assetCategory")?.toUpperCase() === "CASH") continue;
    const date = dateAttr(row, "tradeDate", "dateTime", "reportDate");
    const quantity = num(row, "quantity");
    if (!date || quantity === undefined) continue;
    const currency = attr(row, "currency") ?? baseCurrency;
    const fx = fxOf(row, currency, baseCurrency, "Trades");
    const price = num(row, "tradePrice") ?? 0;
    const ibCommission = num(row, "ibCommission") ?? 0;
    const multiplier = num(row, "multiplier") ?? 1;
    const netCash =
      num(row, "netCash") ??
      (num(row, "proceeds") ?? -quantity * price * multiplier) + ibCommission + (num(row, "taxes") ?? 0);
    trades.push({
      date,
      symbol: attr(row, "symbol") ?? "?",
      quantity,
      price,
      currency,
      commission: clean(-ibCommission),
      amountBase: round2(netCash * fx),
    });
  }
  return trades.sort((a, b) => a.date.localeCompare(b.date));
}

function selectStatement(statements: Node[]): Node {
  const accounts = [...new Set(statements.map((s) => attr(s, "accountId") ?? attr(s.AccountInformation, "accountId")))];
  if (accounts.length > 1) {
    throw new FlexError(
      `Flex-Report enthält mehrere Konten (${accounts.join(", ")}) – die Flex Query auf ein einzelnes Konto beschränken.`,
    );
  }
  // Same account in several statements: use the most recent one.
  return statements.reduce((best, s) => ((attr(s, "toDate") ?? "") >= (attr(best, "toDate") ?? "") ? s : best));
}

export type ParseOptions = { now?: Date };

/** Parse an Activity Flex Query XML report into an `IbkrSnapshot`. Throws `FlexError` on error envelopes. */
export function parseFlexXml(xml: string, options: ParseOptions = {}): IbkrSnapshot {
  let doc: Node;
  try {
    doc = parser.parse(xml);
  } catch (error) {
    throw new FlexError(`Flex-XML ist ungültig: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (doc?.FlexStatementResponse !== undefined) {
    const response = parseFlexStatementResponse(xml);
    throw flexErrorFromCode(response?.errorCode, response?.errorMessage);
  }
  const root = doc?.FlexQueryResponse;
  if (root === undefined) {
    throw new FlexError("Keine Flex-XML: Element <FlexQueryResponse> fehlt (Format der Flex Query muss XML sein).");
  }
  const statements = asArray(root.FlexStatements?.FlexStatement);
  if (statements.length === 0) throw new FlexError("Flex-Report enthält kein <FlexStatement>.");
  const statement = selectStatement(statements);

  const info = statement.AccountInformation;
  const navRows = asArray(statement.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
  const baseCurrency =
    attr(info, "currency") ??
    navRows.map((r) => attr(r, "currency")).find((c) => c !== undefined && c !== "BASE_SUMMARY");
  if (!baseCurrency) {
    throw new FlexError(
      'Basiswährung unbekannt – in der Flex Query den Abschnitt "Account Information" (Feld Currency) aktivieren.',
    );
  }
  const accountId = attr(statement, "accountId") ?? attr(info, "accountId");
  if (!accountId) throw new FlexError("Konto-ID fehlt im Flex-Report.");

  const nav = parseNav(navRows, baseCurrency);
  const positions = parsePositions(asArray(statement.OpenPositions?.OpenPosition), baseCurrency);
  const { deposits, dividends } = parseCashTransactions(asArray(statement.CashTransactions?.CashTransaction), baseCurrency);
  const trades = parseTrades(asArray(statement.Trades?.Trade), baseCurrency);

  const last = nav.at(-1);
  const positionsValue = positions.reduce((sum, p) => sum + p.marketValueBase, 0);
  const baseSummary = asArray(statement.CashReport?.CashReportCurrency).find((r) => attr(r, "currency") === "BASE_SUMMARY");
  const cash = round2(last?.cash ?? num(baseSummary, "endingCash") ?? 0);
  const netLiquidation = last ? last.nav : round2(positionsValue + cash);
  const unrealizedPnl = round2(positions.reduce((sum, p) => sum + (p.unrealizedPnlBase ?? 0), 0));
  const positionDates = asArray(statement.OpenPositions?.OpenPosition)
    .map((r) => dateAttr(r, "reportDate"))
    .filter((d): d is string => !!d)
    .sort();
  const now = options.now ?? new Date();
  const asOf = last?.date ?? dateAttr(statement, "toDate") ?? positionDates.at(-1) ?? now.toISOString().slice(0, 10);

  return {
    source: "flex",
    fetchedAt: now.toISOString(),
    asOf,
    accountId,
    baseCurrency,
    netLiquidation,
    cash,
    unrealizedPnl,
    positions,
    navHistory: nav.map(({ date, nav }) => ({ date, nav })),
    deposits,
    dividends,
    trades,
  };
}
