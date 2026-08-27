#!/usr/bin/env node
import { runIntercept, runObserve, type EngineTarget, type RunOutcome } from "../core/attempt.js";
import { buildBundle, writeBundle, type TargetMetadata } from "../core/diagnostic.js";
import { InspectorError, UsageError } from "../core/errors.js";
import { loadEvent, validateInterceptEvent, type Finding, type LoadedEvent } from "../core/event.js";
import { validateObserveEvent } from "../core/observe-validation.js";
import { buildInterceptRequest, buildObserveNotification, INTERCEPT_METHOD } from "../core/protocol.js";
import { parseCliArgs, USAGE, type CliConfig } from "./args.js";
import { renderJsonLines } from "./render-json.js";
import { renderAttemptProgress, renderFinalText, renderVerbose } from "./render-text.js";

const EXIT_OK = 0;
const EXIT_OPERATIONAL_FAILURE = 1;
const EXIT_USAGE = 2;

function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function printOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Usage/configuration rejection: stable envelope on stderr, exit code 2. */
function exitUsage(error: InspectorError, format: "text" | "json", findings: Finding[] = []): never {
  if (format === "json") {
    const envelope: Record<string, unknown> = { error: { ...error.toEnvelope(), ...(error instanceof UsageError ? { rule: error.rule } : {}) } };
    if (findings.length > 0) envelope.findings = findings;
    printErr(JSON.stringify(envelope));
  } else {
    const rule = error instanceof UsageError ? ` [${error.rule}]` : "";
    printErr(`Error [${error.code}]${rule}: ${error.message}`);
    for (const finding of findings) {
      printErr(`finding: ${finding.path.length > 0 ? `${finding.path}: ` : ""}${finding.message} [${finding.code}, ${finding.requirementId}]`);
    }
    printErr("Run ahp-inspector --help for usage.");
  }
  process.exit(EXIT_USAGE);
}

function engineTarget(config: CliConfig): EngineTarget {
  if (config.transport === "stdio") {
    const stdio = config.stdio as { command: string; args: string[] };
    return { transport: "stdio", stdio };
  }
  const http = config.http as { url: string; headers: Record<string, string>; bearerTokenEnv?: string };
  return { transport: "http", http };
}

function targetMetadata(config: CliConfig): TargetMetadata {
  const base: TargetMetadata = {
    transport: config.transport,
    method: config.method,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: config.connectTimeoutMs }),
    ...(config.failurePolicy === undefined ? {} : { failurePolicy: config.failurePolicy }),
    retries: config.retries,
    duplicateDelivery: config.duplicateDelivery,
  };
  if (config.stdio !== undefined) {
    base.command = config.stdio.command;
    base.args = config.stdio.args;
    base.lifecycle = "per_event";
  }
  if (config.http !== undefined) {
    base.url = config.http.url;
    base.headers = config.http.headers;
    if (config.http.bearerTokenEnv !== undefined) base.bearerTokenEnv = config.http.bearerTokenEnv;
  }
  return base;
}

async function main(): Promise<number> {
  let config: CliConfig;
  try {
    config = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError && error.rule === "help") {
      printOut(USAGE);
      return EXIT_OK;
    }
    if (error instanceof InspectorError) {
      const format = process.argv.includes("json") && process.argv.includes("--format") ? "json" : "text";
      exitUsage(error, format);
    }
    throw error;
  }

  // Load and validate the event before any process or network activity.
  let event: LoadedEvent;
  try {
    event = loadEvent(config.eventSource);
  } catch (error) {
    if (error instanceof InspectorError) exitUsage(error, config.format);
    throw error;
  }

  const findings = config.method === INTERCEPT_METHOD
    ? validateInterceptEvent(event.parsed)
    : validateObserveEvent(event.parsed);
  if (findings.length > 0) {
    exitUsage(
      new InspectorError("INVALID_CONFIG", `The event is not a valid ${config.method === INTERCEPT_METHOD ? "tool.before intercept" : "observe"} event; see findings`, "event-validation", false),
      config.format,
      findings,
    );
  }

  // The exact outbound JSON-RPC message is pinned before transmission.
  const message = config.method === INTERCEPT_METHOD
    ? buildInterceptRequest(event.parsed)
    : buildObserveNotification(event.parsed);

  // The bearer token is resolved only inside the HTTP transport at send time;
  // here the Inspector only verifies the named variable exists.
  if (config.http?.bearerTokenEnv !== undefined) {
    const name = config.http.bearerTokenEnv;
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      exitUsage(new UsageError("bearer-token-env-unset", `Environment variable ${name} named by --bearer-token-env is not set`), config.format);
    }
  }

  const target = engineTarget(config);
  const showProgress = config.format === "text" && (config.retries > 0 || config.duplicateDelivery);

  let outcome: RunOutcome;
  if (config.method === INTERCEPT_METHOD) {
    outcome = await runIntercept({
      target,
      message,
      expectedId: String(event.parsed.id),
      timeoutMs: config.timeoutMs as number,
      failurePolicy: config.failurePolicy as NonNullable<CliConfig["failurePolicy"]>,
      retries: config.retries,
      duplicateDelivery: config.duplicateDelivery,
      ...(showProgress ? { onAttempt: (record) => printErr(renderAttemptProgress(record)) } : {}),
    });
  } else {
    outcome = await runObserve({
      target,
      message,
      connectTimeoutMs: config.connectTimeoutMs as number,
    });
  }

  if (config.format === "json") {
    for (const line of renderJsonLines(outcome)) printOut(line);
  } else {
    const text = renderFinalText(outcome, config.duplicateDelivery);
    for (const line of text.stdout) printOut(line);
    for (const line of text.stderr) printErr(line);
  }
  if (config.verbose) {
    for (const line of renderVerbose(outcome)) printErr(line);
  }

  let exportFailed = false;
  if (config.exportPath !== undefined) {
    const bundle = buildBundle({
      target: targetMetadata(config),
      event,
      attempts: outcome.attempts,
      result: outcome.result,
      ...(outcome.simulation === undefined ? {} : { simulation: outcome.simulation }),
    });
    try {
      const actualPath = writeBundle(bundle, config.exportPath);
      printErr(`Diagnostic bundle written to ${actualPath}`);
    } catch (error) {
      if (error instanceof InspectorError) {
        printErr(`Error [${error.code}] phase=${error.phase}: ${error.message}`);
        exportFailed = true;
      } else {
        throw error;
      }
    }
  }

  const success = outcome.result.classification === "no_effect"
    || outcome.result.classification === "explicit_deny"
    || outcome.result.classification === "notification_sent";
  if (exportFailed) return EXIT_OPERATIONAL_FAILURE;
  return success ? EXIT_OK : EXIT_OPERATIONAL_FAILURE;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    printErr(`Error [IO_ERROR]: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = EXIT_OPERATIONAL_FAILURE;
  },
);
