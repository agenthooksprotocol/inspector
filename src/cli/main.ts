#!/usr/bin/env node
import { runIntercept, runObserve, type EngineTarget, type RunOutcome } from "../core/attempt.js";
import { buildBundle, writeBundle, type TargetMetadata } from "../core/diagnostic.js";
import { InspectorError, UsageError } from "../core/errors.js";
import { loadEvent, validateInterceptEvent, type Finding, type LoadedEvent } from "../core/event.js";
import { validateObserveEvent } from "../core/observe-validation.js";
import { buildInterceptRequest, buildObserveNotification, INTERCEPT_METHOD } from "../core/protocol.js";
import { parseCliArgs, USAGE, type CliConfig } from "./args.js";
import { renderErrorEnvelope, renderRecords, stringifyRecord } from "./render-json.js";

const EXIT_OK = 0;
const EXIT_OPERATIONAL_FAILURE = 1;
const EXIT_USAGE = 2;

function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function printOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Usage/configuration rejection: structured JSON envelope on stderr, exit code 2. */
function exitUsage(error: InspectorError, pretty: boolean, findings: Finding[] = []): never {
  const envelope = { ...error.toEnvelope(), ...(error instanceof UsageError ? { rule: error.rule } : {}) };
  printErr(renderErrorEnvelope(envelope, findings, pretty));
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
      exitUsage(error, process.argv.includes("--pretty"));
    }
    throw error;
  }

  // Load and validate the event before any process or network activity.
  let event: LoadedEvent;
  try {
    event = loadEvent(config.eventSource);
  } catch (error) {
    if (error instanceof InspectorError) exitUsage(error, config.pretty);
    throw error;
  }

  const findings = config.method === INTERCEPT_METHOD
    ? validateInterceptEvent(event.parsed)
    : validateObserveEvent(event.parsed);
  if (findings.length > 0) {
    exitUsage(
      new InspectorError("INVALID_CONFIG", `The event is not a valid ${config.method === INTERCEPT_METHOD ? "tool.before intercept" : "observe"} event; see findings`, "event-validation", false),
      config.pretty,
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
      exitUsage(new UsageError("bearer-token-env-unset", `Environment variable ${name} named by --bearer-token-env is not set`), config.pretty);
    }
  }

  const target = engineTarget(config);

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
    });
  } else {
    outcome = await runObserve({
      target,
      message,
      connectTimeoutMs: config.connectTimeoutMs as number,
    });
  }

  for (const record of renderRecords(outcome, { pretty: config.pretty, verbose: config.verbose })) {
    printOut(record);
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
      printErr(stringifyRecord({ export: { path: actualPath } }, config.pretty));
    } catch (error) {
      if (error instanceof InspectorError) {
        printErr(renderErrorEnvelope(error.toEnvelope(), [], config.pretty));
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
    printErr(JSON.stringify({ error: { code: "IO_ERROR", message: error instanceof Error ? (error.stack ?? error.message) : String(error), phase: "setup", retryable: false } }));
    process.exitCode = EXIT_OPERATIONAL_FAILURE;
  },
);
