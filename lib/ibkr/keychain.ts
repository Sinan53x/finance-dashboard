import { spawnSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "finance-dashboard-ibkr-flex";
export const KEYCHAIN_ACCOUNTS = { token: "token", queryId: "query-id" } as const;

/** Result shape of a synchronous process spawn (subset of node's `SpawnSyncReturns<string>`). */
export type SpawnResult = { status: number | null; stdout: string; stderr: string; error?: Error };
export type SpawnFn = (command: string, args: string[]) => SpawnResult;

/** Spawn with an argument array (no shell), so nothing is interpolated or logged. */
export const defaultSpawn: SpawnFn = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
};

export class KeychainMissingError extends Error {
  readonly missing: string[];
  constructor(missing: string[], detail?: string) {
    const commands = missing
      .map((account) => `  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w`)
      .join("\n");
    super(
      `IBKR-Zugangsdaten fehlen im macOS-Schlüsselbund (${missing.join(", ")}).\n` +
        `Bitte im Terminal ausführen (ohne Wert nach -w – der Wert wird abgefragt und landet nicht in der Shell-History):\n` +
        `${commands}\n` +
        `Anleitung: lib/ibkr/SETUP.de.md` +
        (detail ? `\n(${detail})` : ""),
    );
    this.name = "KeychainMissingError";
    this.missing = missing;
  }
}

/**
 * A stored value has the wrong shape — e.g. the user pasted the whole
 * `security add-generic-password …` command at the hidden prompt instead of
 * the value itself. Extends KeychainMissingError so callers keep mapping it to
 * exit 2 / HTTP 428. The stored value is never echoed.
 */
export class KeychainInvalidError extends KeychainMissingError {
  constructor(invalid: string[]) {
    const lines = invalid.map(
      (account) =>
        `Schlüsselbund-Eintrag ‹${account}› sieht falsch aus (enthält nicht nur Ziffern) – vermutlich wurde der Befehl statt des Werts eingefügt.`
    );
    const commands = invalid
      .map((account) => `  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w`)
      .join("\n");
    super(invalid);
    this.name = "KeychainInvalidError";
    this.message =
      `${lines.join("\n")}\n` +
      `Eintrag überschreiben:\n${commands}\n` +
      `Beim versteckten Prompt nur den Wert einfügen (wird zweimal abgefragt).\n` +
      `Anleitung: lib/ibkr/SETUP.de.md`;
  }
}

/** Flex tokens are numeric; query ids are short numeric. */
const CREDENTIAL_PATTERNS: Record<string, RegExp> = {
  [KEYCHAIN_ACCOUNTS.token]: /^\d{10,40}$/,
  [KEYCHAIN_ACCOUNTS.queryId]: /^\d{3,12}$/,
};

function readSecret(account: string, spawn: SpawnFn): { value?: string; detail?: string } {
  const result = spawn("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
  if (result.error) return { detail: `security konnte nicht gestartet werden: ${result.error.message}` };
  if (result.status !== 0) {
    // 44 = item not found; anything else (e.g. access denied) is reported without echoing secrets.
    return result.status === 44 ? {} : { detail: `security beendet mit Status ${result.status}` };
  }
  const value = result.stdout.replace(/\r?\n$/, "").trim();
  return value ? { value } : {};
}

/** Read Flex token and query ID from the login keychain. Throws `KeychainMissingError`. */
export function readFlexCredentials(spawn: SpawnFn = defaultSpawn): { token: string; queryId: string } {
  const token = readSecret(KEYCHAIN_ACCOUNTS.token, spawn);
  const queryId = readSecret(KEYCHAIN_ACCOUNTS.queryId, spawn);
  const missing: string[] = [];
  if (!token.value) missing.push(KEYCHAIN_ACCOUNTS.token);
  if (!queryId.value) missing.push(KEYCHAIN_ACCOUNTS.queryId);
  if (missing.length > 0) {
    const detail = [token.detail, queryId.detail].filter(Boolean).join("; ") || undefined;
    throw new KeychainMissingError(missing, detail);
  }
  const invalid = [
    [KEYCHAIN_ACCOUNTS.token, token.value!],
    [KEYCHAIN_ACCOUNTS.queryId, queryId.value!],
  ]
    .filter(([account, value]) => !CREDENTIAL_PATTERNS[account].test(value))
    .map(([account]) => account);
  if (invalid.length > 0) throw new KeychainInvalidError(invalid);
  return { token: token.value!, queryId: queryId.value! };
}
