import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { dataDir } from "@/lib/finance/load";
import { importFiles } from "@/lib/import";
import { UNCATEGORISED } from "@/lib/import/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST multipart with `file` (camt.053 XML or ZKB CSV export) and `account`
 * (account id from finance.json; required for CSV — camt.053 detects it from the IBAN).
 * `?mode=preview` dry-runs against the real CSV and returns the would-be rows;
 * `?mode=commit` writes them. Loopback/tailnet-only — no auth.
 */
export async function POST(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode");
  if (mode !== "preview" && mode !== "commit") {
    return NextResponse.json(
      { error: "mode must be preview or commit" },
      { status: 400 }
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large (> 5 MB)" }, { status: 413 });
  }
  const accountField = form!.get("account");
  const account = typeof accountField === "string" && accountField !== "" ? accountField : undefined;

  const ext = file.name.toLowerCase().endsWith(".csv") ? "csv" : "xml";
  const work = join(tmpdir(), `fd-import-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const uploadPath = join(work, `upload.${ext}`);

  try {
    writeFileSync(uploadPath, Buffer.from(await file.arrayBuffer()));
    const dir = dataDir();
    const finance = JSON.parse(readFileSync(join(dir, "finance.json"), "utf8")) as {
      accounts?: { id: string; iban?: string }[];
    };
    const accountIbans = Object.fromEntries(
      (finance.accounts ?? []).filter((a) => a.iban).map((a) => [a.id, a.iban as string]),
    );
    const result = importFiles([uploadPath], {
      csvPath: join(dir, "transactions.csv"),
      rulesPath: join(dir, "rules.json"),
      dryRun: mode === "preview",
      account,
      accountIbans,
    });
    const report = result.files[0];
    return NextResponse.json({
      format: report?.format,
      parsed: report?.parsed ?? 0,
      added: result.added.length,
      skipped: report?.skipped.length ?? 0,
      written: result.written,
      totalRows: result.totalRows,
      rows: result.added,
      uncategorized: result.added.filter(
        (t) => t.category === UNCATEGORISED
      ),
      warnings: report?.warnings ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 }
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
