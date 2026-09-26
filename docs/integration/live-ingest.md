# Live ingest (feat/live-ingest)

Status: implemented in `src/ingest/live/`, tested against
`scripts/fake-live-producer.mjs`. Not wired into the renderer yet. That
wiring belongs to the integrator (it touches `src/renderer/*` and
`package.json`); see "Wiring needed" below.

## What it does

`LiveIngestClient` connects to a running producer and feeds validated events
into the viewer's `SessionStore` through its public API: `reset("live", url)`
once, then batched `append()` and `addRejected()` calls.

```
transport (WebSocket | SSE | NDJSON-over-HTTP)
  -> payload text -> JSON.parse -> adapter hook -> validateEvent
  -> BoundedBuffer (drop accounting) -> batched sink.append()
```

| Concern | Behaviour |
|---|---|
| Transport choice | Picked by URL. `ws://` / `wss://` uses WebSocket. `http://` / `https://` uses a streaming `fetch`. The response `Content-Type` then decides the parser: `text/event-stream` means SSE, anything else is read as NDJSON lines (the fallback). A path ending in `/ndjson`, `.ndjson` or `.jsonl`, or `?format=ndjson`, only changes the `Accept` header. `transport: "websocket" \| "sse" \| "ndjson"` forces a transport. |
| Reconnect | On any close that `stop()` did not cause. Exponential backoff with jitter (defaults: 250 ms initial, x2 per attempt, 10 s cap, 30% jitter). An SSE `retry:` value acts as a floor on the delay. Backoff resets on the first valid event after a connection opens, so a producer that accepts and then closes immediately doesn't cause a tight retry loop. `maxRetries` counts consecutive attempts that delivered no data; once it is exceeded the state becomes `failed`. |
| Resume | The client tracks the last event id: the SSE `id:` field when there is one, otherwise the `event_id` of the last valid event. On reconnect it sends that id: over HTTP as a `Last-Event-ID` header (the SSE standard), over WebSocket as `?last_event_id=` (browsers can't set handshake headers; the name is set by `resumeParam`). A producer that ignores the request and replays from the start is still safe: `SessionStore.append` dedupes by `event_id` and counts `duplicates`. |
| Backpressure | Events wait in a fixed-capacity ring buffer (default 20 000). A timer drains it to the sink in batches (default 1000 events every 50 ms), so `SessionStore.append`, which re-sorts the whole session, runs a few times a second rather than once per frame. If `sink.append` returns a Promise, the next batch waits for it. HTTP streams stop reading while the buffer is above 75% and resume at 25% (`httpBackpressure: "pause"`, the default). This is real TCP backpressure, so HTTP streams don't drop events. A browser can't pause a WebSocket, so a WebSocket drops on overflow. |
| Drops | Overflow policy is `drop-oldest` by default, which keeps the live edge; `drop-newest` is also available. Every dropped event is counted in `status.dropped`, and `appended + dropped + buffered == received` always holds. Drops also show up in the store as sequence `gaps`. Rejected lines (bad JSON, a failed adapter, a failed schema check) go to `store.addRejected` with a running line number and are counted in `status.rejected`. |
| Endpoint safety | Loopback hosts are fine. Any other host sets `status.warning` (use `wss://` / `https://` and an authenticated producer), in line with the existing `checkEndpoint` in `src/transport/live.ts` and docs/SECURITY_PRIVACY.md. |

## Public API (`src/ingest/live/index.ts`)

```ts
import { connectLiveSession, describeStatus } from "../ingest/live";

const client = connectLiveSession(store, {
    url: "ws://127.0.0.1:8766/ws",   // or http://127.0.0.1:8766/sse, .../ndjson
    adapter: undefined,               // Inference adapter hook (see below)
    onAppend: () => scheduleRender(), // after each batch lands in the store
});
const unsubscribe = client.subscribe((status) => { /* LiveIngestStatus */ });
await client.stop();                  // closes, stops reconnecting, flushes buffer
```

`LiveIngestClient` can also be used with any sink shaped like
`{ append(events), addRejected?(lines) }`, for example a worker proxy that
returns a Promise.

`LiveIngestStatus` has these fields: `state` (`idle | connecting | open |
reconnecting | closed | failed`), `transport`, `url`, `loopback`, `warning`,
`attempts`, `reconnects`, `retryInMs`, `lastEventId`, `resumeRequested`,
`received`, `appended`, `dropped`, `rejected`, `buffered`, `bufferCapacity`,
`batches` and `lastError`.

## UI connection-status hook (for the integrator)

The renderer is vanilla TS, so the "hook" is a subscription plus the pure
`describeStatus()` formatter (tested in `tests/ingest/live/units.test.ts`).
Suggested wiring in `src/renderer/app.ts`, or as an `ObservatoryPanel`:

```ts
import { connectLiveSession, describeStatus, type LiveIngestClient } from "../ingest/live";

let live: LiveIngestClient | null = null;
let renderQueued = false;
const scheduleRender = () => {
    if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; render(); });
    }
};

/** Badge: <span id="live-status" class="badge" data-tone="ok|warn|error|idle"> */
export function bindLiveStatus(el: HTMLElement, client: LiveIngestClient): () => void {
    return client.subscribe((status) => {
        const view = describeStatus(status);
        el.textContent = view.label;   // "live · ws", "reconnecting in 2.0 s", "live · sse · 12 dropped"
        el.dataset.tone = view.tone;
        el.title = view.detail;        // url, counters, last error, resume id
    });
}

async function connectLive(url: string) {
    await live?.stop();
    live = connectLiveSession(store, { url, onAppend: scheduleRender });
    unbindBadge?.();
    unbindBadge = bindLiveStatus(document.getElementById("live-status")!, live);
}
```

Styling: map `data-tone` to the design tokens (ok = success, warn = warning,
error = danger, idle = muted). Label the session as synthetic when
`store.synthetic` is true; the fake producer keeps `producer.synthetic: true`.

## Adapter hook (Sonder-Inference)

`adapter?: (value: unknown) => unknown | unknown[] | null | undefined` runs on
every decoded JSON value before envelope validation. It can rewrite a value,
split it into several events, or return `null` to skip it (for control
records). `composeAdapters()` chains adapters.

State as of this PR: main (f5e3ff5) has no separate Inference adapter module.
PR #10 made the readers accept Inference's b2170c0 shapes directly, and the
envelope already validates. `tests/ingest/live/producer.test.ts` streams
`tests/fixtures/sonder-inference-b2170c0.jsonl` over SSE across a forced
reconnect with no rejects, duplicates or false gaps. When the lead's adapter
lands, pass it as `connectLiveSession(store, { url, adapter: adaptInferenceEvent })`,
or make it the default in the renderer's connect path. No change to
`src/ingest/live` is needed.

## Fake live producer (`scripts/fake-live-producer.mjs`)

This serves the synthetic fixture (or any NDJSON / `.sobs` file) on one
loopback port:

- `ws://127.0.0.1:8766/ws`: NDJSON frames (`--batch` events per frame)
- `http://127.0.0.1:8766/sse`: `text/event-stream`, `id:` = `event_id`, `retry:` hint, 15 s keepalive comments
- `http://127.0.0.1:8766/ndjson`: `application/x-ndjson`

Options: `--pace timeline|burst`, `--speed`, `--batch`, `--disconnect-after N`
(hard-closes each connection after N events, to simulate crashes),
`--no-resume` and `--loop`. It honours `Last-Event-ID` and `?last_event_id=`,
sends CORS headers so `npm run dev` can connect from the browser, and waits
for `drain` on HTTP writes. Tests import it as `startFakeLiveProducer()` on an
ephemeral port; types are in `scripts/fake-live-producer.d.mts`. The existing
`scripts/fake-producer.mjs` is unchanged.

## Tests

- `tests/ingest/live/units.test.ts` (15 tests): backoff, ring buffer and both overflow policies, the SSE parser (CR/LF/CRLF split at every byte, BOM, comments, `retry`, NUL ids), line splitter, endpoint and transport selection, adapter composition, `describeStatus`.
- `tests/ingest/live/producer.test.ts` (14 tests, real sockets on loopback):
  - all 3 transports stream the full fixture in replay order with 0 drops, 0 duplicates and no gaps;
  - on all 3 transports, reconnect plus resume with `disconnectAfter: 100` loses nothing and duplicates nothing;
  - a producer without resume falls back to dedupe;
  - out-of-order delivery ends up sorted in the store;
  - a WebSocket that outpaces a slow sink (10k events into a 500-slot buffer) drops, keeps the live edge, satisfies `appended + dropped == received`, delivers batches of at most the batch size in wire order, and the store reports gaps;
  - the same load over NDJSON with pause backpressure drops nothing;
  - the Inference fixture streams over SSE across a resume;
  - the adapter hook works;
  - `maxRetries` ends in `failed`;
  - `stop()` does not reconnect.

## Wiring needed (integrator-owned files)

1. `package.json`: add `"fake-live-producer": "node scripts/fake-live-producer.mjs"`. No new dependencies: the client uses the browser's `WebSocket` and `fetch`, and the producer and tests use `ws`, which is already a devDependency.
2. `src/renderer/app.ts` / `main.ts`: replace the `LiveConnection` connect path with `connectLiveSession`, add the `#live-status` badge from the snippet above, and throttle re-render with `requestAnimationFrame`. The URL field should accept `http(s)://` as well as `ws(s)://`. `checkEndpoint` in `src/transport/live.ts` only allows ws/wss; use `resolveEndpoint` from `src/ingest/live` instead.
3. Tauri: if a CSP is added, `connect-src` needs `ws://127.0.0.1:*` and `http://127.0.0.1:*`.
4. Optional: once the renderer is switched, retire `src/transport/live.ts`, or keep it for the one-shot, no-reconnect case.

## Open questions (not invented here)

- The WebSocket resume parameter name (`last_event_id`) and the use of `Last-Event-ID` on NDJSON streams are proposals. Neither Sonder Runtime nor Inference has a producer contract for resume yet (docs/INTEGRATION.md). Until one exists, dedupe covers producers that ignore it.
- There is no producer capability handshake yet, so the client can't tell whether resume was honoured. `resumeRequested` reports only that it was asked for.
- Credentials (desktop `--session` / `--capability`) are sent as a `session` query parameter plus `Authorization: Bearer` (HTTP) or a first `{"type":"observatory.auth","capability":…,"session":…}` frame (WebSocket). These shapes are proposals too (docs/DECISIONS.md); a producer that ignores the frame simply streams as before.
