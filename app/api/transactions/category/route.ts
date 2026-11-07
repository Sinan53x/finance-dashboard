import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  parseTransactionsCsv,
  serializeTransactionsCsv,
} from "@/lib/import/csv";
import { dataDir } from "@/lib/finance/load";
import { categorize, loadRules, validateRules, type Rule } from "@/lib/import/rules";
import { UNCATEGORISED } from "@/lib/import/types";

export const dynamic = "force-dynamic";

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

type Body = {
  index: number;
  date: string;
  account: string;
  amount: number;
  payee: string;
  text: string;
  category: string;
  createRule?: { pattern: string };
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Ungültiges JSON" }, { status: 400 });
  }
  const { index, date, account, amount, payee, text, category, createRule } = body;
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    typeof category !== "string" ||
    category === ""
  ) {
    return NextResponse.json({ error: "index und category fehlen" }, { status: 400 });
  }

  const csv = path.join(dataDir(), "transactions.csv");
  const rulesFile = path.join(dataDir(), "rules.json");
  const rows = parseTransactionsCsv(readFileSync(csv, "utf8"));
  const row = rows[index];
  const identity =
    row &&
    row.date === date &&
    row.account === account &&
    row.amount === amount &&
    row.payee === payee &&
    row.text === text;
  if (!identity) {
    return NextResponse.json(
      { error: "Buchung stimmt nicht überein (Daten geändert?)", index },
      { status: 409 }
    );
  }

  row.category = category;
  let ruleCreated = false;
  let recategorized = 0;

  if (createRule && typeof createRule.pattern === "string" && createRule.pattern !== "") {
    const rules = loadRules(rulesFile);
    const next: Rule = {
      category,
      patterns: [createRule.pattern],
      accounts: [account],
    };
    validateRules([next]);
    writeAtomic(rulesFile, JSON.stringify([next, ...rules], null, 2) + "\n");
    ruleCreated = true;
    for (const r of rows) {
      if (r === row || r.category !== UNCATEGORISED) continue;
      if (categorize([next], { ...r }) === category) {
        r.category = category;
        recategorized += 1;
      }
    }
  }

  writeAtomic(csv, serializeTransactionsCsv(rows));
  return NextResponse.json({ ok: true, index, ruleCreated, recategorized });
}
