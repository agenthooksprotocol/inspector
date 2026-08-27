import type { AttemptRecord, RunOutcome } from "../core/attempt.js";
import type { ErrorEnvelope } from "../core/errors.js";
import type { Finding } from "../core/event.js";

export interface RenderOptions {
  /** Pretty-print each record; without it, records are strict single-line JSON/JSONL. */
  pretty: boolean;
  /** Include full diagnostic evidence fields in every record. */
  verbose: boolean;
}

export function stringifyRecord(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** Full diagnostic evidence for one attempt, added to records under --verbose. */
function evidenceFields(attempt: AttemptRecord): Record<string, unknown> {
  return {
    request: attempt.request,
    ...(attempt.response === undefined ? {} : { response: attempt.response }),
    transport: attempt.transport,
    timing: attempt.timing,
    validation: attempt.validation,
  };
}

/**
 * Machine output — the only output format. One attempt emits exactly one JSON
 * object; multiple attempts emit one complete record per attempt (attempt
 * number, kind, and its complete result), single-line JSONL by default or
 * pretty-printed in sequence under --pretty. The final record carries the
 * final result. All records go to standard output so multi-attempt streams
 * stay parseable.
 */
export function renderRecords(outcome: RunOutcome, options: RenderOptions): string[] {
  if (outcome.attempts.length === 1) {
    const attempt = outcome.attempts[0] as AttemptRecord;
    const record: Record<string, unknown> = { result: outcome.result };
    if (outcome.simulation !== undefined) record.simulation = outcome.simulation;
    if (options.verbose) Object.assign(record, evidenceFields(attempt));
    return [stringifyRecord(record, options.pretty)];
  }
  return outcome.attempts.map((attempt: AttemptRecord, index: number) => {
    const isFinal = index === outcome.attempts.length - 1;
    const record: Record<string, unknown> = {
      attempt: attempt.number,
      kind: attempt.kind,
      result: attempt.result,
    };
    if (isFinal && outcome.simulation !== undefined) record.simulation = outcome.simulation;
    if (options.verbose) Object.assign(record, evidenceFields(attempt));
    return stringifyRecord(record, options.pretty);
  });
}

/** Structured stderr envelope for usage/configuration and export failures. */
export function renderErrorEnvelope(error: ErrorEnvelope & { rule?: string }, findings: Finding[], pretty: boolean): string {
  const envelope: Record<string, unknown> = { error };
  if (findings.length > 0) envelope.findings = findings;
  return stringifyRecord(envelope, pretty);
}
