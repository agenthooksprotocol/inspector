import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { interceptEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { FAKE_BACKEND, SCRIPTED_BACKEND } from "./helpers/paths.js";
import { runCli } from "./helpers/run-cli.js";

interface AttemptLine {
  attempt: number;
  kind: string;
  result: { classification: string; error?: { code: string } };
}

let dir: string;
let eventPath: string;
let eventId: string;

before(() => {
  dir = tempDir();
  const event = interceptEvent();
  eventId = event.id as string;
  eventPath = writeEventFile(dir, event);
});

function baseArgs(): string[] {
  return [
    "--transport", "stdio",
    "--method", "hooks/intercept",
    "--event", eventPath,
    "--timeout-ms", "5000",
    "--failure-policy", "fail-open",
  ];
}

describe("conforming retry (scenario 13)", () => {
  it("retries after an operational failure within the original deadline, preserving IDs and content", async () => {
    const stateFile = join(dir, "retry-state");
    const recordFile = join(dir, "retry-record");
    const run = await runCli([
      ...baseArgs(), "--retry", "2",
      "--", process.execPath, SCRIPTED_BACKEND, "fail-once", stateFile, recordFile,
    ]);
    assert.equal(run.code, 0, run.stderr);

    const lines = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as AttemptLine);
    assert.equal(lines.length, 2, "expected two JSONL attempt records");
    assert.equal(lines[0]?.attempt, 0);
    assert.equal(lines[0]?.kind, "initial");
    assert.equal(lines[0]?.result.classification, "operational_failure");
    assert.equal(lines[1]?.attempt, 1);
    assert.equal(lines[1]?.kind, "retry");
    assert.equal(lines[1]?.result.classification, "no_effect");

    // Both deliveries carried the byte-identical frame: same event ID,
    // JSON-RPC ID, session ID, call ID, and content (AHP-CORE-004).
    const delivered = readFileSync(recordFile, "utf8").trim().split("\n");
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0], delivered[1]);
    const parsed = JSON.parse(delivered[0] as string) as { id: string; params: { event: { id: string } } };
    assert.equal(parsed.id, eventId);
    assert.equal(parsed.params.event.id, eventId);
  });

  it("does not retry after a successful no-effect result", async () => {
    const run = await runCli([
      ...baseArgs(), "--retry", "3",
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect",
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim().split("\n").length, 1, "a successful first attempt must not be retried");
  });

  it("does not retry after an explicit deny", async () => {
    const run = await runCli([
      ...baseArgs(), "--retry", "3",
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "an explicit deny must not be retried");
    assert.equal((JSON.parse(lines[0] as string) as { result: { classification: string } }).result.classification, "explicit_deny");
  });

  it("does not retry once the original deadline has been consumed", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "300", "--failure-policy", "fail-open", "--retry", "3",
      "--", process.execPath, FAKE_BACKEND, "--mode", "timeout",
    ]);
    assert.equal(run.code, 1);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "a timeout consumes the whole deadline, so no retry may run");
  });
});

describe("duplicate delivery test (scenario 14)", () => {
  it("delivers the identical frame exactly twice with distinguishing attempt kinds", async () => {
    const recordFile = join(dir, "duplicate-record");
    const run = await runCli([
      ...baseArgs(), "--duplicate-delivery",
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny", "--record-file", recordFile,
    ]);
    assert.equal(run.code, 0, run.stderr);

    const lines = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as AttemptLine);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => line.kind), ["initial", "duplicate"]);
    for (const line of lines) {
      assert.equal(line.result.classification, "explicit_deny", "each attempt carries its complete result");
    }

    const delivered = readFileSync(recordFile, "utf8").trim().split("\n").map((entry) => entry.slice(entry.indexOf("\t") + 1));
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0], delivered[1], "duplicate delivery reuses the exact event content and IDs");
  });

  it("labels the attempts as a duplicate delivery test, never as a retry", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "5000", "--failure-policy", "fail-open", "--duplicate-delivery",
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny",
    ]);
    assert.equal(run.code, 0);
    const kinds = run.stdout.trim().split("\n").map((line) => (JSON.parse(line) as AttemptLine).kind);
    assert.deepEqual(kinds, ["initial", "duplicate"]);
    assert.ok(!kinds.includes("retry"), "duplicate delivery must not be labeled retry");
  });
});
