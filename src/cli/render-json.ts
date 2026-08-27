import type { AttemptRecord, RunOutcome } from "../core/attempt.js";
import type { Simulation } from "../core/classify.js";

/**
 * Machine output. One attempt emits exactly one JSON object; multiple attempts
 * emit JSONL with one complete record per attempt (attempt number, kind, and
 * its complete result). The final record carries the final result. All machine
 * records go to standard output so multi-attempt streams stay parseable.
 */
export function renderJsonLines(outcome: RunOutcome): string[] {
  if (outcome.attempts.length === 1) {
    const single: { result: unknown; simulation?: Simulation } = { result: outcome.result };
    if (outcome.simulation !== undefined) single.simulation = outcome.simulation;
    return [JSON.stringify(single)];
  }
  return outcome.attempts.map((attempt: AttemptRecord, index: number) => {
    const isFinal = index === outcome.attempts.length - 1;
    const record: { attempt: number; kind: string; result: unknown; simulation?: Simulation } = {
      attempt: attempt.number,
      kind: attempt.kind,
      result: attempt.result,
    };
    if (isFinal && outcome.simulation !== undefined) record.simulation = outcome.simulation;
    return JSON.stringify(record);
  });
}
