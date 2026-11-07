<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Finance dashboard notes
- Data lives in `data/private/` (gitignored): `transactions.csv` (ZKB Privatkonto, reconciled to statement totals), `finance.json` (accounts, IBKR snapshot, budget, plan), `rules.json` (import categorisation, first match wins).
- `data/demo/` + `data/test-fixtures/` are committed fictional datasets (`bun run demo:generate` regenerates them). `bun run demo` serves the demo; without `data/private/` the app falls back to it.
- Import bank files: `bun run import <camt.xml|zkb.csv> [--dry-run]` or the drop zone in the Ausgaben tab.
- Verify: `bun test`, `bun run build`, `bun run lint`.
- Hosting: `bun run serve` on 127.0.0.1:3100 behind a launchd LaunchAgent; restart after a build with `launchctl kickstart -k gui/$(id -u)/<label>`.
