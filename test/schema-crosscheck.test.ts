import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { interceptEvent, observeAfterEvent, tempDir, writeEventFile } from "./helpers/fixtures.js";
import { startHttpServer, type TestHttpServer } from "./helpers/http-server.js";
import { FAKE_BACKEND, FIXTURES_DIR } from "./helpers/paths.js";
import { runCli } from "./helpers/run-cli.js";
import { protocolSchemaValidator } from "./helpers/schemas.js";

/**
 * Cross-checks against the pinned repository schemas (reused by relative
 * path, never copied): the Inspector's outbound frames must satisfy the
 * golden schemas, and the golden/invalid fixtures behave as labeled.
 */

let dir: string;
let eventPath: string;
let server: TestHttpServer;

before(async () => {
  dir = tempDir();
  eventPath = writeEventFile(dir, interceptEvent());
  server = await startHttpServer();
});

after(async () => {
  await server.close();
});

describe("outbound frames validate against the pinned repo schemas", () => {
  it("the outbound hooks/intercept request satisfies intercept-request.schema.json", async () => {
    const recordFile = join(dir, "schema-record");
    const run = await runCli([
      "--transport", "stdio", "--method", "hooks/intercept", "--event", eventPath,
      "--timeout-ms", "3000", "--failure-policy", "fail-open",
      "--", process.execPath, FAKE_BACKEND, "--mode", "no-effect", "--record-file", recordFile,
    ]);
    assert.equal(run.code, 0, run.stderr);
    const line = readFileSync(recordFile, "utf8").trim();
    const frame = line.slice(line.indexOf("\t") + 1);
    const validate = protocolSchemaValidator("intercept-request.schema.json");
    assert.ok(validate(JSON.parse(frame)), JSON.stringify(validate.errors, null, 2));
  });

  it("the outbound hooks/observe notification satisfies json-rpc-message.schema.json and carries no id", async () => {
    server.setHandler((_request, response) => {
      response.writeHead(202);
      response.end();
    });
    const observePath = writeEventFile(dir, observeAfterEvent(), "observe.json");
    const countBefore = server.requests.length;
    const run = await runCli([
      "--transport", "http", "--method", "hooks/observe", "--event", observePath,
      "--connect-timeout-ms", "3000", server.url,
    ]);
    assert.equal(run.code, 0, run.stderr);
    const body = server.requests[countBefore]?.body as string;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const validate = protocolSchemaValidator("json-rpc-message.schema.json");
    assert.ok(validate(parsed), JSON.stringify(validate.errors, null, 2));
    assert.ok(!("id" in parsed));
  });
});

describe("golden and invalid fixtures behave as labeled", () => {
  it("accepts the golden request and response fixtures", () => {
    const request = protocolSchemaValidator("intercept-request.schema.json");
    const noEffect = protocolSchemaValidator("intercept-no-effect-response.schema.json");
    const deny = protocolSchemaValidator("intercept-deny-response.schema.json");

    const stdioRequest = JSON.parse(readFileSync(join(FIXTURES_DIR, "stdio/intercept-request.valid.jsonl"), "utf8")) as object;
    assert.ok(request(stdioRequest), JSON.stringify(request.errors));
    const httpRequest = JSON.parse(readFileSync(join(FIXTURES_DIR, "http/intercept-request.valid.json"), "utf8")) as object;
    assert.ok(request(httpRequest), JSON.stringify(request.errors));
    assert.ok(noEffect(JSON.parse(readFileSync(join(FIXTURES_DIR, "http/no-effect-response.valid.json"), "utf8"))), JSON.stringify(noEffect.errors));
    assert.ok(deny(JSON.parse(readFileSync(join(FIXTURES_DIR, "http/deny-response.valid.json"), "utf8"))), JSON.stringify(deny.errors));
    assert.ok(deny(JSON.parse(readFileSync(join(FIXTURES_DIR, "stdio/deny-response.valid.jsonl"), "utf8"))), JSON.stringify(deny.errors));
  });

  it("rejects the labeled-invalid response fixtures", () => {
    const noEffect = protocolSchemaValidator("intercept-no-effect-response.schema.json");
    const deny = protocolSchemaValidator("intercept-deny-response.schema.json");
    assert.equal(noEffect(JSON.parse(readFileSync(join(FIXTURES_DIR, "http/no-effect-response-version.invalid.json"), "utf8"))), false);
    assert.equal(deny(JSON.parse(readFileSync(join(FIXTURES_DIR, "stdio/deny-response-multiple.invalid.jsonl"), "utf8"))), false);
  });
});
