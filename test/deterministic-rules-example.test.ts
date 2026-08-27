import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "./helpers/run-cli.js";

const BACKEND = resolve("dist/examples/deterministic-rules/deterministic-policy.js");
const FORCE_PUSH_EVENT = resolve("examples/deterministic-rules/force-push-event.json");
const PRODUCTION_DEPLOY_EVENT = resolve("examples/deterministic-rules/production-deploy-event.json");
const GIT_STATUS_EVENT = resolve("examples/deterministic-rules/git-status-event.json");

function args(eventPath: string): string[] {
  return [
    "--transport", "stdio",
    "--method", "hooks/intercept",
    "--event", eventPath,
    "--timeout-ms", "1000",
    "--failure-policy", "fail-closed",
    "--", process.execPath, BACKEND,
  ];
}

describe("deterministic rules example", () => {
  it("denies a force push", async () => {
    const run = await runCli(args(FORCE_PUSH_EVENT));

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      result: {
        classification: "explicit_deny",
        effects: [{
          type: "deny",
          reason: "Force pushes are blocked by the deterministic example policy.",
          code: "com.example.policy.force_push",
        }],
      },
    });
  });

  it("denies an exact production deployment tool name", async () => {
    const run = await runCli(args(PRODUCTION_DEPLOY_EVENT));

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      result: {
        classification: "explicit_deny",
        effects: [{
          type: "deny",
          reason: "Direct production deployment tool calls require a separate approval path.",
          code: "com.example.policy.production_deploy",
        }],
      },
    });
  });

  it("returns no effect when no rule matches", async () => {
    const run = await runCli(args(GIT_STATUS_EVENT));

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      result: {
        classification: "no_effect",
        effects: [],
      },
    });
  });
});
