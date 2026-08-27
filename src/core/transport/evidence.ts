/** Raw transport evidence, kept separate from parsed protocol data. */

/** One raw stdio frame observed on the backend's stdout. */
export interface FrameEvidence {
  raw: string;
  /** Milliseconds after the attempt started when the frame completed. */
  atMs: number;
  /** True when the frame arrived after the deadline expired (late-response marker). */
  late: boolean;
}

export interface ExchangeTiming {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Absolute deadline for this attempt (intercept) or safety limit (observe). */
  deadlineAt?: string;
  deadlineExceeded: boolean;
  /** True when any response data arrived after the deadline expired. */
  lateResponse: boolean;
}

export interface StdioEvidence {
  transport: "stdio";
  lifecycle: "per_event";
  command: string;
  args: string[];
  spawned: boolean;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** True when the Inspector killed the process (deadline or safety limit). */
  killedByInspector: boolean;
  /** Decoded stdout frames in arrival order, including late frames. */
  frames: FrameEvidence[];
  /** Raw stdout text as received (lossy-decoded, bounded). */
  stdout: string;
  /** Raw stderr text as received (bounded). */
  stderr: string;
  stderrTruncated: boolean;
  stdoutTruncated: boolean;
  /** NDJSON framing violation observed on stdout, if any. */
  framingError?: string;
}

export interface HttpEvidence {
  transport: "http";
  url: string;
  method: "POST";
  /** Headers actually sent, with Authorization redacted as `Bearer [redacted:NAME]`. */
  requestHeaders: Record<string, string>;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  /** Raw response body text (bounded). */
  responseBody?: string;
  /** True when status/body arrived only after the deadline (late-response marker). */
  responseLate?: boolean;
}

export type TransportEvidence = StdioEvidence | HttpEvidence;

/** Bounded drain window after deadline expiry for recording late responses. */
export const LATE_DRAIN_MS = 150;

export const EVIDENCE_TEXT_LIMIT = 64 * 1024;

export function capText(existing: string, chunk: string): { text: string; truncated: boolean } {
  if (existing.length >= EVIDENCE_TEXT_LIMIT) return { text: existing, truncated: true };
  const combined = existing + chunk;
  if (combined.length <= EVIDENCE_TEXT_LIMIT) return { text: combined, truncated: false };
  return { text: combined.slice(0, EVIDENCE_TEXT_LIMIT), truncated: true };
}
