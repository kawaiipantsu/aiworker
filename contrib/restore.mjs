#!/usr/local/bin/node
// Explicit restore into the configured database. Stop aiworker and pause web writes first.
import mysql from "../worker/node_modules/mysql2/promise.js";
import { readFile } from "node:fs/promises";
if (process.argv.length !== 4 || process.argv[2] !== "--replace-database")
  throw new Error("Usage: restore.mjs --replace-database /path/to/backup.sql");
const config = JSON.parse(
  await readFile(new URL("../etc/config.json", import.meta.url), "utf8"),
);
const sql = await readFile(process.argv[3], "utf8");
const db = await mysql.createConnection({
  ...config.db,
  multipleStatements: true,
});
try {
  await db.query(sql);
  console.log("Database restored.");
} finally {
  await db.end();
}
