import { spawn } from "node:child_process";
import { CLI_PATH } from "./paths.js";

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Run the compiled ahp-inspector CLI as a real subprocess. */
export function runCli(args: string[], options: { env?: Record<string, string>; stdin?: string } = {}): Promise<CliRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ stdout, stderr, code, signal }));
    child.stdin.end(options.stdin ?? "");
  });
}

/** Extract the actual diagnostic bundle path from the JSON export notice on stderr. */
export function exportedPath(stderr: string): string {
  for (const line of stderr.trim().split("\n")) {
    try {
      const parsed = JSON.parse(line) as { export?: { path?: string } };
      if (typeof parsed.export?.path === "string") return parsed.export.path;
    } catch {
      // Non-JSON line; keep scanning.
    }
  }
  throw new Error(`No JSON export notice found on stderr: ${stderr}`);
}

/**
 * Parse a stream of concatenated JSON records: single-line JSONL, or a
 * pretty-printed sequence where each record starts with "{" at column 0.
 */
export function parseJsonStream(text: string): unknown[] {
  return text
    .split(/^(?=\{)/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => JSON.parse(chunk) as unknown);
}
