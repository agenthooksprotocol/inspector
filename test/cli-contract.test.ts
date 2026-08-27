import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { interceptEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { runCli } from "./helpers/run-cli.js";

/**
 * Scenario 16: CLI option validation for incompatible methods, event sources,
 * retry modes, and target forms. Every rejection is a stable usage error with
 * exit code 2, produced before any process or network activity.
 */

let dir: string;
let eventPath: string;

before(() => {
  dir = tempDir();
  eventPath = writeEventFile(dir, interceptEvent());
});

const CMD = ["--", "/bin/echo"];

function interceptBase(): string[] {
  return ["--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open"];
}

describe("usage rejections (scenario 16)", () => {
  const cases: Array<{ name: string; args: string[]; rule: string }> = [
    { name: "missing --transport", args: ["--method", "hooks/intercept", "--event", eventPath, ...CMD], rule: "transport-required" },
    { name: "invalid --transport", args: ["--transport", "carrier-pigeon", "--method", "hooks/intercept", "--event", eventPath, ...CMD], rule: "transport-invalid" },
    { name: "missing --method", args: ["--transport", "stdio", "--event", eventPath, ...CMD], rule: "method-required" },
    { name: "invalid --method", args: ["--transport", "stdio", "--method", "hooks/reticulate", "--event", eventPath, ...CMD], rule: "method-invalid" },
    { name: "missing --event", args: ["--transport", "stdio", "--method", "hooks/intercept", "--timeout-ms", "1000", "--failure-policy", "fail-open", ...CMD], rule: "event-required" },
    { name: "repeated --event", args: ["--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath, "--event", "-", "--timeout-ms", "1000", "--failure-policy", "fail-open", ...CMD], rule: "event-repeated" },
    { name: "intercept without --timeout-ms", args: ["--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath, "--failure-policy", "fail-open", ...CMD], rule: "timeout-required-for-intercept" },
    { name: "non-positive --timeout-ms", args: ["--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "0", "--failure-policy", "fail-open", ...CMD], rule: "timeout-invalid" },
    { name: "non-integer --timeout-ms", args: ["--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "soon", "--failure-policy", "fail-open", ...CMD], rule: "timeout-invalid" },
    { name: "intercept without --failure-policy", args: ["--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", ...CMD], rule: "failure-policy-required-for-intercept" },
    { name: "invalid --failure-policy", args: ["--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-maybe", ...CMD], rule: "failure-policy-invalid" },
    { name: "intercept with --connect-timeout-ms", args: [...interceptBase(), "--connect-timeout-ms", "500", ...CMD], rule: "connect-timeout-rejected-for-intercept" },
    { name: "observe with --timeout-ms", args: ["--transport", "stdio", "--method", "hooks/observe", "--event", eventPath, "--timeout-ms", "1000", ...CMD], rule: "timeout-rejected-for-observe" },
    { name: "observe with --failure-policy", args: ["--transport", "stdio", "--method", "hooks/observe", "--event", eventPath, "--failure-policy", "fail-open", ...CMD], rule: "failure-policy-rejected-for-observe" },
    { name: "observe with --retry", args: ["--transport", "stdio", "--method", "hooks/observe", "--event", eventPath, "--retry", ...CMD], rule: "retry-rejected-for-observe" },
    { name: "observe with --duplicate-delivery", args: ["--transport", "stdio", "--method", "hooks/observe", "--event", eventPath, "--duplicate-delivery", ...CMD], rule: "duplicate-rejected-for-observe" },
    { name: "--retry with --duplicate-delivery", args: [...interceptBase(), "--retry", "2", "--duplicate-delivery", ...CMD], rule: "retry-duplicate-exclusive" },
    { name: "zero --retry count", args: [...interceptBase(), "--retry=0", ...CMD], rule: "retry-invalid" },
    { name: "stdio with a positional URL", args: [...interceptBase(), "http://127.0.0.1:1/hooks", ...CMD], rule: "target-both-forms" },
    { name: "stdio without a command", args: interceptBase(), rule: "target-stdio-missing" },
    { name: "http with a stdio command", args: ["--transport", "http", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open", "http://127.0.0.1:1/hooks", ...CMD], rule: "target-both-forms" },
    { name: "http without a URL", args: ["--transport", "http", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open"], rule: "target-http-missing" },
    { name: "http with two URLs", args: ["--transport", "http", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open", "http://127.0.0.1:1/a", "http://127.0.0.1:1/b"], rule: "target-extra-positional" },
    { name: "http with an invalid URL", args: ["--transport", "http", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open", "not a url"], rule: "target-url-invalid" },
    { name: "remote plain-http URL", args: ["--transport", "http", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open", "http://policy.example.com/hooks"], rule: "target-url-plain-http-remote" },
    { name: "stdio with --header", args: [...interceptBase(), "--header", "X-Test: v", ...CMD], rule: "header-rejected-for-stdio" },
    { name: "stdio with --bearer-token-env", args: [...interceptBase(), "--bearer-token-env", "TOKEN", ...CMD], rule: "bearer-token-env-rejected-for-stdio" },
    { name: "malformed --header", args: ["--transport", "http", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open", "--header", "no-colon-here", "http://127.0.0.1:1/hooks"], rule: "header-invalid" },
    { name: "literal bearer token in --header", args: ["--transport", "http", "--method", "hooks/intercept", "--event", eventPath, "--timeout-ms", "1000", "--failure-policy", "fail-open", "--header", "Authorization: Bearer sekrit", "http://127.0.0.1:1/hooks"], rule: "header-literal-bearer" },
    { name: "removed --format option", args: [...interceptBase(), "--format", "json", ...CMD], rule: "unknown-option" },
    { name: "unknown option", args: [...interceptBase(), "--frobnicate", ...CMD], rule: "unknown-option" },
  ];

  for (const { name, args, rule } of cases) {
    it(`rejects ${name} [${rule}]`, async () => {
      const run = await runCli(args);
      assert.equal(run.code, 2, `stdout: ${run.stdout} stderr: ${run.stderr}`);
      assert.ok(run.stderr.includes(rule), `stderr should name rule ${rule}, got: ${run.stderr}`);
      assert.equal(run.stdout, "", "usage errors go to stderr only");
    });
  }

  it("rejects an unset --bearer-token-env variable before sending", async () => {
    const run = await runCli([
      "--transport", "http", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "1000", "--failure-policy", "fail-open",
      "--bearer-token-env", "AHP_DEFINITELY_UNSET_TOKEN", "http://127.0.0.1:1/hooks",
    ]);
    assert.equal(run.code, 2);
    assert.ok(run.stderr.includes("bearer-token-env-unset"), run.stderr);
  });

  it("emits usage errors as JSON envelopes on stderr", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/observe", "--event", eventPath,
      "--timeout-ms", "1000", ...CMD,
    ]);
    assert.equal(run.code, 2);
    assert.equal(run.stdout, "");
    const envelope = JSON.parse(run.stderr.trim()) as { error: { code: string; rule: string; phase: string } };
    assert.equal(envelope.error.code, "USAGE");
    assert.equal(envelope.error.rule, "timeout-rejected-for-observe");
  });
});

describe("event source validation before transport activity", () => {
  it("rejects an unreadable event file", async () => {
    const run = await runCli(["--transport", "stdio", "--method", "hooks/intercept", "--event", join(dir, "missing.json"), "--timeout-ms", "1000", "--failure-policy", "fail-open", ...CMD]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /Could not read event/);
  });

  it("rejects invalid event JSON without repairing it", async () => {
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, "{not json", "utf8");
    const run = await runCli(["--transport", "stdio", "--method", "hooks/intercept", "--event", badPath, "--timeout-ms", "1000", "--failure-policy", "fail-open", ...CMD]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /MALFORMED_JSON/);
  });

  it("rejects an invalid intercept event with a JSON-path finding", async () => {
    const event = interceptEvent();
    delete (event as Record<string, unknown>).tool;
    const path = writeEventFile(dir, event, "no-tool.json");
    const run = await runCli(["--transport", "stdio", "--method", "hooks/intercept", "--event", path, "--timeout-ms", "1000", "--failure-policy", "fail-open", ...CMD]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /event\.tool/);
  });

  it("rejects an unsupported observe event type with a requirement-linked finding", async () => {
    const event = interceptEvent();
    (event as Record<string, unknown>).type = "session.start";
    const path = writeEventFile(dir, event, "session-start.json");
    const run = await runCli(["--transport", "stdio", "--method", "hooks/observe", "--event", path, ...CMD]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /UNSUPPORTED_EVENT/);
    assert.match(run.stderr, /AHP-CORE-003/);
  });

  it("accepts an event from stdin with --event -", async () => {
    const run = await runCli(
      ["--transport", "stdio", "--method", "hooks/intercept", "--event", "-", "--timeout-ms", "1000", "--failure-policy", "fail-open", "--", "/nonexistent/backend"],
      { stdin: JSON.stringify(interceptEvent()) },
    );
    // The event loads and validates from stdin; the run then fails only at the
    // (deliberately missing) backend, proving stdin input reached the engine.
    assert.equal(run.code, 1);
    const record = JSON.parse(run.stdout.trim()) as { result: { error?: { code: string } } };
    assert.equal(record.result.error?.code, "TARGET_UNAVAILABLE");
  });
});
