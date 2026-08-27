# AHP Inspector Stage 1 requirements

**Status:** Agreed v0.1 scope  
**Target protocol:** AHP `0.1.0-draft.1`  
**Scope:** Backend Inspector only  
**Background:** [`research/ahp-inspector-trail.md`](research/ahp-inspector-trail.md)

## Project context

This requirement plan was generated from the AHP source repository at
`/Users/subomi/code/ahp/agent-hooks-protocol` to guide construction of the
Inspector in `/Users/subomi/code/ahp/inspector`.

The Inspector will be implemented in TypeScript and will use the SDK at
`/Users/subomi/code/ahp/typescript-sdk`.

Stage 1 is CLI-first. Its interaction model should take inspiration from
`grpcurl` and the MCP Inspector CLI: explicit commands, composable machine
output, readable human output, and direct control over each request attempt.
These tools are UX references, not additional protocol dependencies.

## Product definition

The AHP Inspector is a one-shot CLI harness/client for testing one AHP backend. It loads an AHP event, sends it over a real transport, validates the exchange, classifies the result, and prints a useful human-readable result or machine-readable result. It can optionally export a full diagnostic bundle when the user supplies an explicit export option.

The Inspector exercises the policy conversation only. It does not execute the tool represented by an event and does not prove that a real harness enforced the result.

## Required user surface

Stage 1 provides the one-shot `ahp-inspector` CLI for direct use, scripts, CI, and agents. Each invocation is self-contained: it configures one target, loads one event, performs one operation (possibly with retry or duplicate delivery), prints its result, optionally exports diagnostics, and exits.

The CLI must use one shared protocol, validation, transport, classification, attempt, and diagnostic implementation. There is no interactive session, persistent CLI session, TUI, or browser UI in Stage 1.

## Core loop

The one-shot workflow is:

```text
configure target -> load event -> send -> inspect result -> optionally retry, replay, or export
```

### 1. Configure one ad hoc backend target

v0.1 does not support AHP registration documents or configuration-file backend selection. Every invocation must provide exactly one ad hoc target:

- stdio: an executable and its arguments after `--`;
- HTTP: one positional URL.

The user must select the transport explicitly with `--transport stdio|http`. The Inspector must:

- validate all CLI target and transport options before use;
- invoke stdio commands directly as an executable plus argument array, without implicit shell interpolation;
- support only the `per_event` stdio lifecycle; there is no lifecycle option in v0.1;
- support repeated `--header "Name: Value"` options for HTTP;
- support HTTP bearer authentication through `--bearer-token-env NAME`, never a literal token argument;
- keep resolved credential values out of command arguments, protocol payloads, diagnostics, and exports;
- identify the exact AHP draft revision used by the request.

AHP v0.1 has no initialization handshake. For HTTP, “configured” means the target is ready for a protocol request; the Inspector must not invent a ping or discovery method. Remote HTTP targets must follow the AHP HTTP transport rules.

**Completion criterion:** the invocation identifies one valid target and can determine exactly which AHP message and transport operation will be attempted.

### 2. Load one event

The CLI must accept exactly one event source:

- `--event <path>` to load a JSON event from a file; or
- `--event -` to load a JSON event from standard input.

Inline `--event-json` input, event templates, structured editing, and event generation are outside v0.1. The Inspector must validate the event before starting a stdio process or making an HTTP request. It must not silently repair invalid input.

For the selected method, validation findings must identify the relevant JSON path. The Inspector must preserve the event content and identities across retries and duplicate-delivery testing.

**Completion criterion:** the invocation validates the event and can determine the exact outbound JSON-RPC message before transmission.

### 3. Send one request or notification

The `--method hooks/intercept|hooks/observe` option is required. The Inspector must not infer the method from event content.

For `hooks/intercept`, the Inspector must:

- send one JSON-RPC request using the selected stdio or HTTP binding;
- require `--timeout-ms` as a positive integer;
- require `--failure-policy fail-open|fail-closed`;
- enforce the deadline across setup, transmission, backend processing, response receipt, parsing, and validation;
- correlate the response ID with the request and event IDs;
- validate the successful result version and effect shape;
- retain raw transport evidence separately from parsed protocol data.

For `hooks/observe`, the Inspector must:

- send a JSON-RPC notification without an `id`;
- reject `--timeout-ms` and `--failure-policy`;
- use `--connect-timeout-ms` as an Inspector transport safety limit for connection and write completion;
- launch a per-event stdio backend, write one notification, close standard input, and wait for process exit or the safety timeout;
- distinguish transport acceptance from proof of durable receipt;
- flag any JSON-RPC response as unexpected;
- avoid waiting for or presenting a semantic decision.

Sending an event must never execute the represented tool.

**Completion criterion:** every send ends with one normalized result and captured evidence for the attempted exchange. Default output presents the useful result or error; full evidence is available through `--verbose` or `--export`.

### 4. Classify and display the result

An intercept exchange must be classified as exactly one of:

- **No effect:** a valid successful result containing `effects: []`;
- **Explicit deny:** a valid successful result containing exactly one advertised `deny`;
- **Operational failure:** a transport, process, deadline, JSON-RPC, version, ID, or effect validation failure.

An observe exchange must be classified as exactly one of:

- **Notification sent:** the notification was accepted for transport delivery, without proof of durable receipt;
- **Notification delivery failure:** the transport or per-event process failed before acceptance.

When `--failure-policy` is supplied, the Inspector may additionally show a separate simulated harness consequence:

- **Fail-open: continued**; or
- **Fail-closed: synthetic denial**.

The simulated consequence must be visibly attributed to Inspector policy simulation. It must not be presented as a backend result or evidence of real harness enforcement. A fail-closed operational failure must remain an `operational_failure` result with a separate synthetic consequence; it must not be represented as an explicit backend `deny`.

The diagnostic view must separate:

1. raw protocol request and response;
2. transport evidence, including HTTP status and headers or stdio frames and process state;
3. backend `stderr` and Inspector diagnostics;
4. schema and semantic validation findings;
5. result classification and optional policy simulation;
6. timing, deadline, and late-response markers.

Default text output must lead with a concise result or error summary. `--verbose` may display the detailed protocol, transport, validation, and timing evidence. The Inspector must not automatically export or persist a diagnostic.

The UI and machine output must never label no-effect as “allow” or imply that it bypasses other interceptors, host permissions, approval, or sandboxing.

**Completion criterion:** a user can distinguish backend denial, backend failure, and a fail-closed synthetic denial from the default result without consulting raw protocol text.

### 5. Retry or test duplicate delivery

The CLI supports two mutually exclusive repeat options:

- `--retry <count>`: retry only after an operational failure and only while the original `--timeout-ms` deadline remains active;
- `--duplicate-delivery`: perform exactly one deliberate replay using the exact same event content and IDs.

`--retry` defaults to one retry. It is rejected for `hooks/observe`, after a successful no-effect result, or after an explicit deny. Every retry must reuse the same event ID, JSON-RPC ID, session ID, call ID, and event contents.

`--duplicate-delivery` is rejected with `--retry` and is not available for `hooks/observe`. It must be labeled **duplicate delivery test**, not **retry**, and must state that it is a backend diagnostic rather than simulated conforming harness behavior.

All attempts must be retained in order and grouped by event ID, with content differences made visible. Each attempt has a complete result.

**Completion criterion:** machine output and exported diagnostics make clear whether each attempt is initial delivery, retry, or duplicate-delivery testing.

### 6. Export a diagnostic bundle

Export is an explicit `--export <path>` option. Stage 1 does not automatically export diagnostics, persist sessions, upload sessions, or create hosted links.

When the user supplies `--export`, the Inspector must write a stable JSON bundle containing:

- diagnostic schema version;
- Inspector version;
- exact AHP draft revision;
- target and transport metadata;
- loaded event;
- all attempts in order;
- raw and parsed request and response evidence for each attempt;
- complete top-level `result`, equal to the final attempt's result;
- validation findings;
- transport and timing evidence;
- process state and backend standard error where applicable.

Export must:

- preserve the full diagnostic evidence needed to understand the request, response, error, and classification;
- avoid writing the bundle until the user explicitly supplies `--export`;
- never overwrite an existing path; when the requested path exists, append a random suffix to create a new path and report the actual path on standard error;
- omit only resolved bearer-token values, as required by the AHP security rules, while preserving the remaining debugger evidence.

Automatic redaction of event input, backend output, paths, model identifiers, denial reasons, error data, or extensions is not required in Stage 1. Exported diagnostics may contain those values.

The diagnostic bundle schema must be committed as [`schemas/diagnostic/0.1.0.json`](schemas/diagnostic/0.1.0.json), independently of the AHP protocol revision.

The v0.1 bundle shape is:

```json
{
  "schemaVersion": "ahp-inspector-diagnostic/0.1",
  "inspector": { "version": "..." },
  "protocol": { "name": "AHP", "revision": "0.1.0-draft.1" },
  "target": {},
  "event": { "raw": "...", "parsed": {} },
  "attempts": [
    {
      "number": 0,
      "kind": "initial",
      "request": { "raw": "...", "parsed": {} },
      "response": { "raw": "...", "parsed": {} },
      "transport": {},
      "timing": {},
      "validation": [],
      "result": {}
    }
  ],
  "result": {}
}
```

Each attempt contains its complete `result`. The top-level `result` is the complete result from the final attempt, repeated for consumers that do not need to inspect `attempts`. The bundle preserves raw and parsed evidence separately.

**Completion criterion:** `--export` produces a self-describing local JSON bundle with enough evidence to reproduce the final result and understand every attempt.

## CLI contract

The binary is named `ahp-inspector`. Every invocation is one-shot: it connects to one target, performs one method, disconnects, optionally exports diagnostics, and exits.

The CLI must:

- require exactly one ad hoc target;
- require `--transport stdio|http`;
- require `--method hooks/intercept|hooks/observe`;
- require exactly one event source: `--event <path>` or `--event -`;
- require `--timeout-ms` and `--failure-policy fail-open|fail-closed` for `hooks/intercept`;
- reject `--timeout-ms` and `--failure-policy` for `hooks/observe`;
- accept `--connect-timeout-ms` as the observe transport safety limit;
- accept repeated `--header "Name: Value"` options for HTTP;
- accept `--bearer-token-env NAME` for HTTP bearer authentication, never a literal bearer token;
- accept `--retry <count>` for deadline-bounded intercept retries;
- accept `--duplicate-delivery` for exactly one deliberate duplicate replay, mutually exclusive with `--retry`;
- accept `--export <path>` for an explicit full diagnostic export;
- accept `--verbose` for detailed human-readable diagnostic evidence;
- accept `--format json` for machine-readable output.

The stdio target must follow `--` and consist of an executable plus argument array. The HTTP target is a positional URL. An invocation combining target forms is invalid.

Default text output must show a concise result or error. With `--format json`, one attempt emits one JSON object. Multiple attempts emit JSONL: one complete object per attempt, including attempt number and kind. Each record includes a complete `result`; the final record represents the final result. Export always uses one full JSON bundle, regardless of stdout format.

For one attempt, machine output has this shape:

```json
{
  "result": {
    "classification": "no_effect",
    "effects": []
  }
}
```

For multiple attempts, each JSONL record has the attempt metadata and its complete result:

```jsonl
{"attempt":0,"kind":"initial","result":{"classification":"operational_failure","error":{"code":"timeout"}}}
{"attempt":1,"kind":"retry","result":{"classification":"no_effect","effects":[]}}
```

Successful result output is written to standard output. Human diagnostics, verbose evidence, usage errors, operational failure envelopes, and the actual export path are written to standard error. A valid explicit deny is a successful result rather than an Inspector execution failure.

The CLI must use stable result and error codes rather than requiring scripts to parse human-readable messages. Result classifications are:

- `no_effect`;
- `explicit_deny`;
- `operational_failure`;
- `notification_sent`;
- `notification_delivery_failure`.

Operational errors must contain a stable code, human-readable message, phase, and retryability indicator. They must distinguish usage/configuration, target unavailable, deadline, invalid protocol response, and backend JSON-RPC error failures.

The v0.1 exit-code contract is:

- `0`: valid result, including no effect, explicit deny, or notification sent;
- nonzero: usage/configuration, target unavailable, deadline, invalid protocol response, backend JSON-RPC error, or other operational failure.

## Minimum acceptance scenarios

Stage 1 is complete only when automated integration tests exercise real transport boundaries for:

1. stdio and HTTP no-effect;
2. stdio and HTTP explicit deny;
3. backend JSON-RPC error;
4. mismatched response ID;
5. wrong successful-result protocol version;
6. missing, malformed, multiple, or unadvertised effects;
7. deadline exceeded and a late response;
8. stdio stdout pollution and multiline framing;
9. stdio process launch failure, crash, nonzero exit, and missing response;
10. HTTP non-success status, wrong content type, and redirect handling;
11. observe accepted without a response;
12. observe receiving an unexpected response;
13. conforming retry preserving IDs and content within the original deadline;
14. deliberate duplicate-delivery testing clearly distinguished from retry;
15. export of a diagnostic bundle containing the captured exchange, all attempts, and complete final result;
16. CLI option validation for incompatible methods, event sources, retry modes, and target forms;
17. JSON output for one attempt and JSONL output for multiple attempts;
18. export path collision handling with a random suffix;
19. resolved bearer-token exclusion while retaining other debugger evidence.

Tests must cover process-per-event stdio and HTTP.

## Stage 1 non-goals

Stage 1 excludes:

- executing real tools;
- claiming that a real harness enforced an outcome;
- inspecting or simulating an ordered multi-backend chain;
- acting as a backend for testing a real harness;
- formal conformance certification;
- a full-screen TUI or browser UI;
- hosted session storage or share links;
- AHP registration-document import or backend selection from configuration files;
- an interactive CLI session or persistent CLI session;
- an `allow` effect or permission-grant semantics;
- SSE, streaming HTTP, OAuth, mTLS, service discovery, or remote plain HTTP;
- standardizing effects or events not present in the selected AHP draft.

## Implementation constraints

- Keep the protocol core independent of CLI presentation.
- Pin each invocation and export to the immutable AHP artifact revision `0.1.0-draft.1`.
- Use `/Users/subomi/code/ahp/typescript-sdk` as the source of shared protocol definitions and behavior; do not fork its types or protocol implementation.
- Publish only the `ahp-inspector` binary in v0.1; internal modules are not a supported library API.
- Target Node.js `>=20`, matching the TypeScript SDK requirement.
- Reuse the repository schemas and fixtures rather than copying their definitions into implementation code.
- Add prose-semantic validation where JSON Schema is insufficient, with each rule linked to its AHP requirement or specification section.
- Exercise stdio and HTTP through real subprocess and network boundaries in integration tests.
- Treat raw backend output and loaded events as untrusted and potentially sensitive.
- Preserve all debugger evidence except resolved bearer-token values, which must not appear in diagnostics or exports under the AHP security rules.
- Preserve the behavior of `tools/check_conformance.py`; it remains the repository artifact checker.
- Keep Inspector diagnostic bundles distinct from future conformance reports.

## Resolved v0.1 decisions

The v0.1 implementation uses:

- TypeScript and the TypeScript SDK dependency;
- Node.js `>=20`;
- the `ahp-inspector` binary;
- one-shot CLI execution only;
- ad hoc stdio and HTTP targets only;
- `--method hooks/intercept|hooks/observe`;
- JSON event input from `--event <path>` or `--event -`;
- human-readable output by default and `--format json` for machine output;
- full JSON diagnostic export through `--export <path>`;
- explicit-deny exit code `0`;
- no public library API, TUI, browser flow, interactive session, or registration-document support.

Remaining implementation choices must not change the v0.1 CLI contract above. Deliberately malformed outbound frames may be deferred to Harness Lab.

## Definition of done

Stage 1 is done when:

- the one-shot CLI completes the full core loop through one shared implementation;
- every minimum acceptance scenario passes over its applicable real transport;
- default CLI output clearly explains errors and results;
- explicit export produces a stable diagnostic bundle;
- user-visible terminology preserves the distinction between no-effect, explicit denial, operational failure, and synthetic policy consequence;
- the existing repository conformance checker passes; and
- documentation includes CLI installation, one stdio walkthrough, one HTTP walkthrough, and machine-output examples.
