import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  unzipSync,
  strFromU8,
} from "../worker/node_modules/fflate/esm/index.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LUCKY_MODEL,
  ideaSchema,
  ideaPrompt,
  validateIdea,
  safeScaffoldPath,
  scaffoldZip,
  responsesGenerate,
} from "../worker/lucky-model.mjs";
import { seal, unseal } from "../worker/lucky-secrets.mjs";
const idea = () => ({
  name: "Packet Orchard",
  summary: "A local packet-analysis garden for authorized lab captures.",
  category: "network engineering",
  project_type: "tui",
  initial_prompt:
    "Build a runnable local TUI to explore synthetic network captures. ".repeat(
      10,
    ),
  recommended_worker: "codex",
  thinking: "high",
  enable_agents: false,
  dynamic_work: false,
  scaffold_files: [
    { path: "README.md", content: "# Packet Orchard\n" },
    { path: "src/main.py", content: 'print("orchard")\n' },
  ],
});
test("generator pins Terra and requests strict JSON without API tools", async () => {
  let sent;
  const result = await responsesGenerate(
    "sk-test",
    "Make an idea",
    ideaSchema,
    {
      fetchImpl: async (url, opt) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        sent = JSON.parse(opt.body);
        return {
          ok: true,
          json: async () => ({
            status: "completed",
            output: [
              {
                content: [
                  { type: "output_text", text: JSON.stringify(idea()) },
                ],
              },
            ],
          }),
        };
      },
    },
  );
  assert.equal(sent.model, "gpt-5.6-terra");
  assert.equal(LUCKY_MODEL, sent.model);
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.equal(sent.tools, undefined);
  assert.equal(result.name, "Packet Orchard");
});
test("provider errors never reflect supplied secret or raw error bodies", async () => {
  await assert.rejects(
    () =>
      responsesGenerate("sk-sensitive", "", ideaSchema, {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({ error: { message: "sk-sensitive" } }),
        }),
      }),
    (e) => /rejected/.test(e.message) && !e.message.includes("sk-sensitive"),
  );
  await assert.rejects(
    () =>
      responsesGenerate("sk-test", "", ideaSchema, {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ status: "incomplete" }),
        }),
      }),
    /incomplete/,
  );
});
test("scaffolding rejects traversal, special paths and collisions", () => {
  for (const p of [
    "../escape",
    "/etc/passwd",
    "a/../x",
    "C:/file",
    "a\\b",
    ".git/config",
    "docs/INIT_PROMPT.md",
    "a//b",
    "a/",
  ])
    assert.equal(safeScaffoldPath(p), false, p);
  assert.equal(safeScaffoldPath("src/main.ts"), true);
  assert.throws(
    () =>
      validateIdea({
        ...idea(),
        scaffold_files: [
          { path: "src", content: "" },
          { path: "src/main.js", content: "" },
        ],
      }),
    /conflicting/,
  );
  assert.throws(
    () =>
      validateIdea({
        ...idea(),
        scaffold_files: [{ path: "../escape", content: "" }],
      }),
    /unsafe/,
  );
});
test("validated files round-trip through the generated ZIP", () => {
  const result = validateIdea(idea());
  const zip = scaffoldZip(result.scaffold_files),
    files = unzipSync(zip);
  assert.equal(strFromU8(files["src/main.py"]), 'print("orchard")\n');
  assert.equal(scaffoldZip([]), null);
  assert.equal(validateIdea(idea(), false).scaffold_files.length, 0);
});
test("draft structure and prompt constrain category, scope and Linux build", () => {
  assert.throws(
    () => validateIdea({ ...idea(), recommended_worker: "shell" }),
    /unsupported/,
  );
  assert.match(ideaPrompt(true), /Linux/);
  assert.match(ideaPrompt(false), /empty scaffold_files/);
});
test("encrypted secrets round-trip and reject tampering or wrong keys", () => {
  const key = randomBytes(32),
    ciphertext = seal({ api_key: "private-fixture" }, key);
  assert(!ciphertext.includes("private-fixture"));
  assert.equal(unseal(ciphertext, key).api_key, "private-fixture");
  assert.throws(() => unseal(ciphertext, randomBytes(32)));
  const altered = Buffer.from(ciphertext, "base64");
  altered[20] ^= 1;
  assert.throws(() => unseal(altered.toString("base64"), key));
});
test("PHP credential encryption is interoperable with Node", () => {
  const key = randomBytes(32);
  const fixture = mkdtempSync(join(tmpdir(), "aiworker-crypto-"));
  try {
    mkdirSync(join(fixture, "etc"));
    writeFileSync(join(fixture, "etc/secrets.key"), key, { mode: 0o600 });
    const cipher = execFileSync("php", ["-r",
      'define("ROOT", $argv[1]); require $argv[2]; echo seal_secret(json_encode(["fixture"=>"not-a-secret"]));',
      fixture, fileURLToPath(new URL("../app/secrets.php", import.meta.url)),
    ]).toString();
    assert.deepEqual(unseal(cipher, key), { fixture: "not-a-secret" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
