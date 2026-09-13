const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto((testUrl + "/"));
  await page.locator("#login-form").waitFor();
  const password = (
    await readFile(new URL("../docs/ADMIN_CREDS.md", import.meta.url), "utf8")
  ).match(/^Password: (.+)$/m)[1];
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await page.locator("[data-view=active].selected").waitFor();
  const active = await page.evaluate(
    async () =>
      (await (await fetch("/api.php?action=jobs&view=active")).json()).jobs,
  );
  assert(
    active.every(
      (j) => !["completed", "cancelled", "failed"].includes(j.status),
    ),
  );
  await page.locator("[data-view=completed]").click();
  await page.locator("[data-view=completed].selected").waitFor();
  await page.locator(".job-row").first().waitFor();
  assert((await page.locator(".job-row").count()) > 0);
  await page.screenshot({
    path: new URL("../docs/screenshots/history-completed.png", import.meta.url)
      .pathname,
    fullPage: true,
  });
  await page.locator("#new").click();
  await page
    .locator("#project-form [name=scaffold_source]")
    .selectOption("url");
  assert(await page.locator("#url-source").isVisible());
  assert(await page.locator("#upload-source").isHidden());
  await page.getByRole("button", { name: "Abort", exact: true }).click();
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await page
    .locator("#openai-status")
    .filter({ hasText: "Not connected" })
    .waitFor();
  await page
    .locator("#openai-key-form [name=api_key]")
    .fill("sk-testfixture-not-a-real-openai-key-12345");
  await page.getByRole("button", { name: "Save API key", exact: true }).click();
  await page
    .locator("#openai-status")
    .filter({ hasText: "API key saved" })
    .waitFor();
  assert.equal(
    await page.locator("#openai-key-form [name=api_key]").inputValue(),
    "",
  );
  const metadata = await page.evaluate(
    async () => await (await fetch("/api.php?action=openai_status")).json(),
  );
  assert(!JSON.stringify(metadata).includes("sk-testfixture"));
  assert.equal(metadata.connection.model, "gpt-5.6-terra");
  await page.locator("#openai-reset").click();
  await page
    .locator("#openai-status")
    .filter({ hasText: "Not connected" })
    .waitFor();
  await page.locator("#openai-login").click();
  await page.locator("#openai-device .device-code").waitFor({ timeout: 45000 });
  assert.match(
    await page.locator("#openai-device a").getAttribute("href"),
    /^https:\/\/auth\.openai\.com\//,
  );
  assert.match(
    await page.locator("#openai-device strong").innerText(),
    /^[A-Za-z0-9-]{4,40}$/,
  );
  console.log(
    "Official OpenAI device-code sign-in appeared in Administration.",
  );
  await page.locator("#openai-cancel-login").click();
  await page.locator("#openai-device").waitFor({ state: "hidden" });
  await page.screenshot({
    path: new URL("../docs/screenshots/openai-admin.png", import.meta.url)
      .pathname,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "History views, ZIP source controls, masked credential storage, reset, device sign-in and cancellation passed.",
  );
} finally {
  await browser.close();
}
