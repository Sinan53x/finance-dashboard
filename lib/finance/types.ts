/** Shape of data/private/finance.json — the contract the UI is built against. */
export type FinanceData = {
  asOf: string;
  /** Date the account balances were taken — the anchor for balance history. */
  balancesAsOf: string;
  /** First day of budget tracking; Lohn before this never creates a cycle. */
  budgetStart: string;
  /** Large one-off payments inside Töpfe categories (shown as notes on the Budget tab). */
  annualPayments: AnnualPayment[];
  sources: Record<string, string>;
  privatkontoOpeningBalance: number;
  accounts: Account[];
  ibkr: Ibkr;
  income: Income;
  budget: Budget;
  goals: Goal[];
  plan: Plan;
  todos: string[];
};

export type AnnualPayment = {
  category: string;
  payee: string;
  date: string;
  amount: number;
  coversMonths: number;
  note: string;
};

export type Account = {
  id: string;
  name: string;
  institution: string;
  iban?: string;
  type: "cash" | "savings" | "brokerage";
  balance: number;
};

export type Ibkr = {
  accountId: string;
  baseCurrency: string;
  netLiquidationChf: number;
  cashChf: number;
  unrealizedPnlChf: number;
  realizedPnlChf: number;
  dividendsChf: number;
  deposits: { date: string; amountChf: number }[];
  positions: {
    symbol: string;
    name: string;
    isin: string;
    ter: number;
    marketValueUsd: number;
    marketValueChf: number;
  }[];
  valueHistory: { date: string; valueChf: number }[];
  valueHistoryNote: string;
};

export type Income = {
  employer: string;
  payday: number;
  grossMonthly: number;
  deductions: { label: string; rate: number | null; amount: number }[];
  netMonthly: number;
  expensesAllowance: number;
  payout: number;
  budgetBase: number;
};

export type BudgetCategory = {
  name: string;
  monthly: number;
  yearlyTarget?: number;
  note?: string;
  fundedBy?: string;
};

export type BudgetGroup = {
  id: "fix" | "topf" | "variabel" | "sparen";
  label: string;
  categories: BudgetCategory[];
};

export type Budget = {
  groups: BudgetGroup[];
  nonBudget: {
    income: string[];
    passThrough: string[];
    passThroughNote: string;
  };
  livingTotal: number;
  savingsTotal: number;
  targetSavingsRate: number;
};

export type Goal = {
  id: string;
  label: string;
  target: number;
  current: number;
  monthly: number;
  targetDate: string;
};

export type Plan = {
  phases: { id: string; label: string; from: string; to: string | null; summary: string }[];
  pillar3a: {
    provider: string;
    strategy: string;
    start: string;
    yearlyMax2026: number;
    monthlyPlaceholder: number;
    note: string;
  };
  etf: {
    symbol: string;
    isin: string;
    broker: string;
    strategy: string;
    monthlyPhase1: number;
    monthlyPhase2: number;
  };
  freeMargin: number;
};

/** One row of data/private/transactions.csv — single source: the importer. */
export type { Transaction } from "../import/types";
