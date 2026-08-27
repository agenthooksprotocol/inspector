import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { interceptEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { FAKE_BACKEND, SCRIPTED_BACKEND } from "./helpers/paths.js";
import { exportedPath, parseJsonStream, runCli } from "./helpers/run-cli.js";

/**
 * Scenario 17 (as amended): JSON is the only output format. One attempt emits
 * exactly one JSON object; multiple attempts emit JSONL with attempt number,
 * kind, and a complete result per record. --pretty pretty-prints each record
 * in sequence; --verbose adds full diagnostic evidence fields.
 */

let dir: string;
let eventPath: string;

before(() => {
  dir = tempDir();
  eventPath = writeEventFile(dir, interceptEvent());
});

describe("machine output shapes (scenario 17)", () => {
  it("emits exactly one JSON object for one attempt, in the contract shape, by default", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] as string), {
      result: { classification: "no_effect", effects: [] },
    });
  });

  it("emits strict single-line JSONL with one complete record per attempt for multiple attempts", async () => {
    const stateFile = join(dir, "format-retry-state");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "5000", "--failure-policy", "fail-open", "--retry",
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

  it("pretty-prints a single attempt as one multi-line JSON object under --pretty", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open", "--pretty",
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect",
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.stdout.trim().split("\n").length > 1, "pretty output spans multiple lines");
    assert.deepEqual(JSON.parse(run.stdout), {
      result: { classification: "no_effect", effects: [] },
    });
  });

  it("pretty-prints each attempt record in sequence under --pretty for multiple attempts", async () => {
    const stateFile = join(dir, "format-pretty-retry-state");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "5000", "--failure-policy", "fail-open", "--retry", "--pretty",
      "--", process.execPath, SCRIPTED_BACKEND, "fail-once", stateFile,
    ]);
    assert.equal(run.code, 0, run.stderr);
    const records = parseJsonStream(run.stdout) as Array<{ attempt: number; kind: string; result: { classification: string } }>;
    assert.equal(records.length, 2);
    assert.equal(records[0]?.kind, "initial");
    assert.equal(records[0]?.result.classification, "operational_failure");
    assert.equal(records[1]?.kind, "retry");
    assert.equal(records[1]?.result.classification, "no_effect");
  });

  it("adds full diagnostic evidence fields to the record under --verbose", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open", "--verbose",
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "verbose output stays a single line without --pretty");
    const record = JSON.parse(lines[0] as string) as {
      result: { classification: string };
      request: { raw: string; parsed: { method: string; id: string } };
      response?: { raw: string };
      transport: { transport: string };
      timing: { startedAt: string; durationMs: number };
      validation: unknown[];
    };
    assert.equal(record.result.classification, "explicit_deny");
    assert.equal(record.request.parsed.method, "hooks/intercept");
    assert.ok(record.request.raw.includes("\"jsonrpc\":\"2.0\""));
    assert.ok(record.response?.raw !== undefined, "verbose includes the raw response");
    assert.equal(record.transport.transport, "stdio");
    assert.ok(typeof record.timing.durationMs === "number");
    assert.ok(Array.isArray(record.validation));
  });

  it("keeps every stdout line machine-parseable while the export notice goes to stderr as JSON", async () => {
    const exportPath = join(dir, "format-export.json");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--export", exportPath, "--verbose",
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny",
    ]);
    assert.equal(run.code, 0);
    for (const line of run.stdout.trim().split("\n")) {
      JSON.parse(line);
    }
    assert.equal(exportedPath(run.stderr), exportPath, "the actual export path is reported on stderr as a JSON object");
  });

  it("writes operational failures as result records on stdout with nothing on stderr", async () => {
    const failed = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", process.execPath, FAKE_BACKEND, "--mode", "json-rpc-error",
    ]);
    assert.equal(failed.code, 1);
    const record = JSON.parse(failed.stdout.trim()) as {
      result: { classification: string; error?: { code: string } };
    };
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.result.error?.code, "JSON_RPC_ERROR");
    assert.equal(failed.stderr.trim(), "", "no duplicate failure envelope on stderr");
  });
});
