import mysql from "mysql2/promise";
import { createClient } from "redis";
import { readFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ideaPrompt,
  ideaSchema,
  testSchema,
  validateIdea,
  scaffoldZip,
  responsesGenerate,
} from "./lucky-model.mjs";
import { codexGenerate, deviceLogin } from "./lucky-codex.mjs";
import { seal, unseal } from "./lucky-secrets.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await readFile(root + "etc/config.json", "utf8"));
const key = await readFile(root + "etc/secrets.key");
if (key.length !== 32) throw new Error("Credential key must be 32 bytes");
const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 5,
  timezone: "Z",
  dateStrings: true,
});
pool.on("connection", (c) => c.query("SET time_zone='+00:00'"));
const redis = createClient({ url: config.redis });
redis.on("error", () =>
  console.error("Idea service Redis connection unavailable"),
);
await redis.connect();
async function q(sql, args = []) {
  const [rows] = await pool.execute(sql, args);
  return rows;
}
const lock = await pool.getConnection();
const [[held]] = await lock.query("SELECT GET_LOCK('aiworker_ideas',0) AS ok");
if (!held.ok) throw new Error("Idea service already running");
const base = process.env.HOME + "/runtime";
await mkdir(base, { recursive: true, mode: 0o700 });
for (const name of await readdir(base))
  if (name.startsWith("request-"))
    await rm(base + "/" + name, { recursive: true, force: true });
await q(
  "UPDATE openai_logins SET status='failed',user_code=NULL,error='Service restarted. Start sign-in again.' WHERE status IN ('starting','waiting')",
);
await q(
  "UPDATE lucky_drafts SET status='failed',error='Service restarted during generation. Please try again.',finished_at=NOW(3) WHERE status='running'",
);
let stopped = false,
  loginTask = null,
  ideaTask = null,
  loginAbort = null,
  ideaAbort = null,
  currentLogin = null,
  currentIdea = null;
function publicError(error) {
  if (error.name === "AbortError" || error.name === "TimeoutError")
    return "OpenAI request cancelled or timed out. Please try again.";
  const message = String(error.message || "");
  if (
    /^(OpenAI|The OpenAI|This OpenAI|Stored OpenAI|Generated scaffolding)/.test(
      message,
    ) &&
    !/(sk-|access_token|refresh_token)/i.test(message)
  )
    return message.slice(0, 500);
  return "OpenAI request could not be completed. Check the connection in Administration and try again.";
}
async function audit(action, user, id) {
  await q("INSERT INTO audit(user_id,action,target,ip) VALUES(?,?,?,?)", [
    user,
    action,
    id,
    "service",
  ]);
}
async function runLogin(row) {
  const dir = await mkdtemp(base + "/request-");
  const controller = new AbortController();
  loginAbort = controller;
  currentLogin = row;
  const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    await q(
      "UPDATE openai_logins SET status='starting' WHERE id=? AND status='queued'",
      [row.id],
    );
    const auth = await deviceLogin(
      config.codex,
      dir,
      async (info) => {
        await q(
          "UPDATE openai_logins SET status='waiting',verification_url=?,user_code=? WHERE id=? AND status='starting'",
          [info.verificationUrl, info.userCode, row.id],
        );
      },
      controller.signal,
    );
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[connection]] = await conn.execute(
        "SELECT revision FROM openai_connection WHERE id=1 FOR UPDATE",
      );
      const [[login]] = await conn.execute(
        "SELECT status FROM openai_logins WHERE id=? FOR UPDATE",
        [row.id],
      );
      if (
        connection.revision !== row.revision ||
        !["starting", "waiting"].includes(login.status)
      )
        throw new Error("OpenAI sign-in was replaced or cancelled.");
      await conn.execute(
        "UPDATE openai_connection SET mode='chatgpt',credential=?,label='OpenAI account',verified_at=NULL,last_error=NULL,revision=revision+1,updated_by=? WHERE id=1",
        [seal(auth, key), row.user_id],
      );
      await conn.execute(
        "UPDATE openai_logins SET status='completed',user_code=NULL WHERE id=?",
        [row.id],
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    await audit("openai.login_completed", row.user_id, "idea-generator");
  } catch (e) {
    await q(
      "UPDATE openai_logins SET status='failed',user_code=NULL,error=? WHERE id=? AND status IN ('queued','starting','waiting')",
      [publicError(e), row.id],
    );
  } finally {
    clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
    loginAbort = null;
    currentLogin = null;
  }
}
async function runIdea(row) {
  const dir = await mkdtemp(base + "/request-");
  const controller = new AbortController();
  ideaAbort = controller;
  currentIdea = row;
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const changed = await q(
      "UPDATE lucky_drafts SET status='running' WHERE id=? AND status='queued'",
      [row.id],
    );
    if (!changed.affectedRows) return;
    const [connection] = await q("SELECT * FROM openai_connection WHERE id=1");
    if (connection.revision !== row.revision || connection.mode === "none")
      throw new Error("OpenAI connection changed. Start a new request.");
    const credential = unseal(connection.credential, key);
    const recent = await q(
      "SELECT result FROM lucky_drafts WHERE kind='idea' AND status IN ('ready','used') ORDER BY created_at DESC LIMIT 12",
    );
    const names = recent
      .map((r) => {
        try {
          return JSON.parse(r.result).name;
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    const testing = row.kind === "test",
      schema = testing ? testSchema : ideaSchema,
      prompt = testing
        ? 'Reply only with the JSON object {"ok":true}. Do not use tools or inspect any files.'
        : ideaPrompt(!!row.with_scaffold, names);
    let result, refreshed;
    if (connection.mode === "api_key")
      result = await responsesGenerate(credential.api_key, prompt, schema, {
        signal: controller.signal,
        test: testing,
      });
    else {
      const output = await codexGenerate(
        config.codex,
        dir,
        credential,
        prompt,
        schema,
        controller.signal,
      );
      result = output.result;
      refreshed = output.auth;
    }
    if (testing) {
      if (result?.ok !== true)
        throw new Error(
          "OpenAI connection test did not return the expected response.",
        );
      result = { ok: true };
    } else result = validateIdea(result, !!row.with_scaffold);
    const zip = testing ? null : scaffoldZip(result.scaffold_files);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[current]] = await conn.execute(
        "SELECT revision FROM openai_connection WHERE id=1 FOR UPDATE",
      );
      const [[draft]] = await conn.execute(
        "SELECT status FROM lucky_drafts WHERE id=? FOR UPDATE",
        [row.id],
      );
      if (current.revision !== row.revision || draft.status !== "running")
        throw new Error(
          "OpenAI connection changed or the request was cancelled.",
        );
      await conn.execute(
        "UPDATE lucky_drafts SET status='ready',result=?,scaffold=?,finished_at=NOW(3) WHERE id=?",
        [JSON.stringify(result), zip, row.id],
      );
      if (refreshed)
        await conn.execute(
          "UPDATE openai_connection SET credential=?,verified_at=NOW(3),last_error=NULL WHERE id=1",
          [seal(refreshed, key)],
        );
      else
        await conn.execute(
          "UPDATE openai_connection SET verified_at=NOW(3),last_error=NULL WHERE id=1",
        );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    await audit(
      testing ? "openai.test_passed" : "lucky.ready",
      row.user_id,
      row.id,
    );
  } catch (e) {
    const message = publicError(e);
    await q(
      "UPDATE lucky_drafts SET status='failed',error=?,finished_at=NOW(3) WHERE id=? AND status IN ('queued','running')",
      [message, row.id],
    );
    if (!controller.signal.aborted)
      await q(
        "UPDATE openai_connection SET last_error=? WHERE id=1 AND revision=?",
        [message, row.revision],
      );
  } finally {
    clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
    ideaAbort = null;
    currentIdea = null;
  }
}
function shutdown() {
  stopped = true;
  loginAbort?.abort();
  ideaAbort?.abort();
}
lock.connection.on("error", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log("AI Worker idea service ready");
while (!stopped) {
  try {
    await lock.query("SELECT 1");
    await redis.set("ideas:heartbeat", new Date().toISOString(), { EX: 10 });
    const [connection] = await q(
      "SELECT revision FROM openai_connection WHERE id=1",
    );
    if (currentLogin) {
      const [r] = await q("SELECT status FROM openai_logins WHERE id=?", [
        currentLogin.id,
      ]);
      if (
        !r ||
        ["cancelled", "failed"].includes(r.status) ||
        connection.revision !== currentLogin.revision
      )
        loginAbort?.abort();
    }
    if (currentIdea) {
      const [r] = await q("SELECT status FROM lucky_drafts WHERE id=?", [
        currentIdea.id,
      ]);
      if (
        !r ||
        r.status === "cancelled" ||
        connection.revision !== currentIdea.revision
      )
        ideaAbort?.abort();
    }
    if (!loginTask) {
      const [row] = await q(
        "SELECT * FROM openai_logins WHERE status='queued' ORDER BY created_at LIMIT 1",
      );
      if (row)
        loginTask = runLogin(row)
          .catch(() => console.error("Sign-in persistence unavailable"))
          .finally(() => {
            loginTask = null;
          });
    }
    if (!ideaTask) {
      const [row] = await q(
        "SELECT * FROM lucky_drafts WHERE status='queued' ORDER BY created_at LIMIT 1",
      );
      if (row)
        ideaTask = runIdea(row)
          .catch(() => console.error("Idea persistence unavailable"))
          .finally(() => {
            ideaTask = null;
          });
    }
  } catch {
    console.error("Idea service database or Redis unavailable");
    loginAbort?.abort();
    ideaAbort?.abort();
  }
  await new Promise((r) => setTimeout(r, 1000));
}
await Promise.allSettled([loginTask, ideaTask].filter(Boolean));
await redis.del("ideas:heartbeat");
lock.release();
await pool.end();
await redis.quit();
