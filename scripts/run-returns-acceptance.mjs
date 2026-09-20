import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reuse the API's ownership-guarded disposable stack runner without modifying its checkout.
// Its own HTTP/SQL acceptance runs first; POS acceptance receives only a local test session.
const posRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const apiRoot = resolve(
  process.env.COMMERCE_API_CHECKOUT ?? join(posRoot, "../clothing-commerce-api"),
);
let runner = readFileSync(join(apiRoot, "scripts/test-returns.mjs"), "utf8");
const rootLine = "const root = dirname(dirname(fileURLToPath(import.meta.url)));";
const success = '"Returns/refunds database, RLS, concurrency and real API acceptance passed.\\n",';
if (
  !runner.includes(rootLine) ||
  !runner.includes(success) ||
  !runner.includes("./returns-test-resources.mjs")
)
  throw new Error("API acceptance runner changed; review adapter before running");
runner = runner
  .replace(rootLine, `const root = ${JSON.stringify(apiRoot)};`)
  .replace(
    '"./returns-test-resources.mjs"',
    JSON.stringify(pathToFileURL(join(apiRoot, "scripts/returns-test-resources.mjs")).href),
  );
const insertion = `
    // Disposable fixture only: allow the test operator to verify stock via the public SDK.
    resources.assertOwner();
    sql("insert into public.role_permissions(tenant_id,role_id,permission_id) select '2a000001-0000-4000-8000-000000000001'::uuid,'2a000013-0000-4000-8000-000000000001'::uuid,id from public.permissions where key='inventory.read' on conflict do nothing;");
    const posCheck = spawnSync(process.execPath, [${JSON.stringify(join(posRoot, "node_modules/vitest/vitest.mjs"))}, "run", "tests/runtime-returns", "--no-file-parallelism", "--testTimeout=60000", "--hookTimeout=60000"], {
      cwd: ${JSON.stringify(posRoot)}, windowsHide: true, stdio: "inherit",
      env: { ...process.env, POS_RETURNS_TEST_URL: baseUrl, POS_RETURNS_TEST_TOKEN: token }
    });
    if (posCheck.status !== 0) throw new Error("POS packed SDK runtime acceptance failed");
`;
const anchor = "    process.stdout.write(\n      " + success;
// Normalize checkout CRLF without changing any safety logic.
runner = runner.replaceAll("\r\n", "\n");
if (!runner.includes(anchor)) throw new Error("Missing API acceptance insertion point");
runner = runner.replace(anchor, insertion + anchor);
const directory = mkdtempSync(join(tmpdir(), "pos-returns-runner-"));
const file = join(directory, "run.mjs");
writeFileSync(file, runner);
try {
  const result = spawnSync(process.execPath, [file], {
    cwd: apiRoot,
    windowsHide: true,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  // Exact owned file only. Non-recursive removal fails if anything unexpected remains.
  unlinkSync(file);
  rmdirSync(directory);
}
