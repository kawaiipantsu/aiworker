const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  args: [
    "--no-sandbox",

  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
await page.goto((testUrl + "/"));
await page.locator("#login-form").waitFor();
const password = (
  await readFile(new URL("../docs/ADMIN_CREDS.md", import.meta.url), "utf8")
).match(/^Password: (.+)$/m)[1];
await page.getByLabel("Username", { exact: true }).fill("admin");
await page.getByLabel("Password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Sign in →" }).click();
await page.locator("#jobs-body").waitFor();
const ids = JSON.parse(
  await readFile(new URL("../var/smoke-jobs.json", import.meta.url), "utf8"),
);
await page.goto((testUrl + "/#job/") + ids.codexId);
await page.locator("#message-form").waitFor();
if (!process.env.ANSWER_ONLY) {
  await page
    .locator("#message-form textarea")
    .fill(
      'Continue the integration smoke test. Run workload ask "What color should the smoke test use?" and wait for its answer. Then write the answer into ANSWER.txt, verify the file, and finish. This explicitly tests the website question channel. Do not delegate or perform any other work.',
    );
  await page
    .getByRole("button", { name: "Queue message", exact: true })
    .click();
}
await page.locator("form.question").waitFor({ timeout: 180000 });
console.log("Question appeared from resumed Codex session");
await page.locator("form.question textarea").fill("mint");
await page
  .getByRole("button", { name: "Send answer & continue", exact: true })
  .click();
await page.waitForFunction(
  () =>
    document.querySelector("#detail-head .badge")?.textContent === "completed",
  {},
  { timeout: 180000 },
);
await page.screenshot({
  path: new URL("../docs/screenshots/workload.png", import.meta.url).pathname,
  fullPage: true,
});
const j = await page.evaluate(
  async (id) =>
    (await (await fetch("/api.php?action=job&id=" + id)).json()).job,
  ids.codexId,
);
const answer = await readFile(
  "/srv/projects/" + j.slug + "/ANSWER.txt",
  "utf8",
);
assert.equal(answer.trim(), "mint");
console.log("Answer delivered; resumed worker wrote and verified ANSWER.txt");
await browser.close();
