import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { interceptEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { FAKE_BACKEND, SCRIPTED_BACKEND } from "./helpers/paths.js";
import { runCli } from "./helpers/run-cli.js";

/**
 * Scenario 17: one attempt emits exactly one JSON object; multiple attempts
 * emit JSONL with attempt number, kind, and a complete result per record.
 */

let dir: string;
let eventPath: string;

before(() => {
  dir = tempDir();
  eventPath = writeEventFile(dir, interceptEvent());
});

describe("machine output shapes (scenario 17)", () => {
  it("emits exactly one JSON object for one attempt, in the contract shape", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open", "--format", "json",
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), {
      result: { classification: "no_effect", effects: [] },
    });
  });

  it("emits JSONL with one complete record per attempt for multiple attempts", async () => {
    const stateFile = join(dir, "format-retry-state");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "5000", "--failure-policy", "fail-open", "--format", "json", "--retry",
      "--", process.execPath, SCRIPTED_BACKEND, "fail-once", stateFile,
    ]);
    assert.equal(run.code, 0, run.stderr);
    const records = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
      attempt: number;
      kind: string;
      result: { classification: string; error?: { code: string; message: string; phase: string; retryable: boolean } };
    });
    assert.equal(records.length, 2);

    assert.equal(records[0]?.attempt, 0);
    assert.equal(records[0]?.kind, "initial");
    assert.equal(records[0]?.result.classification, "operational_failure");
    assert.ok(records[0]?.result.error?.code !== undefined, "failed attempt records carry a complete error envelope");
    assert.ok(records[0]?.result.error?.phase !== undefined);

    assert.equal(records[1]?.attempt, 1);
    assert.equal(records[1]?.kind, "retry");
    assert.equal(records[1]?.result.classification, "no_effect", "the final record represents the final result");
  });

  it("keeps every stdout line machine-parseable while diagnostics go to stderr", async () => {
    const exportPath = join(dir, "format-export.json");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open", "--format", "json",
      "--export", exportPath, "--verbose",
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny",
    ]);
    assert.equal(run.code, 0);
    for (const line of run.stdout.trim().split("\n")) {
      JSON.parse(line);
    }
    assert.match(run.stderr, /Diagnostic bundle written to /, "the actual export path is reported on stderr");
  });

  it("writes text-mode success to stdout and failure envelopes to stderr", async () => {
    const ok = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny", "--reason", "Blocked by policy",
    ]);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /explicit_deny/);
    assert.match(ok.stdout, /Blocked by policy/);

    const failed = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", process.execPath, FAKE_BACKEND, "--mode", "json-rpc-error",
    ]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "", "operational failures produce no stdout result in text mode");
    assert.match(failed.stderr, /operational_failure/);
    assert.match(failed.stderr, /JSON_RPC_ERROR/);
  });

  it("never labels no-effect as allow", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect",
    ]);
    assert.equal(run.code, 0);
    assert.ok(!/\ballow(ed)?\b/i.test(run.stdout.replace(/not "allow"/, "")), run.stdout);
    assert.match(run.stdout, /does not bypass/);
  });
});
