import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { before, describe, it } from "node:test";
import { interceptEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { FAKE_BACKEND, SCRIPTED_BACKEND } from "./helpers/paths.js";
import { runCli } from "./helpers/run-cli.js";
import { diagnosticSchemaValidator } from "./helpers/schemas.js";

interface Bundle {
  schemaVersion: string;
  inspector: { version: string };
  protocol: { name: string; revision: string };
  target: Record<string, unknown>;
  event: { raw: string; parsed: Record<string, unknown> };
  attempts: Array<{
    number: number;
    kind: string;
    request: { raw: string; parsed: { id: string; method: string } };
    response?: { raw: string; parsed?: unknown };
    transport: Record<string, unknown>;
    timing: Record<string, unknown>;
    validation: unknown[];
    result: { classification: string };
  }>;
  result: { classification: string };
}

let dir: string;
let eventPath: string;
let eventRaw: string;

before(() => {
  dir = tempDir();
  eventPath = writeEventFile(dir, interceptEvent());
  eventRaw = readFileSync(eventPath, "utf8");
});

function exportPathFrom(stderr: string): string {
  const match = /Diagnostic bundle written to (.+)/.exec(stderr);
  assert.ok(match !== null, `no export path reported: ${stderr}`);
  return (match as RegExpExecArray)[1] as string;
}

describe("diagnostic bundle export (scenario 15)", () => {
  it("exports a self-describing bundle with the captured exchange and complete final result", async () => {
    const requested = join(dir, "bundle.json");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-closed", "--export", requested,
      "--", process.execPath, FAKE_BACKEND, "--mode", "deny", "--reason", "Denied for the export test",
    ]);
    assert.equal(run.code, 0, run.stderr);
    const actual = exportPathFrom(run.stderr);
    assert.equal(actual, requested);

    const bundle = JSON.parse(readFileSync(actual, "utf8")) as Bundle;
    assert.equal(bundle.schemaVersion, "ahp-inspector-diagnostic/0.1");
    assert.equal(bundle.protocol.name, "AHP");
    assert.equal(bundle.protocol.revision, "0.1.0-draft.1");
    assert.equal(typeof bundle.inspector.version, "string");
    assert.equal(bundle.target.transport, "stdio");
    assert.equal(bundle.target.method, "hooks/intercept");
    assert.equal(bundle.target.failurePolicy, "fail-closed");

    // The loaded event is preserved exactly, raw and parsed kept separate.
    assert.equal(bundle.event.raw, eventRaw);
    assert.equal(bundle.event.parsed.id, "evt_stdio_001");

    assert.equal(bundle.attempts.length, 1);
    const attempt = bundle.attempts[0];
    assert.ok(attempt !== undefined);
    assert.equal(attempt.number, 0);
    assert.equal(attempt.kind, "initial");
    assert.equal(attempt.request.parsed.method, "hooks/intercept");
    assert.equal(attempt.request.parsed.id, "evt_stdio_001");
    assert.match(attempt.response?.raw ?? "", /Denied for the export test/);
    assert.ok(attempt.response?.parsed !== undefined, "raw and parsed response evidence are both preserved");
    assert.equal(attempt.transport.transport, "stdio");
    assert.equal(attempt.timing.deadlineExceeded, false);

    // The top-level result is the complete final attempt result.
    assert.deepEqual(bundle.result, attempt.result);
    assert.equal(bundle.result.classification, "explicit_deny");

    const validate = diagnosticSchemaValidator();
    assert.ok(validate(bundle), JSON.stringify(validate.errors, null, 2));
  });

  it("exports every attempt in order for multi-attempt runs and validates against the schema", async () => {
    const requested = join(dir, "multi.json");
    const stateFile = join(dir, "export-retry-state");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "5000", "--failure-policy", "fail-open", "--retry", "--export", requested,
      "--", process.execPath, SCRIPTED_BACKEND, "fail-once", stateFile,
    ]);
    assert.equal(run.code, 0, run.stderr);
    const bundle = JSON.parse(readFileSync(exportPathFrom(run.stderr), "utf8")) as Bundle;
    assert.deepEqual(bundle.attempts.map((attempt) => attempt.kind), ["initial", "retry"]);
    assert.equal(bundle.attempts[0]?.result.classification, "operational_failure");
    assert.equal(bundle.attempts[1]?.result.classification, "no_effect");
    assert.deepEqual(bundle.result, bundle.attempts[1]?.result);
    assert.equal(bundle.attempts[0]?.request.raw, bundle.attempts[1]?.request.raw);

    const validate = diagnosticSchemaValidator();
    assert.ok(validate(bundle), JSON.stringify(validate.errors, null, 2));
  });

  it("does not export or persist anything without --export", async () => {
    const cleanDir = tempDir("ahp-inspector-noexport-");
    const cleanEvent = writeEventFile(cleanDir, interceptEvent());
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", cleanEvent,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect",
    ]);
    assert.equal(run.code, 0);
    assert.ok(!run.stderr.includes("Diagnostic bundle"));
    assert.deepEqual(readdirSync(cleanDir), [basename(cleanEvent)], "no diagnostic files may be created without --export");
  });
});

describe("export path collision (scenario 18)", () => {
  it("never overwrites an existing path; a random suffix is used and reported on stderr", async () => {
    const requested = join(dir, "collide.json");
    writeFileSync(requested, "sentinel: pre-existing content\n", "utf8");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open", "--export", requested,
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect",
    ]);
    assert.equal(run.code, 0, run.stderr);

    const actual = exportPathFrom(run.stderr);
    assert.notEqual(actual, requested);
    assert.match(basename(actual), /^collide-[0-9a-f]{8}\.json$/);
    assert.equal(readFileSync(requested, "utf8"), "sentinel: pre-existing content\n", "the existing file is untouched");

    const bundle = JSON.parse(readFileSync(actual, "utf8")) as Bundle;
    assert.equal(bundle.result.classification, "no_effect");
    const validate = diagnosticSchemaValidator();
    assert.ok(validate(bundle), JSON.stringify(validate.errors, null, 2));
  });
});
