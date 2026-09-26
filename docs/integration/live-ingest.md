# Live ingest

Status: implemented in `src/ingest/live/`, tested against
`scripts/fake-live-producer.mjs` and a fake fetch/WebSocket. The renderer's
single-URL connect path uses `connectLiveSession`. The multi-producer
`LiveConnectionManager` below is implemented and tested; wiring it into the
renderer (producer cards, presets, URL parameters) is the renderer/UX work.

The wire protocol (discovery, SSE/NDJSON framing, resume, backpressure, auth,
CORS, correlation) is specified in docs/TELEMETRY_PROTOCOL.md, "Live producer
protocol v1".

## One stream: `LiveIngestClient`

`LiveIngestClient` connects to one stream and feeds validated events into a
sink; `connectLiveSession(store, options)` binds it to the viewer's
`SessionStore` through its public API: `reset("live", url)` once, then batched
`append()` and `addRejected()` calls.

```
transport (WebSocket | SSE | NDJSON-over-HTTP)
  -> payload text -> JSON.parse -> adapter hook -> validateEvent
  -> BoundedBuffer (drop accounting) -> batched sink.append()
```

| Concern | Behaviour |
|---|---|
| Transport choice | Picked by URL. `ws://` / `wss://` uses WebSocket. `http://` / `https://` uses a streaming `fetch`. The response `Content-Type` then decides the parser: `text/event-stream` means SSE, anything else is read as NDJSON lines. A path ending in `/ndjson`, `.ndjson` or `.jsonl`, or `?format=ndjson`, only changes the `Accept` header. `transport: "websocket" \| "sse" \| "ndjson"` forces a transport. |
| Headers | `headers` (for example `{ Authorization: "Bearer …" }`) are added to HTTP requests. They are never reported in status. A WebSocket URL with an `Authorization` header is refused, because a browser cannot send it on the handshake. |
| Reconnect | On any close that `stop()` did not cause. Exponential backoff with jitter (defaults: 250 ms initial, x2 per attempt, 10 s cap, 30% jitter). An SSE `retry:` value acts as a floor on the delay. Backoff resets on the first valid event after a connection opens. `maxRetries` counts consecutive attempts that delivered no data; once it is exceeded the state becomes `failed`. |
| Resume | The client tracks the last event id (the SSE `id:` field, otherwise the `event_id` of the last valid event) and sends it on reconnect: `Last-Event-ID` over HTTP, `?last_event_id=` over WebSocket. A producer that replays from the start is still safe: `SessionStore.append` dedupes by `event_id`. |
| Backpressure | A fixed-capacity ring buffer (default 20 000) drains to the sink in batches (default 1000 events every 50 ms). HTTP streams stop reading above 75% and resume at 25% (TCP backpressure, no drops). A WebSocket cannot be paused, so it drops on overflow. |
| Drops | `drop-oldest` by default. Every dropped event is counted in `status.dropped`; drops also show up in the store as sequence `gaps`. Rejected lines go to `store.addRejected` and are counted in `status.rejected`. |
| HTTP errors | `lastError` names the status with a hint: 401 needs a token, 403 origin/host/token refused, 404 no stream (export disabled?), 429 too many subscribers. |
| Endpoint policy | `resolveEndpoint` refuses credentials in the URL, `token` / `access_token` query parameters, and plain `http://` or `ws://` to a non-loopback host. `https://` / `wss://` to a remote host is allowed with a warning. The legacy `checkEndpoint` in `src/transport/live.ts` applies the same rules to ws(s). |

`LiveIngestStatus` has these fields: `state` (`idle | connecting | open |
reconnecting | closed | failed`), `transport`, `url`, `loopback`, `warning`,
`attempts`, `reconnects`, `retryInMs`, `lastEventId`, `resumeRequested`,
`received`, `appended`, `dropped`, `rejected`, `buffered`, `bufferCapacity`,
`batches` and `lastError`. `describeStatus()` formats it for a badge;
`producerState()` maps it to the producer-card words: `idle` and `closed` →
`disconnected`, `connecting` → `connecting`, `open` → `live`, `reconnecting` →
`reconnecting`, `failed` → `failed`.

## Several producers: `LiveConnectionManager`

`src/ingest/live/manager.ts` (contract section 8.1). Observatory connects to
each producer directly (Sonder Runtime, Sonder-Inference, fixtures) and merges
their events into one `SessionStore`; replay order (`mono_ns`, then
`sequence`) and `run_id` / `parent_request_id` correlate them.

```ts
import { LiveConnectionManager, LOCAL_PRESETS, probeProducer } from "../ingest/live";

const manager = new LiveConnectionManager(store, { onAppend: scheduleRender });
const unsubscribe = manager.subscribe((connections) => renderProducerCards(connections));
await manager.add({ url: "http://127.0.0.1:11435" });                  // Runtime base URL
await manager.add({ url: "http://127.0.0.1:11437", label: "inference" }); // Inference base URL
await manager.add({ url: "https://node.example/", token });            // remote: https + token
await manager.remove(id);        // stops that stream; its events stay in the store
await manager.disconnectAll();
```

- `add(input)` never throws. Policy, network and discovery errors give a
  connection in state `failed` with a readable `status.lastError`.
- URL resolution: an http(s) URL with an empty path or `/` is a base URL
  (discovery at `/.well-known/sonder-telemetry`), a URL ending in that path is
  a discovery URL, anything else (including every ws(s) URL, for example
  `DEFAULT_ENDPOINT`) is a stream URL opened directly. From discovery the
  manager opens SSE, then NDJSON, then WebSocket, unless `transport` is forced;
  relative WebSocket paths resolve to `ws(s)://`.
- Discovery documents are validated with `validateDiscovery`
  (`src/protocol/discovery.ts`); another schema major or event schema is
  refused with a message.
- The store is reset to source `live` once, when the first producer is added
  over a non-live source. Each producer gets its own `LiveIngestClient`.
  `store.sourceLabel` lists the open stream URLs.
- `ProducerConnection` carries `id`, `url`, `label`, `hasToken`, `streamUrl`,
  `discovery`, `identity` (from discovery, or from the first events of a direct
  stream; it follows a producer restart to the new `instance_id`) and
  `status`.
- `probeProducer(url, { token })` checks a URL without opening a stream and
  returns `{ ok, discovery, streamUrl, error, corsSuspected }`.
  `corsSuspected` is set when the request failed at the network level (what a
  CORS refusal looks like from a page) or the producer answered
  `forbidden_origin`; the message then names the allowlist to change
  (Runtime `SONDER_OBSERVATORY_ORIGINS`, or `SONDER_CORS_ORIGINS` on runtimes
  without it; Inference `--cors-origin <origin>`). A 401 says a token is
  needed or was rejected.
- `LOCAL_PRESETS`: Sonder Runtime `http://127.0.0.1:11435`, Sonder-Inference
  `http://127.0.0.1:11437`, fake producer `http://127.0.0.1:8766/sse`
  (synthetic).

### Tokens

A token belongs to one producer. The manager sends it as
`Authorization: Bearer <token>` on that producer's discovery and stream
requests only. It is kept in memory inside that producer's client; it is never
put in a URL, never returned by `list()` (only `hasToken`), never logged and
never persisted. A token with a ws(s) stream is refused, and so is a
discovered stream on a different origin than the discovery URL. Tokens must
be printable ASCII without spaces, at most 4 KiB.

## Adapter hook

`adapter?: (value: unknown) => unknown | unknown[] | null | undefined` runs on
every decoded JSON value before envelope validation. It can rewrite a value,
split it into several events, or return `null` to skip it. `composeAdapters()`
chains adapters. Sonder-Inference envelopes validate as they are
(docs/telemetry-schema.md), so no adapter is needed for them.

## Fake live producer (`scripts/fake-live-producer.mjs`)

Dev/test only; every event it serves is synthetic. One loopback port serves:

- `GET /.well-known/sonder-telemetry`: a discovery document
- `ws://127.0.0.1:8766/ws`: NDJSON frames (`--batch` events per frame)
- `http://127.0.0.1:8766/sse`: `text/event-stream`, `retry:` first, `id:` = `event_id`, `: keepalive` heartbeats
- `http://127.0.0.1:8766/ndjson`: `application/x-ndjson`, blank-line heartbeats

Options: `--pace timeline|burst`, `--speed`, `--batch`, `--disconnect-after N`,
`--no-resume`, `--loop`, `--heartbeat-ms N`, and:

- `--role runtime|inference|fixture`: relabel the events as that producer
  (`sonder-runtime` / `sonder-inference` / the fixture's name), with `role`,
  a per-process `instance_id` (`rt-<12 hex>`, `tel-<16 hex>`, `fx-<12 hex>`),
  sequences renumbered from 0 and `event_id = <instance_id>-<sequence>`;
  `producer.synthetic` stays true. Resume follows the protocol: an id of this
  instance resumes after its sequence, another instance replays the window,
  `?since=now` is live only. Without `--role`, events are served unchanged.
- `--token-file PATH`: require `Authorization: Bearer <token>` on every route
  except the CORS preflight (401 with a JSON error otherwise).

It echoes the request `Origin` (dev/test convenience; real producers use an
exact allowlist) and its preflight allows `Accept, Authorization,
Cache-Control, Content-Type, Last-Event-ID`. Tests import it as
`startFakeLiveProducer()` on an ephemeral port; types are in
`scripts/fake-live-producer.d.mts`.

```bash
node scripts/fake-live-producer.mjs --role inference --port 8766
node scripts/fake-live-producer.mjs --role runtime --port 8767 --token-file ./tok
```

## Tests

- `tests/ingest/live/units.test.ts`: backoff, ring buffer, SSE parser, line
  splitter, endpoint selection and policy, adapters, `describeStatus`.
- `tests/ingest/live/producer.test.ts` (real sockets): every transport, resume,
  dedupe, ordering, WebSocket drops vs HTTP pause, the Inference fixture over
  SSE, the adapter hook, `maxRetries`, `stop()`.
- `tests/ingest/live/manager.test.ts` (fake fetch and WebSocket): base URL →
  discovery → SSE, discovery URL, direct stream URL, forced transport, two
  producers into one store with one reset, `remove()` keeps events, failed
  discovery, Authorization only with a token, token + ws refused, plain remote
  http/ws refused, credentials and token query parameters refused,
  `probeProducer` messages.
- `tests/ingest/live/conformance.test.ts`: the fake producer's role modes,
  auth, preflight and heartbeats, and the conformance checks passing on it and
  failing on broken producers.
- `tests/conformance/live-producer.test.ts`: the conformance suite against
  running producers (`SONDER_CONFORMANCE_URLS`; skipped without it).

## Integration notes

- Tauri: if a CSP is added, `connect-src` needs `http://127.0.0.1:*` (and
  `ws://127.0.0.1:*` for WebSocket producers) plus any https producer origin.
- `src/transport/live.ts` (`LiveConnection`) remains the minimal one-shot
  WebSocket client.
