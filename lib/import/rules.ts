import { readFileSync } from "node:fs";
import { UNCATEGORISED } from "./types";

/**
 * One categorisation rule. All given conditions must hold; `patterns` match if any of them is a
 * case-insensitive substring of `payee + " " + text`. Amount bounds apply to the absolute value.
 */
export interface Rule {
  category: string;
  patterns?: string[];
  iban?: string;
  /** Restrict the rule to rows on these account ids (e.g. `notgroschen`, `steuern`). */
  accounts?: string[];
  sign?: "debit" | "credit";
  minAmount?: number;
  maxAmount?: number;
}

export interface CategorizeInput {
  payee: string;
  text: string;
  amount: number;
  iban?: string;
  account?: string;
}

const normalizeIban = (iban: string) => iban.replace(/\s/g, "").toUpperCase();

export function validateRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) throw new Error("rules.json must contain an array of rules");
  return value.map((rule, index) => {
    const where = `rules.json[${index}]`;
    if (typeof rule !== "object" || rule === null) throw new Error(`${where}: not an object`);
    const r = rule as Record<string, unknown>;
    if (typeof r.category !== "string" || r.category === "") throw new Error(`${where}: missing category`);
    if (r.patterns !== undefined && !(Array.isArray(r.patterns) && r.patterns.every((p) => typeof p === "string" && p !== ""))) {
      throw new Error(`${where}: patterns must be non-empty strings`);
    }
    if (r.iban !== undefined && typeof r.iban !== "string") throw new Error(`${where}: iban must be a string`);
    if (r.accounts !== undefined && !(Array.isArray(r.accounts) && r.accounts.every((a) => typeof a === "string" && a !== ""))) {
      throw new Error(`${where}: accounts must be non-empty strings`);
    }
    if (r.sign !== undefined && r.sign !== "debit" && r.sign !== "credit") throw new Error(`${where}: sign must be "debit" or "credit"`);
    for (const key of ["minAmount", "maxAmount"] as const) {
      if (r[key] !== undefined && typeof r[key] !== "number") throw new Error(`${where}: ${key} must be a number`);
    }
    if (r.patterns === undefined && r.iban === undefined) throw new Error(`${where}: needs patterns or iban`);
    return r as unknown as Rule;
  });
}

export function loadRules(path: string): Rule[] {
  return validateRules(JSON.parse(readFileSync(path, "utf8")));
}

export function ruleMatches(rule: Rule, input: CategorizeInput): boolean {
  const abs = Math.abs(input.amount);
  if (rule.accounts !== undefined && (!input.account || !rule.accounts.includes(input.account))) return false;
  if (rule.iban !== undefined && (!input.iban || normalizeIban(input.iban) !== normalizeIban(rule.iban))) return false;
  if (rule.sign === "debit" && input.amount >= 0) return false;
  if (rule.sign === "credit" && input.amount <= 0) return false;
  // Compare in cents so 1500 matches 1500.00 exactly.
  if (rule.minAmount !== undefined && Math.round(abs * 100) < Math.round(rule.minAmount * 100)) return false;
  if (rule.maxAmount !== undefined && Math.round(abs * 100) > Math.round(rule.maxAmount * 100)) return false;
  if (rule.patterns !== undefined) {
    const haystack = `${input.payee} ${input.text}`.toLowerCase();
    if (!rule.patterns.some((p) => haystack.includes(p.toLowerCase()))) return false;
  }
  return true;
}

/** First matching rule wins; unmatched rows are `Unkategorisiert`. */
export function categorize(rules: Rule[], input: CategorizeInput): string {
  return rules.find((rule) => ruleMatches(rule, input))?.category ?? UNCATEGORISED;
}
