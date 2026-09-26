# Security and Privacy

Observability can easily become an accidental prompt/secret recorder. Treat telemetry as potentially sensitive.

## Defaults

- bind live telemetry to loopback by default
- require explicit configuration for remote listening
- raw prompt/output capture off by default
- tool arguments/results redacted by default
- never include environment variables, API keys, auth headers, passwords, or connector tokens
- recordings inherit a storage quota and retention policy
- show capture/redaction state prominently in the UI

## Payload classes

| Class | Default | Examples |
|---|---|---|
| Structural | record | event type, IDs, timings, sizes |
| Resource | record | VRAM, RAM, utilization |
| Model metadata | record | model/backend/quantization names |
| Token IDs | configurable | generated/prompt token IDs |
| Token text | redacted/opt-in | prompt/output token strings |
| User content | off/opt-in | complete prompts/messages |
| Tool payloads | redacted | command args, retrieved documents |
| Secrets | never | API keys, cookies, bearer tokens |

## Redaction

Redaction should happen **before** telemetry leaves the producer process where possible.

Support:

- field allow/deny lists
- path/key pattern redaction
- size limits
- hashing for correlation without plaintext
- content-classification hooks
- "do not record" spans/scopes

## Remote transport

When remote Observatory is enabled:

- authenticate peers
- encrypt transport
- capability/session tokens should be short-lived
- authorize telemetry level separately from normal API actions
- rate-limit and cap retained replay data

### Rules Observatory enforces (live producer protocol v1)

- Loopback by default. Plain `http://` and `ws://` are refused to any
  non-loopback host (browser, manager and desktop launch alike); remote
  producers need `https://` / `wss://` and a bearer token.
- URLs with credentials (`user:pass@`) or a `token` / `access_token` query
  parameter are refused. Tokens never go in URLs or logs and are never taken
  from argv.
- A bearer token is bound to one producer and sent only as
  `Authorization: Bearer` on that producer's HTTP requests. It is not sent
  over WebSocket (browsers cannot set the header), not sent to a stream on a
  different origin than the discovery URL, not exposed in connection lists,
  and not persisted. The desktop shell reads `--token-file` once (max 4 KiB)
  and binds it to the preceding `--connect`, so one producer's key is never
  sent to another. A token given on the command line (the legacy
  `--capability <token>`) is never used as a bearer token: other local users
  can read a process's arguments.
- Redirects are never followed for discovery or stream requests (`redirect:
  "manual"`, any redirect is an error), so a producer cannot move the viewer
  to an endpoint the policy above refuses. Discovery documents over 64 KiB
  are refused unread.
- The CORS allowlists are the producers' (exact match): Sonder-Inference
  `--cors-origin` (defaults: the Observatory dev, preview and Tauri origins),
  Sonder Runtime its telemetry origin allowlist. Observatory's messages name
  the setting to change and never suggest a wildcard.
- Producer telemetry is content-free by default: Inference exports token text
  only with `--capture-text` (announced as `text_capture`), Runtime never
  exports prompts, responses, summaries or provider payloads.

Open: Runtime telemetry currently needs Runtime's admin authorization (granted
by local-open loopback mode). A read-only, short-lived telemetry capability
would be less privileged; it is not specified yet.

## Recording hygiene

- manifest records the capture policy
- recordings are treated like user data
- export warns when full text/tool payloads are present
- deletion should remove indexes/snapshots as well as primary event logs
- partial/crashed recordings remain clearly marked as incomplete

## No chain-of-thought claim

Observatory may display:
- explicit model outputs
- backend instrumentation
- hidden-state-derived research views if deliberately implemented and clearly labeled
- reasoning summaries if explicitly produced

It must not present an invented visualization as literal private reasoning or internal thoughts.
