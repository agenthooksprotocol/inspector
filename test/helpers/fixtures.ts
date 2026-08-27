import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@agenthooksprotocol/sdk";
import { FIXTURES_DIR } from "./paths.js";

/** The golden tool.before event, extracted from the pinned repo fixture. */
export function interceptEvent(): JsonObject {
  const raw = readFileSync(join(FIXTURES_DIR, "stdio/intercept-request.valid.jsonl"), "utf8");
  const request = JSON.parse(raw) as { params: { event: JsonObject } };
  return request.params.event;
}

/** The golden HTTP no-effect response fixture, as raw text. */
export function httpFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, "http", name), "utf8");
}

/** A valid tool.after observe event derived from the golden tool.before event. */
export function observeAfterEvent(): JsonObject {
  const before = interceptEvent();
  const tool = { ...(before.tool as JsonObject) };
  tool.output = { exitCode: 0, stdout: "On branch main\n", stderr: "" };
  return { ...before, id: "evt_observe_001", type: "tool.after", tool };
}

export function tempDir(prefix = "ahp-inspector-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeEventFile(dir: string, event: JsonObject, name = "event.json"): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  return path;
}
