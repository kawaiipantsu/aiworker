const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import { readFile, writeFile } from "node:fs/promises";
import {
  unzipSync,
  strFromU8,
} from "../worker/node_modules/fflate/esm/index.mjs";
import assert from "node:assert/strict";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto((testUrl + "/"));
  await page.locator("#login-form").waitFor();
  const password = (
    await readFile(new URL("../docs/ADMIN_CREDS.md", import.meta.url), "utf8")
  ).match(/^Password: (.+)$/m)[1];
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await page.locator("#lucky").waitFor();
  await page.locator("#lucky").click();
  await page.locator("#lucky-loading").waitFor();
  assert(await page.locator("#lucky").isDisabled());
  await page.screenshot({
    path: new URL("../docs/screenshots/lucky-loading.png", import.meta.url)
      .pathname,
    fullPage: true,
  });
  await page.locator("#project-dialog[open]").waitFor({ timeout: 200000 });
  const form = page.locator("#project-form");
  const name = await form.locator("[name=name]").inputValue(),
    prompt = await form.locator("[name=prompt]").inputValue();
  assert(name.length > 3);
  assert(prompt.length > 200);
  const result = JSON.parse(
    await page.locator("#lucky-json-output").textContent(),
  );
  assert.equal(result.name, name);
  assert.equal(result.initial_prompt, prompt);
  assert.equal(
    await form
      .locator("[name=lucky_id]")
      .inputValue()
      .then((v) => v.length),
    36,
  );
  let zipFiles = 0;
  if (result.scaffold_files.length) {
    assert.equal(
      await form.locator("[name=scaffold_source]").inputValue(),
      "generated",
    );
    const link = await page.locator("#scaffold-download").getAttribute("href");
    const response = await page.request.get((testUrl + "") + link);
    assert.equal(response.status(), 200);
    const files = unzipSync(await response.body());
    zipFiles = Object.keys(files).length;
    for (const file of result.scaffold_files)
      assert.equal(strFromU8(files[file.path]), file.content);
  }
  await page.screenshot({
    path: new URL("../docs/screenshots/lucky-generated.png", import.meta.url)
      .pathname,
    fullPage: true,
  });
  await writeFile(
    new URL("../var/lucky-test-draft.json", import.meta.url),
    JSON.stringify({
      id: await form.locator("[name=lucky_id]").inputValue(),
      name,
      zipFiles,
    }),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      model: "gpt-5.6-terra",
      name,
      category: result.category,
      scaffoldFiles: zipFiles,
      verified: true,
    }),
  );
  // Keep the ready draft for the following creation integration test; never submit the generated workload here.
} finally {
  await browser.close();
}
