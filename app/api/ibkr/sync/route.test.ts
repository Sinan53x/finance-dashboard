import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "@/lib/ibkr/keychain";
import { createPost } from "./route";

const FIXTURE = join(
  import.meta.dir,
  "../../../../lib/ibkr/fixtures/flex-activity.xml"
);
const TOKEN = "123456789012345678901234";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fd-ibkr-sync-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keychain =
  (secrets: Record<string, string>): SpawnFn =>
  (_command, args) => {
    const account = args[args.indexOf("-a") + 1];
    return account in secrets
      ? { status: 0, stdout: `${secrets[account]}\n`, stderr: "" }
      : { status: 44, stdout: "", stderr: "not found" };
  };

describe("POST /api/ibkr/sync", () => {
  test("keychain missing → 428 with the setup hint", async () => {
    const res = await createPost({
      spawn: keychain({}),
      fetch: async () => {
        throw new Error("must not fetch");
      },
      env: { FINANCE_DATA_DIR: dir },
    })();
    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.keychain).toBe(true);
    expect(body.error).toContain("security add-generic-password");
    expect(existsSync(join(dir, "ibkr.json"))).toBe(false);
  });

  test("success → 200 with the one-line summary and a written ibkr.json", async () => {
    const report = readFileSync(FIXTURE, "utf8");
    const bodies = [
      `<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode><Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>`,
      report,
    ];
    const res = await createPost({
      spawn: keychain({ token: TOKEN, "query-id": "1234567" }),
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => bodies.shift()!,
      }),
      sleep: async () => {},
      env: { FINANCE_DATA_DIR: dir },
    })();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.line).toContain("NAV CHF 1'698.30");
    expect(existsSync(join(dir, "ibkr.json"))).toBe(true);
  });
});
