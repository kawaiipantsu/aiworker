#!/usr/local/bin/node
// Consistent, streaming database backup. Secrets never appear in process arguments.
import mysql from "../worker/node_modules/mysql2/promise.js";
import { readFile, mkdir, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
const root = new URL("../", import.meta.url);
const config = JSON.parse(
  await readFile(new URL("etc/config.json", root), "utf8"),
);
const dir = new URL("var/backups/", root);
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const file = new URL(
  `aiworker-${new Date().toISOString().replaceAll(":", "-")}.sql`,
  dir,
);
const out = createWriteStream(file, { mode: 0o600 });
out.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
const db = await mysql.createConnection({
  ...config.db,
  timezone: "Z",
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
});
await db.query("SET time_zone='+00:00'");
await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
await db.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
async function write(s) {
  if (!out.write(s)) await once(out, "drain");
}
try {
  await write(
    "-- AI Worker consistent database backup\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET time_zone='+00:00';\n",
  );
  const [tables] = await db.query("SHOW TABLES");
  for (const row of tables) {
    const table = Object.values(row)[0];
    if (!/^[a-z_]+$/.test(table)) throw new Error("Unexpected table name");
    const ident = "`" + table + "`";
    const [[ddl]] = await db.query("SHOW CREATE TABLE " + ident);
    await write(`DROP TABLE IF EXISTS ${ident};\n${ddl["Create Table"]};\n`);
    const stream = db.connection
      .query("SELECT * FROM " + ident)
      .stream({ highWaterMark: 5 });
    for await (const record of stream) {
      const cols = Object.keys(record)
        .map((k) => "`" + k + "`")
        .join(",");
      const values = Object.values(record)
        .map((v) =>
          Buffer.isBuffer(v) ? "X'" + v.toString("hex") + "'" : db.escape(v),
        )
        .join(",");
      await write(`INSERT INTO ${ident} (${cols}) VALUES (${values});\n`);
    }
  }
  await write("SET FOREIGN_KEY_CHECKS=1;\n");
  out.end();
  await once(out, "finish");
  await db.commit();
  console.log(file.pathname);
} catch (e) {
  out.destroy();
  await db.rollback();
  throw e;
} finally {
  await db.end();
}
