/**
 * Normalised Interactive Brokers account snapshot, written to `<dataDir>/ibkr.json`
 * by `scripts/ibkr-sync.ts` (Flex Web Service) and read via `loadIbkrSnapshot`.
 *
 * Conventions:
 * - All `*Base` fields and every amount in `navHistory`, `deposits` and `dividends` are in
 *   `baseCurrency`, rounded to cents.
 * - Dates are `YYYY-MM-DD`; all arrays are sorted ascending by date.
 * - `deposits[].amount`: + deposit, − withdrawal.
 * - `dividends[].amount` is the gross dividend; `withholdingTax` is the tax withheld as a
 *   positive number (net = amount − withholdingTax).
 * - `trades[].quantity`: + buy, − sell. `price`/`commission` are in the trade `currency`;
 *   `commission` is a positive cost. `amountBase` is the signed cash effect in base currency
 *   (IBKR `netCash` × `fxRateToBase`, i.e. negative for buys incl. commission).
 */
export type IbkrSnapshot = {
  source: "flex" | "manual";
  fetchedAt: string; // ISO timestamp
  asOf: string; // last report date YYYY-MM-DD
  accountId: string;
  baseCurrency: string; // e.g. "CHF"
  netLiquidation: number; // base currency
  cash: number;
  unrealizedPnl: number;
  positions: {
    symbol: string;
    isin?: string;
    description: string;
    quantity: number;
    currency: string;
    markPrice: number;
    marketValue: number;
    marketValueBase: number;
    costBasisBase?: number;
    unrealizedPnlBase?: number;
  }[];
  navHistory: { date: string; nav: number }[]; // base ccy, ascending, unique by date
  deposits: { date: string; amount: number }[]; // base ccy, + deposit, − withdrawal
  dividends: { date: string; symbol: string; amount: number; withholdingTax: number }[]; // base ccy
  trades: {
    date: string;
    symbol: string;
    quantity: number;
    price: number;
    currency: string;
    commission: number;
    amountBase: number;
  }[];
};
