import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FlexError } from "./errors";
import { normalizeFlexDate, parseFlexNumber, parseFlexStatementResponse, parseFlexXml } from "./parse";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const NOW = new Date("2026-10-10T07:00:00.000Z");

describe("parseFlexXml (synthetic CHF account holding VT)", () => {
  const snapshot = parseFlexXml(fixture("flex-activity.xml"), { now: NOW });

  test("account scalars from AccountInformation and the last NAV row", () => {
    expect(snapshot).toMatchObject({
      source: "flex",
      fetchedAt: "2026-10-10T07:00:00.000Z",
      asOf: "2026-10-09",
      accountId: "U00000000",
      baseCurrency: "CHF",
      netLiquidation: 1698.3,
      cash: 129.36,
      unrealizedPnl: 18.37,
    });
  });

  test("open position uses the SUMMARY row and converts USD → CHF with fxRateToBase", () => {
    expect(snapshot.positions).toEqual([
      {
        symbol: "VT",
        isin: "US9220427424",
        description: "VANGUARD TOT WORLD STK ETF",
        quantity: 15,
        currency: "USD",
        markPrice: 132.4,
        marketValue: 1986,
        marketValueBase: 1568.94, // 1986 × 0.79
        costBasisBase: 1550.57, // 1962.75 × 0.79
        unrealizedPnlBase: 18.37, // 23.25 × 0.79
      },
    ]);
  });

  test("daily NAV history: ascending, unique, base currency", () => {
    const nav = snapshot.navHistory;
    expect(nav).toHaveLength(32);
    expect(nav[0]).toEqual({ date: "2026-08-27", nav: 0 });
    expect(nav[1]).toEqual({ date: "2026-08-28", nav: 850 });
    expect(nav.at(-1)).toEqual({ date: "2026-10-09", nav: 1698.3 });
    const dates = nav.map((n) => n.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test("deposits in CHF; interest is ignored", () => {
    expect(snapshot.deposits).toEqual([
      { date: "2026-08-28", amount: 850 },
      { date: "2026-09-25", amount: 850 },
    ]);
  });

  test("USD dividend and withholding tax are combined and converted to CHF", () => {
    // 6.40 × 0.8 = 5.12; 0.96 × 0.8 = 0.768
    expect(snapshot.dividends).toEqual([{ date: "2026-09-24", symbol: "VT", amount: 5.12, withholdingTax: 0.77 }]);
  });

  test("VT trades only (FX conversions excluded), amountBase = netCash × fxRateToBase", () => {
    expect(snapshot.trades).toEqual([
      { date: "2026-08-31", symbol: "VT", quantity: 8, price: 130.5, currency: "USD", commission: 1, amountBase: -836 },
      { date: "2026-09-28", symbol: "VT", quantity: 7, price: 131.25, currency: "USD", commission: 1, amountBase: -735.8 },
    ]);
  });

  test("yyyy-MM-dd and 'yyyy-MM-dd, HH:mm:ss' date configuration parses identically", () => {
    const iso = fixture("flex-activity.xml")
      .replace(/"(\d{4})(\d{2})(\d{2});(\d{2})(\d{2})(\d{2})"/g, '"$1-$2-$3, $4:$5:$6"')
      .replace(/"(\d{4})(\d{2})(\d{2})"/g, '"$1-$2-$3"');
    expect(iso).toContain('reportDate="2026-10-09"');
    expect(iso).toContain('dateTime="2026-09-24, 20:20:00"');
    expect(parseFlexXml(iso, { now: NOW })).toEqual(snapshot);
  });
});

describe("parseFlexXml edge cases", () => {
  const wrap = (statements: string) =>
    `<FlexQueryResponse queryName="q" type="AF"><FlexStatements count="1">${statements}</FlexStatements></FlexQueryResponse>`;

  test("missing sections give empty arrays; cash falls back to CashReport BASE_SUMMARY", () => {
    const xml = wrap(
      `<FlexStatement accountId="U00000000" fromDate="20251010" toDate="20261009" period="Last365CalendarDays" whenGenerated="20261010;031502">
        <AccountInformation accountId="U00000000" currency="CHF" />
        <CashReport><CashReportCurrency currency="BASE_SUMMARY" endingCash="1,234.5" /></CashReport>
      </FlexStatement>`,
    );
    const s = parseFlexXml(xml, { now: NOW });
    expect(s).toMatchObject({ asOf: "2026-10-09", cash: 1234.5, netLiquidation: 1234.5, unrealizedPnl: 0 });
    expect(s.positions).toEqual([]);
    expect(s.navHistory).toEqual([]);
    expect(s.deposits).toEqual([]);
    expect(s.dividends).toEqual([]);
    expect(s.trades).toEqual([]);
  });

  test("several statements of the same account: the latest one wins", () => {
    const stmt = (to: string, total: string) =>
      `<FlexStatement accountId="U00000000" toDate="${to}"><AccountInformation currency="CHF" />
        <EquitySummaryInBase><EquitySummaryByReportDateInBase reportDate="${to}" cash="1" total="${total}" /></EquitySummaryInBase>
      </FlexStatement>`;
    const s = parseFlexXml(wrap(stmt("20261009", "200") + stmt("20261008", "100")), { now: NOW });
    expect(s.netLiquidation).toBe(200);
    expect(s.asOf).toBe("2026-10-09");
  });

  test("several accounts throw", () => {
    const xml = wrap(
      `<FlexStatement accountId="U00000001"><AccountInformation currency="CHF" /></FlexStatement>
       <FlexStatement accountId="U00000002"><AccountInformation currency="CHF" /></FlexStatement>`,
    );
    expect(() => parseFlexXml(xml)).toThrow(/mehrere Konten \(U00000001, U00000002\)/);
  });

  test("Open Positions with LOT rows only are aggregated", () => {
    const xml = wrap(
      `<FlexStatement accountId="U00000000" toDate="20261009"><AccountInformation currency="CHF" />
        <OpenPositions>
          <OpenPosition symbol="VT" conid="1" currency="USD" fxRateToBase="0.5" position="1" markPrice="100" positionValue="100" costBasisMoney="90" fifoPnlUnrealized="10" levelOfDetail="LOT" />
          <OpenPosition symbol="VT" conid="1" currency="USD" fxRateToBase="0.5" position="2" markPrice="100" positionValue="200" costBasisMoney="210" fifoPnlUnrealized="-10" levelOfDetail="LOT" />
        </OpenPositions>
      </FlexStatement>`,
    );
    const [p] = parseFlexXml(xml).positions;
    expect(p).toMatchObject({ quantity: 3, marketValue: 300, marketValueBase: 150, costBasisBase: 150, unrealizedPnlBase: 0 });
  });

  test("missing fxRateToBase for a foreign currency is a clear error", () => {
    const xml = wrap(
      `<FlexStatement accountId="U00000000"><AccountInformation currency="CHF" />
        <CashTransactions><CashTransaction type="Dividends" currency="USD" amount="1" dateTime="20260924;202000" symbol="VT" /></CashTransactions>
      </FlexStatement>`,
    );
    expect(() => parseFlexXml(xml)).toThrow(/fxRateToBase/);
  });

  test("error envelope throws FlexError with German message", () => {
    let error: unknown;
    try {
      parseFlexXml(fixture("flex-error-1012.xml"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FlexError);
    expect((error as FlexError).code).toBe(1012);
    expect((error as FlexError).message).toContain("Token abgelaufen");
  });

  test("non-Flex XML is rejected", () => {
    expect(() => parseFlexXml("<html><body>Login</body></html>")).toThrow(/FlexQueryResponse/);
  });
});

describe("helpers", () => {
  test("normalizeFlexDate handles yyyyMMdd, yyyy-MM-dd and date-time variants", () => {
    expect(normalizeFlexDate("20260925")).toBe("2026-09-25");
    expect(normalizeFlexDate("2026-09-25")).toBe("2026-09-25");
    expect(normalizeFlexDate("20260925;143000")).toBe("2026-09-25");
    expect(normalizeFlexDate("2026-09-25;14:30:00")).toBe("2026-09-25");
    expect(normalizeFlexDate("2026-09-25, 14:30:00 EDT")).toBe("2026-09-25");
    expect(normalizeFlexDate("20260925 143000")).toBe("2026-09-25");
    expect(normalizeFlexDate(" 20260925 ")).toBe("2026-09-25");
  });

  test("normalizeFlexDate rejects other formats with a hint", () => {
    expect(() => normalizeFlexDate("09/25/2026")).toThrow(/yyyyMMdd/);
    expect(() => normalizeFlexDate("20261325")).toThrow(/Datumsformat/);
    expect(() => normalizeFlexDate("202609251")).toThrow(/Datumsformat/);
  });

  test("parseFlexNumber strips thousands separators", () => {
    expect(parseFlexNumber("1,234.56")).toBe(1234.56);
    expect(parseFlexNumber("-0.74")).toBe(-0.74);
    expect(parseFlexNumber("")).toBeUndefined();
    expect(parseFlexNumber(undefined)).toBeUndefined();
  });

  test("parseFlexStatementResponse accepts <Url> and <url>", () => {
    const xml = (tag: string) =>
      `<FlexStatementResponse timestamp="x"><Status>Success</Status><ReferenceCode>123</ReferenceCode><${tag}>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</${tag}></FlexStatementResponse>`;
    for (const tag of ["Url", "url"]) {
      expect(parseFlexStatementResponse(xml(tag))).toEqual({
        status: "Success",
        referenceCode: "123",
        url: "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement",
        errorCode: undefined,
        errorMessage: undefined,
      });
    }
    expect(parseFlexStatementResponse("<FlexQueryResponse />")).toBeNull();
  });
});
