import { INTERCEPT_METHOD, PROTOCOL_VERSION, type JsonObject } from "@agenthooksprotocol/sdk";

/** Exact immutable AHP artifact revision this Inspector build is pinned to. */
export const AHP_REVISION = "0.1.0-draft.1" as const;

/** Inspector release version (kept in sync with package.json). */
export const INSPECTOR_VERSION = "0.1.0" as const;

export const OBSERVE_METHOD = "hooks/observe" as const;

export { INTERCEPT_METHOD, PROTOCOL_VERSION };

export type Method = typeof INTERCEPT_METHOD | typeof OBSERVE_METHOD;

/** The exact outbound JSON-RPC frame, pinned before any process or network activity. */
export interface OutboundMessage {
  /** Exact serialized JSON text sent on the wire (without the trailing LF used by stdio framing). */
  raw: string;
  parsed: JsonObject;
}

/**
 * Build the canonical `hooks/intercept` request for an event: the JSON-RPC id
 * equals `event.id` and the Inspector advertises exactly `["deny"]`
 * (working draft section 8.1, AHP-CAP-001).
 */
export function buildInterceptRequest(event: JsonObject): OutboundMessage {
  const parsed: JsonObject = {
    jsonrpc: "2.0",
    id: typeof event.id === "string" ? event.id : "",
    method: INTERCEPT_METHOD,
    params: {
      protocolVersion: PROTOCOL_VERSION,
      event,
      capabilities: { effects: ["deny"] },
    },
  };
  return { raw: JSON.stringify(parsed), parsed };
}

/**
 * Build the canonical `hooks/observe` notification for an event: a JSON-RPC
 * notification without an `id` (working draft section 8.4, AHP-RPC-002).
 */
export function buildObserveNotification(event: JsonObject): OutboundMessage {
  const parsed: JsonObject = {
    jsonrpc: "2.0",
    method: OBSERVE_METHOD,
    params: {
      protocolVersion: PROTOCOL_VERSION,
      event,
    },
  };
  return { raw: JSON.stringify(parsed), parsed };
}
