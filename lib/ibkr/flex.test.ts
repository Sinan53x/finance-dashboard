import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FlexError, redactToken } from "./errors";
import { fetchFlexStatement, USER_AGENT } from "./flex";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const TOKEN = "123456789012345678901234";
const QUERY = "1234567";
const GET_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement";

const sendOk = `<FlexStatementResponse timestamp="10 October, 2026 03:15 AM EDT"><Status>Success</Status><ReferenceCode>9876543210</ReferenceCode><Url>${GET_URL}</Url></FlexStatementResponse>`;
const fail = (code: number, message: string, status = "Fail") =>
  `<FlexStatementResponse timestamp="10 October, 2026 03:15 AM EDT"><Status>${status}</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></FlexStatementResponse>`;

/** Fake fetch that serves canned bodies in order, plus a fake clock advanced by `sleep`. */
function harness(bodies: string[]) {
  let clock = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const queue = [...bodies];
  return {
    calls,
    sleeps,
    logs,
    options: {
      token: TOKEN,
      queryId: QUERY,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      log: (message: string) => logs.push(message),
      fetch: async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: init.headers });
        clock += 50;
        const body = queue.shift();
        if (body === undefined) throw new Error("unexpected request");
        return { ok: true, status: 200, text: async () => body };
      },
    },
  };
}

describe("fetchFlexStatement", () => {
  test("success after one 1019 retry", async () => {
    const report = fixture("flex-activity.xml");
    const h = harness([sendOk, fail(1019, "Statement generation in progress. Please try again shortly.", "Warn"), report]);
    const xml = await fetchFlexStatement(h.options);

    expect(xml).toBe(report);
    expect(h.calls).toHaveLength(3);
    const send = new URL(h.calls[0].url);
    expect(send.origin + send.pathname).toBe("https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest");
    expect(Object.fromEntries(send.searchParams)).toEqual({ t: TOKEN, q: QUERY, v: "3" });
    const get = new URL(h.calls[1].url);
    expect(get.origin + get.pathname).toBe(GET_URL);
    expect(Object.fromEntries(get.searchParams)).toEqual({ t: TOKEN, q: "9876543210", v: "3" });
    expect(h.calls.every((c) => c.headers["User-Agent"] === USER_AGENT)).toBe(true);
    // One backoff (3 s) for the 1019; plus ≥1 s spacing between consecutive requests.
    expect(h.sleeps.some((ms) => ms >= 3000)).toBe(true);
    // The token never appears in progress logs.
    expect(h.logs.join("\n")).not.toContain(TOKEN);
    expect(h.logs.join("\n")).toContain("t=***");
  });

  test("fatal 1012 (token expired) fails immediately with a German message", async () => {
    const h = harness([fail(1012, "Token has expired.")]);
    const error = await fetchFlexStatement(h.options).catch((e) => e);
    expect(error).toBeInstanceOf(FlexError);
    expect(error.code).toBe(1012);
    expect(error.message).toContain("Token abgelaufen – neuen Token im Client Portal erzeugen");
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  test.each([
    [1015, "Token ist ungültig"],
    [1014, "Query ist ungültig"],
    [1013, "IP-Beschränkung"],
  ])("fatal %d → %s", async (code, text) => {
    const h = harness([fail(code, "x")]);
    const error = await fetchFlexStatement(h.options).catch((e) => e);
    expect(error.message).toContain(text);
    expect(h.calls).toHaveLength(1);
  });

  test("rate limit 1018 waits ≥15 s then succeeds", async () => {
    const report = fixture("flex-activity.xml");
    const h = harness([fail(1018, "Too many requests"), sendOk, report]);
    expect(await fetchFlexStatement(h.options)).toBe(report);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(15_000);
  });

  test("gives up after the ~90 s budget while the statement stays in progress", async () => {
    const pending = fail(1019, "Statement generation in progress. Please try again shortly.", "Warn");
    const h = harness([sendOk, ...Array(50).fill(pending)]);
    const error = await fetchFlexStatement(h.options).catch((e) => e);
    expect(error).toBeInstanceOf(FlexError);
    expect(error.message).toMatch(/aufgegeben/);
    const slept = h.sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeLessThanOrEqual(90_000);
    expect(slept).toBeGreaterThan(60_000);
  });

  test("refuses to send the token to a non-IBKR statement URL", async () => {
    const evil = sendOk.replace(GET_URL, "https://evil.example.com/GetStatement");
    const h = harness([evil]);
    const error = await fetchFlexStatement(h.options).catch((e) => e);
    expect(error.message).toMatch(/Unerwartete Statement-URL/);
    expect(h.calls).toHaveLength(1);
  });

  test("lowercase <url> from the IBKR docs example is accepted", async () => {
    const report = fixture("flex-activity.xml");
    const h = harness([sendOk.replace("<Url>", "<url>").replace("</Url>", "</url>"), report]);
    expect(await fetchFlexStatement(h.options)).toBe(report);
  });

  test("HTTP 5xx is retried, network errors are redacted", async () => {
    let n = 0;
    const report = fixture("flex-activity.xml");
    const h = harness([]);
    const error = await fetchFlexStatement({
      ...h.options,
      timeoutMs: 1_000,
      fetch: async (url: string) => {
        n++;
        throw new Error(`connect ECONNREFUSED ${url}`);
      },
    }).catch((e) => e);
    expect(n).toBe(1);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("t=***");

    const bodies = [sendOk, report];
    let first = true;
    const ok = await fetchFlexStatement({
      ...h.options,
      fetch: async () => {
        if (first) {
          first = false;
          return { ok: false, status: 503, text: async () => "Service Unavailable" };
        }
        const body = bodies.shift()!;
        return { ok: true, status: 200, text: async () => body };
      },
    });
    expect(ok).toBe(report);
  });
});

test("redactToken", () => {
  expect(redactToken(`https://x/SendRequest?t=${TOKEN}&q=1&v=3`)).toBe("https://x/SendRequest?t=***&q=1&v=3");
  expect(redactToken(`GetStatement?q=1&t=${TOKEN}`)).toBe("GetStatement?q=1&t=***");
});
