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
