/**
 * Scriptable per-event stdio backend for failure modes the shared
 * ahp-fake-backend does not cover: stdout pollution, multiline framing,
 * crashes, nonzero exits, missing responses, deferred (late) responses,
 * fail-once-then-succeed retry sequences, and observe behaviors.
 *
 * Usage: node scripted-stdio.js <mode> [arg1] [arg2]
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, arg1, arg2] = process.argv.slice(2);

function respond(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function noEffectResponse(id: unknown): unknown {
  return { jsonrpc: "2.0", id, result: { protocolVersion: "0.1", effects: [] } };
}

function requestId(line: string): unknown {
  try {
    return (JSON.parse(line) as { id?: unknown }).id;
  } catch {
    return null;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

let sawLine = false;

lines.on("line", (line: string) => {
  if (sawLine) return;
  sawLine = true;
  const id = requestId(line);
  switch (mode) {
    case "pollution": {
      process.stdout.write("starting scripted backend, please wait...\n");
      respond(noEffectResponse(id));
      process.exit(0);
      break;
    }
    case "multiline": {
      process.stdout.write(`${JSON.stringify(noEffectResponse(id), null, 2)}\n`);
      process.exit(0);
      break;
    }
    case "missing-effects": {
      respond({ jsonrpc: "2.0", id, result: { protocolVersion: "0.1" } });
      process.exit(0);
      break;
    }
    case "crash": {
      process.kill(process.pid, "SIGKILL");
      break;
    }
    case "nonzero-exit": {
      respond(noEffectResponse(id));
      process.exit(3);
      break;
    }
    case "missing-response": {
      process.exit(0);
      break;
    }
    case "late-response": {
      const delayMs = Number(arg1 ?? "500");
      setTimeout(() => {
        respond(noEffectResponse(id));
        process.exit(0);
      }, delayMs);
      break;
    }
    case "fail-once": {
      // arg1: state file marking that the first delivery already failed.
      // arg2: record file receiving every request line, for ID/content checks.
      if (arg2 !== undefined) appendFileSync(arg2, `${line}\n`, "utf8");
      if (arg1 !== undefined && !existsSync(arg1)) {
        writeFileSync(arg1, "failed-once\n", "utf8");
        process.stderr.write("scripted backend: failing the first delivery\n");
        process.exit(7);
      }
      respond(noEffectResponse(id));
      process.exit(0);
      break;
    }
    case "observe-respond": {
      // A notification carries no id; a misbehaving backend answers anyway.
      respond({ jsonrpc: "2.0", id: "spurious-response", result: { protocolVersion: "0.1", effects: [] } });
      process.exit(0);
      break;
    }
    case "observe-hang": {
      setTimeout(() => process.exit(0), 60_000);
      break;
    }
    case "observe-silent":
    default:
      break;
  }
});

lines.on("close", () => {
  if (mode === "observe-silent" || (!sawLine && mode !== "observe-hang")) {
    process.exit(0);
  }
});
