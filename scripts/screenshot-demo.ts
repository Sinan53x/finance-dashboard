#!/usr/bin/env bun
/**
 * Screenshots of every dashboard tab into docs/screenshots/.
 * Expects the app running on PORT (default http://localhost:3799), e.g.
 *
 *   FINANCE_DATA_DIR=data/demo bunx next dev -p 3799
 *   bunx playwright install chromium   # once
 *   bun scripts/screenshot-demo.ts
 */
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.DEMO_URL ?? "http://localhost:3799";
const outDir = join(import.meta.dir, "..", "docs", "screenshots");

const tabs = [
  ["uebersicht", "Übersicht"],
  ["budget", "Budget"],
  ["ausgaben", "Ausgaben"],
  ["vermoegen", "Vermögen & Investitionen"],
  ["plan", "Plan"],
] as const;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector('[role="tab"]');
await page.waitForTimeout(1200);

for (const [name, label] of tabs) {
  if (name !== "uebersicht") {
    await page.getByRole("tab", { name: label }).click();
    await page.waitForTimeout(1200);
  }
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`wrote ${file}`);
}

await browser.close();
