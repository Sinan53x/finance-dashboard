import { FlexError, flexErrorFromCode, RATE_LIMIT_CODE, redactToken } from "./errors";
import { parseFlexStatementResponse } from "./parse";

/**
 * Flex Web Service v3 client (read-only).
 * https://www.interactivebrokers.com/docs/web-api/api-reference/send-request.md
 * https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm
 *
 *   1. GET SendRequest?t=TOKEN&q=QUERY_ID&v=3  → <FlexStatementResponse> with ReferenceCode + Url
 *   2. GET <Url>?t=TOKEN&q=REFERENCE_CODE&v=3  → <FlexQueryResponse> (the report) or a
 *      <FlexStatementResponse> error such as 1019 "generation in progress" → retry with backoff.
 */

export const SEND_REQUEST_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";
export const USER_AGENT = "finance-dashboard/1.0";

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type FetchFlexOptions = {
  token: string;
  queryId: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Total time budget for polling/retries (default 90 s). */
  timeoutMs?: number;
  /** Progress messages (never contain the token). */
  log?: (message: string) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** IBKR allows 1 request/second; keep a little margin between consecutive calls. */
const MIN_INTERVAL_MS = 1100;
/** After a 1018 (10 requests/minute exceeded) wait long enough for the window to roll. */
const RATE_LIMIT_WAIT_MS = 15_000;
const INITIAL_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

function isAllowedStatementUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)interactivebrokers\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Request and download an Activity Flex Query report. Returns the raw `<FlexQueryResponse>` XML.
 * Throws `FlexError` with a German message on fatal errors or when the time budget is exhausted.
 */
export async function fetchFlexStatement(options: FetchFlexOptions): Promise<string> {
  const { token, queryId } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 90_000;

  if (!token || !queryId) throw new FlexError("Token oder Query ID fehlt.");

  const start = now();
  let lastRequestAt = -Infinity;
  let backoff = INITIAL_BACKOFF_MS;

  const elapsed = () => now() - start;

  async function get(url: string): Promise<string> {
    const wait = lastRequestAt + MIN_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml" },
        signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
      });
    } catch (error) {
      const reason = redactToken(error instanceof Error ? error.message : String(error));
      throw new FlexError(`Netzwerkfehler beim IBKR-Abruf: ${reason}`, { retryable: true });
    }
    const body = await response.text();
    if (!response.ok) {
      throw new FlexError(`IBKR antwortet mit HTTP ${response.status}.`, { retryable: response.status >= 500 || response.status === 429 });
    }
    return body;
  }

  /** Wait before the next attempt, or throw if the budget would be exceeded. */
  async function backoffOrThrow(error: FlexError): Promise<void> {
    const delay = error.code === RATE_LIMIT_CODE ? Math.max(backoff, RATE_LIMIT_WAIT_MS) : backoff;
    if (elapsed() + delay > timeoutMs) {
      throw new FlexError(`${error.message} (nach ${Math.round(elapsed() / 1000)} s aufgegeben)`, { code: error.code });
    }
    log(`${error.message} Neuer Versuch in ${Math.round(delay / 1000)} s …`);
    await sleep(delay);
    backoff = Math.min(Math.round(backoff * 1.5), MAX_BACKOFF_MS);
  }

  async function withRetry<T>(step: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await step();
      } catch (error) {
        if (!(error instanceof FlexError) || !error.retryable) throw error;
        await backoffOrThrow(error);
      }
    }
  }

  // Step 1: SendRequest → reference code + statement URL.
  const sendUrl = `${SEND_REQUEST_URL}?${new URLSearchParams({ t: token, q: queryId, v: "3" })}`;
  log(`Flex-Report anfordern: ${redactToken(sendUrl)}`);
  const { referenceCode, statementUrl } = await withRetry(async () => {
    const body = await get(sendUrl);
    const response = parseFlexStatementResponse(body);
    if (!response) throw new FlexError("Unerwartete Antwort von SendRequest (kein <FlexStatementResponse>).");
    if (response.status.toLowerCase() !== "success") throw flexErrorFromCode(response.errorCode, response.errorMessage);
    if (!response.referenceCode || !response.url) {
      throw new FlexError("SendRequest-Antwort ohne ReferenceCode oder Url.");
    }
    if (!isAllowedStatementUrl(response.url)) {
      throw new FlexError(`Unerwartete Statement-URL von IBKR (${response.url}) – Abruf abgebrochen.`);
    }
    return { referenceCode: response.referenceCode, statementUrl: response.url };
  });

  // Step 2: GetStatement, polling while IBKR is still generating the report.
  const getUrl = `${statementUrl}${statementUrl.includes("?") ? "&" : "?"}${new URLSearchParams({ t: token, q: referenceCode, v: "3" })}`;
  log(`Flex-Report abholen: ${redactToken(getUrl)}`);
  return withRetry(async () => {
    const body = await get(getUrl);
    if (/<FlexQueryResponse[\s>]/.test(body)) return body;
    const response = parseFlexStatementResponse(body);
    if (!response) throw new FlexError("Unerwartete Antwort von GetStatement (weder Report noch Statusmeldung).");
    if (response.errorCode === undefined && response.status.toLowerCase() === "warn") {
      throw new FlexError("Statement wird noch erzeugt.", { retryable: true });
    }
    throw flexErrorFromCode(response.errorCode, response.errorMessage);
  });
}
