import mysql from "mysql2/promise";
import { createClient } from "redis";
import {
  readFile,
  mkdir,
  writeFile,
  lstat,
  chmod,
  rename,
  rm,
} from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Beanstalk } from "./queue.mjs";
import {
  command,
  classifyFailure,
  describeEvent,
  providerError,
  outcomeFromEvent,
} from "./providers.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const config = JSON.parse(await readFile(root + "/etc/config.json", "utf8"));
const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 12,
  timezone: "Z",
  charset: "utf8mb4",
  dateStrings: true,
});
pool.on("connection", (connection) =>
  connection.query("SET time_zone='+00:00'"),
);
const redis = createClient({ url: config.redis });
redis.on("error", (e) => console.error("Redis:", e.message));
await redis.connect();
const queue = new Beanstalk(config.beanstalk),
  active = new Map();
let stopping = false,
  settings = {},
  lastWebhooks = 0,
  webhookTask = null;
const runFile = promisify(execFile);
async function q(sql, args = []) {
  const [rows] = await pool.execute(sql, args);
  return rows;
}
function clean(s) {
  return String(s)
    .replaceAll(config.db.password, "[redacted]")
    .replace(
      /https:\/\/discord\.com\/api\/webhooks\/\S+/g,
      "[webhook redacted]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]+)\b/g,
      "[redacted]",
    );
}
async function event(id, kind, body) {
  await q("INSERT INTO events(job_id,kind,body) VALUES(?,?,?)", [
    id,
    kind,
    clean(body).slice(0, 200000),
  ]);
}
async function status(id, state, summary) {
  await q(
    "UPDATE jobs SET status=?,summary=?,finished_at=IF(? IN ('completed','failed','cancelled'),NOW(3),NULL) WHERE id=?",
    [state, clean(summary).slice(0, 3000), state, id],
  );
  await event(id, "status", state + ": " + summary);
  await q(
    "INSERT INTO webhook_deliveries(webhook_id,job_id,status) SELECT id,?,? FROM webhooks WHERE enabled=1",
    [id, state],
  );
}
async function loadSettings() {
  settings = Object.fromEntries(
    (await q("SELECT * FROM settings")).map((r) => [
      r.key,
      JSON.parse(r.value),
    ]),
  );
}
async function workspace(job) {
  const dir = config.projects + "/" + job.slug;
  if (!/^[a-z0-9-]+$/.test(job.slug)) throw new Error("Invalid workspace slug");
  let exists = false;
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new Error("Unsafe workspace");
    exists = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!exists) {
    const stage = config.projects + "/.aiworker-stage-" + job.id;
    // This deterministic staging path is reserved to this job; final workspaces are never removed.
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { mode: 0o770 });
    await runFile(
      "/usr/bin/php",
      [root + "/contrib/extract.php", String(job.id), stage],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    await rename(stage, dir);
  }

  const docs = dir + "/docs";
  try {
    const st = await lstat(docs);
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new Error("Unsafe docs directory");
  } catch (e) {
    if (e.code === "ENOENT") await mkdir(docs, { mode: 0o770 });
    else throw e;
  }
  for (const file of ["INIT_PROMPT.md", "WORKLOAD_DETAILS.md"]) {
    try {
      const st = await lstat(docs + "/" + file);
      if (st.isSymbolicLink() || !st.isFile())
        throw new Error("Unsafe documentation file");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await writeFile(docs + "/INIT_PROMPT.md", job.prompt + "\n", { mode: 0o660 });
  await writeFile(
    docs + "/WORKLOAD_DETAILS.md",
    `# ${job.name}\n\n- Workload ID: ${job.id}\n- Workspace: ${dir}\n- Provider: ${job.provider}\n- Model: ${job.model}\n- Run mode: ${job.mode}\n- Thinking: ${job.effort}\n- Agents: ${!!job.agents}\n- Dynamic workload: ${!!job.dynamic_work}\n- Created: ${job.created_at} UTC\n- Dashboard: ${config.url}/#job/${job.id}\n\nThe database is authoritative. Initial prompt: INIT_PROMPT.md.\n`,
    { mode: 0o660 },
  );
  return dir;
}
function instructions(job) {
  return `You were launched autonomously by AI Worker (${config.url}/#job/${job.id}). Workload: ${job.name}. Your workspace is ${config.projects}/${job.slug}.\nMake implementation decisions yourself, complete the requested work, and validate the result. Avoid user interaction unless genuinely blocked by missing information. Full-access modes authorize the requested workload, not unrelated destructive changes. Do not alter the AI Worker control plane or other projects.\nKeep the dashboard informed: run '/opt/aiworker/bin/workload status "short progress update"' at milestones and at completion. Run '/opt/aiworker/bin/workload inbox' regularly to read additional user instructions. If essential information is missing, run '/opt/aiworker/bin/workload ask "one clear question"'; it waits for the website answer. Do not ask through an interactive terminal. Write a concise final result with validation and limitations, using the required outcome JSON schema. Only report completed after actually validating the requested result. Report blocked with one clear question if essential user input is missing, or failed for an execution/tool failure.\n${job.agents ? "You may delegate bounded tasks to subagents." : "Do not spawn or delegate to subagents."}\n${job.dynamic_work ? "Dynamic workload is enabled: maintain docs/TASKS.md as a living task list, expand tasks as you learn, and continue until all requirements and validation are complete. This is a workflow instruction, not a CLI extension." : ""}\nRead docs/INIT_PROMPT.md and docs/WORKLOAD_DETAILS.md.\n`;
}
async function start(job) {
  const state = {
    job,
    child: null,
    control: null,
    tail: "",
    chain: Promise.resolve(),
    failed: false,
    runtimeError: false,
    finalOutcome: null,
    pendingWrites: 0,
  };
  active.set(job.id, state);
  try {
    const dir = await workspace(job);
    await status(job.id, "running", "Worker starting");
    const messages = await q(
      "SELECT id,body FROM messages WHERE job_id=? AND delivered_at IS NULL ORDER BY id",
      [job.id],
    );
    const prompt =
      instructions(job) +
      "\n" +
      (job.session_id
        ? "Continue from the saved session. Inspect existing work and finish outstanding requirements."
        : job.prompt) +
      (messages.length
        ? "\nAdditional user instructions:\n" +
          messages.map((m) => m.body).join("\n\n")
        : "");
    const spec = command(job, config);
    await event(
      job.id,
      "system",
      `Starting ${job.provider} · ${job.model} · ${job.mode} · attempt ${job.attempts}`,
    );
    const child = spawn(spec.file, spec.args, {
      cwd: dir,
      detached: true,
      env: {
        ...process.env,
        ...spec.env,
        AIWORKER_JOB_ID: String(job.id),
        PATH: "/opt/aiworker/bin:/usr/local/bin:/usr/bin:/bin",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.child = child;
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.once("spawn", () => {
      state.chain = state.chain.then(async () => {
        for (const m of messages)
          await q("UPDATE messages SET delivered_at=NOW(3) WHERE id=?", [m.id]);
      });
    });
    let stdout = "",
      stderr = "";
    const consume = (line, kind) => {
      if (!line.trim()) return;
      state.pendingWrites++;
      if (state.pendingWrites > 128) {
        child.stdout.pause();
        child.stderr.pause();
      }
      state.chain = state.chain
        .then(async () => {
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {}
          if (obj) {
            if (obj.type === "error" || obj.item?.type === "error")
              state.runtimeError = true;
            const outcome = outcomeFromEvent(obj);
            if (outcome) state.finalOutcome = outcome;
            const sid = obj.thread_id || obj.session_id;
            if (sid && /^[a-zA-Z0-9-]{8,100}$/.test(sid)) {
              job.session_id = sid;
              await q("UPDATE jobs SET session_id=? WHERE id=?", [sid, job.id]);
            }
            if (
              obj.type === "error" ||
              obj.type === "turn.failed" ||
              obj.is_error
            )
              state.failed = true;
            if (
              obj.type === "turn.completed" ||
              (obj.type === "result" && !obj.is_error)
            ) {
              state.failed = false;
              state.tail = "";
            }
            // Limit classification only examines provider errors/results, never ordinary tool output.
            const providerFailure = providerError(obj);
            if (providerFailure)
              state.tail = (state.tail + "\n" + providerFailure).slice(-40000);
            await event(job.id, kind, describeEvent(obj));
          } else {
            if (kind === "stderr")
              state.tail = (state.tail + "\n" + line).slice(-40000);
            await event(job.id, kind, line);
          }
        })
        .catch((e) => {
          console.error("Output persistence:", e.message);
          state.failed = true;
          state.persistenceError = true;
          stopChild(state, "persistence");
        })
        .finally(() => {
          state.pendingWrites--;
          if (state.pendingWrites < 64) {
            child.stdout.resume();
            child.stderr.resume();
          }
        });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      let i;
      while ((i = stdout.indexOf("\n")) >= 0) {
        consume(stdout.slice(0, i), "output");
        stdout = stdout.slice(i + 1);
      }
      if (stdout.length > 200000) {
        consume(stdout.slice(0, 200000), "output");
        stdout = stdout.slice(200000);
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
      let i;
      while ((i = stderr.indexOf("\n")) >= 0) {
        consume(stderr.slice(0, i), "stderr");
        stderr = stderr.slice(i + 1);
      }
      if (stderr.length > 200000) {
        consume(stderr.slice(0, 200000), "stderr");
        stderr = stderr.slice(200000);
      }
    });
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: -1, error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (stdout) consume(stdout, "output");
    if (stderr) consume(stderr, "stderr");
    await state.chain;
    if (state.killTimer) clearTimeout(state.killTimer);
    if (result.error) throw result.error;
    // Serialize completion with incoming answers/messages and UI control requests.
    const conn = await pool.getConnection();
    let next, summary;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        "SELECT * FROM jobs WHERE id=? FOR UPDATE",
        [job.id],
      );
      const latest = rows[0];
      const control = latest.control || state.control;
      const failure =
        result.code !== 0 || state.failed
          ? classifyFailure(
              state.tail,
              settings.retry_seconds || 300,
              (job.rate_attempts || 0) + 1,
            )
          : null;
      if (control === "cancel") {
        next = "cancelled";
        summary = "Cancelled by user";
      } else if (control === "pause") {
        next = "paused";
        summary = "Paused by user; resume continues the saved session";
      } else if (
        control === "steer" ||
        control === "shutdown" ||
        control === "persistence"
      ) {
        next = "queued";
        summary = "Session interrupted; queued to continue";
      } else if (failure) {
        next = "rate_limited";
        summary = "Provider limit reached; automatic retry scheduled";
        await conn.execute(
          "UPDATE jobs SET rate_attempts=rate_attempts+1,retry_at=DATE_ADD(NOW(3),INTERVAL ? SECOND) WHERE id=?",
          [Math.ceil(failure.delay), job.id],
        );
        await conn.execute(
          "UPDATE provider_state SET cooldown_until=GREATEST(COALESCE(cooldown_until,NOW(3)),DATE_ADD(NOW(3),INTERVAL ? SECOND)),reason=? WHERE provider=?",
          [Math.ceil(failure.delay), clean(failure.reason), job.provider],
        );
      } else {
        const [questions] = await conn.execute(
          "SELECT id FROM questions WHERE job_id=? AND answer IS NULL LIMIT 1",
          [job.id],
        );
        const [pending] = await conn.execute(
          "SELECT id FROM messages WHERE job_id=? AND delivered_at IS NULL LIMIT 1",
          [job.id],
        );
        if (questions.length) {
          next = "waiting_input";
          summary = "Waiting for an answer on the workload page";
        } else if (pending.length) {
          next = "queued";
          summary = "Continuing with additional user instructions";
        } else if (result.code !== 0 || state.failed || state.runtimeError) {
          next = "failed";
          summary =
            result.code === 0
              ? "Worker reported an execution error. See output for details."
              : `Worker exited with ${result.code ?? result.signal}. See output for details; retry after resolving the error.`;
        } else if (state.finalOutcome?.outcome === "blocked") {
          next = "waiting_input";
          summary = state.finalOutcome.summary;
          await conn.execute(
            "INSERT INTO questions(job_id,question) VALUES(?,?)",
            [job.id, state.finalOutcome.question || summary],
          );
        } else if (state.finalOutcome?.outcome === "completed") {
          next = "completed";
          summary = state.finalOutcome.summary;
        } else {
          next = "failed";
          summary =
            state.finalOutcome?.summary ||
            "Worker ended without a validated outcome report. Review its output before retrying.";
        }
      }
      if (next === "completed")
        await conn.execute("UPDATE jobs SET rate_attempts=0 WHERE id=?", [
          job.id,
        ]);
      summary = clean(summary).slice(0, 3000);
      await conn.execute(
        "UPDATE jobs SET status=?,control=NULL,queued_at=NULL,summary=?,finished_at=IF(? IN ('completed','failed','cancelled'),NOW(3),NULL) WHERE id=?",
        [next, summary, next, job.id],
      );
      await conn.execute(
        "INSERT INTO webhook_deliveries(webhook_id,job_id,status) SELECT id,?,? FROM webhooks WHERE enabled=1",
        [job.id, next],
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    await event(job.id, "status", next + ": " + summary);
  } catch (e) {
    console.error("Job", job.id, e.message);
    try {
      await status(job.id, "failed", e.message);
    } catch {}
  } finally {
    active.delete(job.id);
  }
}
function stopChild(state, reason) {
  if (!state.child || state.control) return;
  state.control = reason;
  try {
    process.kill(-state.child.pid, "SIGTERM");
  } catch {}
  state.killTimer = setTimeout(() => {
    try {
      process.kill(-state.child.pid, "SIGKILL");
    } catch {}
  }, 10000);
}
async function dispatch() {
  await queue.connect();
  await redis.set("worker:queue", "ok", { EX: 15 });
  for (const provider of ["codex", "claude"]) {
    const available = Math.max(
      0,
      Number(settings["parallel_" + provider] || 1) -
        [...active.values()].filter((s) => s.job.provider === provider).length,
    );
    if (!available) continue;
    const jobs = await q(
      "SELECT j.id FROM jobs j JOIN provider_state p ON p.provider=j.provider WHERE j.provider=? AND j.status IN ('queued','rate_limited') AND (j.retry_at IS NULL OR j.retry_at<=NOW(3)) AND (p.cooldown_until IS NULL OR p.cooldown_until<=NOW(3)) AND (j.queued_at IS NULL OR j.queued_at<DATE_SUB(NOW(3),INTERVAL 60 SECOND)) ORDER BY j.id LIMIT " +
        Math.min(16, available),
      [provider],
    );
    for (const j of jobs) {
      await queue.put(j.id);
      await q("UPDATE jobs SET queued_at=NOW(3) WHERE id=?", [j.id]);
    }
  }
  for (let i = 0; i < 100; i++) {
    const item = await queue.reserve();
    if (!item) break;
    let id;
    try {
      id = JSON.parse(item.body).id;
    } catch {}
    if (!Number.isSafeInteger(id) || id <= 0) {
      await queue.delete(item.queueId);
      continue;
    }
    const conn = await pool.getConnection();
    let job;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        "SELECT j.* FROM jobs j JOIN provider_state p ON p.provider=j.provider WHERE j.id=? AND j.status IN ('queued','rate_limited') AND (j.retry_at IS NULL OR j.retry_at<=NOW(3)) AND (p.cooldown_until IS NULL OR p.cooldown_until<=NOW(3)) FOR UPDATE",
        [id],
      );
      job = rows[0];
      if (job) {
        const count = [...active.values()].filter(
          (s) => s.job.provider === job.provider,
        ).length;
        if (count >= Number(settings["parallel_" + job.provider] || 1)) {
          await conn.execute("UPDATE jobs SET queued_at=NULL WHERE id=?", [id]);
          job = null;
        } else {
          await conn.execute(
            "UPDATE jobs SET status='preparing',attempts=attempts+1,started_at=NOW(3),retry_at=NULL,control=NULL WHERE id=?",
            [id],
          );
          job.attempts++;
        }
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    if (job) void start(job);
    await queue.delete(item.queueId);
  }
}
async function deliverWebhooks() {
  const rows = await q(
    "SELECT d.*,w.url,j.name FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id JOIN jobs j ON j.id=d.job_id WHERE d.delivered_at IS NULL AND d.next_at<=NOW(3) AND w.enabled=1 ORDER BY d.id LIMIT 10",
  );
  for (const d of rows) {
    try {
      if (
        !/^https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.test(
          d.url,
        )
      )
        throw new Error("Invalid webhook URL");
      const r = await fetch(d.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "AI Worker",
          avatar_url: config.url + "/assets/avatar.png",
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: d.name.slice(0, 256),
              description: "Workload " + d.status.replaceAll("_", " "),
              url: config.url + "/#job/" + d.job_id,
              color: d.status === "completed" ? 7653789 : 15510414,
              footer: { text: "AI Worker · Kawaiipantsu / thugs.red" },
            },
          ],
        }),
      });
      if (!r.ok) {
        let delay = 0;
        if (r.status === 429) {
          const body = await r.json().catch(() => ({}));
          delay = Number(body.retry_after) || 0;
        }
        const error = new Error("Discord HTTP " + r.status);
        error.retry = delay;
        throw error;
      }
      await q(
        "UPDATE webhook_deliveries SET delivered_at=NOW(3),attempts=attempts+1,last_error=NULL WHERE id=?",
        [d.id],
      );
    } catch (e) {
      await q(
        "UPDATE webhook_deliveries SET attempts=attempts+1,next_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),last_error=? WHERE id=?",
        [
          Math.ceil(
            Math.max(
              e.retry || 0,
              Math.min(21600, 30 * 2 ** Math.min(d.attempts, 10)),
            ),
          ),
          clean(e.message),
          d.id,
        ],
      );
    }
  }
}
// Database advisory lock prevents two daemons dispatching into the same provider slots.
const lock = await pool.getConnection();
const [[locked]] = await lock.query(
  "SELECT GET_LOCK('aiworker_dispatcher',0) AS ok",
);
if (!locked.ok) throw new Error("Another dispatcher is active");
lock.connection.on("error", () => {
  console.error("Dispatcher lock connection lost");
  shutdown();
});
await q(
  "UPDATE jobs SET status=CASE control WHEN 'pause' THEN 'paused' WHEN 'cancel' THEN 'cancelled' ELSE 'queued' END,control=NULL,queued_at=NULL,summary='Recovered after service restart' WHERE status IN ('preparing','running')",
);
await q(
  "UPDATE jobs SET queued_at=NULL WHERE status IN ('queued','rate_limited')",
);
console.log("AI Worker ready");
async function tick() {
  await lock.query("SELECT 1");
  await loadSettings();
  const interrupted = await q(
    "SELECT id,control FROM jobs WHERE status IN ('running','preparing')",
  );
  for (const job of interrupted) {
    if (active.has(job.id)) continue;
    const recovered =
      job.control === "pause"
        ? "paused"
        : job.control === "cancel"
          ? "cancelled"
          : "queued";
    await q(
      "UPDATE jobs SET status=?,control=NULL,queued_at=NULL,summary='Recovered after interrupted dispatch' WHERE id=? AND status IN ('running','preparing')",
      [recovered, job.id],
    );
    await event(
      job.id,
      "recovery",
      "Recovered interrupted dispatch as " + recovered,
    );
  }
  await redis.set(
    "worker:heartbeat",
    JSON.stringify({
      time: new Date().toISOString(),
      active: active.size,
      pid: process.pid,
    }),
    { EX: 15 },
  );
  for (const [id, s] of active) {
    const rows = await q("SELECT control FROM jobs WHERE id=?", [id]);
    if (rows[0]?.control) stopChild(s, rows[0].control);
  }
  if (!settings.paused && !stopping) {
    try {
      await dispatch();
    } catch (e) {
      queue.close();
      await redis.set("worker:queue", "error", { EX: 15 });
      console.error("Queue:", e.message);
    }
  }
  if (!webhookTask && Date.now() - lastWebhooks > 10000) {
    lastWebhooks = Date.now();
    webhookTask = deliverWebhooks()
      .catch((e) => console.error("Webhook delivery:", e.message))
      .finally(() => {
        webhookTask = null;
      });
  }
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const s of active.values()) stopChild(s, "shutdown");
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
while (!stopping) {
  try {
    await tick();
  } catch (e) {
    console.error("Tick:", e.message);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
while (active.size) await new Promise((r) => setTimeout(r, 250));
if (webhookTask) await webhookTask;
await redis.del("worker:heartbeat");
queue.close();
lock.release();
await pool.end();
await redis.quit();
