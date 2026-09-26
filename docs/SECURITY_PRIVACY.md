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
