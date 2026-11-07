import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const realDir = join(root, "data", "test-fixtures");
const fixture = join(root, "lib", "import", "fixtures", "camt053-v08.xml");

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fd-data-"));
  copyFileSync(join(realDir, "transactions.csv"), join(dir, "transactions.csv"));
  copyFileSync(join(realDir, "rules.json"), join(dir, "rules.json"));
  // The camt fixture's statement IBAN is fake — register it as a test account.
  const finance = JSON.parse(readFileSync(join(realDir, "finance.json"), "utf8"));
  finance.accounts.push({ id: "fixture", name: "Fixture", iban: "CH0000700000000000001", type: "cash", balance: 0 });
  writeFileSync(join(dir, "finance.json"), JSON.stringify(finance, null, 2));
  return dir;
}

async function post(filePath: string, mode: "preview" | "commit") {
  // Set before the route module is loaded — the data dir is read per request.
  const { POST } = await import("./route");
  const form = new FormData();
  form.set("file", new File([readFileSync(filePath)], "export.xml"));
  const req = new Request(`http://localhost/api/import?mode=${mode}`, {
    method: "POST",
    body: form,
  });
  const res = await POST(
    Object.assign(req, {
      nextUrl: new URL(req.url),
    }) as never
  );
  return res;
}

describe("POST /api/import", () => {
  test("preview dry-runs and leaves the CSV byte-identical", async () => {
    const dir = makeDataDir();
    process.env.FINANCE_DATA_DIR = dir;
    const before = readFileSync(join(dir, "transactions.csv"));
    const res = await post(fixture, "preview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toBe(false);
    expect(body.parsed).toBeGreaterThan(0);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(Array.isArray(body.uncategorized)).toBe(true);
    expect(readFileSync(join(dir, "transactions.csv"))).toEqual(before);
  });

  test("commit appends new rows to a temp copy", async () => {
    const dir = makeDataDir();
    process.env.FINANCE_DATA_DIR = dir;
    const before = readFileSync(join(dir, "transactions.csv"), "utf8");
    const res = await post(fixture, "commit");
    expect(res.status).toBe(200);
    const body = await res.json();
    const after = readFileSync(join(dir, "transactions.csv"), "utf8");
    if (body.added > 0) {
      expect(body.written).toBe(true);
      expect(after.split("\n").length).toBeGreaterThan(before.split("\n").length);
      expect(after.startsWith(before.slice(0, 200))).toBe(true);
    } else {
      expect(after).toBe(before);
    }
  });

  test("rejects missing file and bad mode", async () => {
    const dir = makeDataDir();
    process.env.FINANCE_DATA_DIR = dir;
    const { POST } = await import("./route");
    const res = await POST(
      Object.assign(
        new Request("http://localhost/api/import?mode=nope", {
          method: "POST",
          body: new FormData(),
        }),
        { nextUrl: new URL("http://localhost/api/import?mode=nope") }
      ) as never
    );
    expect(res.status).toBe(400);
  });
});
