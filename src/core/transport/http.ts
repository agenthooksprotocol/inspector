import { InspectorError } from "../errors.js";
import {
  LATE_DRAIN_MS,
  capText,
  type ExchangeTiming,
  type HttpEvidence,
} from "./evidence.js";

export interface HttpTarget {
  url: string;
  /** User-supplied headers from repeated `--header "Name: Value"` options. */
  headers: Record<string, string>;
  /** Environment variable name holding the bearer token; never a literal token. */
  bearerTokenEnv?: string;
}

export interface HttpExchangeOutcome {
  responseRaw?: string;
  error?: InspectorError;
  evidence: HttpEvidence;
  timing: ExchangeTiming;
}

export interface HttpObserveOutcome {
  accepted: boolean;
  error?: InspectorError;
  /** Response body received where none was expected (flagged, never a result). */
  unexpectedBody?: string;
  evidence: HttpEvidence;
  timing: ExchangeTiming;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface BuiltHeaders {
  /** Headers actually sent, including the resolved Authorization value. */
  send: Record<string, string>;
  /** Evidence copy with the bearer token redacted. */
  evidence: Record<string, string>;
}

/**
 * Assemble request headers. The bearer token is resolved from the named
 * environment variable at send time only; every evidence copy stores
 * `Bearer [redacted:NAME]` so the resolved value never reaches diagnostics
 * or exports (working-draft §18.3).
 */
function buildHeaders(target: HttpTarget): BuiltHeaders {
  const send: Record<string, string> = {};
  for (const [name, value] of Object.entries(target.headers)) send[name.toLowerCase()] = value;
  send["content-type"] = "application/json";
  send.accept ??= "application/json";
  const evidence: Record<string, string> = { ...send };
  if (target.bearerTokenEnv !== undefined) {
    const token = process.env[target.bearerTokenEnv];
    if (token === undefined || token.length === 0) {
      throw new InspectorError("INVALID_CONFIG", `Environment variable ${target.bearerTokenEnv} named by --bearer-token-env is not set`, "setup", false);
    }
    send.authorization = `Bearer ${token}`;
    evidence.authorization = `Bearer [redacted:${target.bearerTokenEnv}]`;
  }
  return { send, evidence };
}

function fetchFailure(error: unknown, url: string): InspectorError {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
  return new InspectorError("TARGET_UNAVAILABLE", `Could not reach ${url}: ${detail}`, "setup", true, { cause: error });
}

interface RawHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

async function readResponse(response: Response): Promise<RawHttpResponse> {
  const body = await response.text();
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

function recordResponse(evidence: HttpEvidence, raw: RawHttpResponse, late: boolean): void {
  evidence.status = raw.status;
  evidence.statusText = raw.statusText;
  evidence.responseHeaders = raw.headers;
  evidence.responseBody = capText("", raw.body).text;
  if (late) evidence.responseLate = true;
}

function timing(startedAtMs: number, deadlineAtMs: number, deadlineExceeded: boolean, lateResponse: boolean): ExchangeTiming {
  const endedAtMs = Date.now();
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    deadlineAt: new Date(deadlineAtMs).toISOString(),
    deadlineExceeded,
    lateResponse,
  };
}

function mediaType(headers: Record<string, string>): string {
  const value = headers["content-type"] ?? "";
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * One `hooks/intercept` exchange over the HTTP binding: a single POST with
 * `application/json` both ways, redirects never followed (working-draft
 * §18.1). On deadline expiry the result is fixed as TIMEOUT; a short bounded
 * drain records a late response as evidence (marked late) without changing
 * the result.
 */
export async function httpInterceptExchange(target: HttpTarget, line: string, deadlineAtMs: number): Promise<HttpExchangeOutcome> {
  const startedAtMs = Date.now();
  const evidence: HttpEvidence = {
    transport: "http",
    url: target.url,
    method: "POST",
    requestHeaders: {},
  };
  const fail = (error: InspectorError, deadlineExceeded = false, lateResponse = false): HttpExchangeOutcome => ({
    error,
    evidence,
    timing: timing(startedAtMs, deadlineAtMs, deadlineExceeded, lateResponse),
  });

  let headers: BuiltHeaders;
  try {
    headers = buildHeaders(target);
  } catch (error) {
    return fail(error as InspectorError);
  }
  evidence.requestHeaders = headers.evidence;

  if (Date.now() >= deadlineAtMs) {
    return fail(new InspectorError("TIMEOUT", "Deadline expired before the request could be sent", "setup", true), true);
  }

  const controller = new AbortController();
  const exchange = (async (): Promise<RawHttpResponse> => {
    const response = await fetch(target.url, {
      method: "POST",
      headers: headers.send,
      body: line,
      redirect: "manual",
      signal: controller.signal,
    }).catch((error: unknown) => {
      throw fetchFailure(error, target.url);
    });
    return readResponse(response).catch((error: unknown) => {
      throw new InspectorError("IO_ERROR", `Could not read the response body: ${error instanceof Error ? error.message : String(error)}`, "await-response", true, { cause: error });
    });
  })();

  const deadlineToken = Symbol("deadline");
  const raced = await Promise.race([
    exchange.then((value) => ({ value }), (error: unknown) => ({ error })),
    new Promise<typeof deadlineToken>((resolve) => setTimeout(() => resolve(deadlineToken), deadlineAtMs - Date.now())),
  ]);

  if (raced === deadlineToken) {
    // Result fixed as TIMEOUT. Drain briefly: if the response lands inside the
    // drain window, record it as late evidence, then abort the socket.
    const drainToken = Symbol("drain");
    const late = await Promise.race([
      exchange.then((value) => ({ value }), () => drainToken),
      new Promise<typeof drainToken>((resolve) => setTimeout(() => resolve(drainToken), LATE_DRAIN_MS)),
    ]);
    let lateResponse = false;
    if (late !== drainToken && typeof late === "object") {
      recordResponse(evidence, late.value, true);
      lateResponse = true;
    }
    controller.abort();
    exchange.catch(() => undefined);
    return fail(new InspectorError("TIMEOUT", "Backend did not respond within the deadline", "await-response", true), true, lateResponse);
  }

  if ("error" in raced) {
    const error = raced.error;
    return fail(error instanceof InspectorError ? error : new InspectorError("IO_ERROR", String(error), "await-response", true, { cause: error }));
  }

  const response = raced.value;
  recordResponse(evidence, response, false);

  if (REDIRECT_STATUSES.has(response.status)) {
    return fail(new InspectorError("UNEXPECTED_RESPONSE", `Backend answered with HTTP ${response.status} redirect; redirects are not followed (working-draft §18.1)`, "await-response", true));
  }
  if (response.status !== 200) {
    return fail(new InspectorError("UNEXPECTED_RESPONSE", `Backend answered with HTTP ${response.status}; a successful intercept response must use HTTP 200 (AHP-HTTP-001)`, "await-response", true));
  }
  if (mediaType(response.headers) !== "application/json") {
    return fail(new InspectorError("UNEXPECTED_RESPONSE", `Backend answered HTTP 200 with Content-Type "${response.headers["content-type"] ?? "(none)"}"; intercept responses must use application/json (AHP-HTTP-001)`, "await-response", true));
  }

  return {
    responseRaw: response.body,
    evidence,
    timing: timing(startedAtMs, deadlineAtMs, false, false),
  };
}

/**
 * One `hooks/observe` delivery over HTTP. Acceptance is `202 Accepted` or
 * `204 No Content` with no JSON-RPC body (working-draft §18.1); any other
 * status, or any response body, is a delivery failure with the unexpected
 * response flagged as evidence.
 */
export async function httpObserveDelivery(target: HttpTarget, line: string, connectTimeoutMs: number): Promise<HttpObserveOutcome> {
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + connectTimeoutMs;
  const evidence: HttpEvidence = {
    transport: "http",
    url: target.url,
    method: "POST",
    requestHeaders: {},
  };
  const outcome = (accepted: boolean, error?: InspectorError, unexpectedBody?: string, deadlineExceeded = false): HttpObserveOutcome => ({
    accepted,
    ...(error === undefined ? {} : { error }),
    ...(unexpectedBody === undefined ? {} : { unexpectedBody }),
    evidence,
    timing: timing(startedAtMs, deadlineAtMs, deadlineExceeded, false),
  });

  let headers: BuiltHeaders;
  try {
    headers = buildHeaders(target);
  } catch (error) {
    return outcome(false, error as InspectorError);
  }
  evidence.requestHeaders = headers.evidence;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  let response: RawHttpResponse;
  try {
    const fetched = await fetch(target.url, {
      method: "POST",
      headers: headers.send,
      body: line,
      redirect: "manual",
      signal: controller.signal,
    });
    response = await readResponse(fetched);
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return outcome(false, new InspectorError("TIMEOUT", `Notification delivery did not complete within the ${connectTimeoutMs} ms safety limit`, "send", true), undefined, true);
    }
    return outcome(false, fetchFailure(error, target.url));
  }
  clearTimeout(timer);
  recordResponse(evidence, response, false);

  const hasBody = response.body.trim().length > 0;
  if ((response.status === 202 || response.status === 204) && !hasBody) {
    return outcome(true);
  }
  if (response.status === 202 || response.status === 204) {
    return outcome(
      false,
      new InspectorError("UNEXPECTED_RESPONSE", `Backend accepted the notification with HTTP ${response.status} but returned a body; a notification must not receive a JSON-RPC response (working-draft §8.4, §18.1)`, "await-response", true),
      response.body,
    );
  }
  return outcome(
    false,
    new InspectorError("UNEXPECTED_RESPONSE", `Backend answered HTTP ${response.status}; an accepted observe notification uses 202 or 204 with no body (working-draft §18.1)`, "await-response", true),
    hasBody ? response.body : undefined,
  );
}
