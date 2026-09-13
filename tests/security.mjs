const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  args: [
    "--no-sandbox",

  ],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const base = (testUrl + "");
await page.goto(base);
await page.locator("#login-form").waitFor();
for (const path of [
  "/etc/config.json",
  "/docs/ADMIN_CREDS.md",
  "/.git/config",
  "/worker/service.mjs",
  "/app/schema.sql",
  "/assets/",
]) {
  const status = await page.evaluate(
    async (p) => (await fetch(p)).status,
    path,
  );
  assert([403, 404].includes(status), `${path}: ${status}`);
}
assert.equal(
  await page.evaluate(async () => (await fetch("/api.php?action=jobs")).status),
  401,
);
const password = (
  await readFile(new URL("../docs/ADMIN_CREDS.md", import.meta.url), "utf8")
).match(/^Password: (.+)$/m)[1];
await page.getByLabel("Username", { exact: true }).fill("admin");
await page.getByLabel("Password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Sign in →" }).click();
await page.locator("#jobs-body").waitFor();
assert.equal(
  await page.evaluate(
    async () =>
      (
        await fetch("/api.php?action=settings", {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        })
      ).status,
  ),
  403,
);
const cookies = await ctx.cookies();
const session = cookies.find((c) => c.name === "aiworker_session");
assert(session.secure && session.httpOnly && session.sameSite === "Strict");
const r = await page.evaluate(async () => {
  const s = await (await fetch("/api.php?action=session")).json();
  return (
    await fetch("/api.php?action=webhook_save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf },
      body: JSON.stringify({
        name: "SSRF test",
        url: "http://127.0.0.1:6379",
        enabled: true,
      }),
    })
  ).status;
});
assert.equal(r, 400);
execFileSync("python3", [
  "-c",
  "import zipfile; z=zipfile.ZipFile('/tmp/aiworker-unsafe.zip','w'); z.writestr('../escape.txt','bad'); z.close()",
]);
await page.locator("#new").click();
await page.locator("#project-form [name=name]").fill("Rejected unsafe archive");
await page
  .locator("#project-form [name=prompt]")
  .fill("This archive must not be accepted.");
await page
  .locator("#project-form [name=zip]")
  .setInputFiles("/tmp/aiworker-unsafe.zip");
await page.getByRole("button", { name: "Create workload ↗" }).click();
await page.locator("#project-error").filter({ hasText: "unsafe" }).waitFor();
await page.getByRole("button", { name: "Abort", exact: true }).click();
console.log(
  "Protected paths, authentication, CSRF, cookie flags, webhook SSRF, and ZIP traversal checks passed.",
);
await browser.close();
