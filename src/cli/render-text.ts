import type { AttemptRecord, RunOutcome } from "../core/attempt.js";
import type { Finding } from "../core/event.js";

export interface TextOutput {
  stdout: string[];
  stderr: string[];
}

function describeResult(record: AttemptRecord): string {
  const result = record.result;
  if (result.classification === "operational_failure" || result.classification === "notification_delivery_failure") {
    const error = result.error;
    return error === undefined ? result.classification : `${result.classification} [${error.code}] ${error.message}`;
  }
  return result.classification;
}

export function renderAttemptProgress(record: AttemptRecord): string {
  return `attempt ${record.number} (${record.kind}): ${describeResult(record)}`;
}

function findingLine(finding: Finding): string {
  const at = finding.path.length > 0 ? `${finding.path}: ` : "";
  return `finding: ${at}${finding.message} [${finding.code}, ${finding.requirementId}]`;
}

/**
 * Default text output: a concise result or error summary. Successful results
 * go to stdout; failure envelopes, findings, simulation, and diagnostics go
 * to stderr. Terminology deliberately keeps no-effect, explicit denial,
 * operational failure, and synthetic policy consequence distinct, and never
 * presents no-effect as "allow".
 */
export function renderFinalText(outcome: RunOutcome, duplicateDelivery: boolean): TextOutput {
  const out: TextOutput = { stdout: [], stderr: [] };
  const result = outcome.result;

  if (duplicateDelivery) {
    out.stderr.push("Duplicate delivery test: the identical event (same IDs and content) was deliberately delivered twice. This is a backend diagnostic, not simulated conforming harness behavior.");
  }

  switch (result.classification) {
    case "no_effect": {
      out.stdout.push("Result: no_effect — the backend returned an empty effects list (no objection).");
      out.stdout.push("Note: no_effect is not \"allow\". It does not bypass other interceptors, host permissions, approval, or sandboxing.");
      break;
    }
    case "explicit_deny": {
      const deny = result.effects?.[0];
      const code = deny !== undefined && deny.code !== undefined ? ` (code: ${deny.code})` : "";
      out.stdout.push(`Result: explicit_deny — the backend denied the operation: "${deny?.reason ?? ""}"${code}`);
      break;
    }
    case "notification_sent": {
      out.stdout.push("Result: notification_sent — the notification was accepted for transport delivery. Acceptance is not proof of durable receipt.");
      break;
    }
    case "operational_failure":
    case "notification_delivery_failure": {
      out.stderr.push(`Result: ${result.classification}`);
      const error = result.error;
      if (error !== undefined) {
        out.stderr.push(`Error [${error.code}] phase=${error.phase} retryable=${String(error.retryable)}: ${error.message}`);
      }
      break;
    }
  }

  for (const finding of result.findings ?? []) {
    out.stderr.push(findingLine(finding));
  }

  if (outcome.simulation !== undefined) {
    const simulation = outcome.simulation;
    out.stderr.push(`Simulated policy consequence (--failure-policy ${simulation.policy}): ${simulation.consequence} — ${simulation.note}`);
  }

  return out;
}

/** Detailed protocol, transport, validation, and timing evidence (stderr). */
export function renderVerbose(outcome: RunOutcome): string[] {
  const lines: string[] = [];
  for (const attempt of outcome.attempts) {
    lines.push(`--- attempt ${attempt.number} (${attempt.kind}) ---`);
    lines.push(`request: ${attempt.request.raw}`);
    if (attempt.response !== undefined) {
      lines.push(`response${attempt.response.late === true ? " (late, after deadline; did not change the result)" : ""}: ${attempt.response.raw}`);
    } else {
      lines.push("response: (none)");
    }
    lines.push(`transport evidence: ${JSON.stringify(attempt.transport, null, 2)}`);
    if (attempt.transport.transport === "stdio" && attempt.transport.stderr.length > 0) {
      lines.push(`backend stderr:\n${attempt.transport.stderr.replace(/\s+$/, "")}`);
    }
    lines.push(`timing: ${JSON.stringify(attempt.timing)}`);
    if (attempt.validation.length > 0) {
      lines.push("validation findings:");
      for (const finding of attempt.validation) lines.push(`  - ${findingLine(finding)}`);
    }
    lines.push(`result: ${JSON.stringify(attempt.result)}`);
  }
  return lines;
}
