import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { LUCKY_MODEL } from "./lucky-model.mjs";
export function isolatedEnv(home) {
  return {
    HOME: home,
    CODEX_HOME: home + "/codex",
    PATH: "/opt/aiworker/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
}
function stop(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 2000);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}
export async function codexGenerate(file, home, auth, prompt, schema, signal) {
  const env = isolatedEnv(home);
  await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  await mkdir(home + "/workspace", { mode: 0o700 });
  await writeFile(env.CODEX_HOME + "/auth.json", JSON.stringify(auth), {
    mode: 0o600,
  });
  await writeFile(home + "/schema.json", JSON.stringify(schema), {
    mode: 0o600,
  });
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.unified_exec=false",
    "-c",
    "features.code_mode=false",
    "-c",
    "features.code_mode_host=false",
    "-c",
    'web_search="disabled"',
    "--json",
    "-m",
    LUCKY_MODEL,
    "--output-schema",
    home + "/schema.json",
    "--output-last-message",
    home + "/result.json",
    "-",
  ];
  const child = spawn(file, args, {
    env,
    cwd: home + "/workspace",
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let size = 0,
    errors = "";
  const abort = () => stop(child);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  // Never persist raw CLI output: it may contain credentials or account metadata.
  child.stdout.on("data", (b) => {
    size += b.length;
    if (size > 2000000) stop(child);
  });
  child.stderr.on("data", (b) => {
    errors = (errors + b.toString()).slice(-4000);
  });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(
          new Error(
            "OpenAI sign-in runtime could not start. Contact an administrator.",
          ),
        ),
      );
      child.once("close", resolve);
    });
    if (signal?.aborted)
      throw new Error("OpenAI request cancelled or timed out.");
    if (code !== 0) {
      if (/rate.?limit|usage.?limit|quota|credits|429/i.test(errors))
        throw new Error(
          "OpenAI usage limit reached. Retry after the account limit resets.",
        );
      throw new Error(
        "The OpenAI session could not generate a response. Sign in again or check gpt-5.6-terra access.",
      );
    }
    const text = await readFile(home + "/result.json", "utf8");
    if (text.length > 350000)
      throw new Error("OpenAI response exceeded the size limit.");
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("OpenAI returned invalid JSON. Please try again.");
    }
    const refreshed = JSON.parse(
      await readFile(env.CODEX_HOME + "/auth.json", "utf8"),
    );
    return { result, auth: refreshed };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
export async function deviceLogin(file, home, onCode, signal) {
  const env = isolatedEnv(home);
  await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const child = spawn(
    file,
    ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="file"'],
    { env, cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let sequence = 0,
    buffer = "",
    closed = false;
  const pending = new Map();
  let finishResolve, finishReject;
  const completed = new Promise((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  completed.catch(() => {});
  const abort = () => {
    stop(child);
    finishReject(new Error("OpenAI sign-in cancelled or expired."));
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const send = (msg) => {
    if (closed) throw new Error("OpenAI sign-in process ended.");
    child.stdin.write(JSON.stringify(msg) + "\n");
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("OpenAI sign-in timed out. Try again."));
      }, 30000);
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        send({ id, method, params });
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1000000) {
      abort();
      return;
    }
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error)
          p.reject(
            new Error(
              "OpenAI device sign-in is unavailable. Enable device-code login in your ChatGPT security settings, or use an API key.",
            ),
          );
        else p.resolve(msg.result);
      } else if (msg.method === "account/login/completed") {
        if (msg.params?.success) finishResolve();
        else
          finishReject(
            new Error(
              "OpenAI sign-in was not completed. Try again or use an API key.",
            ),
          );
      }
    }
  });
  child.once("error", () =>
    finishReject(new Error("OpenAI sign-in runtime could not start.")),
  );
  child.once("close", () => {
    closed = true;
    for (const p of pending.values())
      p.reject(new Error("OpenAI sign-in process ended."));
    pending.clear();
    finishReject(
      new Error("OpenAI sign-in process ended before authorization."),
    );
  });
  try {
    await request("initialize", {
      clientInfo: { name: "aiworker_ideas", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });
    const login = await request("account/login/start", {
      type: "chatgptDeviceCode",
    });
    const url = new URL(login.verificationUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "auth.openai.com" ||
      !/^[A-Za-z0-9-]{4,40}$/.test(login.userCode)
    )
      throw new Error("OpenAI returned unexpected sign-in details.");
    await onCode({
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
    });
    await completed;
    const auth = JSON.parse(
      await readFile(env.CODEX_HOME + "/auth.json", "utf8"),
    );
    if (!auth.tokens?.access_token)
      throw new Error(
        "OpenAI did not provide a saved session. Try signing in again.",
      );
    return auth;
  } finally {
    signal?.removeEventListener("abort", abort);
    stop(child);
    for (const p of pending.values()) p.reject(new Error("Sign-in ended."));
    pending.clear();
  }
}
