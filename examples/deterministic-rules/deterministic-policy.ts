#!/usr/bin/env node

import {
  PROTOCOL_VERSION,
  type InterceptResponse,
  type InterceptResult,
  type ToolBeforeEvent,
} from "@agenthooksprotocol/sdk";
import {
  readStdioInterceptRequest,
  reportBackendError,
  writeStdioInterceptResponse,
} from "../shared/stdio-backend.js";

interface Rule {
  code: string;
  reason: string;
  matches: (event: ToolBeforeEvent) => boolean;
}

function isForcePush(event: ToolBeforeEvent): boolean {
  if (event.tool.kind !== "shell") return false;
  const command = event.tool.input.command;
  if (typeof command !== "string") return false;

  const invokesGitPush = /(?:^|[;&|]\s*)git\s+push(?:\s|$)/.test(command);
  const hasForceFlag = /(?:^|\s)(?:-f|--force(?:-with-lease|-if-includes)?(?:=[^\s;&|]+)?)(?=\s|$|[;&|])/.test(command);
  return invokesGitPush && hasForceFlag;
}

const RULES: readonly Rule[] = [
  {
    code: "com.example.policy.production_deploy",
    reason: "Direct production deployment tool calls require a separate approval path.",
    matches: (event) => event.tool.name === "deploy_production",
  },
  {
    code: "com.example.policy.force_push",
    reason: "Force pushes are blocked by the deterministic example policy.",
    matches: isForcePush,
  },
];

function responseFor(requestId: string, event: ToolBeforeEvent): InterceptResponse {
  const matchedRule = RULES.find((rule) => rule.matches(event));
  const result: InterceptResult = matchedRule === undefined
    ? { protocolVersion: PROTOCOL_VERSION, effects: [] }
    : {
        protocolVersion: PROTOCOL_VERSION,
        effects: [{
          type: "deny",
          reason: matchedRule.reason,
          code: matchedRule.code,
        }],
      };

  return {
    jsonrpc: "2.0",
    id: requestId,
    result,
  };
}

try {
  const request = await readStdioInterceptRequest();
  writeStdioInterceptResponse(responseFor(request.id, request.params.event));
} catch (error) {
  reportBackendError("deterministic-policy", error);
}
