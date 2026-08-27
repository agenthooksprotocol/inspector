import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { HookOperationalError, NdjsonDecoder } from "@agenthooksprotocol/sdk";
import { InspectorError } from "../errors.js";
import {
  LATE_DRAIN_MS,
  capText,
  type ExchangeTiming,
  type FrameEvidence,
  type StdioEvidence,
} from "./evidence.js";

export interface StdioTarget {
  command: string;
  args: string[];
}

export interface StdioExchangeOutcome {
  /** The single response frame received in time, when the exchange succeeded. */
  responseRaw?: string;
  error?: InspectorError;
  evidence: StdioEvidence;
  timing: ExchangeTiming;
}

export interface StdioObserveOutcome {
  /** True when the notification was accepted for transport delivery (write completed). */
  accepted: boolean;
  error?: InspectorError;
  /** Stdout frames observed after a notification; any such frame is unexpected. */
  unexpectedFrames: FrameEvidence[];
  evidence: StdioEvidence;
  timing: ExchangeTiming;
}

function newEvidence(target: StdioTarget): StdioEvidence {
  return {
    transport: "stdio",
    lifecycle: "per_event",
    command: target.command,
    args: [...target.args],
    spawned: false,
    killedByInspector: false,
    frames: [],
    stdout: "",
    stderr: "",
    stderrTruncated: false,
    stdoutTruncated: false,
  };
}

interface Session {
  child: ChildProcessWithoutNullStreams | undefined;
  evidence: StdioEvidence;
  startedAtMs: number;
  decoderFailed: boolean;
}

/** Spawn the per-event backend directly (no shell) and wire evidence capture. */
function startSession(target: StdioTarget, deadlineAtMs: number, onFrame: (frame: FrameEvidence) => void, onSpawnError: (error: Error) => void): Session {
  const session: Session = { child: undefined, evidence: newEvidence(target), startedAtMs: Date.now(), decoderFailed: false };
  const decoder = new NdjsonDecoder();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(target.command, target.args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    queueMicrotask(() => onSpawnError(error instanceof Error ? error : new Error(String(error))));
    return session;
  }
  session.child = child;
  child.once("spawn", () => {
    session.evidence.spawned = true;
    if (child.pid !== undefined) session.evidence.pid = child.pid;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const capped = capText(session.evidence.stdout, text);
    session.evidence.stdout = capped.text;
    if (capped.truncated) session.evidence.stdoutTruncated = true;
    if (session.decoderFailed) return;
    try {
      for (const raw of decoder.push(chunk)) {
        const frame: FrameEvidence = { raw, atMs: Date.now() - session.startedAtMs, late: Date.now() > deadlineAtMs };
        session.evidence.frames.push(frame);
        onFrame(frame);
      }
    } catch (error) {
      session.decoderFailed = true;
      session.evidence.framingError = error instanceof HookOperationalError ? `${error.code}: ${error.message}` : String(error);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const capped = capText(session.evidence.stderr, chunk.toString("utf8"));
    session.evidence.stderr = capped.text;
    if (capped.truncated) session.evidence.stderrTruncated = true;
  });
  return session;
}

function recordExit(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
  session.evidence.exitCode = code;
  session.evidence.signal = signal;
}

function timing(session: Session, deadlineAtMs: number | undefined, deadlineExceeded: boolean): ExchangeTiming {
  const endedAtMs = Date.now();
  return {
    startedAt: new Date(session.startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - session.startedAtMs,
    ...(deadlineAtMs === undefined ? {} : { deadlineAt: new Date(deadlineAtMs).toISOString() }),
    deadlineExceeded,
    lateResponse: session.evidence.frames.some((frame) => frame.late),
  };
}

/**
 * One `hooks/intercept` exchange over a per-event stdio backend.
 *
 * The single absolute deadline covers spawn, write, backend processing, and
 * response receipt. On expiry the result is fixed as a TIMEOUT operational
 * failure; a short bounded drain records any late frame as evidence (marked
 * late) before the process is killed, without changing the result.
 */
export function stdioInterceptExchange(target: StdioTarget, line: string, deadlineAtMs: number): Promise<StdioExchangeOutcome> {
  return new Promise((resolve) => {
    if (Date.now() >= deadlineAtMs) {
      const startedAtMs = Date.now();
      resolve({
        error: new InspectorError("TIMEOUT", "Deadline expired before the backend could be started", "setup", true),
        evidence: newEvidence(target),
        timing: {
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(startedAtMs).toISOString(),
          durationMs: 0,
          deadlineAt: new Date(deadlineAtMs).toISOString(),
          deadlineExceeded: true,
          lateResponse: false,
        },
      });
      return;
    }
    let settled = false;
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    const session = startSession(target, deadlineAtMs, () => undefined, (error) => {
      finish(new InspectorError("TARGET_UNAVAILABLE", `Could not launch backend ${target.command}: ${error.message}`, "setup", true, { cause: error }));
    });

    const finish = (error?: InspectorError, responseRaw?: string): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      const child = session.child;
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        session.evidence.killedByInspector = true;
        child.kill("SIGKILL");
      }
      resolve({
        ...(responseRaw === undefined ? {} : { responseRaw }),
        ...(error === undefined ? {} : { error }),
        evidence: session.evidence,
        timing: timing(session, deadlineAtMs, timedOut),
      });
    };

    const child = session.child;
    if (child === undefined) return; // synchronous spawn failure already scheduled

    child.once("error", (error: Error) => {
      finish(new InspectorError("TARGET_UNAVAILABLE", `Could not launch backend ${target.command}: ${error.message}`, "setup", true, { cause: error }));
    });

    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      recordExit(session, code, signal);
      if (settled) return;
      if (timedOut) {
        finish(new InspectorError("TIMEOUT", `Backend did not complete the exchange within the deadline`, "await-response", true));
        return;
      }
      if (session.evidence.framingError !== undefined) {
        const code_ = session.evidence.framingError.startsWith("MALFORMED_UTF8") ? "MALFORMED_UTF8" : "MALFORMED_JSON_RPC";
        finish(new InspectorError(code_, `Backend stdout violated NDJSON framing: ${session.evidence.framingError}`, "await-response", true));
        return;
      }
      if (signal !== null) {
        finish(new InspectorError("IO_ERROR", `Backend process terminated by signal ${signal} before completing the exchange`, "await-response", true));
        return;
      }
      if (code !== 0) {
        finish(new InspectorError("IO_ERROR", `Backend process exited with status ${String(code)}; a per-event backend signals a completed exchange with exit status 0 (working-draft §17.3)`, "await-response", true));
        return;
      }
      const frames = session.evidence.frames;
      if (frames.length === 0) {
        finish(new InspectorError("IO_ERROR", "Backend exited without writing a response frame (working-draft §17.3)", "await-response", true));
        return;
      }
      if (frames.length > 1) {
        finish(new InspectorError("MALFORMED_JSON_RPC", `Backend wrote ${frames.length} stdout frames for one request; protocol stdout must carry exactly one response and no other content (AHP-STDIO-001)`, "await-response", true));
        return;
      }
      finish(undefined, (frames[0] as FrameEvidence).raw);
    });

    child.stdin.once("error", (error: Error) => {
      if (settled || timedOut) return;
      finish(new InspectorError("IO_ERROR", `Could not write the request to the backend: ${error.message}`, "send", true, { cause: error }));
    });
    child.stdin.end(`${line}\n`);

    timers.push(setTimeout(() => {
      timedOut = true;
      // Result is fixed as TIMEOUT; drain briefly to record any late frame as
      // evidence, then kill the process.
      timers.push(setTimeout(() => {
        finish(new InspectorError("TIMEOUT", `Backend did not respond within the deadline`, "await-response", true));
      }, LATE_DRAIN_MS));
    }, deadlineAtMs - Date.now()));
  });
}

/**
 * One `hooks/observe` delivery over a per-event stdio backend: spawn, write
 * one notification, close stdin, then wait for process exit or the
 * `--connect-timeout-ms` safety limit. Acceptance means the write completed;
 * it is not proof of durable receipt. Any stdout frame is unexpected.
 */
export function stdioObserveDelivery(target: StdioTarget, line: string, connectTimeoutMs: number): Promise<StdioObserveOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let accepted = false;
    let safetyExpired = false;
    const timers: NodeJS.Timeout[] = [];
    const deadlineAtMs = Date.now() + connectTimeoutMs;
    const session = startSession(target, deadlineAtMs, () => undefined, (error) => {
      finish(new InspectorError("TARGET_UNAVAILABLE", `Could not launch backend ${target.command}: ${error.message}`, "setup", true, { cause: error }));
    });

    const finish = (error?: InspectorError): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      const child = session.child;
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        session.evidence.killedByInspector = true;
        child.kill("SIGKILL");
      }
      resolve({
        accepted,
        ...(error === undefined ? {} : { error }),
        unexpectedFrames: [...session.evidence.frames],
        evidence: session.evidence,
        timing: timing(session, deadlineAtMs, safetyExpired),
      });
    };

    const child = session.child;
    if (child === undefined) return;

    child.once("error", (error: Error) => {
      finish(new InspectorError("TARGET_UNAVAILABLE", `Could not launch backend ${target.command}: ${error.message}`, "setup", true, { cause: error }));
    });

    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      recordExit(session, code, signal);
      if (settled) return;
      if (accepted) {
        finish();
      } else {
        finish(new InspectorError("IO_ERROR", "Backend process ended before the notification write completed", "send", true));
      }
    });

    child.stdin.once("error", (error: Error) => {
      if (settled || accepted) return;
      finish(new InspectorError("IO_ERROR", `Could not write the notification to the backend: ${error.message}`, "send", true, { cause: error }));
    });
    child.stdin.end(`${line}\n`, () => {
      accepted = true;
    });

    timers.push(setTimeout(() => {
      safetyExpired = true;
      if (accepted) {
        // Acceptance already happened; the safety limit only bounds how long
        // the Inspector waits for the per-event process to exit.
        finish();
      } else {
        finish(new InspectorError("TIMEOUT", `Notification write did not complete within the ${connectTimeoutMs} ms safety limit`, "send", true));
      }
    }, connectTimeoutMs));
  });
}
