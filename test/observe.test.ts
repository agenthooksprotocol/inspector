import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { observeAfterEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { startHttpServer, type TestHttpServer } from "./helpers/http-server.js";
import { SCRIPTED_BACKEND } from "./helpers/paths.js";
import { runCli } from "./helpers/run-cli.js";

interface MachineResult {
  result: {
    classification: string;
    error?: { code: string; message: string; phase: string };
    findings?: Array<{ code: string; message: string; requirementId: string }>;
  };
}

let server: TestHttpServer;
let eventPath: string;

before(async () => {
  const dir = tempDir();
  eventPath = writeEventFile(dir, observeAfterEvent());
  server = await startHttpServer();
});

after(async () => {
  await server.close();
});

function stdioArgs(mode: string, connectTimeoutMs = 3000): string[] {
  return [
    "--transport", "stdio",
    "--method", "hooks/observe",
    "--event", eventPath,
    "--connect-timeout-ms", String(connectTimeoutMs),
    "--format", "json",
    "--", process.execPath, SCRIPTED_BACKEND, mode,
  ];
}

function httpArgs(): string[] {
  return [
    "--transport", "http",
    "--method", "hooks/observe",
    "--event", eventPath,
    "--connect-timeout-ms", "3000",
    "--format", "json",
    server.url,
  ];
}

function parseSingle(stdout: string): MachineResult {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected one machine record, got: ${stdout}`);
  return JSON.parse(lines[0] as string) as MachineResult;
}

describe("observe over stdio (scenarios 11, 12)", () => {
  it("classifies a silently accepted notification as notification_sent", async () => {
    const run = await runCli(stdioArgs("observe-silent"));
    assert.equal(run.code, 0, run.stderr);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "notification_sent");
    assert.equal(record.result.findings, undefined);
  });

  it("flags an unexpected JSON-RPC response without retracting acceptance", async () => {
    const run = await runCli(stdioArgs("observe-respond"));
    assert.equal(run.code, 0, run.stderr);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "notification_sent");
    const finding = record.result.findings?.[0];
    assert.equal(finding?.code, "UNEXPECTED_RESPONSE");
    assert.match(finding?.message ?? "", /must not receive a JSON-RPC response/);
  });

  it("bounds waiting with the safety limit while keeping acceptance", async () => {
    const run = await runCli(stdioArgs("observe-hang", 300));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(parseSingle(run.stdout).result.classification, "notification_sent");
  });

  it("classifies a launch failure as notification_delivery_failure", async () => {
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/observe", "--event", eventPath,
      "--connect-timeout-ms", "3000", "--format", "json",
      "--", "/nonexistent/definitely-missing-backend",
    ]);
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "notification_delivery_failure");
    assert.equal(record.result.error?.code, "TARGET_UNAVAILABLE");
  });
});

describe("observe over HTTP (scenarios 11, 12)", () => {
  it("classifies 202 Accepted with no body as notification_sent", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(202);
      response.end();
    });
    const run = await runCli(httpArgs());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(parseSingle(run.stdout).result.classification, "notification_sent");
  });

  it("classifies 204 No Content as notification_sent", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const run = await runCli(httpArgs());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(parseSingle(run.stdout).result.classification, "notification_sent");
  });

  it("sends a JSON-RPC notification without an id", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(202);
      response.end();
    });
    const countBefore = server.requests.length;
    await runCli(httpArgs());
    const request = server.requests[countBefore];
    assert.ok(request !== undefined);
    const parsed = JSON.parse(request.body) as Record<string, unknown>;
    assert.equal(parsed.method, "hooks/observe");
    assert.ok(!("id" in parsed), "a notification must not carry a JSON-RPC id");
    assert.equal((parsed.params as { protocolVersion: string }).protocolVersion, "0.1");
  });

  it("classifies an unexpected JSON-RPC body as a flagged delivery failure", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: "spurious", result: { protocolVersion: "0.1", effects: [] } }));
    });
    const run = await runCli(httpArgs());
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "notification_delivery_failure");
    assert.equal(record.result.error?.code, "UNEXPECTED_RESPONSE");
    assert.equal(record.result.findings?.[0]?.code, "UNEXPECTED_RESPONSE");
  });

  it("classifies 202 with a body as a flagged delivery failure", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: "spurious", result: { protocolVersion: "0.1", effects: [] } }));
    });
    const run = await runCli(httpArgs());
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "notification_delivery_failure");
    assert.equal(record.result.findings?.[0]?.code, "UNEXPECTED_RESPONSE");
  });

  it("classifies a non-2xx status as notification_delivery_failure", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(500);
      response.end();
    });
    const run = await runCli(httpArgs());
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "notification_delivery_failure");
    assert.match(record.result.error?.message ?? "", /202 or 204/);
  });
});
