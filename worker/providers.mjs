import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const schemaPath = fileURLToPath(
  new URL("../etc/outcome.schema.json", import.meta.url),
);
const schema = readFileSync(schemaPath, "utf8");
export function command(job, config) {
  const agents = !!job.agents;
  let args;
  if (job.provider === "codex") {
    args = [
      "exec",
      ...(job.mode === "auto" ? ["--approve-for-me"] : []),
      ...(job.session_id ? ["resume"] : []),
      "--json",
      "--output-schema",
      schemaPath,
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-m",
      job.model,
      "-c",
      `model_reasoning_effort="${job.effort}"`,
      "-c",
      `features.multi_agent=${agents}`,
    ];
    if (job.mode !== "auto")
      args.push("--dangerously-bypass-approvals-and-sandbox");
    if (job.session_id) args.push(job.session_id);
    args.push("-");
  } else {
    args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--json-schema",
      schema,
      "--model",
      job.model,
      "--effort",
      job.effort,
      "--permission-prompts",
      "none",
      "--setting-sources",
      "user",
    ];
    if (job.mode === "auto") args.push("--permission-mode", "auto");
    else args.push("--dangerously-skip-permissions");
    if (!agents) args.push("--disallowedTools", "Agent");
    if (job.session_id) args.push("--resume", job.session_id);
  }
  return {
    file: config[job.provider],
    args,
    env:
      job.provider === "claude"
        ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: agents ? "1" : "0" }
        : {},
  };
}
export function classifyFailure(
  text,
  baseSeconds = 300,
  attempts = 1,
  now = Date.now(),
) {
  const limited =
    /rate.?limit|usage.?limit|quota|insufficient[_ ](?:quota|credits)|credit balance|out of credits|billing|hit your limit|too many requests|limit reached|usage cap|resets? (?:at|in)|429/i.test(
      text,
    );
  if (!limited) return null;
  let delay = Math.min(
    21600,
    baseSeconds * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
  );
  const seconds = text.match(/retry[_ -]?after["'\s:=]+(\d+(?:\.\d+)?)/i);
  if (seconds) delay = Math.max(delay, Number(seconds[1]));
  const relative = text.match(
    /(?:reset|retry|try again)s?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i,
  );
  if (relative && (relative[1] || relative[2] || relative[3]))
    delay = Math.max(
      delay,
      Number(relative[1] || 0) * 3600 +
        Number(relative[2] || 0) * 60 +
        Number(relative[3] || 0),
    );
  const timestamp = text.match(
    /(?:resets?_?at|reset_time|retry_at)["'\s:=]+(\d{10,13}|\d{4}-\d{2}-\d{2}T[^\s"']+)/i,
  );
  if (timestamp) {
    let t = /^\d+$/.test(timestamp[1])
      ? Number(timestamp[1])
      : Date.parse(timestamp[1]);
    if (t < 1e12) t *= 1000;
    if (Number.isFinite(t)) delay = Math.max(delay, (t - now) / 1000 + 10);
  }
  return {
    delay: Math.max(30, Math.min(delay, 7 * 86400)),
    reason: text.slice(-1500),
  };
}
export function describeEvent(event) {
  if (event.type === "item.completed") {
    const i = event.item || {};
    return i.text || i.aggregated_output || JSON.stringify(i);
  }
  if (event.type === "assistant")
    return (event.message?.content || [])
      .map(
        (c) =>
          c.text ||
          (c.type === "tool_use"
            ? `Tool: ${c.name} ${JSON.stringify(c.input)}`
            : ""),
      )
      .filter(Boolean)
      .join("\n");
  if (event.type === "result")
    return event.result || event.errors?.join("\n") || JSON.stringify(event);
  return JSON.stringify(event);
}

export function providerError(event) {
  if (
    event.type === "error" ||
    event.type === "turn.failed" ||
    (event.type === "result" && event.is_error) ||
    (event.type === "rate_limit_event" &&
      event.rate_limit_info?.status === "rejected")
  )
    return JSON.stringify(event);
  return null;
}
export function outcomeFromEvent(event) {
  let outcome = event.structured_output;
  if (!outcome && event.type === "item.completed" && event.item?.text) {
    try {
      outcome = JSON.parse(event.item.text);
    } catch {}
  }
  if (!outcome && event.type === "result" && event.result) {
    try {
      outcome = JSON.parse(event.result);
    } catch {}
  }
  return outcome &&
    ["completed", "blocked", "failed"].includes(outcome.outcome) &&
    typeof outcome.summary === "string"
    ? outcome
    : null;
}
