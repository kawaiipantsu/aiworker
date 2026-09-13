const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const creds = await readFile(new URL("docs/ADMIN_CREDS.md", root), "utf8");
const password = creds.match(/^Password: (.+)$/m)[1];
const browser = await chromium.launch({
  args: [
    "--no-sandbox",

  ],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto((testUrl + "/"));
await page.locator("#login-form").waitFor();
await mkdir(new URL("docs/screenshots", root), { recursive: true });
await page.screenshot({
  path: new URL("docs/screenshots/login.png", root).pathname,
  fullPage: true,
});
await page.getByLabel("Username", { exact: true }).fill("admin");
await page.getByLabel("Password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Sign in →" }).click();
await page.locator("#jobs-body").waitFor();
await page.screenshot({
  path: new URL("docs/screenshots/overview.png", root).pathname,
  fullPage: true,
});
// Generator behavior is exercised separately by lucky-live.mjs.
await page.locator("#new").click();
assert.equal(await page.locator("#project-form [name=name]").inputValue(), "");
await page.getByRole("button", { name: "Abort", exact: true }).click();
await page.locator("#new").click();
await page.locator("#project-form [name=name]").fill("Smoke Codex");
await page
  .locator("#project-form [name=prompt]")
  .fill(
    'This is an integration smoke test. Do not delegate. Run workload status "Smoke verification in progress". Write SMOKE_OK.txt containing exactly "codex worker verified". Read it back to verify, then finish with a short confirmation. Do not do any additional work.',
  );
await page.locator("#project-form [name=effort]").selectOption("low");
await page.getByRole("button", { name: "Create workload ↗" }).click();
await page.waitForURL(/#job\/\d+/);
const codexId = Number(page.url().split("/").at(-1));
console.log("Codex smoke workload", codexId);
await page.getByRole("link", { name: "← All workloads" }).click();
await page.locator("#new").click();
await page.locator("#project-form [name=name]").fill("Smoke Claude");
await page.locator("#project-form [name=provider]").selectOption("claude");
await page.locator("#project-form [name=effort]").selectOption("low");
await page
  .locator("#project-form [name=prompt]")
  .fill(
    'This is an integration smoke test. Do not delegate. Run workload status "Smoke verification in progress". Write SMOKE_OK.txt containing exactly "claude worker verified". Read it back to verify, then finish with a short confirmation. Do not do any additional work.',
  );
await page.getByRole("button", { name: "Create workload ↗" }).click();
await page.waitForURL(/#job\/\d+/);
const claudeId = Number(page.url().split("/").at(-1));
console.log("Claude smoke workload", claudeId);
await page.getByRole("link", { name: "Administration", exact: true }).click();
await page.locator("#settings-form").waitFor();
await page.screenshot({
  path: new URL("docs/screenshots/admin.png", root).pathname,
  fullPage: true,
});
await page.locator("[data-user]").first().click();
assert.equal(
  await page.locator("#user-form [name=username]").inputValue(),
  "admin",
);
await page.getByRole("link", { name: "Workloads", exact: true }).click();
await page.locator("#jobs-body").waitFor();
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: new URL("docs/screenshots/mobile.png", root).pathname,
  fullPage: true,
});
assert.equal(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
  true,
);
await writeFile(
  new URL("var/smoke-jobs.json", root),
  JSON.stringify({ codexId, claudeId }),
);
console.log("Browser errors:", errors);
assert.deepEqual(errors, []);
await browser.close();
