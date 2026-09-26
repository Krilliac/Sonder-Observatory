import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObservatoryEvent } from "../../src/protocol/events";
import { parseNdjson } from "../../src/recording/ndjson";
import { orderEvents } from "../../src/replay/order";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** The synthetic fixture (generated in `pretest`), in replay order. */
export function fixtureEvents(): ObservatoryEvent[] {
    const parsed = parseNdjson(readFileSync(join(root, "fixtures/synthetic-session.ndjson"), "utf8"));
    if (parsed.rejected.length > 0) {
        throw new Error(`fixture has rejected lines: ${JSON.stringify(parsed.rejected[0])}`);
    }
    return orderEvents(parsed.events).events;
}

/** Fixed stamp so exports are byte-reproducible. */
export const GENERATED_AT = new Date("2026-09-26T12:00:00.000Z");
