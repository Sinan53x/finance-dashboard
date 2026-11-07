export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Collapses whitespace and removes ZKB order numbers such as "Auftrags-Nr. Z261316246211". */
export function cleanText(value: string): string {
  return collapseWhitespace(value.replace(/[,;]?\s*Auftrags-?Nr\.?:?\s*\S+/gi, " "));
}

const BOOKING_PREFIXES = [
  /^(Online-)?Einkauf ZKB (Visa|Maestro|Debit)[^,]*,\s*/i,
  /^(Belastung|Gutschrift|Rückerstattung|Zahlung|Einzahlung)(en)?(\s[^:]{0,40})?:\s*/i,
];

/**
 * Derives a payee from a ZKB booking text when no counterparty name is available, e.g.
 * "Einkauf ZKB Visa Debit Card Nr. xxxx 4607, Volg Laden Musterdorf 0842" -> "Volg Laden Musterdorf".
 */
export function payeeFromBookingText(value: string): string {
  let payee = cleanText(value);
  for (const prefix of BOOKING_PREFIXES) payee = payee.replace(prefix, "");
  payee = addressFreeName(payee.replace(/^[,\s]+/, ""))
    // Card terminal numbers such as "0842" or "00000".
    .replace(/\s+\d{4,5}$/, "");
  return payee || cleanText(value);
}

/**
 * Drops a trailing address (detected by a 4–5 digit postcode):
 * "Muster GmbH, Musterstrasse 1, 8000 Zürich, CH" -> "Muster GmbH"; keeps "MUSTER, MAX +41790000000".
 */
export function addressFreeName(value: string): string {
  const [first, ...rest] = value.split(",");
  return rest.length > 0 && /(^|[\s,])\d{4,5}(\s|,|$)/.test(rest.join(",")) ? first.trim() : value.trim();
}
