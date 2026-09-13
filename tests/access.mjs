const testUrl = (process.env.AIWORKER_TEST_URL || "https://aiworker.example.com").replace(/\/$/, "");
import { chromium } from "../worker/node_modules/@playwright/test/index.mjs";
import mysql from "../worker/node_modules/mysql2/promise.js";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
let id;
const config = JSON.parse(
  await readFile(new URL("etc/config.json", root), "utf8"),
);
const db = await mysql.createConnection(config.db);
try {
  const page = await browser.newPage();
  await page.goto((testUrl + "/"));
  await page.locator("#login-form").waitFor();
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in →" }).click();
  await page.locator("#jobs-body").waitFor();
  const username = "test_access_" + randomBytes(5).toString("hex"),
    pw = randomBytes(20).toString("hex");
  async function post(action, body) {
    return page.evaluate(
      async ({ action, body }) => {
        const s = await (await fetch("/api.php?action=session")).json();
        const r = await fetch("/api.php?action=" + action, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": s.csrf,
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw Error(await r.text());
        return r.json();
      },
      { action, body },
    );
  }
  await post("user_save", {
    username,
    password: pw,
    role: "operator",
    active: true,
  });
  [[{ id }]] = await db.execute("SELECT id FROM users WHERE username=?", [
    username,
  ]);
  const operator = await browser.newPage();
  await operator.goto((testUrl + "/"));
  await operator.locator("#login-form").waitFor();
  await operator.getByLabel("Username", { exact: true }).fill(username);
  await operator.getByLabel("Password", { exact: true }).fill(pw);
  await operator.getByRole("button", { name: "Sign in →" }).click();
  await operator.locator("#jobs-body").waitFor();
  assert(await operator.locator("#admin-link").isHidden());
  assert.equal(
    await operator.evaluate(
      async () => (await fetch("/api.php?action=admin")).status,
    ),
    403,
  );
  for (const action of ["openai_status"]) {
    assert.equal(
      await operator.evaluate(
        async (action) => (await fetch("/api.php?action=" + action)).status,
        action,
      ),
      403,
    );
  }
  assert.equal(
    await operator.evaluate(async () => {
      const session = await (await fetch("/api.php?action=session")).json();
      return (
        await fetch("/api.php?action=openai_reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: "{}",
        })
      ).status;
    }),
    403,
  );
  for (const action of ["job_delete", "retention"]) {
    assert.equal(
      await operator.evaluate(async (action) => {
        const session = await (await fetch("/api.php?action=session")).json();
        return (
          await fetch("/api.php?action=" + action, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrf,
            },
            body: "{}",
          })
        ).status;
      }, action),
      403,
    );
  }
  const [drafts] = await db.query(
    "SELECT id FROM lucky_drafts WHERE user_id<>? LIMIT 1",
    [id],
  );
  if (drafts.length)
    for (const action of ["lucky_status", "lucky_scaffold"])
      assert.equal(
        await operator.evaluate(
          async ({ action, id }) =>
            (await fetch("/api.php?action=" + action + "&draft=" + id)).status,
          { action, id: drafts[0].id },
        ),
        404,
      );
  await post("user_save", {
    id,
    username,
    password: "",
    role: "operator",
    active: false,
  });
  assert.equal(
    await operator.evaluate(
      async () => (await fetch("/api.php?action=jobs")).status,
    ),
    401,
  );
  console.log(
    "Operator administrator access denied; disabling account revoked active session.",
  );
} finally {
  if (id) await db.execute("DELETE FROM users WHERE id=?", [id]);
  await db.end();
  await browser.close();
}
