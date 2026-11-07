import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, readFlexCredentials, type SpawnFn } from "./keychain";
import { EXIT_ERROR, EXIT_KEYCHAIN, EXIT_OK, runSync } from "./sync";
import type { IbkrSnapshot } from "./types";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "flex-activity.xml");
const TOKEN = "123456789012345678901234";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ibkr-sync-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** Stubbed `security` that knows only the given accounts. */
const keychain =
  (secrets: Record<string, string>): SpawnFn & { calls: string[][] } => {
    const calls: string[][] = [];
    const fn = ((command: string, args: string[]) => {
      calls.push([command, ...args]);
      const account = args[args.indexOf("-a") + 1];
      return account in secrets
        ? { status: 0, stdout: `${secrets[account]}\n`, stderr: "" }
        : { status: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." };
    }) as SpawnFn & { calls: string[][] };
    fn.calls = calls;
    return fn;
  };

describe("keychain", () => {
  test("missing credentials → exit 2 with the exact add-generic-password commands", async () => {
    const spawn = keychain({});
    const c = capture();
    const code = await runSync(["--data-dir", dir], { ...c.deps, spawn, fetch: async () => { throw new Error("must not fetch"); } });
    expect(code).toBe(EXIT_KEYCHAIN);
    const message = c.err.join("\n");
    expect(message).toContain(`security add-generic-password -s ${KEYCHAIN_SERVICE} -a token -w`);
    expect(message).toContain(`security add-generic-password -s ${KEYCHAIN_SERVICE} -a query-id -w`);
    expect(existsSync(join(dir, "ibkr.json"))).toBe(false);
    // Reads via argument array, never through a shell.
    expect(spawn.calls[0]).toEqual(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "token", "-w"]);
  });

  test("only the query id missing lists only that command", () => {
    expect(() => readFlexCredentials(keychain({ token: TOKEN }))).toThrow(/-a query-id -w/);
    expect(() => readFlexCredentials(keychain({ token: TOKEN }))).not.toThrow(/-a token -w/);
  });

  test("credentials are trimmed", () => {
    expect(readFlexCredentials(keychain({ token: TOKEN, "query-id": "1234567" }))).toEqual({ token: TOKEN, queryId: "1234567" });
  });
});

describe("runSync with Flex Web Service (fake fetch)", () => {
  test("fetches, writes ibkr.json and never prints the token", async () => {
    const report = readFileSync(FIXTURE, "utf8");
    const bodies = [
      `<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode><Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>`,
      report,
    ];
    const c = capture();
    const code = await runSync(["--data-dir", dir], {
      ...c.deps,
      spawn: keychain({ token: TOKEN, "query-id": "1234567" }),
      fetch: async () => ({ ok: true, status: 200, text: async () => bodies.shift()! }),
      sleep: async () => {},
    });
    expect(code).toBe(EXIT_OK);
    expect([...c.out, ...c.err].join("\n")).not.toContain(TOKEN);
    const saved = JSON.parse(readFileSync(join(dir, "ibkr.json"), "utf8")) as IbkrSnapshot;
    expect(saved.netLiquidation).toBe(1698.3);
  });

  test("fatal Flex error → exit 1 with German message, nothing written", async () => {
    const c = capture();
    const code = await runSync(["--data-dir", dir], {
      ...c.deps,
      spawn: keychain({ token: TOKEN, "query-id": "1234567" }),
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => readFileSync(join(import.meta.dir, "fixtures", "flex-error-1012.xml"), "utf8"),
      }),
    });
    expect(code).toBe(EXIT_ERROR);
    expect(c.err.join("\n")).toContain("Token abgelaufen");
    expect(existsSync(join(dir, "ibkr.json"))).toBe(false);
  });

  test("unknown option → exit 1", async () => {
    const c = capture();
    expect(await runSync(["--token", "x"], c.deps)).toBe(EXIT_ERROR);
  });
});

describe("scripts/ibkr-sync.ts --from-file (end-to-end)", () => {
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, join(ROOT, "scripts", "ibkr-sync.ts"), ...args], {
      cwd: ROOT,
      env: { ...process.env, FINANCE_DATA_DIR: "" },
    });

  test("dry run prints the summary and writes nothing", () => {
    const result = run("--from-file", FIXTURE, "--data-dir", dir, "--dry-run");
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("Stand 2026-10-09");
    expect(stdout).toContain("NAV CHF 1'698.30");
    expect(stdout).toContain("Positionen 1");
    expect(stdout).toContain("NAV-Tage 32");
    expect(stdout).toContain("Probelauf");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("writes ibkr.json atomically and merges with existing history", () => {
    // Existing file with an older NAV day outside the report window.
    const first = run("--from-file", FIXTURE, "--data-dir", dir);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString().trim().split("\n")).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(dir, "ibkr.json"), "utf8")) as IbkrSnapshot;
    expect(saved.accountId).toBe("U00000000");
    expect(saved.navHistory).toHaveLength(32);

    saved.navHistory.unshift({ date: "2025-09-01", nav: 0 });
    saved.deposits.unshift({ date: "2025-09-01", amount: 100 });
    writeFileSync(join(dir, "ibkr.json"), JSON.stringify(saved));

    const second = run("--from-file", FIXTURE, "--data-dir", dir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("NAV-Tage 33");
    const merged = JSON.parse(readFileSync(join(dir, "ibkr.json"), "utf8")) as IbkrSnapshot;
    expect(merged.navHistory[0]).toEqual({ date: "2025-09-01", nav: 0 });
    expect(merged.deposits).toHaveLength(3);
    expect(merged.trades).toHaveLength(2);
    expect(readdirSync(dir)).toEqual(["ibkr.json"]); // no temp files left behind
  });

  test("FINANCE_DATA_DIR is honoured when --data-dir is absent", () => {
    const result = Bun.spawnSync([process.execPath, join(ROOT, "scripts", "ibkr-sync.ts"), "--from-file", FIXTURE], {
      cwd: ROOT,
      env: { ...process.env, FINANCE_DATA_DIR: dir },
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, "ibkr.json"))).toBe(true);
  });

  test("error fixture → exit 1", () => {
    const result = run("--from-file", join(import.meta.dir, "fixtures", "flex-error-1012.xml"), "--data-dir", dir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Token abgelaufen");
  });
});
