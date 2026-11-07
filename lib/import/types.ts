/** One row of data/private/transactions.csv. Amount is signed CHF (negative = Belastung). */
export interface Transaction {
  date: string;
  valuta: string;
  /** Account id from finance.json (`privat`, `notgroschen`, `steuern`). */
  account: string;
  payee: string;
  text: string;
  amount: number;
  category: string;
}

/** A booking parsed from a bank export, before categorisation. */
export interface ParsedTransaction extends Omit<Transaction, "category" | "account"> {
  /** Counterparty IBAN, used for rule matching only (never written to the CSV). */
  iban?: string;
  /** The statement account's own IBAN (camt.053 `Stmt/Acct/Id/IBAN`). */
  accountIban?: string;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  warnings: string[];
}

export const UNCATEGORISED = "Unkategorisiert";
