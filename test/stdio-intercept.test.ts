import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { interceptEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { FAKE_BACKEND, SCRIPTED_BACKEND } from "./helpers/paths.js";
import { exportedPath, runCli } from "./helpers/run-cli.js";

interface MachineResult {
  result: {
    classification: string;
    effects?: Array<{ type: string; reason?: string; code?: string }>;
    error?: { code: string; message: string; phase: string; retryable: boolean };
  };
  simulation?: { simulated: boolean; policy: string; consequence: string };
  /** Present only under --verbose. */
  transport?: { stdout?: string; stderr?: string };
}

let eventPath: string;
let dir: string;

before(() => {
  dir = tempDir();
  eventPath = writeEventFile(dir, interceptEvent());
});

function args(backendArgs: string[], extra: string[] = [], timeoutMs = 3000): string[] {
  return [
    "--transport", "stdio",
    "--method", "hooks/intercept",
    "--event", eventPath,
    "--timeout-ms", String(timeoutMs),
    "--failure-policy", "fail-open",
    ...extra,
    "--", process.execPath, ...backendArgs,
  ];
}

function parseSingle(stdout: string): MachineResult {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected one machine record, got: ${stdout}`);
  return JSON.parse(lines[0] as string) as MachineResult;
}

describe("stdio intercept (scenario 1, 2: valid results)", () => {
  it("classifies an empty effects list as no_effect", async () => {
    const run = await runCli(args([FAKE_BACKEND, "--mode", "no-effect"]));
    assert.equal(run.code, 0, run.stderr);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "no_effect");
    assert.deepEqual(record.result.effects, []);
  });

  it("classifies a valid deny as explicit_deny with exit code 0", async () => {
    const run = await runCli(args([FAKE_BACKEND, "--mode", "deny", "--reason", "No force pushes"]));
    assert.equal(run.code, 0, run.stderr);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "explicit_deny");
    assert.equal(record.result.effects?.[0]?.type, "deny");
    assert.equal(record.result.effects?.[0]?.reason, "No force pushes");
  });

  it("reassembles a chunked response through NDJSON framing", async () => {
    const run = await runCli(args([FAKE_BACKEND, "--mode", "no-effect", "--chunk-size", "3"]));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(parseSingle(run.stdout).result.classification, "no_effect");
  });
});

describe("stdio intercept protocol failures (scenarios 3-6)", () => {
  const failureCases: Array<{ name: string; mode: string; code: string }> = [
    { name: "backend JSON-RPC error", mode: "json-rpc-error", code: "JSON_RPC_ERROR" },
    { name: "mismatched response ID", mode: "id-mismatch", code: "ID_MISMATCH" },
    { name: "wrong successful-result protocol version", mode: "incompatible-version", code: "INCOMPATIBLE_VERSION" },
    { name: "unadvertised effect", mode: "unsupported-effect", code: "UNSUPPORTED_EFFECT" },
    { name: "multiple effects", mode: "multiple-effects", code: "MULTIPLE_EFFECTS" },
    { name: "malformed deny effect", mode: "malformed-deny", code: "MALFORMED_JSON_RPC" },
    { name: "malformed JSON response", mode: "malformed-json", code: "MALFORMED_JSON" },
  ];

  for (const { name, mode, code } of failureCases) {
    it(`classifies ${name} as operational_failure [${code}]`, async () => {
      const run = await runCli(args([FAKE_BACKEND, "--mode", mode]));
      assert.equal(run.code, 1, run.stdout + run.stderr);
      const record = parseSingle(run.stdout);
      assert.equal(record.result.classification, "operational_failure");
      assert.equal(record.result.error?.code, code);
      assert.equal(record.result.error?.retryable, true);
    });
  }

  it("classifies missing effects as operational_failure", async () => {
    const run = await runCli(args([SCRIPTED_BACKEND, "missing-effects"]));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.result.error?.code, "MALFORMED_JSON_RPC");
  });
});

describe("stdio intercept deadline (scenario 7)", () => {
  it("classifies a non-responding backend as TIMEOUT", async () => {
    const run = await runCli(args([FAKE_BACKEND, "--mode", "timeout"], [], 300));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.result.error?.code, "TIMEOUT");
    assert.equal(record.result.error?.phase, "await-response");
  });

  it("records a late response as evidence without changing the TIMEOUT result", async () => {
    const exportPath = join(dir, "late-stdio.json");
    const run = await runCli(
      args([SCRIPTED_BACKEND, "late-response", "700"], ["--export", exportPath], 300),
      { env: { AHP_INSPECTOR_LATE_DRAIN_MS: "5000" } },
    );
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "TIMEOUT");
    const bundle = JSON.parse(readFileSync(exportedPath(run.stderr), "utf8")) as {
      attempts: Array<{ response?: { raw: string; late?: boolean }; timing: { deadlineExceeded: boolean; lateResponse: boolean }; result: { classification: string } }>;
    };
    const attempt = bundle.attempts[0];
    assert.ok(attempt !== undefined);
    assert.equal(attempt.result.classification, "operational_failure");
    assert.equal(attempt.timing.deadlineExceeded, true);
    assert.equal(attempt.timing.lateResponse, true);
    assert.equal(attempt.response?.late, true);
    assert.match(attempt.response?.raw ?? "", /"effects":\s*\[\]/);
  });
});

describe("stdio framing discipline (scenario 8)", () => {
  it("classifies stdout pollution as an operational failure with retained evidence", async () => {
    const run = await runCli(args([SCRIPTED_BACKEND, "pollution"], ["--verbose"]));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.result.error?.code, "MALFORMED_JSON_RPC");
    assert.match(record.result.error?.message ?? "", /AHP-STDIO-001/);
    // Verbose evidence in the JSON record retains the polluted raw stdout.
    assert.match(record.transport?.stdout ?? "", /starting scripted backend/);
  });

  it("classifies a multiline (pretty-printed) response as an operational failure", async () => {
    const run = await runCli(args([SCRIPTED_BACKEND, "multiline"]));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.result.error?.code, "MALFORMED_JSON_RPC");
  });
});

describe("stdio process failures (scenario 9)", () => {
  it("classifies a launch failure as TARGET_UNAVAILABLE", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", "/nonexistent/definitely-missing-backend",
    ]);
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.result.error?.code, "TARGET_UNAVAILABLE");
    assert.equal(record.result.error?.phase, "setup");
  });

  it("classifies a mid-exchange crash as an operational failure naming the signal", async () => {
    const run = await runCli(args([SCRIPTED_BACKEND, "crash"]));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "IO_ERROR");
    assert.match(record.result.error?.message ?? "", /SIGKILL/);
  });

  it("classifies a nonzero exit as an operational failure even when a response was written", async () => {
    const run = await runCli(args([SCRIPTED_BACKEND, "nonzero-exit"]));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "IO_ERROR");
    assert.match(record.result.error?.message ?? "", /status 3/);
  });

  it("classifies a missing response with clean exit as an operational failure", async () => {
    const run = await runCli(args([SCRIPTED_BACKEND, "missing-response"]));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "IO_ERROR");
    assert.match(record.result.error?.message ?? "", /without writing a response/);
  });
});

describe("failure-policy simulation stays separate (scenario 4 display contract)", () => {
  it("keeps a fail-closed operational failure as operational_failure with a separate synthetic consequence", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "300", "--failure-policy", "fail-closed",
      "--", process.execPath, FAKE_BACKEND, "--mode", "timeout",
    ]);
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.simulation?.simulated, true);
    assert.equal(record.simulation?.policy, "fail-closed");
    assert.equal(record.simulation?.consequence, "synthetic_denial");
  });

  it("shows fail-open continuation as a simulated consequence only", async () => {
    const run = await runCli(args([FAKE_BACKEND, "--mode", "timeout"], [], 300));
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.simulation?.consequence, "continued");
  });

  it("attaches no simulation to a successful result", async () => {
    const run = await runCli(args([FAKE_BACKEND, "--mode", "no-effect"]));
    const record = parseSingle(run.stdout);
    assert.equal(record.simulation, undefined);
  });
});
