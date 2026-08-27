import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { FailurePolicy } from "@agenthooksprotocol/sdk";
import type { AttemptRecord } from "./attempt.js";
import type { ClassifiedResult, Simulation } from "./classify.js";
import { InspectorError } from "./errors.js";
import type { LoadedEvent } from "./event.js";
import { AHP_REVISION, INSPECTOR_VERSION, type Method } from "./protocol.js";

export const DIAGNOSTIC_SCHEMA_VERSION = "ahp-inspector-diagnostic/0.1" as const;

/**
 * Target and transport metadata. Credential values never appear here: HTTP
 * bearer authentication is recorded only as the environment variable name.
 */
export interface TargetMetadata {
  transport: "stdio" | "http";
  method: Method;
  command?: string;
  args?: string[];
  lifecycle?: "per_event";
  url?: string;
  headers?: Record<string, string>;
  bearerTokenEnv?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  failurePolicy?: FailurePolicy;
  retries?: number;
  duplicateDelivery?: boolean;
}

/** Stable diagnostic bundle (schema: schemas/diagnostic/0.1.0.json). */
export interface DiagnosticBundle {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  inspector: { version: string };
  protocol: { name: "AHP"; revision: typeof AHP_REVISION };
  target: TargetMetadata;
  event: { raw: string; parsed: unknown };
  attempts: AttemptRecord[];
  /** Complete final result, equal to the final attempt's result. */
  result: ClassifiedResult;
  simulation?: Simulation;
}

export function buildBundle(input: {
  target: TargetMetadata;
  event: LoadedEvent;
  attempts: AttemptRecord[];
  result: ClassifiedResult;
  simulation?: Simulation;
}): DiagnosticBundle {
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    inspector: { version: INSPECTOR_VERSION },
    protocol: { name: "AHP", revision: AHP_REVISION },
    target: input.target,
    event: { raw: input.event.raw, parsed: input.event.parsed },
    attempts: input.attempts,
    result: input.result,
    ...(input.simulation === undefined ? {} : { simulation: input.simulation }),
  };
}

function withRandomSuffix(path: string): string {
  const dir = dirname(path);
  const ext = extname(path);
  const base = basename(path, ext);
  return join(dir, `${base}-${randomBytes(4).toString("hex")}${ext}`);
}

/**
 * Write the bundle to the requested path, never overwriting an existing file:
 * on collision a random suffix produces a new path. Returns the actual path
 * written (the caller reports it on standard error).
 */
export function writeBundle(bundle: DiagnosticBundle, requestedPath: string): string {
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  let path = requestedPath;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(path, json, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        path = withRandomSuffix(requestedPath);
        continue;
      }
      throw new InspectorError("EXPORT_IO", `Could not write diagnostic bundle to ${path}: ${error instanceof Error ? error.message : String(error)}`, "export", false, { cause: error });
    }
  }
  throw new InspectorError("EXPORT_IO", `Could not find a free export path near ${requestedPath}`, "export", false);
}
