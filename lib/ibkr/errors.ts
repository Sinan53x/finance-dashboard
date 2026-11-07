/**
 * Flex Web Service error codes.
 * https://www.interactivebrokers.com/docs/web-api/flex-web-service/error-codes.md
 */

/** "Please try again shortly" – the statement is still being generated or the server is busy. */
export const RETRYABLE_CODES = new Set([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1019, 1021]);

/** Too many requests (1 req/s, 10 req/min per token). */
export const RATE_LIMIT_CODE = 1018;

const GERMAN_MESSAGES: Record<number, string> = {
  1003: "Statement ist nicht verfügbar – Zeitraum der Flex Query prüfen.",
  1010: "Legacy-Flex-Queries werden nicht mehr unterstützt – eine Activity Flex Query anlegen.",
  1011: "Service-Account ist inaktiv – Flex Web Service im Client Portal aktivieren.",
  1012: "Token abgelaufen – neuen Token im Client Portal erzeugen (Performance & Reports → Flex Queries → Flex Web Service Configuration) und im Schlüsselbund ersetzen: security add-generic-password -U -s finance-dashboard-ibkr-flex -a token -w",
  1013: "IP-Beschränkung – der Token ist an eine andere IP-Adresse gebunden. Im Client Portal einen Token ohne bzw. mit der aktuellen IP erzeugen.",
  1014: "Query ist ungültig – Query ID im Schlüsselbund prüfen (finance-dashboard-ibkr-flex / query-id).",
  1015: "Token ist ungültig – Token im Schlüsselbund prüfen oder im Client Portal neu erzeugen und ersetzen: security add-generic-password -U -s finance-dashboard-ibkr-flex -a token -w",
  1016: "Konto ist ungültig – Konto-Auswahl der Flex Query prüfen.",
  1017: "Referenzcode ist ungültig – Abruf erneut starten.",
  1018: "Zu viele Anfragen – IBKR erlaubt 1 Anfrage pro Sekunde und 10 pro Minute. Später erneut versuchen.",
  1020: "Ungültige Anfrage – Token und Query ID prüfen.",
};

export class FlexError extends Error {
  readonly code?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { code?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "FlexError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export function isRetryableCode(code: number | undefined): boolean {
  return code !== undefined && (RETRYABLE_CODES.has(code) || code === RATE_LIMIT_CODE);
}

/** German, user-facing message for a Flex error code (falls back to IBKR's English text). */
export function germanFlexMessage(code: number | undefined, ibkrMessage?: string): string {
  if (code !== undefined && GERMAN_MESSAGES[code]) return `${GERMAN_MESSAGES[code]} [IBKR ${code}]`;
  if (code !== undefined && RETRYABLE_CODES.has(code)) {
    return `IBKR konnte das Statement noch nicht liefern (${code}${ibkrMessage ? `: ${ibkrMessage}` : ""}) – später erneut versuchen.`;
  }
  return `IBKR Flex-Fehler${code !== undefined ? ` ${code}` : ""}${ibkrMessage ? `: ${ibkrMessage}` : ""}`;
}

export function flexErrorFromCode(code: number | undefined, ibkrMessage?: string): FlexError {
  return new FlexError(germanFlexMessage(code, ibkrMessage), { code, retryable: isRetryableCode(code) });
}

/** Replace the token in any URL/query string before it is logged or thrown. */
export function redactToken(text: string): string {
  return text.replace(/([?&]t=)[^&\s"'<>]*/g, "$1***");
}
