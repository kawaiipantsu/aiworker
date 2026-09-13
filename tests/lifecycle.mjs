const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url),
  password = (
    await readFile(new URL("docs/ADMIN_CREDS.md", root), "utf8")
  ).match(/^Password: (.+)$/m)[1];
const browser = await chromium.launch({
  args: [
    "--no-sandbox",

  ],
});
const page = await browser.newPage();
await page.goto((testUrl + "/"));
await page.locator("#login-form").waitFor();
await page.getByLabel("Username", { exact: true }).fill("admin");
await page.getByLabel("Password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Sign in →" }).click();
await page.locator("#jobs-body").waitFor();
async function api(action, data, extra = "") {
  return page.evaluate(
    async ({ action, data, extra }) => {
      const s = await (await fetch("/api.php?action=session")).json();
      const r = await fetch(
        "/api.php?action=" + action + extra,
        data === null
          ? {}
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": s.csrf,
              },
              body: JSON.stringify(data),
            },
      );
      const b = await r.json();
      if (!r.ok) throw Error(b.error);
      return b;
    },
    { action, data, extra },
  );
}
const ids = JSON.parse(
  await readFile(new URL("var/smoke-jobs.json", root), "utf8"),
);
await api(
  "message",
  {
    body: 'Verify SMOKE_OK.txt still contains exactly "claude worker verified". Run workload status "Structured outcome verification complete". Then finish using the required outcome JSON schema. Do not change other files or delegate.',
  },
  "&id=" + ids.claudeId,
);
execFileSync("python3", [
  "-c",
  "import zipfile; z=zipfile.ZipFile('/tmp/aiworker-safe.zip','w'); z.writestr('seed.txt','zip scaffold verified'); z.writestr('nested/base.txt','nested archive path verified'); z.close()",
]);
await page.locator("#new").click();
await page.locator("#project-form [name=name]").fill("Smoke lifecycle");
await page
  .locator("#project-form [name=prompt]")
  .fill(
    'Integration test. Do not delegate. Verify seed.txt equals "zip scaffold verified" and nested/base.txt exists. Run workload status "Ready for lifecycle pause test" and then run sleep 45 in a terminal. Afterwards write LIFECYCLE_OK.txt containing "verified", verify it, and finish using the outcome JSON schema. If resumed and the status already says the pause test ran, skip the sleep and finish.',
  );
await page.locator("#project-form [name=effort]").selectOption("low");
await page
  .locator("#project-form [name=zip]")
  .setInputFiles("/tmp/aiworker-safe.zip");
await page.getByRole("button", { name: "Create workload ↗" }).click();
await page.waitForURL(/#job\/\d+/);
const id = Number(page.url().split("/").at(-1));
await page.waitForFunction(
  () =>
    document
      .querySelector("#logs")
      ?.textContent.includes("Ready for lifecycle pause test"),
  {},
  { timeout: 180000 },
);
await api("control", { command: "pause" }, "&id=" + id);
await page.waitForFunction(
  () => document.querySelector("#detail-head .badge")?.textContent === "paused",
  {},
  { timeout: 30000 },
);
console.log("Running job paused and process group stopped");
await api(
  "message",
  {
    body: "The lifecycle pause test has passed. Skip sleep, verify both scaffold files, write LIFECYCLE_OK.txt with verified, and finish. Do not do other work.",
  },
  "&id=" + id,
);
await api("control", { command: "resume" }, "&id=" + id);
await page.waitForFunction(
  () =>
    document.querySelector("#detail-head .badge")?.textContent === "completed",
  {},
  { timeout: 180000 },
);
const j = (await api("job", null, "&id=" + id)).job;
assert.equal(
  (
    await readFile("/srv/projects/" + j.slug + "/LIFECYCLE_OK.txt", "utf8")
  ).trim(),
  "verified",
);
assert.equal(
  await readFile("/srv/projects/" + j.slug + "/seed.txt", "utf8"),
  "zip scaffold verified",
);
const claude = (await api("job", null, "&id=" + ids.claudeId)).job;
assert.equal(claude.status, "completed");
assert(
  claude.summary !==
    "Worker finished successfully. Review the output and project files.",
);
await writeFile(
  new URL("var/lifecycle-job.json", root),
  JSON.stringify({ id }),
);
console.log(
  "ZIP extraction, pause/resume, saved-session continuation and Claude structured outcome passed.",
);
await browser.close();
