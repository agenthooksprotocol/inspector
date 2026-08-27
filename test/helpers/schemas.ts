import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { DIAGNOSTIC_SCHEMA_PATH, SCHEMAS_DIR } from "./paths.js";

const require = createRequire(import.meta.url);
// The repo schemas declare the 2020-12 dialect (schemas manifest).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Ajv2020 = (require("ajv/dist/2020.js") as { default: new (options: object) => AjvLike }).default;
const addFormats = (require("ajv-formats") as { default: (ajv: AjvLike) => AjvLike }).default;

interface AjvLike {
  addSchema(schema: object): AjvLike;
  compile(schema: object): ValidateFunction;
  getSchema(id: string): ValidateFunction | undefined;
}

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

let protocolAjv: AjvLike | undefined;

/** Compile a validator for one pinned repo schema, resolving cross-file $refs. */
export function protocolSchemaValidator(fileName: string): ValidateFunction {
  if (protocolAjv === undefined) {
    protocolAjv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
    for (const entry of readdirSync(SCHEMAS_DIR)) {
      if (entry.endsWith(".schema.json")) protocolAjv.addSchema(loadJson(join(SCHEMAS_DIR, entry)));
    }
  }
  const id = loadJson(join(SCHEMAS_DIR, fileName)).$id as string;
  const validator = protocolAjv.getSchema(id);
  if (validator === undefined) throw new Error(`Schema not found: ${fileName}`);
  return validator;
}

/** Compile a validator for the Inspector diagnostic bundle schema. */
export function diagnosticSchemaValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(loadJson(DIAGNOSTIC_SCHEMA_PATH));
}
