# AHP Inspector (Stage 1)

`ahp-inspector` is a one-shot CLI harness client for testing one [Agent Hooks Protocol](../agent-hooks-protocol) backend. Each invocation loads one AHP event, sends it over a real stdio or HTTP transport, validates and classifies the exchange, prints a machine-readable JSON result, and can export a full diagnostic bundle.

- **Protocol revision:** pinned to the immutable AHP artifact revision `0.1.0-draft.1` (protocol version `0.1`).
- **Scope:** the Inspector exercises the policy conversation only. It never executes the tool represented by an event, and it never proves that a real harness enforced a result.
- **Runtime dependencies:** none beyond the private `@agenthooksprotocol/sdk` (shared protocol types, validators, and NDJSON framing). `ajv`, `ajv-formats`, and `@agenthooksprotocol/testing` are used by tests only.

## Installation

Requires Node.js >= 20 and pnpm. The SDK is consumed as a local workspace sibling and must be built first:

```bash
# 1. Build the TypeScript SDK (sibling checkout)
cd ../typescript-sdk
pnpm install
pnpm build          # or: npx tsc -p packages/sdk/tsconfig.json && npx tsc -p packages/testing/tsconfig.json

# 2. Install and build the Inspector
cd ../inspector
pnpm install
pnpm build
pnpm test           # runs the integration suite on the compiled output
```

The binary is `dist/src/cli/main.js`, declared as `ahp-inspector`. Run it as `node dist/src/cli/main.js …`, or put `ahp-inspector` on your PATH with `pnpm link --global`. The walkthroughs below use the direct form.

## CLI contract

```text
ahp-inspector --transport stdio --method <hooks/intercept|hooks/observe> --event <path|-> [options] -- <command> [args...]
ahp-inspector --transport http  --method <hooks/intercept|hooks/observe> --event <path|-> [options] <url>
```

Every invocation is one-shot: one ad hoc target, one event, one method, optional retry or duplicate-delivery, optional export, exit.

| Option | Meaning |
| --- | --- |
| `--transport stdio\|http` | Required. Stdio targets take an executable and argument array after `--` (invoked directly, no shell). HTTP targets take one positional URL. |
| `--method hooks/intercept\|hooks/observe` | Required. Never inferred from event content. |
| `--event <path>` / `--event -` | Required. One JSON event from a file or stdin. Validated before any process or network activity; never silently repaired. |
| `--timeout-ms <n>` | Required for `hooks/intercept`; rejected for observe. One absolute deadline across setup, transmission, backend processing, response receipt, parsing, and validation. |
| `--failure-policy fail-open\|fail-closed` | Required for `hooks/intercept`; rejected for observe. Drives the *simulated* consequence display only. |
| `--connect-timeout-ms <n>` | Observe-only transport safety limit for connection and write completion (default 5000). |
| `--header "Name: Value"` | Repeatable; HTTP only. |
| `--bearer-token-env NAME` | HTTP bearer auth. The token is resolved from the environment at send time only and never appears in arguments, payloads, output, or exports. |
| `--retry [count]` | Retry after an operational failure, only while the original deadline remains (default one retry). Never retries a no-effect or deny result. Mutually exclusive with `--duplicate-delivery`. |
| `--duplicate-delivery` | Exactly one deliberate replay of the identical frame (same event, JSON-RPC, session, and call IDs), each delivery with a fresh deadline. A backend diagnostic, not simulated harness behavior. |
| `--export <path>` | Write the full diagnostic bundle. Never overwrites: on collision a random suffix is appended and the actual path is reported on stderr. |
| `--verbose` | Include full diagnostic evidence (raw/parsed request and response, transport, timing, validation findings) as additional fields in the JSON output records. |
| `--pretty` | Pretty-print the JSON output. For multiple attempts, each record is pretty-printed in sequence; without it, output is strict single-line JSON/JSONL. |

**Exit codes:** `0` valid result (no effect, explicit deny, or notification sent), `1` operational failure, `2` usage/configuration error. Failure categories (usage, target unavailable, deadline, invalid protocol response, backend JSON-RPC error) are distinguished by the structured `error.code` and `phase`, not by exit code.

**Streams:** all output is JSON. Attempt records — including operational failures — go to stdout so the stream stays parseable. stderr carries only structured JSON side-channel objects: usage/configuration error envelopes (`{"error":{...}}`, optionally with `findings`), the actual export path notice (`{"export":{"path":"..."}}`), and export failure envelopes. Both streams honor `--pretty`.

## Terminology (worth keeping straight)

| Term | Meaning |
| --- | --- |
| **No effect** (`no_effect`) | A valid successful result with `effects: []`. The backend has no objection. This is **not** "allow": it does not bypass other interceptors, host permissions, approval, or sandboxing. |
| **Explicit deny** (`explicit_deny`) | A valid successful result with exactly one advertised `deny` effect. A policy decision by the backend — a *successful* exchange, exit code 0. |
| **Operational failure** (`operational_failure`) | A transport, process, deadline, JSON-RPC, version, ID, or effect validation failure. Never presented as a backend decision. |
| **Synthetic consequence** (`simulation`) | What a `fail-open`/`fail-closed` harness *would* do after an operational failure (`continued` or `synthetic_denial`). Always attributed to Inspector policy simulation; a fail-closed failure stays an `operational_failure`, never a backend deny. |
| **Notification sent** (`notification_sent`) | An observe notification was accepted for transport delivery. Acceptance is not proof of durable receipt. |
| **Notification delivery failure** (`notification_delivery_failure`) | The transport or per-event process failed before acceptance. |

## Stdio walkthrough (fake backend)

The SDK's `@agenthooksprotocol/testing` package ships `ahp-fake-backend` with controllable modes. Grab a golden event from the protocol repo and intercept it:

```bash
# Extract the golden tool.before event from the pinned fixtures
node -e '
const fs = require("node:fs");
const req = JSON.parse(fs.readFileSync("../agent-hooks-protocol/fixtures/0.1.0-draft.1/stdio/intercept-request.valid.jsonl", "utf8"));
fs.writeFileSync("/tmp/event.json", JSON.stringify(req.params.event, null, 2));
'

# A clean no-effect exchange
node dist/src/cli/main.js \
  --transport stdio --method hooks/intercept \
  --event /tmp/event.json --timeout-ms 1000 --failure-policy fail-open \
  -- node node_modules/@agenthooksprotocol/testing/dist/src/fake-backend.js --mode no-effect
```

```json
{"result":{"classification":"no_effect","effects":[]}}
```

Remember `no_effect` is not "allow": it does not bypass other interceptors, host permissions, approval, or sandboxing.

Try a denial (`--mode deny`), a timeout (`--mode timeout`), a malformed response (`--mode malformed-json`), or an ID mismatch (`--mode id-mismatch`). Add `--pretty` to pretty-print the JSON, `--verbose` to include raw frames, backend stderr, process state, and timing in the record, and `--export /tmp/bundle.json` to capture everything.

## HTTP walkthrough (sample server)

Start a minimal AHP backend on loopback:

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

Remote endpoints must use `https`; plain `http` is accepted only for loopback addresses. Bearer authentication comes from an environment variable, never a literal token:

```bash
AHP_POLICY_TOKEN=... node dist/src/cli/main.js \
  --transport http --method hooks/intercept \
  --event /tmp/event.json --timeout-ms 1000 --failure-policy fail-closed \
  --bearer-token-env AHP_POLICY_TOKEN \
  https://policy.example.com/agent-hooks
```

Evidence and exports record the header as `Bearer [redacted:AHP_POLICY_TOKEN]`.

## Machine output

JSON is the only output format. One attempt emits exactly one JSON object on stdout:

```json
{"result":{"classification":"no_effect","effects":[]}}
```

Multiple attempts (retry or duplicate delivery) emit JSONL — one complete record per attempt with attempt number and kind; the final record represents the final result:

```jsonl
{"attempt":0,"kind":"initial","result":{"classification":"operational_failure","error":{"code":"IO_ERROR","message":"Backend process exited with status 7; a per-event backend signals a completed exchange with exit status 0 (working-draft §17.3)","phase":"await-response","retryable":true}}}
{"attempt":1,"kind":"retry","result":{"classification":"no_effect","effects":[]}}
```

`--pretty` pretty-prints each record in sequence (like `jq` over a JSONL stream), and `--verbose` adds `request`, `response`, `transport`, `timing`, and `validation` evidence fields to every record.

Operational error envelopes always carry a stable `code` (the SDK's operational codes plus `USAGE`, `TARGET_UNAVAILABLE`, `EXPORT_IO`, `UNEXPECTED_RESPONSE`), a human-readable `message`, the failure `phase`, and a `retryable` indicator. A simulated policy consequence, when present, is a separate top-level `simulation` object:

```json
{"simulated":true,"policy":"fail-closed","consequence":"synthetic_denial","note":"Inspector simulation of a fail-closed harness: ..."}
```

## Observe mode

`hooks/observe` sends one JSON-RPC notification (no `id`). Stdio: the Inspector spawns the per-event backend, writes the notification, closes stdin, and waits for exit or the safety limit; any stdout frame is flagged as an unexpected response without retracting acceptance. HTTP: `202`/`204` with no body is `notification_sent`; any other status or any response body is a flagged `notification_delivery_failure`. Stage 1 accepts the `tool.before`, `tool.after`, and `tool.error` events of working-draft sections 9–10.

## Diagnostic bundles

`--export <path>` writes a stable JSON bundle described by [`schemas/diagnostic/0.1.0.json`](schemas/diagnostic/0.1.0.json) (versioned independently of the protocol revision): schema/Inspector versions, exact AHP revision, target metadata, the loaded event (raw and parsed), every attempt in order with raw/parsed request and response evidence, transport evidence, timing with deadline and late-response markers, validation findings, per-attempt results, and the complete top-level final `result`. Only resolved bearer-token values are excluded; all other debugger evidence (event input, backend output, stderr, reasons, errors) is preserved.

## Layout

```text
src/core/     protocol core — no CLI presentation imports
  protocol.ts             revision pin, canonical message construction
  event.ts                event loading + intercept validation (SDK validators)
  observe-validation.ts   observe semantic rules linked to AHP-*/§ references
  classify.ts             the five classifications + policy simulation
  attempt.ts              deadline, retry, duplicate delivery, late-response drain
  transport/stdio.ts      per_event spawn, NDJSON framing, evidence capture
  transport/http.ts       POST, manual redirects, bearer redaction, evidence
  diagnostic.ts           bundle assembly and collision-safe export
src/cli/      argument grammar, JSON renderer, orchestration
test/         node:test integration suites over real subprocesses and HTTP
```

Only the `ahp-inspector` binary is supported surface; internal modules are not a library API. Tests reuse the protocol repo's schemas and fixtures by relative path (`../agent-hooks-protocol`) and cross-check outbound frames and exported bundles with ajv.
