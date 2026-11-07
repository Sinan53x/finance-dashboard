const chfFmt = new Intl.NumberFormat("de-CH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const chfSignedFmt = new Intl.NumberFormat("de-CH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

/** `1'234.56` — de-CH grouping with apostrophe. */
export const chf = (n: number): string => chfFmt.format(n);
export const chfSigned = (n: number): string => chfSignedFmt.format(n);
export const pct = (n: number, digits = 1): string =>
  `${(n * 100).toFixed(digits).replace(".", ",")} %`;

const MONTHS_DE_LONG = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

/** `10. Oktober 2026` */
export function dateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}. ${MONTHS_DE_LONG[m - 1]} ${y}`;
}

/** `25.12.2026` */
export function dateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}



/** `Okt 25` for chart axis labels. */
export function dateAxis(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const short = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"][m - 1];
  return `${short} ${String(y).slice(2)}`;
}

const MONTHS_DE_SHORT = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

/** `Okt 2026` from `"2026-10"` or a full ISO date. */
export function monthShort(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS_DE_SHORT[m - 1]} ${y}`;
}

/** `Oktober 2026` from `"2026-10"` or a full ISO date. */
export function monthLong(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS_DE_LONG[m - 1]} ${y}`;
}

const WEEKDAYS_DE_LONG = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];

/**
 * `Freitag, 9. Oktober` — banking-app day header. The year is appended only
 * when it differs from `currentYear`.
 */
export function dayLabel(iso: string, currentYear: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = WEEKDAYS_DE_LONG[new Date(`${iso}T00:00:00Z`).getUTCDay()];
  return `${wd}, ${d}. ${MONTHS_DE_LONG[m - 1]}${y !== currentYear ? ` ${y}` : ""}`;
}
