import test from "node:test";
import assert from "node:assert/strict";
import {
  command,
  classifyFailure,
  describeEvent,
  providerError,
  outcomeFromEvent,
} from "../worker/providers.mjs";
const config = { codex: "/bin/codex", claude: "/bin/claude" };
const job = {
  provider: "codex",
  model: "gpt-6-astra",
  effort: "high",
  mode: "yolo",
  agents: 0,
};
test("noninteractive Codex preserves arguments without shell interpolation", () => {
  const c = command({ ...job, model: "model; touch /bad" }, config);
  assert.equal(c.args[c.args.indexOf("-m") + 1], "model; touch /bad");
  assert(c.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert(c.args.includes("features.multi_agent=false"));
  assert.equal(c.args.at(-1), "-");
});
test("resume uses explicit session and keeps full access", () => {
  const c = command({ ...job, session_id: "abc12345" }, config);
  assert.equal(c.args[1], "resume");
  assert.equal(c.args.at(-2), "abc12345");
  assert(c.args.includes("--dangerously-bypass-approvals-and-sandbox"));
});
test("Claude auto never leaves permission prompts waiting on stdin", () => {
  const c = command({ ...job, provider: "claude", mode: "auto" }, config);
  assert(c.args.includes("auto"));
  assert(c.args.includes("none"));
  assert(c.args.includes("Agent"));
  assert(!c.args.includes("--dangerously-skip-permissions"));
});
test("rate limits respect retry-after, epoch reset and fallback backoff", () => {
  assert.equal(classifyFailure("429 retry-after: 7200", 300, 1, 0).delay, 7200);
  assert.equal(
    classifyFailure("usage limit resets in 2h 15m", 300, 1, 0).delay,
    8100,
  );
  assert.equal(classifyFailure("insufficient_quota", 300, 4, 0).delay, 2400);
  assert.equal(
    classifyFailure("rate_limit reset_time: 1800000000", 300, 1, 1799990000000)
      .delay,
    10010,
  );
  assert.equal(classifyFailure("file not found"), null);
});
test("provider text and tool output are rendered as data", () => {
  assert.equal(
    describeEvent({
      type: "item.completed",
      item: { text: "<script>bad</script>" },
    }),
    "<script>bad</script>",
  );
});

test("allowed Claude telemetry never triggers a cooldown, even if overage is rejected", () => {
  assert.equal(
    providerError({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", overageStatus: "rejected" },
    }),
    null,
  );
  const rejected = providerError({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1800000000 },
  });
  assert.equal(classifyFailure(rejected, 300, 1, 1799990000000).delay, 10010);
});
test("successful exit is not an outcome report", () => {
  assert.equal(outcomeFromEvent({ type: "turn.completed" }), null);
  assert.equal(
    outcomeFromEvent({
      type: "item.completed",
      item: { text: "Blocked by a missing executable" },
    }),
    null,
  );
  assert.equal(
    outcomeFromEvent({
      type: "result",
      structured_output: {
        outcome: "completed",
        summary: "Files verified",
        question: "",
      },
    }).outcome,
    "completed",
  );
});
