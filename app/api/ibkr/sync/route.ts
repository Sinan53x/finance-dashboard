import { NextResponse } from "next/server";
import { runSync, type SyncDeps } from "@/lib/ibkr/sync";

export const dynamic = "force-dynamic";

/**
 * Runs the IBKR Flex sync in-process (no shell). Returns `{ ok, line }` with the
 * one-line summary, or `{ ok: false, error, keychain }` — `keychain` flags the
 * "credentials missing" case so the card can show the setup hint.
 * Loopback/tailnet-only — no auth.
 */
export function createPost(deps: SyncDeps = {}) {
  return async function POST() {
    const captured: { line?: string; error?: string } = {};
    const code = await runSync([], {
      ...deps,
      out: (l) => {
        captured.line = l;
      },
      err: (l) => {
        captured.error = l;
      },
    });
    if (code === 0) {
      return NextResponse.json({ ok: true, line: captured.line });
    }
    return NextResponse.json(
      {
        ok: false,
        keychain: code === 2,
        error: captured.error ?? "Sync fehlgeschlagen",
      },
      { status: code === 2 ? 428 : 422 }
    );
  };
}

export const POST = createPost();
