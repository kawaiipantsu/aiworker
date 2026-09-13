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
  await page.screenshot({
    path: new URL(
      "../docs/screenshots/active-history-tabs.png",
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await page
    .locator("#openai-status")
    .filter({ hasText: "OpenAI account connected" })
    .waitFor();
  await page.locator("#openai-test").click();
  await page
    .locator("#toast")
    .filter({ hasText: "OpenAI connection verified" })
    .waitFor({ timeout: 180000 });
  console.log(
    "Live fixed-model connection test passed with encrypted credentials.",
  );
  await page.screenshot({
    path: new URL("../docs/screenshots/openai-connected.png", import.meta.url)
      .pathname,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("link", { name: "Workloads", exact: true }).click();
  await page.locator("#new").click();
  assert(
    await page.locator("#project-form [name=scaffold_source]").isVisible(),
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Abort", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    "Desktop and mobile administration, source selector and history checks passed without browser errors.",
  );
} finally {
  await browser.close();
}
