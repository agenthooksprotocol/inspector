#!/usr/bin/env node

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const depsDir = resolve(".deps");
const repos = [
  {
    name: "TypeScript SDK",
    url: "https://github.com/agenthooksprotocol/typescript-sdk.git",
    dir: join(depsDir, "typescript-sdk"),
    build: true,
  },
  {
    name: "Agent Hooks Protocol",
    url: "https://github.com/agenthooksprotocol/agent-hooks-protocol.git",
    dir: join(depsDir, "agent-hooks-protocol"),
    build: false,
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensureRepo(repo) {
  if (!existsSync(join(repo.dir, ".git"))) {
    run("git", ["clone", "--depth", "1", repo.url, repo.dir]);
    return;
  }

  run("git", ["-C", repo.dir, "fetch", "--depth", "1", "origin", "main"]);
  run("git", ["-C", repo.dir, "checkout", "-B", "main", "FETCH_HEAD"]);
}

mkdirSync(depsDir, { recursive: true });

for (const repo of repos) {
  process.stderr.write(`bootstrap-deps: preparing ${repo.name}\n`);
  ensureRepo(repo);
}

const sdkDir = repos[0].dir;
run("pnpm", ["--dir", sdkDir, "install", "--frozen-lockfile"]);
run("pnpm", ["--dir", sdkDir, "build"]);
