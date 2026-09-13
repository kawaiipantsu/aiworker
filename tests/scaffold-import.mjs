const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import mysql from "../worker/node_modules/mysql2/promise.js";
import {
  zipSync,
  strToU8,
  unzipSync,
  strFromU8,
} from "../worker/node_modules/fflate/esm/index.mjs";
import { readFile, writeFile, unlink, rm } from "node:fs/promises";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url),
  config = JSON.parse(await readFile(new URL("etc/config.json", root), "utf8")),
  db = await mysql.createConnection(config.db),
  jobs = [];
const fixture = Buffer.from(
  zipSync({ "fixture.txt": strToU8("public URL import verified") }),
);
const path = new URL("html/assets/import-fixture.bin", root);
await writeFile(path, fixture);
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto((testUrl + "/"));
  await page.locator("#login-form").waitFor();
  const password = (
    await readFile(new URL("docs/ADMIN_CREDS.md", root), "utf8")
  ).match(/^Password: (.+)$/m)[1];
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await page.locator("#new").waitFor();
  const saved = JSON.parse(
    await readFile(new URL("var/lucky-test-draft.json", root), "utf8"),
  );
  async function create(source, extra) {
    return await page.evaluate(
      async ({ source, extra }) => {
        const session = await (await fetch("/api.php?action=session")).json(),
          form = new FormData();
        for (const [k, v] of Object.entries({
          name: "Scaffold transport verification",
          prompt:
            "This is a transport integration fixture. Do not build any project or run any commands. Finish immediately with the required JSON outcome.",
          provider: "codex",
          model: "gpt-5.6-terra",
          mode: "yolo",
          effort: "low",
          scaffold_source: source,
          ...extra,
        }))
          form.set(k, v);
        const r = await fetch("/api.php?action=create", {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf },
          body: form,
        });
        const data = await r.json();
        if (r.ok) {
          await fetch("/api.php?action=control&id=" + data.id, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrf,
            },
            body: JSON.stringify({ command: "cancel" }),
          });
        }
        return { status: r.status, data };
      },
      { source, extra },
    );
  }
  const generated = await create("generated", { lucky_id: saved.id });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  jobs.push(generated.data);
  const [[upload]] = await db.execute(
    "SELECT data,filename FROM uploads WHERE job_id=?",
    [generated.data.id],
  );
  assert.equal(upload.filename, "generated-scaffold.zip");
  assert.equal(Object.keys(unzipSync(upload.data)).length, saved.zipFiles);
  const repeat = await create("generated", { lucky_id: saved.id });
  assert([400, 409].includes(repeat.status));
  const imported = await create("url", {
    zip_url: (testUrl + "/assets/import-fixture.bin"),
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  jobs.push(imported.data);
  const [[remote]] = await db.execute(
    "SELECT data FROM uploads WHERE job_id=?",
    [imported.data.id],
  );
  assert.equal(
    strFromU8(unzipSync(remote.data)["fixture.txt"]),
    "public URL import verified",
  );
  const blocked = await create("url", { zip_url: "http://127.0.0.1:8080/" });
  assert.equal(blocked.status, 400);
  console.log(
    "Generated ZIP and public URL ZIP saved into workload uploads; reused drafts and private URL imports rejected.",
  );
} finally {
  for (const job of jobs) {
    for (let i = 0; i < 25; i++) {
      const [[r]] = await db.execute("SELECT status FROM jobs WHERE id=?", [
        job.id,
      ]);
      if (!r || !["running", "preparing"].includes(r.status)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await db.execute("DELETE FROM jobs WHERE id=?", [job.id]);
    if (/^scaffold-transport-verification-[a-f0-9]+$/.test(job.slug))
      await rm("/srv/projects/" + job.slug, { force: true, recursive: true });
  }
  await unlink(path);
  await browser.close();
  await db.end();
}
