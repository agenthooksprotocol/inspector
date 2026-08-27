import { parseArgs } from "node:util";
import type { FailurePolicy } from "@agenthooksprotocol/sdk";
import { UsageError } from "../core/errors.js";
import { INTERCEPT_METHOD, OBSERVE_METHOD, type Method } from "../core/protocol.js";

/** Default observe transport safety limit when --connect-timeout-ms is omitted. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export interface CliConfig {
  transport: "stdio" | "http";
  method: Method;
  /** Event source: a file path or "-" for stdin. */
  eventSource: string;
  stdio?: { command: string; args: string[] };
  http?: { url: string; headers: Record<string, string>; bearerTokenEnv?: string };
  timeoutMs?: number;
  connectTimeoutMs?: number;
  failurePolicy?: FailurePolicy;
  retries: number;
  duplicateDelivery: boolean;
  exportPath?: string;
  verbose: boolean;
  format: "text" | "json";
}

export const USAGE = `Usage:
  ahp-inspector --transport stdio --method <hooks/intercept|hooks/observe> --event <path|-> [options] -- <command> [args...]
  ahp-inspector --transport http  --method <hooks/intercept|hooks/observe> --event <path|-> [options] <url>

Required:
  --transport stdio|http                one ad hoc target transport
  --method hooks/intercept|hooks/observe
  --event <path>|-                      one JSON event (file or stdin)

hooks/intercept (required):
  --timeout-ms <n>                      positive-integer deadline for the whole exchange
  --failure-policy fail-open|fail-closed

hooks/observe:
  --connect-timeout-ms <n>              transport safety limit (default ${DEFAULT_CONNECT_TIMEOUT_MS})

Options:
  --header "Name: Value"                repeatable; HTTP only
  --bearer-token-env NAME               HTTP bearer auth via environment variable; never a literal token
  --retry [count]                       retry after operational failure within the original deadline (default 1)
  --duplicate-delivery                  deliberate duplicate delivery test; mutually exclusive with --retry
  --export <path>                       write a full diagnostic bundle (never overwrites)
  --verbose                             detailed evidence on stderr
  --format json                         machine output: one JSON object, or JSONL for multiple attempts
`;

const KNOWN_OPTIONS = {
  transport: { type: "string" },
  method: { type: "string" },
  event: { type: "string", multiple: true },
  "timeout-ms": { type: "string" },
  "connect-timeout-ms": { type: "string" },
  "failure-policy": { type: "string" },
  header: { type: "string", multiple: true },
  "bearer-token-env": { type: "string" },
  retry: { type: "string" },
  "duplicate-delivery": { type: "boolean" },
  export: { type: "string" },
  verbose: { type: "boolean" },
  format: { type: "string" },
  help: { type: "boolean" },
} as const;

/**
 * `--retry` accepts an optional count. A following token is treated as the
 * count only when it is a plain integer; otherwise the default of one retry
 * is inserted.
 */
function normalizeRetry(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    out.push(token);
    if (token === "--retry") {
      const next = argv[index + 1];
      if (next === undefined || !/^\d+$/.test(next)) out.push("1");
    }
  }
  return out;
}

function positiveInteger(value: string, option: string, rule: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(rule, `${option} must be a positive integer, got: ${value}`);
  }
  return Number(value);
}

function requireValue(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError("missing-option-value", `${option} requires a value`);
  }
  return value;
}

function parseHeader(entry: string): [string, string] {
  const colon = entry.indexOf(":");
  if (colon <= 0) {
    throw new UsageError("header-invalid", `--header must look like "Name: Value", got: ${entry}`);
  }
  const name = entry.slice(0, colon).trim();
  const value = entry.slice(colon + 1).trim();
  if (name.length === 0) {
    throw new UsageError("header-invalid", `--header must look like "Name: Value", got: ${entry}`);
  }
  if (/^authorization$/i.test(name) && /^bearer\s/i.test(value)) {
    throw new UsageError("header-literal-bearer", "A literal bearer token must not be passed on the command line; use --bearer-token-env NAME");
  }
  return [name, value];
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Parse and validate the full CLI contract. Every contract rejection is a
 * UsageError with a stable rule slug; nothing is inferred from event content.
 */
export function parseCliArgs(argv: string[]): CliConfig {
  // The stdio command follows a literal `--` and is never interpreted as options.
  const separator = argv.indexOf("--");
  const optionArgv = separator === -1 ? argv : argv.slice(0, separator);
  const stdioCommand = separator === -1 ? undefined : argv.slice(separator + 1);

  let parsed: ReturnType<typeof parseArgs<{ options: typeof KNOWN_OPTIONS; tokens: true; strict: false; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: normalizeRetry(optionArgv),
      options: KNOWN_OPTIONS,
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
  } catch (error) {
    throw new UsageError("invalid-arguments", error instanceof Error ? error.message : String(error));
  }

  for (const token of parsed.tokens) {
    if (token.kind === "option" && !(token.name in KNOWN_OPTIONS)) {
      throw new UsageError("unknown-option", `Unknown option: --${token.name}`);
    }
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>;

  if (values.help === true) {
    throw new UsageError("help", USAGE);
  }

  const transport = requireValue(values.transport as string | undefined, "--transport");
  if (transport !== "stdio" && transport !== "http") {
    throw new UsageError("transport-invalid", `--transport must be stdio or http, got: ${transport}`);
  }

  const method = requireValue(values.method as string | undefined, "--method");
  if (method !== INTERCEPT_METHOD && method !== OBSERVE_METHOD) {
    throw new UsageError("method-invalid", `--method must be ${INTERCEPT_METHOD} or ${OBSERVE_METHOD}, got: ${method}`);
  }

  const events = (values.event as string[] | undefined) ?? [];
  if (events.length === 0) {
    throw new UsageError("event-required", "Exactly one event source is required: --event <path> or --event -");
  }
  if (events.length > 1) {
    throw new UsageError("event-repeated", "--event may be supplied only once");
  }
  const eventSource = requireValue(events[0], "--event");

  const format = (values.format as string | undefined) ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError("format-invalid", `--format must be json (or omitted for text), got: ${format}`);
  }

  // Target form: stdio command after `--`, or exactly one positional URL.
  const positionals = parsed.positionals;
  if (transport === "stdio") {
    if (positionals.length > 0) {
      throw new UsageError("target-both-forms", `A stdio invocation takes its command after --; unexpected positional argument: ${String(positionals[0])}`);
    }
    if (stdioCommand === undefined || stdioCommand.length === 0) {
      throw new UsageError("target-stdio-missing", "A stdio target requires an executable and arguments after --");
    }
  } else {
    if (stdioCommand !== undefined) {
      throw new UsageError("target-both-forms", "An HTTP invocation must not include a stdio command after --");
    }
    if (positionals.length === 0) {
      throw new UsageError("target-http-missing", "An HTTP target requires one positional URL");
    }
    if (positionals.length > 1) {
      throw new UsageError("target-extra-positional", `Exactly one URL is expected, got ${positionals.length} positional arguments`);
    }
  }

  // Transport-specific options.
  const headers = (values.header as string[] | undefined) ?? [];
  const bearerTokenEnv = values["bearer-token-env"] as string | undefined;
  if (transport === "stdio") {
    if (headers.length > 0) throw new UsageError("header-rejected-for-stdio", "--header applies only to --transport http");
    if (bearerTokenEnv !== undefined) throw new UsageError("bearer-token-env-rejected-for-stdio", "--bearer-token-env applies only to --transport http");
  }

  // Method-specific options.
  const timeoutRaw = values["timeout-ms"] as string | undefined;
  const failurePolicyRaw = values["failure-policy"] as string | undefined;
  const connectTimeoutRaw = values["connect-timeout-ms"] as string | undefined;
  const retryRaw = values.retry as string | undefined;
  const duplicateDelivery = values["duplicate-delivery"] === true;

  let timeoutMs: number | undefined;
  let connectTimeoutMs: number | undefined;
  let failurePolicy: FailurePolicy | undefined;
  let retries = 0;

  if (method === INTERCEPT_METHOD) {
    if (timeoutRaw === undefined) {
      throw new UsageError("timeout-required-for-intercept", "--timeout-ms is required for hooks/intercept");
    }
    timeoutMs = positiveInteger(requireValue(timeoutRaw, "--timeout-ms"), "--timeout-ms", "timeout-invalid");
    if (failurePolicyRaw === undefined) {
      throw new UsageError("failure-policy-required-for-intercept", "--failure-policy fail-open|fail-closed is required for hooks/intercept");
    }
    const policy = requireValue(failurePolicyRaw, "--failure-policy");
    if (policy !== "fail-open" && policy !== "fail-closed") {
      throw new UsageError("failure-policy-invalid", `--failure-policy must be fail-open or fail-closed, got: ${policy}`);
    }
    failurePolicy = policy;
    if (connectTimeoutRaw !== undefined) {
      throw new UsageError("connect-timeout-rejected-for-intercept", "--connect-timeout-ms applies only to hooks/observe; hooks/intercept is bounded by --timeout-ms");
    }
    if (retryRaw !== undefined && duplicateDelivery) {
      throw new UsageError("retry-duplicate-exclusive", "--retry and --duplicate-delivery are mutually exclusive");
    }
    if (retryRaw !== undefined) {
      retries = positiveInteger(requireValue(retryRaw, "--retry"), "--retry", "retry-invalid");
    }
  } else {
    if (timeoutRaw !== undefined) {
      throw new UsageError("timeout-rejected-for-observe", "--timeout-ms is rejected for hooks/observe; use --connect-timeout-ms as the transport safety limit");
    }
    if (failurePolicyRaw !== undefined) {
      throw new UsageError("failure-policy-rejected-for-observe", "--failure-policy is rejected for hooks/observe");
    }
    if (retryRaw !== undefined) {
      throw new UsageError("retry-rejected-for-observe", "--retry is not available for hooks/observe");
    }
    if (duplicateDelivery) {
      throw new UsageError("duplicate-rejected-for-observe", "--duplicate-delivery is not available for hooks/observe");
    }
    connectTimeoutMs = connectTimeoutRaw === undefined
      ? DEFAULT_CONNECT_TIMEOUT_MS
      : positiveInteger(requireValue(connectTimeoutRaw, "--connect-timeout-ms"), "--connect-timeout-ms", "connect-timeout-invalid");
  }

  const exportPath = values.export as string | undefined;
  if (exportPath !== undefined) requireValue(exportPath, "--export");

  const config: CliConfig = {
    transport,
    method,
    eventSource,
    retries,
    duplicateDelivery,
    verbose: values.verbose === true,
    format,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    ...(failurePolicy === undefined ? {} : { failurePolicy }),
    ...(exportPath === undefined ? {} : { exportPath }),
  };

  if (transport === "stdio") {
    const [command, ...args] = stdioCommand as string[];
    config.stdio = { command: command as string, args };
  } else {
    const urlText = positionals[0] as string;
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new UsageError("target-url-invalid", `The HTTP target must be an absolute URL, got: ${urlText}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UsageError("target-url-invalid", `The HTTP target must use http or https, got: ${url.protocol}`);
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      throw new UsageError("target-url-plain-http-remote", "Plain http is permitted only for loopback addresses; remote endpoints must use https (working-draft §18.2)");
    }
    if (bearerTokenEnv !== undefined && bearerTokenEnv.trim().length === 0) {
      throw new UsageError("bearer-token-env-invalid", "--bearer-token-env requires an environment variable name");
    }
    const headerMap: Record<string, string> = {};
    for (const entry of headers) {
      const [name, value] = parseHeader(entry);
      headerMap[name] = value;
    }
    config.http = {
      url: urlText,
      headers: headerMap,
      ...(bearerTokenEnv === undefined ? {} : { bearerTokenEnv }),
    };
  }

  return config;
}
