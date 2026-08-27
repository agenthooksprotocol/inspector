import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Compiled location: dist/test/helpers/paths.js → repo root three levels up. */
export const INSPECTOR_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

export const CLI_PATH = join(INSPECTOR_ROOT, "dist/src/cli/main.js");
export const SCRIPTED_BACKEND = join(INSPECTOR_ROOT, "dist/test/helpers/scripted-stdio.js");
export const FAKE_BACKEND = join(INSPECTOR_ROOT, "node_modules/@agenthooksprotocol/testing/dist/src/fake-backend.js");

/** Protocol repo artifacts are reused by relative path, never copied. */
const BOOTSTRAPPED_PROTOCOL_REPO = join(INSPECTOR_ROOT, ".deps/agent-hooks-protocol");
const SIBLING_PROTOCOL_REPO = resolve(INSPECTOR_ROOT, "../agent-hooks-protocol");
export const PROTOCOL_REPO = firstExistingPath([
  BOOTSTRAPPED_PROTOCOL_REPO,
  SIBLING_PROTOCOL_REPO,
]);

function firstExistingPath(paths: string[]): string {
  const found = paths.find((path) => existsSync(path));
  return found ?? (paths[0] as string);
}

export const SCHEMAS_DIR = firstExistingPath([
  join(PROTOCOL_REPO, "schemas/0.1.0-draft.1"),
  join(PROTOCOL_REPO, "schema/draft"),
]);
export const FIXTURES_DIR = firstExistingPath([
  join(PROTOCOL_REPO, "fixtures/0.1.0-draft.1"),
  join(PROTOCOL_REPO, "fixtures/draft"),
]);

export const DIAGNOSTIC_SCHEMA_PATH = join(INSPECTOR_ROOT, "schemas/diagnostic/0.1.0.json");
