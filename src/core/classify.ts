import { HookOperationalError, parseInterceptResponse, type DenyEffect, type FailurePolicy } from "@agenthooksprotocol/sdk";
import { fromHookError, type ErrorEnvelope, type InspectorError } from "./errors.js";
import { hookErrorToFinding, type Finding } from "./event.js";

export type Classification =
  | "no_effect"
  | "explicit_deny"
  | "operational_failure"
  | "notification_sent"
  | "notification_delivery_failure";

/**
 * One normalized result. Every exchange ends in exactly one classification.
 * A valid explicit deny is a successful result, not an Inspector failure.
 */
export interface ClassifiedResult {
  classification: Classification;
  /** Present for valid intercept results: `[]` or exactly one deny effect. */
  effects?: [] | [DenyEffect];
  /** Present for operational and delivery failures. */
  error?: ErrorEnvelope;
  /** Validation or protocol findings attached to this result (may be empty). */
  findings?: Finding[];
}

/**
 * Separate simulated harness consequence, shown only when `--failure-policy`
 * is supplied and the exchange ended in an operational failure. It is
 * Inspector policy simulation, never a backend result.
 */
export interface Simulation {
  simulated: true;
  policy: FailurePolicy;
  consequence: "continued" | "synthetic_denial";
  note: string;
}

export interface ValidatedResponse {
  result: ClassifiedResult;
  findings: Finding[];
}

/**
 * Validate a raw intercept response frame against the SDK semantic validator
 * (ID correlation, protocol version, effect shape) and classify it.
 */
export function classifyInterceptResponse(raw: string, expectedId: string): ValidatedResponse {
  try {
    const result = parseInterceptResponse(raw, expectedId);
    if (result.effects.length === 0) {
      return { result: { classification: "no_effect", effects: [] }, findings: [] };
    }
    return { result: { classification: "explicit_deny", effects: result.effects }, findings: [] };
  } catch (error) {
    if (error instanceof HookOperationalError) {
      const finding = hookErrorToFinding(error);
      const inspectorError = fromHookError(error, "response-validation");
      return {
        result: { classification: "operational_failure", error: inspectorError.toEnvelope(), findings: [finding] },
        findings: [finding],
      };
    }
    throw error;
  }
}

/** Classify a failure that occurred before a validatable response existed. */
export function classifyFailure(error: InspectorError, findings: Finding[] = []): ClassifiedResult {
  return { classification: "operational_failure", error: error.toEnvelope(), findings };
}

/**
 * Compute the separate simulated policy consequence for a final result.
 * A fail-closed operational failure remains an `operational_failure`; the
 * synthetic denial is attached as simulation, never as a backend deny.
 */
export function simulateConsequence(policy: FailurePolicy | undefined, result: ClassifiedResult): Simulation | undefined {
  if (policy === undefined || result.classification !== "operational_failure") return undefined;
  if (policy === "fail-open") {
    return {
      simulated: true,
      policy,
      consequence: "continued",
      note: "Inspector simulation of a fail-open harness: the operation would continue unchanged. Not a backend result and not evidence of real harness enforcement.",
    };
  }
  return {
    simulated: true,
    policy,
    consequence: "synthetic_denial",
    note: "Inspector simulation of a fail-closed harness: the operation would be denied with a synthetic (local) reason. Not a backend deny and not evidence of real harness enforcement.",
  };
}
