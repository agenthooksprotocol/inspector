import { HookOperationalError, type HookErrorCode } from "@agenthooksprotocol/sdk";

/**
 * Stable Inspector error codes: the SDK's operational codes plus Inspector-only
 * categories (usage/configuration, target unavailable, export I/O, and
 * unexpected transport-level responses).
 */
export type InspectorErrorCode =
  | HookErrorCode
  | "USAGE"
  | "TARGET_UNAVAILABLE"
  | "EXPORT_IO"
  | "UNEXPECTED_RESPONSE";

/** Where in the one-shot lifecycle a failure occurred. */
export type Phase =
  | "usage"
  | "event-load"
  | "event-validation"
  | "setup"
  | "send"
  | "await-response"
  | "response-validation"
  | "export";

/** Serializable error envelope used in machine output and diagnostics. */
export interface ErrorEnvelope {
  code: InspectorErrorCode;
  message: string;
  phase: Phase;
  retryable: boolean;
}

export class InspectorError extends Error {
  readonly code: InspectorErrorCode;
  readonly phase: Phase;
  readonly retryable: boolean;

  constructor(code: InspectorErrorCode, message: string, phase: Phase, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "InspectorError";
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
  }

  toEnvelope(): ErrorEnvelope {
    return { code: this.code, message: this.message, phase: this.phase, retryable: this.retryable };
  }
}

/** Usage/configuration rejection with a stable machine-readable rule slug. */
export class UsageError extends InspectorError {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super("USAGE", message, "usage", false);
    this.name = "UsageError";
    this.rule = rule;
  }
}

/** Wrap an SDK operational error, preserving its stable code. */
export function fromHookError(error: HookOperationalError, phase: Phase): InspectorError {
  return new InspectorError(error.code, error.message, phase, true, { cause: error });
}

export function toInspectorError(error: unknown, phase: Phase): InspectorError {
  if (error instanceof InspectorError) return error;
  if (error instanceof HookOperationalError) return fromHookError(error, phase);
  const message = error instanceof Error ? error.message : String(error);
  return new InspectorError("IO_ERROR", message, phase, true, { cause: error });
}
