const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import mysql from "../worker/node_modules/mysql2/promise.js";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const root = new URL("../", import.meta.url);
const config = JSON.parse(
  await readFile(new URL("etc/config.json", root), "utf8"),
);
const db = await mysql.createConnection(config.db);
await db.execute("SET time_zone='+00:00'");
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const tag = "history-test-" + randomBytes(4).toString("hex");
const ids = [],
  paths = [];
const [oldSettings] = await db.execute(
  "SELECT * FROM settings WHERE `key` IN ('cancelled_cleanup_enabled','cancelled_retention_days')",
);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function post(action, body = {}, id = "") {
  return page.evaluate(
    async ({ action, body, id }) => {
      const s = await (await fetch("/api.php?action=session")).json();
      const r = await fetch("/api.php?action=" + action + "&id=" + id, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
    { action, body, id },
  );
}
async function fixture(status, age, name = tag) {
  const slug = tag + "-" + ids.length;
  const [r] = await db.execute(
    "INSERT INTO jobs(name,slug,prompt,provider,model,mode,effort,status,created_by,finished_at,summary) VALUES(?,?,?,'codex','gpt-5.6-terra','yolo','medium',?,(SELECT id FROM users WHERE username='admin'),DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY),?)",
    [
      name,
      slug,
      "Fixture only. Never run.",
      status,
      age,
      "Built a test artifact.\nVerified export formatting and retention.",
    ],
  );
  ids.push(r.insertId);
  return { id: r.insertId, slug };
}
try {
  await page.goto((testUrl + "/"));
  const password = (
    await readFile(new URL("docs/ADMIN_CREDS.md", root), "utf8")
  ).match(/^Password: (.+)$/m)[1];
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await page.locator("#jobs-body").waitFor();
  const manual = await fixture("cancelled", 0),
    old = await fixture("cancelled", 31),
    recent = await fixture("cancelled", 29),
    failed = await fixture("failed", 40),
    done = await fixture("completed", 40, "=SUM(1,2) " + tag);
  for (const job of [manual, old]) {
    const path = "/srv/projects/" + job.slug;
    paths.push(path);
    await mkdir(path, { mode: 0o770 });
    execFileSync("chown", ["aiworker:aiworker", path]);
    await symlink("/etc", path + "/outside");
  }
  assert.equal((await post("job_delete", {}, done.id)).status, 409);
  await page.goto((testUrl + "/#job/") + manual.id);
  await page.locator("#delete-project").waitFor();
  page.once("dialog", (d) => d.accept());
  await page.locator("#delete-project").click();
  await page.locator("[data-view=closed].selected").waitFor();
  assert.equal(
    (await post("control", { command: "resume" }, manual.id)).status,
    409,
  );
  assert.equal(
    (await post("message", { body: "Try to resume" }, manual.id)).status,
    409,
  );
  assert.equal(
    (await post("retention", { enabled: false, days: 0 })).status,
    400,
  );
  assert.equal(
    (await post("retention", { enabled: false, days: 30 })).status,
    200,
  );
  execFileSync("systemctl", ["start", "aiworker-retention.service"]);
  assert.equal(
    (await db.execute("SELECT id FROM jobs WHERE id=?", [manual.id]))[0].length,
    0,
  );
  assert.equal(
    (await db.execute("SELECT id FROM jobs WHERE id=?", [old.id]))[0].length,
    1,
  );
  await assert.rejects(stat("/srv/projects/" + manual.slug), {
    code: "ENOENT",
  });
  assert((await stat("/etc/passwd")).isFile());
  assert.equal(
    (await post("retention", { enabled: true, days: 30 })).status,
    200,
  );
  execFileSync("systemctl", ["start", "aiworker-retention.service"]);
  assert.equal(
    (await db.execute("SELECT id FROM jobs WHERE id=?", [old.id]))[0].length,
    0,
  );
  for (const job of [recent, failed, done])
    assert.equal(
      (await db.execute("SELECT id FROM jobs WHERE id=?", [job.id]))[0].length,
      1,
    );
  await post("retention", { enabled: false, days: 30 });
  for (let i = 0; i < 51; i++)
    await fixture("completed", 1, tag + " export row " + i);
  const otherProvider = await fixture("completed", 1, tag + " other provider");
  await db.execute("UPDATE jobs SET provider='claude' WHERE id=?", [
    otherProvider.id,
  ]);
  await page.locator("[data-view=completed]").click();
  await page.locator("#provider-filter").selectOption("codex");
  await page.locator("#search").fill(tag);
  await page.waitForTimeout(600);
  assert(await page.locator("#export-csv").isVisible());
  for (const format of ["csv", "pdf"]) {
    const href = await page.locator("#export-" + format).getAttribute("href");
    const response = await page.request.get((testUrl + "") + href);
    assert.equal(response.status(), 200, await response.text());
    const body = await response.body();
    if (format === "csv") {
      assert(body.toString().includes("'=SUM(1,2)"));
      assert(!body.toString().includes("," + recent.slug + ","));
      assert(!body.toString().includes(otherProvider.slug));
      for (let i = 0; i < 51; i++)
        assert(body.toString().includes(tag + " export row " + i));
    } else {
      assert.equal(body.subarray(0, 5).toString(), "%PDF-");
      await writeFile(
        new URL("docs/screenshots/completed-report-test.pdf", root),
        body,
      );
      const text = execFileSync(
        "pdftotext",
        [
          new URL("docs/screenshots/completed-report-test.pdf", root).pathname,
          "-",
        ],
        { encoding: "utf8" },
      );
      assert(text.includes("52 completed projects"));
      assert(text.includes(tag + " export row 50"));
      assert(!text.includes(otherProvider.slug));
    }
  }
  await page.screenshot({
    path: new URL("docs/screenshots/completed-exports.png", root).pathname,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await page.locator("#retention-form").waitFor();
  assert.equal(
    await page.locator("#retention-form [name=days]").inputValue(),
    "30",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Manual deletion, resume protection, symlink safety, optional 30-day retention, completed/failed preservation, CSV formula escaping, PDF download and browser checks passed.",
  );
} finally {
  await db.execute(
    "DELETE FROM settings WHERE `key` IN ('cancelled_cleanup_enabled','cancelled_retention_days')",
  );
  for (const row of oldSettings)
    await db.execute("INSERT INTO settings(`key`,value) VALUES(?,?)", [
      row.key,
      row.value,
    ]);
  for (const id of ids) await db.execute("DELETE FROM jobs WHERE id=?", [id]);
  for (const path of paths) await rm(path, { recursive: true, force: true });
  await db.end();
  await browser.close();
}
