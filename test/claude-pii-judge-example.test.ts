import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers/fixtures.js";
import { runCli } from "./helpers/run-cli.js";

const ADAPTER = resolve("dist/examples/pii-judge/claude-pii-judge.js");
const PII_EVENT = resolve("examples/pii-judge/pii-event.json");
const CLEAN_EVENT = resolve("examples/pii-judge/clean-event.json");

let fakeClaude: string;

before(() => {
  fakeClaude = join(tempDir("fake-claude-"), "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const containsPii = JSON.stringify(JSON.parse(input).input).includes("@");
  const structured_output = {
    containsPii,
    categories: containsPii ? ["email_address"] : [],
  };
  process.stdout.write(JSON.stringify({ structured_output }));
});
`,
    "utf8",
  );
  chmodSync(fakeClaude, 0o755);
});

function args(eventPath: string): string[] {
  return [
    "--transport", "stdio",
    "--method", "hooks/intercept",
    "--event", eventPath,
    "--timeout-ms", "5000",
    "--failure-policy", "fail-closed",
    "--", process.execPath, ADAPTER,
  ];
}

describe("Claude PII judge example", () => {
  it("maps a positive structured verdict to an AHP deny", async () => {
    const run = await runCli(args(PII_EVENT), { env: { CLAUDE_BIN: fakeClaude } });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      result: {
        classification: "explicit_deny",
        effects: [{
          type: "deny",
          reason: "Claude PII judge detected potential PII (email_address).",
          code: "com.example.policy.pii_detected",
        }],
      },
    });
  });

  it("maps a negative structured verdict to no effect", async () => {
    const run = await runCli(args(CLEAN_EVENT), { env: { CLAUDE_BIN: fakeClaude } });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      result: {
        classification: "no_effect",
        effects: [],
      },
    });
  });
});
