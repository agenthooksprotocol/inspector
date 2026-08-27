import { readFileSync } from "node:fs";
import { HookOperationalError, parseInterceptRequest, type JsonObject } from "@agenthooksprotocol/sdk";
import { InspectorError } from "./errors.js";
import { buildInterceptRequest } from "./protocol.js";

/**
 * One validation finding. `path` is the JSON path of the offending value where
 * it can be determined, and `requirementId` links the rule to its stable
 * AHP requirement ID or working-draft section.
 */
export interface Finding {
  path: string;
  message: string;
  code: string;
  requirementId: string;
}

export interface LoadedEvent {
  /** Original event text exactly as supplied. */
  raw: string;
  parsed: JsonObject;
}

/** Requirement/section link for each SDK operational code used during validation. */
const REQUIREMENT_BY_CODE: Record<string, string> = {
  MALFORMED_UTF8: "AHP-RPC-001",
  MALFORMED_JSON: "AHP-RPC-001",
  MALFORMED_JSON_RPC: "AHP-RPC-001",
  ID_MISMATCH: "working-draft §8.1",
  JSON_RPC_ERROR: "working-draft §16",
  INCOMPATIBLE_VERSION: "AHP-VER-001",
  UNSUPPORTED_EVENT: "AHP-TB-001",
  UNSUPPORTED_EFFECT: "AHP-CAP-001",
  MULTIPLE_EFFECTS: "AHP-DEC-001",
  TIMEOUT: "AHP-FAIL-002",
};

export function requirementForCode(code: string): string {
  return REQUIREMENT_BY_CODE[code] ?? "working-draft";
}

/**
 * Best-effort JSON-path extraction from the SDK's JSON-path-labeled messages
 * (for example "event.tool.callId must be a non-empty string").
 */
function pathFromMessage(message: string, code: string): string {
  const match = /(?:request|response|event)(?:\.[A-Za-z0-9_$]+|\[\d+\])*/.exec(message);
  if (match !== null) return match[0];
  if (code === "INCOMPATIBLE_VERSION") return "params.protocolVersion";
  if (code === "MULTIPLE_EFFECTS") return "response.result.effects";
  return "";
}

/** Convert an SDK validation error into a finding. */
export function hookErrorToFinding(error: HookOperationalError): Finding {
  return {
    path: pathFromMessage(error.message, error.code),
    message: error.message,
    code: error.code,
    requirementId: requirementForCode(error.code),
  };
}

function readAllOfStdin(): string {
  return readFileSync(0, "utf8");
}

/**
 * Load one event from `--event <path>` or `--event -` (stdin). The Inspector
 * never repairs invalid input; parse failures surface as errors.
 */
export function loadEvent(source: string): LoadedEvent {
  let raw: string;
  try {
    raw = source === "-" ? readAllOfStdin() : readFileSync(source, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InspectorError("USAGE", `Could not read event from ${source === "-" ? "stdin" : source}: ${message}`, "event-load", false, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InspectorError("MALFORMED_JSON", `Event is not valid JSON: ${message}`, "event-load", false, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InspectorError("MALFORMED_JSON", "Event must be a JSON object", "event-load", false);
  }
  return { raw, parsed: parsed as JsonObject };
}

/**
 * Validate an event destined for `hooks/intercept` by constructing the exact
 * canonical outbound request and running the SDK's semantic request validator
 * over its serialized form. This pins the outbound frame and validates the
 * event with JSON-path findings before any process or network activity.
 */
export function validateInterceptEvent(event: JsonObject): Finding[] {
  const message = buildInterceptRequest(event);
  try {
    parseInterceptRequest(message.raw);
    return [];
  } catch (error) {
    if (error instanceof HookOperationalError) return [hookErrorToFinding(error)];
    throw error;
  }
}
