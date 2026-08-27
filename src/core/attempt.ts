import type { FailurePolicy, JsonObject } from "@agenthooksprotocol/sdk";
import {
  classifyFailure,
  classifyInterceptResponse,
  simulateConsequence,
  type ClassifiedResult,
  type Simulation,
} from "./classify.js";
import { InspectorError } from "./errors.js";
import type { Finding } from "./event.js";
import type { OutboundMessage } from "./protocol.js";
import type { ExchangeTiming, TransportEvidence } from "./transport/evidence.js";
import { httpInterceptExchange, httpObserveDelivery, type HttpTarget } from "./transport/http.js";
import { stdioInterceptExchange, stdioObserveDelivery, type StdioTarget } from "./transport/stdio.js";

export type AttemptKind = "initial" | "retry" | "duplicate";

/** One complete attempt: exact frames, transport evidence, findings, result. */
export interface AttemptRecord {
  number: number;
  kind: AttemptKind;
  request: { raw: string; parsed: JsonObject };
  response?: { raw: string; parsed?: unknown; late?: boolean };
  transport: TransportEvidence;
  timing: ExchangeTiming;
  validation: Finding[];
  result: ClassifiedResult;
}

export type EngineTarget =
  | { transport: "stdio"; stdio: StdioTarget }
  | { transport: "http"; http: HttpTarget };

export interface InterceptRunConfig {
  target: EngineTarget;
  message: OutboundMessage;
  /** Expected response ID: equals both the JSON-RPC request ID and event.id. */
  expectedId: string;
  timeoutMs: number;
  failurePolicy: FailurePolicy;
  /** Number of retries allowed after an operational failure (0 = none). */
  retries: number;
  /** Deliver the identical message exactly twice (duplicate delivery test). */
  duplicateDelivery: boolean;
  onAttempt?: (record: AttemptRecord) => void;
}

export interface ObserveRunConfig {
  target: EngineTarget;
  message: OutboundMessage;
  connectTimeoutMs: number;
  onAttempt?: (record: AttemptRecord) => void;
}

export interface RunOutcome {
  attempts: AttemptRecord[];
  /** Complete final result: the result of the last attempt. */
  result: ClassifiedResult;
  simulation?: Simulation;
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function responseEvidence(raw: string, late: boolean): { raw: string; parsed?: unknown; late?: boolean } {
  const parsed = tryParse(raw);
  return {
    raw,
    ...(parsed === undefined ? {} : { parsed }),
    ...(late ? { late: true } : {}),
  };
}

/** Extract any late response captured during the post-deadline drain. */
function lateResponseRaw(evidence: TransportEvidence): string | undefined {
  if (evidence.transport === "stdio") {
    const late = evidence.frames.find((frame) => frame.late);
    return late?.raw;
  }
  return evidence.responseLate === true ? evidence.responseBody : undefined;
}

/**
 * Run one `hooks/intercept` invocation: an initial delivery, then either
 * deadline-bounded retries after operational failures (reusing the exact same
 * frame, IDs, and content — AHP-CORE-004) or exactly one deliberate duplicate
 * delivery with a fresh deadline.
 */
export async function runIntercept(config: InterceptRunConfig): Promise<RunOutcome> {
  const attempts: AttemptRecord[] = [];

  const deliver = async (kind: AttemptKind, number: number, deadlineAtMs: number): Promise<AttemptRecord> => {
    const outcome = config.target.transport === "stdio"
      ? await stdioInterceptExchange(config.target.stdio, config.message.raw, deadlineAtMs)
      : await httpInterceptExchange(config.target.http, config.message.raw, deadlineAtMs);

    let result: ClassifiedResult;
    let validation: Finding[] = [];
    let response: AttemptRecord["response"];

    if (outcome.responseRaw !== undefined) {
      const validated = classifyInterceptResponse(outcome.responseRaw, config.expectedId);
      result = validated.result;
      validation = validated.findings;
      response = responseEvidence(outcome.responseRaw, false);
    } else {
      const error = outcome.error ?? new InspectorError("IO_ERROR", "Exchange produced neither a response nor an error", "await-response", true);
      result = classifyFailure(error);
      const late = lateResponseRaw(outcome.evidence);
      if (late !== undefined) response = responseEvidence(late, true);
    }

    const record: AttemptRecord = {
      number,
      kind,
      request: { raw: config.message.raw, parsed: config.message.parsed },
      ...(response === undefined ? {} : { response }),
      transport: outcome.evidence,
      timing: outcome.timing,
      validation,
      result,
    };
    attempts.push(record);
    config.onAttempt?.(record);
    return record;
  };

  // The original deadline starts at the first attempt and bounds every retry.
  const originalDeadlineAtMs = Date.now() + config.timeoutMs;
  let last = await deliver("initial", 0, originalDeadlineAtMs);

  if (config.duplicateDelivery) {
    // A duplicate delivery is a deliberate second delivery of the identical
    // frame, so it receives its own fresh deadline.
    last = await deliver("duplicate", 1, Date.now() + config.timeoutMs);
  } else {
    let retriesUsed = 0;
    while (
      last.result.classification === "operational_failure" &&
      retriesUsed < config.retries &&
      Date.now() < originalDeadlineAtMs
    ) {
      retriesUsed += 1;
      last = await deliver("retry", retriesUsed, originalDeadlineAtMs);
    }
  }

  const result = last.result;
  const simulation = simulateConsequence(config.failurePolicy, result);
  return { attempts, result, ...(simulation === undefined ? {} : { simulation }) };
}

/**
 * Run one `hooks/observe` invocation: a single notification delivery.
 * Acceptance for transport delivery is distinguished from proof of durable
 * receipt; any JSON-RPC response is flagged as unexpected (working-draft §8.4).
 */
export async function runObserve(config: ObserveRunConfig): Promise<RunOutcome> {
  const findings: Finding[] = [];
  let result: ClassifiedResult;
  let transport: TransportEvidence;
  let timing: ExchangeTiming;
  let response: AttemptRecord["response"];

  if (config.target.transport === "stdio") {
    const outcome = await stdioObserveDelivery(config.target.stdio, config.message.raw, config.connectTimeoutMs);
    transport = outcome.evidence;
    timing = outcome.timing;
    for (const frame of outcome.unexpectedFrames) {
      findings.push({
        path: "",
        message: `Backend wrote a stdout frame in response to a notification; a notification must not receive a JSON-RPC response: ${frame.raw}`,
        code: "UNEXPECTED_RESPONSE",
        requirementId: "working-draft §8.4",
      });
    }
    result = outcome.accepted
      ? { classification: "notification_sent", ...(findings.length === 0 ? {} : { findings }) }
      : {
          classification: "notification_delivery_failure",
          error: (outcome.error ?? new InspectorError("IO_ERROR", "Delivery failed", "send", true)).toEnvelope(),
          ...(findings.length === 0 ? {} : { findings }),
        };
  } else {
    const outcome = await httpObserveDelivery(config.target.http, config.message.raw, config.connectTimeoutMs);
    transport = outcome.evidence;
    timing = outcome.timing;
    if (outcome.unexpectedBody !== undefined) {
      findings.push({
        path: "",
        message: `Backend returned a response body to a notification; a notification must not receive a JSON-RPC response: ${outcome.unexpectedBody}`,
        code: "UNEXPECTED_RESPONSE",
        requirementId: "working-draft §8.4",
      });
      response = responseEvidence(outcome.unexpectedBody, false);
    }
    result = outcome.accepted
      ? { classification: "notification_sent", ...(findings.length === 0 ? {} : { findings }) }
      : {
          classification: "notification_delivery_failure",
          error: (outcome.error ?? new InspectorError("IO_ERROR", "Delivery failed", "send", true)).toEnvelope(),
          ...(findings.length === 0 ? {} : { findings }),
        };
  }

  const record: AttemptRecord = {
    number: 0,
    kind: "initial",
    request: { raw: config.message.raw, parsed: config.message.parsed },
    ...(response === undefined ? {} : { response }),
    transport,
    timing,
    validation: findings,
    result,
  };
  config.onAttempt?.(record);
  return { attempts: [record], result };
}
