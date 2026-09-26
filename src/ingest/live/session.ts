/**
 * Binds a live connection to the viewer's SessionStore through its public
 * API: reset("live", url) once, then batched append()/addRejected().
 */
import type { SessionStore } from "../../replay/session";
import { LiveIngestClient, type LiveIngestOptions } from "./client";

export interface LiveSessionOptions extends Omit<LiveIngestOptions, "sink"> {
    /** Called after each batch lands in the store (e.g. to re-render). */
    onAppend?: (store: SessionStore) => void;
}

/** Resets `store` to a live source and starts streaming into it. */
export function connectLiveSession(store: SessionStore, options: LiveSessionOptions): LiveIngestClient {
    const { onAppend, ...rest } = options;
    store.reset("live", options.url);
    const client = new LiveIngestClient({
        ...rest,
        sink: {
            append: (events) => {
                store.append(events);
                onAppend?.(store);
            },
            addRejected: (lines) => store.addRejected(lines),
        },
    });
    client.start();
    return client;
}
