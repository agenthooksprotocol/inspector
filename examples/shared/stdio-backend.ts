import {
  asOperationalError,
  HookOperationalError,
  NdjsonDecoder,
  parseInterceptRequest,
  parseInterceptResponse,
  type InterceptRequest,
  type InterceptResponse,
} from "@agenthooksprotocol/sdk";

/** Read and validate exactly one SDK-framed AHP intercept request from stdin. */
export async function readStdioInterceptRequest(): Promise<InterceptRequest> {
  const decoder = new NdjsonDecoder();
  const frames: string[] = [];

  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer;
    frames.push(...decoder.push(bytes));
  }
  decoder.end();

  if (frames.length !== 1) {
    throw new HookOperationalError(
      "MALFORMED_JSON_RPC",
      `Expected exactly one AHP request frame, received ${frames.length}`,
    );
  }

  return parseInterceptRequest(frames[0] as string);
}

/** Validate and write exactly one compact SDK-compatible AHP response frame. */
export function writeStdioInterceptResponse(response: InterceptResponse): void {
  const line = JSON.stringify(response);
  parseInterceptResponse(line, response.id);
  process.stdout.write(`${line}\n`);
}

export function reportBackendError(name: string, error: unknown): void {
  const operational = asOperationalError(error);
  process.stderr.write(`${name}: ${operational.code}: ${operational.message}\n`);
  process.exitCode = 1;
}
