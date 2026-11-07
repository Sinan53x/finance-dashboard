#!/usr/bin/env bun
/**
 * Generates the fictional datasets shipped with the repo:
 *
 *   data/demo/            full ~12-month dataset for `bun run demo`
 *   data/test-fixtures/   small frozen snapshot the test-suite asserts against
 *
 * Everything is invented: person "Alex Muster", fake IBANs (CH00 0000 …),
 * IBKR account U00000000, generic merchants. No values are derived from
 * data/private/. Deterministic (seeded RNG) — re-running produces the same
 * files. Run: `bun scripts/generate-demo.ts`
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeTransactionsCsv } from "../lib/import/csv";
import { categorize, validateRules, type Rule } from "../lib/import/rules";
import type { Transaction } from "../lib/import/types";
import type { IbkrSnapshot } from "../lib/ibkr/types";

const root = join(import.meta.dir, "..");
const round2 = (n: number) => Math.round(n * 100) / 100;

/** mulberry32 — small deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAKE_IBANS = {
  // Matches the committed camt fixture's statement IBAN, so
  // `bun run import lib/import/fixtures/camt053-v08.xml --dry-run` works on demo data.
  privat: "CH00 0070 0000 0000 0000 1",
  notgroschen: "CH00 0070 0000 0000 0000 2",
  steuern: "CH00 0070 0000 0000 0000 3",
};

const EMPLOYER = "Muster AG";
const SELF = "Alex Muster";

const MONTH_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
const plusDays = (isoDate: string, n: number) => {
  const d = day(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

class TxBuilder {
  rows: Transaction[] = [];
  add(
    date: string,
    account: string,
    payee: string,
    text: string,
    amount: number,
    category: string,
    valuta = date,
  ) {
    this.rows.push({ date, valuta, account, payee, text, amount: round2(amount), category });
  }
  sorted(): Transaction[] {
    return [...this.rows].sort((a, b) => a.date.localeCompare(b.date));
  }
  sum(account: string) {
    return round2(
      this.rows.filter((t) => t.account === account).reduce((s, t) => s + t.amount, 0),
    );
  }
}

/** Fails loudly unless the ruleset reproduces every stored category. */
function checkRules(rules: Rule[], txs: Transaction[], label: string) {
  const mismatches = txs
    .map((t) => ({ t, got: categorize(rules, t) }))
    .filter(({ t, got }) => got !== t.category);
  if (mismatches.length > 0) {
    for (const { t, got } of mismatches) {
      console.error(`${label}: ${t.date} ${t.payee} ${t.amount} → ${got}, want ${t.category}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Shared ruleset (demo + fixtures). First match wins — keep income/credit and
// account-scoped rules above the generic merchant rules.
// ---------------------------------------------------------------------------
function baseRules(): Rule[] {
  return [
    // Own-account transfer by IBAN (only camt.053 imports carry counterparty IBANs).
    { category: "Notgroschen", iban: FAKE_IBANS.notgroschen },
    { category: "Steuern", iban: FAKE_IBANS.steuern },
    { category: "Zinsen", accounts: ["privat", "notgroschen", "steuern"], patterns: ["Guthabenzins"] },
    { category: "Übertrag", accounts: ["notgroschen", "steuern"], patterns: [SELF] },
    { category: "Steuern", accounts: ["steuern"], patterns: ["Steueramt"] },
    { category: "Familie", patterns: ["Laura Muster"] },
    { category: "Spesen", patterns: ["Spesen"] },
    { category: "Rückerstattungen", sign: "credit", patterns: ["Rückerstattung", "Rückzahlung", "Erstattung"] },
    { category: "Lohn", sign: "credit", patterns: ["Salär", EMPLOYER] },
    { category: "Notgroschen", accounts: ["privat"], patterns: ["Notgroschen"] },
    { category: "Steuern", accounts: ["privat"], patterns: ["Steuertopf"] },
    { category: "ETF IBKR", patterns: ["Interactive Brokers", "IBKR"] },
    { category: "Miete", patterns: ["Muster Immobilien"] },
    { category: "Krankenkasse", patterns: ["Krankenkasse Beispiel", "Visana"] },
    { category: "Internet/Handy", patterns: ["Swisscom"] },
    { category: "Technik/Abos", patterns: ["Spotify", "Netflix", "iCloud", "Galaxus", "Digitec"] },
    { category: "ÖV/Mobilität", patterns: ["SBB", "ZVV", "Halbtax", "P+Rail", "Mobility Carsharing"] },
    { category: "Essen/Alltag", patterns: ["Migros", "Coop", "Denner", "Aldi", "Lidl"] },
    { category: "Ausgehen", patterns: ["Restaurant", "Café", "Pizzeria", "Bar Orion", "Kino"] },
    { category: "Freizeit/Shopping", patterns: ["Amazon", "Orell Füssli", "Zalando", "Decathlon", "Interdiscount"] },
    { category: "Kleidung", patterns: ["H&M", "Zara", "C&A", "Dosenbach"] },
    { category: "Bargeld", patterns: ["Bancomatbezug"] },
    { category: "Gym", patterns: ["Fitnessstudio", "Boulderhalle"] },
    { category: "Gesundheit/Franchise", patterns: ["Apotheke", "Zahnarzt", "Optiker"] },
    { category: "Reisen", patterns: ["Booking", "Airbnb", "easyJet", "Hotel", "SWISS"] },
    { category: "Jahreskosten/Diverses", patterns: ["Serafe", "Die Post", "Muster Versicherung"] },
  ];
}

// ---------------------------------------------------------------------------
// data/demo — ~12 months (Nov 2025 → early Nov 2026) for Alex Muster.
// ---------------------------------------------------------------------------
const DEMO_START = "2025-11-01";
const AS_OF = "2026-11-06";
const NET_MONTHLY = 5816.4;

function buildDemoTransactions(): TxBuilder {
  const r = rng(20261107);
  const num = (a: number, b: number) => a + r() * (b - a);
  const chance = (p: number) => r() < p;
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const b = new TxBuilder();

  // --- monthly skeleton (Nov 2025 … Oct 2026) ---
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(2025, 10 + i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const isoDay = (day: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const monat = `${MONTH_DE[m]} ${y}`;

    b.add(isoDay(25), "privat", EMPLOYER, `Gutschrift Salär ${monat}`, NET_MONTHLY, "Lohn");
    b.add(isoDay(26), "privat", SELF, "Übertrag aufs Sparkonto Notgroschen", -800, "Notgroschen");
    b.add(isoDay(26), "notgroschen", SELF, "Übertrag vom Privatkonto", 800, "Übertrag");
    b.add(isoDay(26), "privat", SELF, "Übertrag aufs Sparkonto Steuertopf", -450, "Steuern");
    b.add(isoDay(26), "steuern", SELF, "Übertrag vom Privatkonto", 450, "Übertrag");
    b.add(isoDay(26), "privat", "Interactive Brokers", "Dauerauftrag ETF-Sparplan", -1000, "ETF IBKR");
    b.add(isoDay(1), "privat", "Muster Immobilien AG", `Miete ${monat}`, -1350, "Miete");
    b.add(isoDay(4), "privat", "Krankenkasse Beispiel AG", `Prämie ${monat}`, -340, "Krankenkasse");
    b.add(isoDay(6), "privat", "Swisscom", "Internet & Mobile Abo", -59.9, "Internet/Handy");
    b.add(isoDay(12), "privat", "Spotify", "Spotify Premium", -12.95, "Technik/Abos");
    b.add(isoDay(18), "privat", "Netflix", "Netflix Standard", -24.9, "Technik/Abos");
    b.add(isoDay(21), "privat", "iCloud", "iCloud+ 200 GB", -2.95, "Technik/Abos");
  }

  // --- variable day-to-day spending (seeded) ---
  const groceries = ["Migros", "Coop", "Denner", "Aldi Suisse", "Lidl"];
  const goingOut = ["Restaurant Adler", "Café Merkur", "Pizzeria Sole", "Bar Orion", "Kino Apollo"];
  const shopping = ["Amazon", "Orell Füssli", "Zalando", "Decathlon", "Interdiscount"];
  const clothes = ["H&M", "Zara", "C&A", "Dosenbach"];
  const health = ["Apotheke Vita", "Optiker Klar"];
  for (let d = DEMO_START; d <= "2026-11-04"; d = plusDays(d, 1)) {
    if (chance(0.3)) {
      b.add(d, "privat", pick(groceries), "Einkauf ZKB Visa Debit", -num(6, 68), "Essen/Alltag");
    }
    if (chance(0.07)) {
      b.add(d, "privat", pick(goingOut), "Konsumation ZKB Visa Debit", -num(14, 82), "Ausgehen");
    }
    if (chance(0.05)) {
      b.add(d, "privat", pick(shopping), "Online-Bestellung", -num(15, 155), "Freizeit/Shopping");
    }
    if (chance(0.02)) {
      b.add(d, "privat", pick(clothes), "Einkauf ZKB Visa Debit", -num(22, 118), "Kleidung");
    }
    if (chance(0.05)) {
      b.add(d, "privat", "SBB", "Billett SBB Mobile", -num(6.8, 58), "ÖV/Mobilität");
    }
    if (chance(0.015)) {
      b.add(d, "privat", pick(health), "Einkauf ZKB Visa Debit", -num(9, 48), "Gesundheit/Franchise");
    }
    if (chance(0.055)) {
      b.add(d, "privat", "ZKB Bancomat", "Bancomatbezug", -pick([100, 150, 200]), "Bargeld");
    }
    if (chance(0.008)) {
      b.add(d, "privat", "Die Post", "Paketversand", -num(8, 26), "Jahreskosten/Diverses");
    }
  }

  // --- one-offs ---
  const once = (date: string, payee: string, text: string, amount: number, cat: string, account = "privat") =>
    b.add(date, account, payee, text, amount, cat);
  once("2025-11-02", SELF, "Gutschrift Startkapital", 2500, "Übertrag", "notgroschen");
  once("2025-12-31", "Zürcher Kantonalbank", "Guthabenzins 2025", 12.4, "Zinsen", "notgroschen");
  once("2025-12-31", "Zürcher Kantonalbank", "Guthabenzins 2025", 2.15, "Zinsen", "steuern");
  once("2026-01-10", "Fitnessstudio Aktiv", "Jahresabo Fitness", -540, "Gym");
  once("2026-01-15", "SBB", "Halbtax-Abo Verlängerung", -185, "ÖV/Mobilität");
  once("2026-02-01", "Serafe AG", "Billag/Serafe Jahresrechnung", -335, "Jahreskosten/Diverses");
  once("2026-02-14", "Laura Muster", "Geschenk", -80, "Familie");
  once("2026-03-12", "Zahnarztpraxis Dr. Beispiel", "Zahnreinigung", -640, "Gesundheit/Franchise");
  once("2026-03-27", "easyJet", "Flug ZRH-LIS", -310, "Reisen");
  once("2026-04-18", "Mobility Carsharing", "Wochenendfahrt", -96.4, "ÖV/Mobilität");
  once("2026-05-08", "Krankenkasse Beispiel AG", "Rückerstattung Prämie", 95.2, "Rückerstattungen");
  once("2026-05-22", "Boulderhalle Steinbock", "10er-Abo", -290, "Gym");
  once("2026-06-30", "Laura Muster", "Anteil Ferien", 150, "Familie");
  once("2026-07-05", "Hotel Alpenblick", "Hotel Sommerferien", -780, "Reisen");
  once("2026-07-07", "Airbnb", "Unterkunft Lissabon", -240, "Reisen");
  once("2026-08-14", "Galaxus", "Rückerstattung Retoure", 38, "Rückerstattungen");
  once("2026-09-20", "Steueramt Kanton Zürich", "Steuerrechnung 2025", -2100, "Steuern", "steuern");
  once("2026-09-24", "Booking.com", "Städtetrip Oktober", -160, "Reisen");
  once("2026-10-03", "Muster Versicherung AG", "Hausratversicherung jährlich", -214.6, "Jahreskosten/Diverses");

  // --- Spesen (pass-through: out then reimbursed) ---
  for (const [d, amt] of [["2026-02-11", 68.4], ["2026-06-16", 112.75], ["2026-10-13", 54.2]] as const) {
    b.add(d, "privat", "SBB", "Spesen: SBB Geschäftsreise", -amt, "Spesen");
    b.add(plusDays(d, 9), "privat", EMPLOYER, "Spesenrückerstattung", amt, "Spesen");
  }

  // --- a few intentionally uncategorised rows (demo shows the workflow) ---
  once("2025-12-14", "Unbekannt GmbH", "Belastung eBanking", -49.9, "Unkategorisiert");
  once("2026-02-20", "Quartierverein Musterdorf", "Mitgliederbeitrag", -30, "Unkategorisiert");
  once("2026-04-30", "Unbekannt GmbH", "Belastung eBanking", -22.5, "Unkategorisiert");
  once("2026-06-19", "Verein Alpenblick", "Jahresbeitrag", -60, "Unkategorisiert");
  once("2026-08-27", "Kiosk Zentrum", "Einkauf ZKB Visa Debit", -6.2, "Unkategorisiert");
  once("2026-10-29", "Unbekannt GmbH", "Belastung eBanking", -35.75, "Unkategorisiert");

  return b;
}

function buildDemoIbkrSnapshot(): IbkrSnapshot {
  const r = rng(4177);
  const deposits: IbkrSnapshot["deposits"] = [];
  const trades: IbkrSnapshot["trades"] = [];
  const dividends: IbkrSnapshot["dividends"] = [];

  // Monthly CHF 1'000 into VT, three days after each privat transfer.
  let qty = 0;
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(2025, 10 + i, 28));
    const date = iso(d);
    deposits.push({ date, amount: 1000 });
    const price = 128 + r() * 24; // USD
    const q = Math.floor((1000 / 0.8 / price) * 10) / 10;
    qty = round2(qty + q);
    trades.push({
      date,
      symbol: "VT",
      quantity: q,
      price: round2(price),
      currency: "USD",
      commission: 0.35,
      amountBase: -round2(q * price * 0.8 + 0.35),
    });
  }
  for (const [date, gross] of [["2026-03-27", 87.4], ["2026-06-26", 96.2], ["2026-09-25", 101.5]] as const) {
    dividends.push({ date, symbol: "VT", amount: gross, withholdingTax: round2(gross * 0.3) });
  }

  // NAV every ~3 days: cumulative deposits + a wobbly ~9 %/yr growth path.
  const navHistory: IbkrSnapshot["navHistory"] = [];
  const depositedThrough = (date: string) =>
    deposits.filter((d) => d.date <= date).reduce((s, d) => s + d.amount, 0);
  const t0 = day("2025-11-28").getTime();
  for (let d = "2025-11-25"; d <= AS_OF; d = plusDays(d, 3)) {
    const dep = depositedThrough(d);
    const years = Math.max(0, (day(d).getTime() - t0) / (365.25 * 86400e3));
    const growth = dep * 0.09 * years * (1 + 0.35 * Math.sin(years * 9) * r());
    navHistory.push({ date: d, nav: round2(dep === 0 ? 0 : dep + growth + 118.6) });
  }
  const netLiq = 13240.55;
  navHistory.push({ date: AS_OF, nav: netLiq });

  return {
    source: "flex",
    fetchedAt: `${AS_OF}T21:34:00Z`,
    asOf: AS_OF,
    accountId: "U00000000",
    baseCurrency: "CHF",
    netLiquidation: netLiq,
    cash: 118.6,
    unrealizedPnl: 1121.95,
    positions: [
      {
        symbol: "VT",
        isin: "US9220427424",
        description: "Vanguard Total World Stock ETF",
        quantity: round2(qty),
        currency: "USD",
        markPrice: 149.1,
        marketValue: 16401,
        marketValueBase: 13121.95,
        costBasisBase: 12000,
        unrealizedPnlBase: 1121.95,
      },
    ],
    navHistory: navHistory.filter((h, i, a) => i === 0 || h.date !== a[i - 1].date),
    deposits,
    dividends,
    trades,
  };
}

function buildDemoFinance(b: TxBuilder, ibkr: IbkrSnapshot) {
  const privatOpening = 3200;
  const privatBalance = round2(privatOpening + b.sum("privat"));
  const ngBalance = b.sum("notgroschen");
  const steuernBalance = b.sum("steuern");

  return {
    asOf: AS_OF,
    sources: {
      zkbStatement: "Demo-Daten (erfundene Buchungen, scripts/generate-demo.ts)",
      zkbAssets: "Demo-Vermögensauszug",
      ibkr: "Demo Flex-Snapshot (erfundene Daten, Konto U00000000)",
      plan: "Demo-Investitionsplan",
      payslip: "Demo-Lohnabrechnung",
    },
    privatkontoOpeningBalance: privatOpening,
    balancesAsOf: AS_OF,
    budgetStart: "2026-01-01",
    annualPayments: [
      {
        category: "Gym",
        payee: "Fitnessstudio Aktiv",
        date: "2026-01-10",
        amount: 540,
        coversMonths: 12,
        note: "Jahresabo Fitnessstudio",
      },
      {
        category: "Jahreskosten/Diverses",
        payee: "Serafe AG",
        date: "2026-02-01",
        amount: 335,
        coversMonths: 12,
        note: "Serafe Jahresrechnung",
      },
    ],
    accounts: [
      { id: "privat", name: "Privatkonto", institution: "ZKB", iban: FAKE_IBANS.privat, type: "cash", balance: privatBalance },
      { id: "notgroschen", name: "Sparkonto Notgroschen", institution: "ZKB", iban: FAKE_IBANS.notgroschen, type: "savings", balance: ngBalance },
      { id: "steuern", name: "Sparkonto Steuern", institution: "ZKB", iban: FAKE_IBANS.steuern, type: "savings", balance: steuernBalance },
      { id: "ibkr", name: "Interactive Brokers", institution: "IBKR", type: "brokerage", balance: ibkr.netLiquidation },
    ],
    ibkr: {
      accountId: "U00000000",
      baseCurrency: "CHF",
      netLiquidationChf: ibkr.netLiquidation,
      cashChf: ibkr.cash,
      unrealizedPnlChf: ibkr.unrealizedPnl,
      realizedPnlChf: 0,
      dividendsChf: round2(ibkr.dividends.reduce((s, d) => s + d.amount - d.withholdingTax, 0)),
      deposits: ibkr.deposits.map((d) => ({ date: d.date, amountChf: d.amount })),
      positions: [
        {
          symbol: "VT",
          name: "Vanguard Total World Stock ETF",
          isin: "US9220427424",
          ter: 0.07,
          marketValueUsd: 16401,
          marketValueChf: 13121.95,
        },
      ],
      valueHistory: ibkr.navHistory.filter((_, i) => i % 10 === 0 || i === ibkr.navHistory.length - 1)
        .map((h) => ({ date: h.date, valueChf: h.nav })),
      valueHistoryNote: "NAV-Stichproben aus dem Demo-Flex-Snapshot",
    },
    income: {
      employer: EMPLOYER,
      payday: 25,
      grossMonthly: 6800,
      deductions: [
        { label: "AHV/IV/EO", rate: 0.053, amount: 360.4 },
        { label: "ALV", rate: 0.011, amount: 74.8 },
        { label: "Pensionskasse", rate: 0.07, amount: 476 },
        { label: "NBU", rate: 0.008, amount: 54.4 },
        { label: "KTG", rate: null, amount: 18 },
      ],
      netMonthly: NET_MONTHLY,
      expensesAllowance: 0,
      payout: NET_MONTHLY,
      // livingTotal + savingsTotal — what the budget actually allocates.
      budgetBase: 5400,
    },
    budget: {
      groups: [
        {
          id: "fix",
          label: "Fixkosten",
          categories: [
            { name: "Miete", monthly: 1350, note: "Muster Immobilien AG" },
            { name: "Krankenkasse", monthly: 340, note: "Krankenkasse Beispiel AG" },
            { name: "Internet/Handy", monthly: 60, note: "Swisscom" },
          ],
        },
        {
          id: "topf",
          label: "Töpfe (Sinking Funds)",
          categories: [
            { name: "Steuern", monthly: 450, yearlyTarget: 5400, fundedBy: "steuern", note: "Steuerrechnung ca. CHF 5'400/Jahr" },
            { name: "Gesundheit/Franchise", monthly: 60, yearlyTarget: 720 },
            { name: "ÖV/Mobilität", monthly: 110, yearlyTarget: 1320 },
            { name: "Kleidung", monthly: 50, yearlyTarget: 600 },
            { name: "Technik/Abos", monthly: 80, yearlyTarget: 960 },
            { name: "Reisen", monthly: 180, yearlyTarget: 2160 },
            { name: "Jahreskosten/Diverses", monthly: 60, yearlyTarget: 720 },
            { name: "Gym", monthly: 60, yearlyTarget: 720, note: "Jahresabo, anteilig" },
          ],
        },
        {
          id: "variabel",
          label: "Variabel",
          categories: [
            { name: "Essen/Alltag", monthly: 350 },
            { name: "Freizeit/Shopping", monthly: 220 },
            { name: "Ausgehen", monthly: 150 },
            { name: "Bargeld", monthly: 100 },
            { name: "Puffer", monthly: 50 },
          ],
        },
        {
          id: "sparen",
          label: "Sparen & Investieren",
          categories: [
            { name: "Notgroschen", monthly: 800, fundedBy: "notgroschen" },
            { name: "ETF IBKR", monthly: 1000, fundedBy: "ibkr" },
          ],
        },
      ],
      nonBudget: {
        income: ["Lohn", "Rückerstattungen", "Zinsen"],
        passThrough: ["Spesen"],
        passThroughNote: "Spesen werden von der Muster AG erstattet.",
      },
      livingTotal: 3600,
      savingsTotal: 1800,
      targetSavingsRate: 0.3,
    },
    goals: [
      { id: "notgroschen", label: "Notgroschen", target: 15000, current: ngBalance, monthly: 800, targetDate: "2027-04-30" },
      { id: "steuern", label: "Steuertopf", target: 5400, current: steuernBalance, monthly: 450, targetDate: "2027-06-30" },
    ],
    plan: {
      phases: [
        { id: "p1", label: "Phase 1", from: "2026-01", to: "2027-01", summary: "Notgroschen auf CHF 15'000 aufbauen, ETF-Sparplan CHF 1'000/Mt." },
        { id: "p2", label: "Phase 2", from: "2027-01", to: null, summary: "Notgroschen voll — Sparplan auf CHF 1'800/Mt erhöhen, Säule 3a starten." },
      ],
      pillar3a: {
        provider: "VIAC",
        strategy: "Global 100 (100 % Aktien)",
        start: "2027",
        yearlyMax2026: 7258,
        monthlyPlaceholder: 580,
        note: "Einzahlung erst ab Phase 2, sobald der Notgroschen voll ist.",
      },
      etf: {
        symbol: "VT",
        isin: "US9220427424",
        broker: "Interactive Brokers",
        strategy: "100 % VT, monatlicher Sparplan, nicht timen",
        monthlyPhase1: 1000,
        monthlyPhase2: 1800,
      },
      freeMargin: 416.4,
    },
    todos: [
      "Säule-3a-Konto bei VIAC eröffnen (ab Phase 2)",
      "Steuererklärung 2026 bis März einreichen",
      "Halbtax prüfen — lohnt sich ein GA?",
    ],
  };
}

// ---------------------------------------------------------------------------
// data/test-fixtures — small frozen snapshot the tests assert against.
// Two pay cycles (2026-08-25, 2026-09-25) plus Vor-Zyklus rows.
// ---------------------------------------------------------------------------
function buildFixtureTransactions(): TxBuilder {
  const b = new TxBuilder();
  const t = (date: string, account: string, payee: string, text: string, amount: number, cat: string) =>
    b.add(date, account, payee, text, amount, cat);

  // notgroschen/steuern history (before budgetStart)
  t("2025-11-15", "notgroschen", SELF, "Gutschrift Startkapital", 2000, "Übertrag");
  t("2025-12-31", "notgroschen", "Zürcher Kantonalbank", "Guthabenzins 2025", 6.8, "Zinsen");
  t("2026-08-26", "notgroschen", SELF, "Übertrag vom Privatkonto", 1200, "Übertrag");
  t("2026-09-26", "notgroschen", SELF, "Übertrag vom Privatkonto", 1200, "Übertrag");
  t("2026-08-26", "steuern", SELF, "Übertrag vom Privatkonto", 250, "Übertrag");
  t("2026-09-26", "steuern", SELF, "Übertrag vom Privatkonto", 250, "Übertrag");

  // Vor-Zyklus (privat rows before the first Lohn on/after budgetStart)
  t("2026-08-18", "privat", "Migros", "Einkauf ZKB Visa Debit", -42.6, "Essen/Alltag");
  t("2026-08-20", "privat", "Zara", "Einkauf ZKB Visa Debit", -85, "Kleidung");
  t("2026-08-22", "privat", "Apotheke Vita", "Einkauf ZKB Visa Debit", -18.4, "Gesundheit/Franchise");
  t("2026-08-24", "privat", "ZKB Bancomat", "Bancomatbezug", -100, "Bargeld");

  // Cycle 1: 2026-08-25 → 2026-09-24
  t("2026-08-25", "privat", EMPLOYER, "Gutschrift Salär August 2026", 4800, "Lohn");
  t("2026-08-26", "privat", SELF, "Übertrag aufs Sparkonto Notgroschen", -1200, "Notgroschen");
  t("2026-08-26", "privat", SELF, "Übertrag aufs Sparkonto Steuertopf", -250, "Steuern");
  t("2026-08-26", "privat", "Interactive Brokers", "Dauerauftrag ETF-Sparplan", -1000, "ETF IBKR");
  t("2026-08-28", "privat", "Krankenkasse Beispiel AG", "Prämie September 2026", -385.2, "Krankenkasse");
  t("2026-09-01", "privat", "Muster Immobilien AG", "Miete September 2026", -1280, "Miete");
  t("2026-09-02", "privat", "SBB", "Billett SBB Mobile", -44.6, "ÖV/Mobilität");
  t("2026-09-03", "privat", "Coop", "Einkauf ZKB Visa Debit", -31.55, "Essen/Alltag");
  t("2026-09-05", "privat", "SBB", "Halbtax-Abo Verlängerung", -185, "ÖV/Mobilität");
  t("2026-09-06", "privat", "Migros", "Einkauf ZKB Visa Debit", -22.9, "Essen/Alltag");
  t("2026-09-08", "privat", "Swisscom", "Internet & Mobile Abo", -59.9, "Internet/Handy");
  t("2026-09-10", "privat", "SBB", "Spesen: SBB Geschäftsreise", -68.4, "Spesen");
  t("2026-09-12", "privat", "Spotify", "Spotify Premium", -12.95, "Technik/Abos");
  t("2026-09-14", "privat", "Amazon", "Online-Bestellung", -87.4, "Freizeit/Shopping");
  t("2026-09-16", "privat", "Restaurant Adler", "Konsumation ZKB Visa Debit", -46.5, "Ausgehen");
  t("2026-09-18", "privat", "Migros", "Einkauf ZKB Visa Debit", -15.75, "Essen/Alltag");
  t("2026-09-19", "privat", EMPLOYER, "Spesenrückerstattung", 68.4, "Spesen");
  t("2026-09-20", "privat", "Denner", "Einkauf ZKB Visa Debit", -18.2, "Essen/Alltag");
  t("2026-09-21", "privat", "Netflix", "Netflix Standard", -24.9, "Technik/Abos");
  t("2026-09-22", "privat", "Laura Muster", "Anteil Ferien", -60, "Familie");
  t("2026-09-23", "privat", "Coop", "Einkauf ZKB Visa Debit", -26.45, "Essen/Alltag");
  t("2026-09-07", "privat", "Coop", "Einkauf ZKB Visa Debit", -12.3, "Essen/Alltag");
  t("2026-09-11", "privat", "Bar Orion", "Konsumation ZKB Visa Debit", -34, "Ausgehen");
  t("2026-09-13", "privat", "Migros", "Einkauf ZKB Visa Debit", -8.95, "Essen/Alltag");
  t("2026-09-15", "privat", "SBB", "Billett SBB Mobile", -33.6, "ÖV/Mobilität");
  t("2026-09-17", "privat", "H&M", "Einkauf ZKB Visa Debit", -59.95, "Kleidung");
  t("2026-09-24", "privat", "ZKB Bancomat", "Bancomatbezug", -100, "Bargeld");

  // Cycle 2 (open): 2026-09-25 → asOf
  t("2026-09-25", "privat", EMPLOYER, "Gutschrift Salär September 2026", 4800, "Lohn");
  t("2026-09-26", "privat", SELF, "Übertrag aufs Sparkonto Notgroschen", -1200, "Notgroschen");
  t("2026-09-26", "privat", SELF, "Übertrag aufs Sparkonto Steuertopf", -250, "Steuern");
  t("2026-09-26", "privat", "Interactive Brokers", "Dauerauftrag ETF-Sparplan", -1000, "ETF IBKR");
  t("2026-09-28", "privat", "Fitnessstudio Aktiv", "Jahresabo Fitness", -540, "Gym");
  t("2026-09-28", "privat", "Krankenkasse Beispiel AG", "Prämie Oktober 2026", -385.2, "Krankenkasse");
  t("2026-09-29", "privat", "Serafe AG", "Serafe Jahresrechnung", -335, "Jahreskosten/Diverses");
  t("2026-10-01", "privat", "Muster Immobilien AG", "Miete Oktober 2026", -1280, "Miete");
  t("2026-10-02", "privat", "easyJet", "Flug ZRH-LIS", -265.9, "Reisen");
  t("2026-10-03", "privat", "Migros", "Einkauf ZKB Visa Debit", -33.8, "Essen/Alltag");
  t("2026-10-04", "privat", "Unbekannt GmbH", "Belastung eBanking", -49.9, "Unkategorisiert");
  t("2026-10-05", "privat", "Café Merkur", "Konsumation ZKB Visa Debit", -9.6, "Ausgehen");
  t("2026-10-06", "privat", "SBB", "Billett SBB Mobile", -21.4, "ÖV/Mobilität");
  t("2026-10-07", "privat", "Krankenkasse Beispiel AG", "Rückerstattung Prämie", 95.2, "Rückerstattungen");
  t("2026-10-08", "privat", "Galaxus", "Online-Bestellung", -149, "Technik/Abos");
  t("2026-10-08", "privat", "ZKB Bancomat", "Bancomatbezug", -150, "Bargeld");
  t("2026-10-09", "privat", "Coop", "Einkauf ZKB Visa Debit", -41.15, "Essen/Alltag");
  t("2026-10-10", "privat", "Migros", "Einkauf ZKB Visa Debit", -19.3, "Essen/Alltag");
  return b;
}

function fixtureRules(): Rule[] {
  return baseRules();
}

function buildFixtureFinance(b: TxBuilder) {
  const privatOpening = 1500;
  const privatBalance = round2(privatOpening + b.sum("privat"));
  const ngBalance = b.sum("notgroschen");
  const steuernBalance = b.sum("steuern");
  return {
    asOf: "2026-10-10",
    sources: {
      zkbStatement: "Test-Fixture (erfundene Buchungen)",
      zkbAssets: "Test-Fixture",
      ibkr: "Test-Fixture (Konto U00000000)",
      plan: "Test-Fixture",
      payslip: "Test-Fixture",
    },
    privatkontoOpeningBalance: privatOpening,
    balancesAsOf: "2026-10-10",
    budgetStart: "2026-08-01",
    annualPayments: [
      {
        category: "Gym",
        payee: "Fitnessstudio Aktiv",
        date: "2026-09-28",
        amount: 540,
        coversMonths: 12,
        note: "Jahresabo Fitnessstudio",
      },
    ],
    accounts: [
      { id: "privat", name: "Privatkonto", institution: "ZKB", iban: FAKE_IBANS.privat, type: "cash", balance: privatBalance },
      { id: "notgroschen", name: "Sparkonto Notgroschen", institution: "ZKB", iban: FAKE_IBANS.notgroschen, type: "savings", balance: ngBalance },
      { id: "steuern", name: "Sparkonto Steuern", institution: "ZKB", iban: FAKE_IBANS.steuern, type: "savings", balance: steuernBalance },
      { id: "ibkr", name: "Interactive Brokers", institution: "IBKR", type: "brokerage", balance: 3120 },
    ],
    ibkr: {
      accountId: "U00000000",
      baseCurrency: "CHF",
      netLiquidationChf: 3120,
      cashChf: 55,
      unrealizedPnlChf: 120,
      realizedPnlChf: 0,
      dividendsChf: 0,
      deposits: [
        { date: "2026-08-28", amountChf: 1000 },
        { date: "2026-09-28", amountChf: 1000 },
      ],
      positions: [
        { symbol: "VT", name: "Vanguard Total World Stock ETF", isin: "US9220427424", ter: 0.07, marketValueUsd: 3800, marketValueChf: 3065 },
      ],
      valueHistory: [
        { date: "2026-08-28", valueChf: 1010 },
        { date: "2026-09-28", valueChf: 2060 },
        { date: "2026-10-10", valueChf: 3120 },
      ],
      valueHistoryNote: "Test-Fixture",
    },
    income: {
      employer: EMPLOYER,
      payday: 25,
      grossMonthly: 5800,
      deductions: [
        { label: "AHV/IV/EO", rate: 0.053, amount: 307.4 },
        { label: "ALV", rate: 0.011, amount: 63.8 },
        { label: "Pensionskasse", rate: 0.07, amount: 406 },
        { label: "NBU", rate: 0.008, amount: 46.4 },
        { label: "KTG", rate: null, amount: 16.4 },
      ],
      netMonthly: 4960,
      expensesAllowance: 0,
      payout: 4960,
      budgetBase: 4800,
    },
    budget: {
      groups: [
        {
          id: "fix",
          label: "Fixkosten",
          categories: [
            { name: "Miete", monthly: 1280 },
            { name: "Krankenkasse", monthly: 385 },
          ],
        },
        {
          id: "topf",
          label: "Töpfe (Sinking Funds)",
          categories: [
            { name: "Steuern", monthly: 250, yearlyTarget: 3000, fundedBy: "steuern" },
            { name: "Gesundheit/Franchise", monthly: 90, yearlyTarget: 1080 },
            { name: "ÖV/Mobilität", monthly: 110, yearlyTarget: 1320 },
            { name: "Gym", monthly: 70, yearlyTarget: 840 },
            { name: "Technik/Abos", monthly: 140, yearlyTarget: 1680 },
            { name: "Reisen", monthly: 220, yearlyTarget: 2640 },
            { name: "Jahreskosten/Diverses", monthly: 45, yearlyTarget: 540 },
          ],
        },
        {
          id: "variabel",
          label: "Variabel",
          categories: [
            { name: "Essen/Alltag", monthly: 300 },
            { name: "Freizeit/Shopping", monthly: 180 },
            { name: "Ausgehen", monthly: 150 },
            { name: "Kleidung", monthly: 50 },
            { name: "Bargeld", monthly: 100 },
            { name: "Puffer", monthly: 50 },
          ],
        },
        {
          id: "sparen",
          label: "Sparen & Investieren",
          categories: [
            { name: "Notgroschen", monthly: 1200, fundedBy: "notgroschen" },
            { name: "ETF IBKR", monthly: 1000, fundedBy: "ibkr" },
          ],
        },
      ],
      nonBudget: {
        income: ["Lohn", "Rückerstattungen", "Zinsen"],
        passThrough: ["Spesen"],
        passThroughNote: "Spesen werden von der Muster AG erstattet.",
      },
      livingTotal: 3505,
      savingsTotal: 2200,
      targetSavingsRate: 0.38,
    },
    goals: [
      { id: "notgroschen", label: "Notgroschen", target: 12000, current: ngBalance, monthly: 1200, targetDate: "2027-05-31" },
      { id: "steuern", label: "Steuertopf", target: 3000, current: steuernBalance, monthly: 250, targetDate: "2027-06-30" },
    ],
    plan: {
      phases: [
        { id: "p1", label: "Phase 1", from: "2026-08", to: "2027-01", summary: "Notgroschen aufbauen, ETF-Sparplan CHF 1'000/Mt." },
        { id: "p2", label: "Phase 2", from: "2027-01", to: null, summary: "Sparplan erhöhen, Säule 3a starten." },
      ],
      pillar3a: {
        provider: "VIAC",
        strategy: "Global 100",
        start: "2027",
        yearlyMax2026: 7258,
        monthlyPlaceholder: 580,
        note: "Test-Fixture",
      },
      etf: {
        symbol: "VT",
        isin: "US9220427424",
        broker: "Interactive Brokers",
        strategy: "100 % VT, monatlicher Sparplan",
        monthlyPhase1: 1000,
        monthlyPhase2: 1800,
      },
      freeMargin: 160,
    },
    todos: ["Test-Fixture To-do"],
  };
}

// ---------------------------------------------------------------------------
// Write everything.
// ---------------------------------------------------------------------------
function write(dir: string, name: string, content: string) {
  const p = join(root, dir, name);
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(p, content);
  console.log(`wrote ${p}`);
}

const demoRules = baseRules();
const fixtureRuleSet = fixtureRules();
validateRules(demoRules);
validateRules(fixtureRuleSet);

const demoTx = buildDemoTransactions();
checkRules(demoRules, demoTx.rows, "demo");
const demoIbkr = buildDemoIbkrSnapshot();
const demoFinance = buildDemoFinance(demoTx, demoIbkr);

write("data/demo", "finance.json", JSON.stringify(demoFinance, null, 2) + "\n");
write("data/demo", "transactions.csv", serializeTransactionsCsv(demoTx.sorted()));
write("data/demo", "rules.json", JSON.stringify(demoRules, null, 2) + "\n");
write("data/demo", "ibkr.json", JSON.stringify(demoIbkr, null, 2) + "\n");

const fixtureTx = buildFixtureTransactions();
checkRules(fixtureRuleSet, fixtureTx.rows, "test-fixtures");
const fixtureFinance = buildFixtureFinance(fixtureTx);

write("data/test-fixtures", "finance.json", JSON.stringify(fixtureFinance, null, 2) + "\n");
write("data/test-fixtures", "transactions.csv", serializeTransactionsCsv(fixtureTx.sorted()));
write("data/test-fixtures", "rules.json", JSON.stringify(fixtureRuleSet, null, 2) + "\n");

console.log(
  `\ndemo: ${demoTx.rows.length} rows, privat ${demoFinance.accounts[0].balance}, ` +
    `notgroschen ${demoFinance.accounts[1].balance}, steuern ${demoFinance.accounts[2].balance}`,
);
console.log(
  `test-fixtures: ${fixtureTx.rows.length} rows, privat ${fixtureFinance.accounts[0].balance}, ` +
    `notgroschen ${fixtureFinance.accounts[1].balance}, steuern ${fixtureFinance.accounts[2].balance}`,
);

if (!existsSync(join(root, "data", "private"))) {
  console.log("\nnote: data/private not present — demo data is the only dataset (as on a fresh clone).");
}
