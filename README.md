# AHP Inspector

`ahp-inspector` is a CLI for testing [Agent Hooks Protocol](../agent-hooks-protocol) backends. It loads one AHP event, sends it to a stdio or HTTP backend, validates the exchange, and prints a JSON result.

The Inspector exercises the policy conversation only. It never executes the tool represented by an event or proves that a harness enforced the result.

- Protocol revision: `0.1.0-draft.1` (`protocolVersion: "0.1"`)
- Runtime dependency: `@agenthooksprotocol/sdk`
- Test dependencies: `ajv`, `ajv-formats`, and `@agenthooksprotocol/testing`

## Installation

Requires Node.js >= 20, pnpm, and git:

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm install` bootstraps local checkouts under `.deps/`, builds the TypeScript SDK, and links the SDK packages from there. The Inspector binary is `dist/src/cli/main.js`.

## Usage

```text
ahp-inspector --transport stdio --method <hooks/intercept|hooks/observe> --event <path|-> [options] -- <command> [args...]
ahp-inspector --transport http  --method <hooks/intercept|hooks/observe> --event <path|-> [options] <url>
```

Each run sends one event to one backend and exits.

| Option | Meaning |
| --- | --- |
| `--transport stdio\|http` | Required. Stdio targets go after `--`; HTTP targets use one URL. |
| `--method hooks/intercept\|hooks/observe` | Required. |
| `--event <path>` / `--event -` | Required. Reads one JSON event from a file or stdin. |
| `--timeout-ms <n>` | Required for `hooks/intercept`. Covers the full exchange. |
| `--failure-policy fail-open\|fail-closed` | Required for `hooks/intercept`. Used only to show the simulated consequence of operational failures. |
| `--connect-timeout-ms <n>` | Observe-only transport safety limit. Default: `5000`. |
| `--header "Name: Value"` | Repeatable; HTTP only. |
| `--bearer-token-env NAME` | HTTP bearer auth from an environment variable. Token values are redacted from output and exports. |
| `--retry [count]` | Retry operational failures within the original deadline. Default: `1`. |
| `--duplicate-delivery` | Replay the same request once to test backend idempotency. Mutually exclusive with `--retry`. |
| `--export <path>` | Write a diagnostic bundle. Existing files are not overwritten. |
| `--verbose` | Include request, response, transport, timing, and validation evidence. |
| `--pretty` | Pretty-print JSON output. |

Exit codes:

- `0`: valid result, explicit deny, or notification sent
- `1`: operational failure
- `2`: usage or configuration error

All attempt records are JSON on stdout. Usage errors, export notices, and export failures are JSON on stderr.

## Result Types

| Term | Meaning |
| --- | --- |
| `no_effect` | The backend returned `effects: []`. This is not an allow decision; other policy layers may still block the action. |
| `explicit_deny` | The backend returned one `deny` effect. This is a successful exchange and exits `0`. |
| `operational_failure` | Transport, timeout, process, JSON-RPC, version, ID, or effect validation failed. |
| `simulation` | The fail-open or fail-closed consequence Inspector would apply after an operational failure. |
| `notification_sent` | An observe notification was accepted for transport delivery. |
| `notification_delivery_failure` | Observe delivery failed before acceptance. |

## Examples

### Stdio

```bash
node -e '
const fs = require("node:fs");
const req = JSON.parse(fs.readFileSync(".deps/agent-hooks-protocol/fixtures/0.1.0-draft.1/stdio/intercept-request.valid.jsonl", "utf8"));
fs.writeFileSync("/tmp/event.json", JSON.stringify(req.params.event, null, 2));
'

node dist/src/cli/main.js \
  --transport stdio --method hooks/intercept \
  --event /tmp/event.json --timeout-ms 1000 --failure-policy fail-open \
  -- node node_modules/@agenthooksprotocol/testing/dist/src/fake-backend.js --mode no-effect
```

Expected classification: `no_effect`. Other fake-backend modes include `deny`, `timeout`, `malformed-json`, and `id-mismatch`.

### Claude PII Judge

[`examples/pii-judge/claude-pii-judge.ts`](examples/pii-judge/claude-pii-judge.ts) uses the TypeScript SDK and `claude -p` to flag PII in `event.tool.input`.

Run a PII event:

```bash
node dist/src/cli/main.js \
  --transport stdio --method hooks/intercept \
  --event examples/pii-judge/pii-event.json \
  --timeout-ms 120000 --failure-policy fail-closed \
  -- node dist/examples/pii-judge/claude-pii-judge.js
```

Expected classification: `explicit_deny`. Use `clean-event.json` with the same command to get `no_effect`.

The sample PII values are fictitious, but the adapter sends tool input to Claude. Use only data you are permitted to send. Set `CLAUDE_MODEL` to choose a model.

### Deterministic Rules

[`examples/deterministic-rules/deterministic-policy.ts`](examples/deterministic-rules/deterministic-policy.ts) is an SDK-backed policy backend with no model or network dependency. It denies:

- Any tool named `deploy_production`.
- A shell tool whose command invokes `git push` with `-f`, `--force`, or a force variant.

```bash
node dist/src/cli/main.js \
  --transport stdio --method hooks/intercept \
  --event examples/deterministic-rules/force-push-event.json \
  --timeout-ms 1000 --failure-policy fail-closed \
  -- node dist/examples/deterministic-rules/deterministic-policy.js
```

Expected classification: `explicit_deny`. Use `git-status-event.json` with the same command to get `no_effect`.

### HTTP

Start a minimal loopback backend:

```bash
node -e '
const http = require("node:http");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    const id = JSON.parse(body).id;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "0.1", effects: [] } }));
  });
}).listen(8790, "127.0.0.1");
' &

node dist/src/cli/main.js \
  --transport http --method hooks/intercept \
  --event /tmp/event.json --timeout-ms 1000 --failure-policy fail-closed \
  http://127.0.0.1:8790/hooks
```

Remote endpoints must use `https`. Plain `http` is accepted only for loopback addresses.

```bash
AHP_POLICY_TOKEN=... node dist/src/cli/main.js \
  --transport http --method hooks/intercept \
  --event /tmp/event.json --timeout-ms 1000 --failure-policy fail-closed \
  --bearer-token-env AHP_POLICY_TOKEN \
  https://policy.example.com/agent-hooks
```

Bearer tokens are resolved from the environment and redacted from output.

## Output

Output is always JSON. A single attempt emits one object:

```json
{"result":{"classification":"no_effect","effects":[]}}
```

Retries and duplicate delivery emit JSONL, one record per attempt:

```jsonl
{"attempt":0,"kind":"initial","result":{"classification":"operational_failure","error":{"code":"IO_ERROR","message":"Backend process exited with status 7; a per-event backend signals a completed exchange with exit status 0 (working-draft §17.3)","phase":"await-response","retryable":true}}}
{"attempt":1,"kind":"retry","result":{"classification":"no_effect","effects":[]}}
```

Operational failures include `code`, `message`, `phase`, and `retryable`. Fail-open or fail-closed consequences appear separately under `simulation`.

## Observe mode

`hooks/observe` sends a JSON-RPC notification with no `id`. Stdio backends should read the notification, perform any side effect, and exit without writing stdout. HTTP backends should return `202` or `204` with no body.

Observe mode accepts `tool.before`, `tool.after`, and `tool.error` events.

## Diagnostic bundles

`--export <path>` writes a diagnostic bundle described by [`schemas/diagnostic/0.1.0.json`](schemas/diagnostic/0.1.0.json). Bundles include the event, target metadata, attempts, transport evidence, timing, validation findings, final result, and simulation when present. Bearer token values are excluded.

## Project Layout

```text
src/core/   protocol, classification, transport, and diagnostics
src/cli/    argument parsing and JSON rendering
examples/   SDK-backed sample policy backends
schemas/    diagnostic bundle schema
test/       integration tests
```

Only the `ahp-inspector` binary is supported. Internal modules are not a public API.
