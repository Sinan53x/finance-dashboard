import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEYCHAIN_SERVICE,
  KeychainInvalidError,
  KeychainMissingError,
  readFlexCredentials,
  type SpawnFn,
} from "./keychain";
import { EXIT_KEYCHAIN, runSync } from "./sync";

const keychain =
  (secrets: Record<string, string>): SpawnFn =>
  (_command, args) => {
    const account = args[args.indexOf("-a") + 1];
    return account in secrets
      ? { status: 0, stdout: `${secrets[account]}\n`, stderr: "" }
      : { status: 44, stdout: "", stderr: "not found" };
  };

const BAD_TOKEN = "security add-generic-password -s finance-dashboard-ibkr-flex -a token -w";
const GOOD_QUERY = "1234567";

describe("credential shape validation", () => {
  test("command text pasted as token → KeychainInvalidError, value never echoed", () => {
    const spawn = keychain({ token: BAD_TOKEN, "query-id": GOOD_QUERY });
    let thrown: unknown;
    try {
      readFlexCredentials(spawn);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(KeychainInvalidError);
    // maps like missing credentials (exit 2 / HTTP 428)
    expect(thrown).toBeInstanceOf(KeychainMissingError);
    const msg = (thrown as Error).message;
    expect(msg).toContain("Schlüsselbund-Eintrag ‹token› sieht falsch aus");
    expect(msg).toContain(
      `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a token -w`
    );
    expect(msg).toContain("nur den Wert einfügen");
    expect(msg).not.toContain("query-id");
    expect(msg).not.toContain(BAD_TOKEN);
  });

  test("bad query-id is named too", () => {
    const spawn = keychain({
      token: "123456789012345678901234",
      "query-id": "abc",
    });
    expect(() => readFlexCredentials(spawn)).toThrow(/‹query-id›/);
  });

  test("both bad → both entries listed", () => {
    const spawn = keychain({ token: BAD_TOKEN, "query-id": "x" });
    try {
      readFlexCredentials(spawn);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("‹token›");
      expect(msg).toContain("‹query-id›");
      expect(msg).not.toContain(BAD_TOKEN);
    }
  });

  test("whitespace/newline-padded digits are accepted (trimmed)", () => {
    const spawn = keychain({
      token: "  123456789012345678901234 \n",
      "query-id": "\t1234567\n",
    });
    expect(readFlexCredentials(spawn)).toEqual({
      token: "123456789012345678901234",
      queryId: "1234567",
    });
  });

  test("runSync maps invalid credentials to exit 2 with the fix hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ibkr-kc-"));
    try {
      const err: string[] = [];
      const code = await runSync(["--data-dir", dir], {
        spawn: keychain({ token: BAD_TOKEN, "query-id": GOOD_QUERY }),
        fetch: async () => {
          throw new Error("must not fetch");
        },
        out: () => {},
        err: (l) => err.push(l),
      });
      expect(code).toBe(EXIT_KEYCHAIN);
      const msg = err.join("\n");
      expect(msg).toContain("‹token› sieht falsch aus");
      expect(msg).toContain("-U -s finance-dashboard-ibkr-flex -a token -w");
      expect(msg).not.toContain(BAD_TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
