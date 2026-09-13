import mysql from "../worker/node_modules/mysql2/promise.js";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const c = JSON.parse(
  await readFile(new URL("../etc/config.json", import.meta.url), "utf8"),
);
const db = await mysql.createConnection(c.db);
let id;
try {
  await new Promise((r) => setTimeout(r, 1000));
  const [[u]] = await db.query("SELECT id FROM users WHERE username='admin'");
  const [r] = await db.execute(
    "INSERT INTO jobs(name,slug,prompt,provider,model,mode,effort,status,control,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [
      "Recovery verification",
      "recovery-verification-" + Date.now(),
      "Do not dispatch; recovery fixture.",
      "codex",
      "gpt-6-astra",
      "yolo",
      "low",
      "preparing",
      "pause",
      u.id,
    ],
  );
  id = r.insertId;
  let job;
  for (let n = 0; n < 10; n++) {
    await new Promise((r) => setTimeout(r, 500));
    [[job]] = await db.execute("SELECT status FROM jobs WHERE id=?", [id]);
    if (job.status === "paused") break;
  }
  assert.equal(job.status, "paused");
  console.log(
    "Interrupted dispatch reconciled without launching a worker; pending pause preserved.",
  );
} finally {
  if (id) await db.execute("DELETE FROM jobs WHERE id=?", [id]);
  await db.end();
}
