#!/usr/bin/env bun
/**
 * Read-only Interactive Brokers sync via the Flex Web Service → data/private/ibkr.json.
 *
 *   bun scripts/ibkr-sync.ts [--from-file <flex.xml>] [--dry-run] [--data-dir <dir>]
 *
 * Token and Query ID are read from the macOS Keychain (service "finance-dashboard-ibkr-flex",
 * accounts "token" / "query-id"); see lib/ibkr/SETUP.de.md. Exit codes: 0 ok, 1 error,
 * 2 credentials missing in the Keychain.
 */
import { runSync } from "../lib/ibkr/sync";

process.exit(await runSync(process.argv.slice(2)));
