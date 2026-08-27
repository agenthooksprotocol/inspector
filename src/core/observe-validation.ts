import { TOOL_KINDS, type JsonObject } from "@agenthooksprotocol/sdk";
import type { Finding } from "./event.js";

/**
 * Prose-semantic validation for `hooks/observe` events. The SDK and the pinned
 * schema set cover `hooks/intercept` only, so these rules are derived directly
 * from the working draft (sections 8.4, 9, and 10) and each finding links the
 * rule to its requirement ID or section.
 */

export const OBSERVE_EVENT_TYPES = ["tool.before", "tool.after", "tool.error"] as const;
export type ObserveEventType = (typeof OBSERVE_EVENT_TYPES)[number];

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REVERSE_DNS = /^(?:[A-Za-z][A-Za-z0-9-]*\.)+[A-Za-z][A-Za-z0-9_.-]*$/;

function finding(path: string, message: string, code: string, requirementId: string): Finding {
  return { path, message, code, requirementId };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(out: Finding[], value: unknown, path: string, requirementId: string): boolean {
  if (isNonEmptyString(value)) return true;
  out.push(finding(path, `${path} must be a non-empty string`, "MALFORMED_JSON_RPC", requirementId));
  return false;
}

function checkSession(out: Finding[], session: unknown): void {
  if (!isObject(session)) {
    out.push(finding("event.session", "event.session must be an object", "MALFORMED_JSON_RPC", "working-draft §9.2"));
    return;
  }
  requireString(out, session.id, "event.session.id", "working-draft §9.2");
  for (const key of ["cwd", "model"] as const) {
    if (key in session && !isNonEmptyString(session[key])) {
      out.push(finding(`event.session.${key}`, `event.session.${key} must be a non-empty string when present`, "MALFORMED_JSON_RPC", "working-draft §9.2"));
    }
  }
  if ("workspaceRoots" in session) {
    const roots = session.workspaceRoots;
    if (!Array.isArray(roots) || !roots.every((root) => isNonEmptyString(root))) {
      out.push(finding("event.session.workspaceRoots", "event.session.workspaceRoots must be an array of non-empty strings", "MALFORMED_JSON_RPC", "working-draft §9.2"));
    }
  }
  if ("agent" in session) {
    const agent = session.agent;
    if (!isObject(agent)) {
      out.push(finding("event.session.agent", "event.session.agent must be an object", "MALFORMED_JSON_RPC", "working-draft §9.2"));
    } else {
      requireString(out, agent.id, "event.session.agent.id", "working-draft §9.2");
      if ("type" in agent && !isNonEmptyString(agent.type)) {
        out.push(finding("event.session.agent.type", "event.session.agent.type must be a non-empty string when present", "MALFORMED_JSON_RPC", "working-draft §9.2"));
      }
    }
  }
}

function checkTool(out: Finding[], tool: unknown, eventType: ObserveEventType): void {
  if (!isObject(tool)) {
    out.push(finding("event.tool", "event.tool is required for tool events and must be an object", "MALFORMED_JSON_RPC", "working-draft §9.1"));
    return;
  }
  requireString(out, tool.callId, "event.tool.callId", "working-draft §9.3");
  requireString(out, tool.name, "event.tool.name", "working-draft §9.3");
  if (!isNonEmptyString(tool.kind) || !(TOOL_KINDS as readonly string[]).includes(tool.kind)) {
    out.push(finding("event.tool.kind", `event.tool.kind must be one of: ${TOOL_KINDS.join(", ")}`, "MALFORMED_JSON_RPC", "working-draft §9.3"));
  }
  if (!isObject(tool.input)) {
    out.push(finding("event.tool.input", "event.tool.input must be a JSON object, not an encoded string", "MALFORMED_JSON_RPC", "working-draft §9.3"));
  }
  if ("mcp" in tool && !isObject(tool.mcp)) {
    out.push(finding("event.tool.mcp", "event.tool.mcp must be an object when present", "MALFORMED_JSON_RPC", "working-draft §9.3"));
  }
  if ("output" in tool && eventType !== "tool.after") {
    out.push(finding("event.tool.output", "event.tool.output is permitted only on tool.after events", "MALFORMED_JSON_RPC", "working-draft §9.3"));
  }
  if (eventType === "tool.error") {
    const toolError = tool.error;
    if (!isObject(toolError)) {
      out.push(finding("event.tool.error", "event.tool.error is required for tool.error events and must be an object", "MALFORMED_JSON_RPC", "working-draft §10.3"));
    } else {
      requireString(out, toolError.message, "event.tool.error.message", "working-draft §10.3");
    }
  } else if ("error" in tool) {
    out.push(finding("event.tool.error", "event.tool.error is permitted only on tool.error events", "MALFORMED_JSON_RPC", "working-draft §9.3"));
  }
}

function checkNative(out: Finding[], native: unknown): void {
  if (!isObject(native)) {
    out.push(finding("event.native", "event.native must be an object when present", "MALFORMED_JSON_RPC", "working-draft §9.4"));
    return;
  }
  requireString(out, native.provider, "event.native.provider", "working-draft §9.4");
  requireString(out, native.eventName, "event.native.eventName", "working-draft §9.4");
  if (!isObject(native.payload)) {
    out.push(finding("event.native.payload", "event.native.payload must be a JSON object", "MALFORMED_JSON_RPC", "working-draft §9.4"));
  }
}

function checkExtensions(out: Finding[], extensions: unknown): void {
  if (!isObject(extensions)) {
    out.push(finding("event.extensions", "event.extensions must be an object when present", "MALFORMED_JSON_RPC", "AHP-EXT-001"));
    return;
  }
  for (const key of Object.keys(extensions)) {
    if (!REVERSE_DNS.test(key)) {
      out.push(finding(`event.extensions.${key}`, `Extension key "${key}" must use reverse-DNS namespacing`, "MALFORMED_JSON_RPC", "AHP-EXT-001"));
    }
  }
}

/**
 * Validate one event destined for a `hooks/observe` notification. Stage 1
 * accepts the tool lifecycle events (`tool.before`, `tool.after`,
 * `tool.error`) defined in working-draft sections 9 and 10.
 */
export function validateObserveEvent(event: JsonObject): Finding[] {
  const out: Finding[] = [];
  requireString(out, event.id, "event.id", "working-draft §9.1");
  if (requireString(out, event.source, "event.source", "working-draft §9.1")) {
    try {
      new URL(event.source as string);
    } catch {
      out.push(finding("event.source", "event.source must be an absolute URI", "MALFORMED_JSON_RPC", "working-draft §9.1"));
    }
  }
  const type = event.type;
  if (!isNonEmptyString(type) || !(OBSERVE_EVENT_TYPES as readonly string[]).includes(type)) {
    out.push(finding(
      "event.type",
      `event.type must be one of ${OBSERVE_EVENT_TYPES.join(", ")} for Stage 1 observe; unknown event types are unsupported protocol semantics`,
      "UNSUPPORTED_EVENT",
      "AHP-CORE-003",
    ));
    return out;
  }
  const eventType = type as ObserveEventType;
  if (!isNonEmptyString(event.time) || !RFC3339.test(event.time as string) || !Number.isFinite(Date.parse(event.time as string))) {
    out.push(finding("event.time", "event.time must be an RFC 3339 timestamp", "MALFORMED_JSON_RPC", "working-draft §9.1"));
  }
  checkSession(out, event.session);
  checkTool(out, event.tool, eventType);
  if ("native" in event) checkNative(out, event.native);
  if ("extensions" in event) checkExtensions(out, event.extensions);
  return out;
}
