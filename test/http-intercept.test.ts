import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { httpFixture, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { startHttpServer, type TestHttpServer } from "./helpers/http-server.js";
import { FIXTURES_DIR } from "./helpers/paths.js";
import { exportedPath, runCli } from "./helpers/run-cli.js";
import type { JsonObject } from "@agenthooksprotocol/sdk";

interface MachineResult {
  result: {
    classification: string;
    effects?: Array<{ type: string; reason?: string; code?: string }>;
    error?: { code: string; message: string; phase: string; retryable: boolean };
  };
}

let server: TestHttpServer;
let eventPath: string;
let eventId: string;
let dir: string;

before(async () => {
  dir = tempDir();
  // The HTTP golden fixtures pair with the HTTP request fixture's event.
  const request = JSON.parse(readFileSync(join(FIXTURES_DIR, "http/intercept-request.valid.json"), "utf8")) as {
    params: { event: JsonObject };
  };
  eventId = request.params.event.id as string;
  eventPath = writeEventFile(dir, request.params.event);
  server = await startHttpServer();
});

after(async () => {
  await server.close();
});

function args(extra: string[] = [], timeoutMs = 3000, url = ""): string[] {
  return [
    "--transport", "http",
    "--method", "hooks/intercept",
    "--event", eventPath,
    "--timeout-ms", String(timeoutMs),
    "--failure-policy", "fail-open",
    ...extra,
    url === "" ? server.url : url,
  ];
}

function parseSingle(stdout: string): MachineResult {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected one machine record, got: ${stdout}`);
  return JSON.parse(lines[0] as string) as MachineResult;
}

function noEffectBody(id: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "0.1", effects: [] } });
}

describe("HTTP intercept valid results (scenarios 1, 2)", () => {
  it("classifies HTTP 200 with empty effects as no_effect", async () => {
    server.setHandler((request, response) => {
      const id = (JSON.parse(request.body) as { id: string }).id;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(noEffectBody(id));
    });
    const run = await runCli(args());
    assert.equal(run.code, 0, run.stderr);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "no_effect");
    assert.deepEqual(record.result.effects, []);
  });

  it("classifies the golden deny fixture as explicit_deny", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(httpFixture("deny-response.valid.json"));
    });
    const run = await runCli(args());
    assert.equal(run.code, 0, run.stderr);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "explicit_deny");
    assert.equal(record.result.effects?.[0]?.code, "com.example.policy.protected_path");
  });

  it("sends one JSON-RPC POST with application/json and the correlated ID", async () => {
    server.setHandler((request, response) => {
      const id = (JSON.parse(request.body) as { id: string }).id;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(noEffectBody(id));
    });
    const countBefore = server.requests.length;
    await runCli(args());
    const request = server.requests[countBefore];
    assert.ok(request !== undefined);
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], "application/json");
    const parsed = JSON.parse(request.body) as { jsonrpc: string; id: string; method: string; params: { event: { id: string } } };
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.method, "hooks/intercept");
    assert.equal(parsed.id, eventId);
    assert.equal(parsed.params.event.id, eventId);
  });
});

describe("HTTP intercept protocol failures (scenarios 4, 5)", () => {
  it("classifies a mismatched response ID as ID_MISMATCH", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(noEffectBody("evt_wrong_id"));
    });
    const run = await runCli(args());
    assert.equal(run.code, 1);
    assert.equal(parseSingle(run.stdout).result.error?.code, "ID_MISMATCH");
  });

  it("classifies a wrong successful-result protocol version as INCOMPATIBLE_VERSION", async () => {
    server.setHandler((request, response) => {
      const id = (JSON.parse(request.body) as { id: string }).id;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "0.2", effects: [] } }));
    });
    const run = await runCli(args());
    assert.equal(run.code, 1);
    assert.equal(parseSingle(run.stdout).result.error?.code, "INCOMPATIBLE_VERSION");
  });
});

describe("HTTP transport failures (scenario 10)", () => {
  it("classifies a non-success status as an operational failure", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ oops: true }));
    });
    const run = await runCli(args());
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "UNEXPECTED_RESPONSE");
    assert.match(record.result.error?.message ?? "", /HTTP 500/);
  });

  it("classifies a wrong content type as an operational failure", async () => {
    server.setHandler((request, response) => {
      const id = (JSON.parse(request.body) as { id: string }).id;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(noEffectBody(id));
    });
    const run = await runCli(args());
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "UNEXPECTED_RESPONSE");
    assert.match(record.result.error?.message ?? "", /text\/plain/);
  });

  it("does not follow redirects and classifies them as operational failures", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(302, { location: `${server.url}/elsewhere` });
      response.end();
    });
    const countBefore = server.requests.length;
    const run = await runCli(args());
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "UNEXPECTED_RESPONSE");
    assert.match(record.result.error?.message ?? "", /redirect/);
    assert.equal(server.requests.length, countBefore + 1, "the redirect target must not be requested");
  });

  it("classifies a refused connection as TARGET_UNAVAILABLE", async () => {
    const closed = await startHttpServer();
    const url = closed.url;
    await closed.close();
    const run = await runCli(args([], 3000, url));
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.error?.code, "TARGET_UNAVAILABLE");
  });
});

describe("HTTP deadline and late response (scenario 7)", () => {
  it("fixes the result at TIMEOUT and records a late response as late evidence", async () => {
    server.setHandler((request, response) => {
      const id = (JSON.parse(request.body) as { id: string }).id;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(noEffectBody(id));
      }, 700);
    });
    const exportPath = join(dir, "late-http.json");
    const run = await runCli(args(["--export", exportPath], 250), { env: { AHP_INSPECTOR_LATE_DRAIN_MS: "5000" } });
    assert.equal(run.code, 1);
    const record = parseSingle(run.stdout);
    assert.equal(record.result.classification, "operational_failure");
    assert.equal(record.result.error?.code, "TIMEOUT");
    const bundle = JSON.parse(readFileSync(exportedPath(run.stderr), "utf8")) as {
      attempts: Array<{
        response?: { raw: string; late?: boolean };
        transport: { responseLate?: boolean; status?: number };
        timing: { deadlineExceeded: boolean; lateResponse: boolean };
      }>;
    };
    const attempt = bundle.attempts[0];
    assert.ok(attempt !== undefined);
    assert.equal(attempt.timing.deadlineExceeded, true);
    assert.equal(attempt.timing.lateResponse, true);
    assert.equal(attempt.response?.late, true);
    assert.equal(attempt.transport.responseLate, true);
    assert.equal(attempt.transport.status, 200);
  });
});

describe("HTTP bearer authentication (scenario 19)", () => {
  it("sends the resolved token to the server but never to output or export", async () => {
    const token = "sekrit-bearer-token-a1b2c3";
    server.setHandler((request, response) => {
      const id = (JSON.parse(request.body) as { id: string }).id;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(noEffectBody(id));
    });
    const exportPath = join(dir, "bearer.json");
    const countBefore = server.requests.length;
    const run = await runCli(
      args(["--bearer-token-env", "AHP_TEST_TOKEN", "--header", "X-Test-Header: hello", "--export", exportPath, "--verbose"]),
      { env: { AHP_TEST_TOKEN: token } },
    );
    assert.equal(run.code, 0, run.stderr);

    // The live server received the real token…
    const request = server.requests[countBefore];
    assert.equal(request?.headers.authorization, `Bearer ${token}`);
    assert.equal(request?.headers["x-test-header"], "hello");

    // …while no Inspector output contains any trace of it.
    assert.ok(!run.stdout.includes(token), "stdout (including verbose evidence) must not contain the token");
    assert.ok(!run.stderr.includes(token), "stderr must not contain the token");
    const bundleText = readFileSync(exportedPath(run.stderr), "utf8");
    assert.ok(!bundleText.includes(token), "the exported bundle must not contain the token");

    // Other debugger evidence is preserved, with the redaction marker in place.
    const bundle = JSON.parse(bundleText) as {
      target: { bearerTokenEnv?: string };
      attempts: Array<{ transport: { requestHeaders: Record<string, string> } }>;
    };
    assert.equal(bundle.target.bearerTokenEnv, "AHP_TEST_TOKEN");
    const headers = bundle.attempts[0]?.transport.requestHeaders;
    assert.equal(headers?.authorization, "Bearer [redacted:AHP_TEST_TOKEN]");
    assert.equal(headers?.["x-test-header"], "hello");
  });
});
