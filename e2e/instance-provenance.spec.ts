/** Live browser cards over real local HTTP sockets; evidence is synthetic test data. */
import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import type { ObservatoryEvent } from "../src/protocol/events";

function event(instance: string, sequence: number, synthetic?: boolean, version = "1"): ObservatoryEvent {
    return {
        schema: "sonder.observatory.event/1", event_id: `${instance}-${sequence}`, sequence,
        event_type: "engine.stopped", session_id: "synthetic-browser-control",
        mono_ns: sequence + 1, wall_time: "2026-10-05T00:00:00.000Z",
        producer: { name: "sonder-inference", version, node_id: "test-host", instance_id: instance, synthetic }, attributes: {},
    };
}

for (const transport of ["sse", "ndjson"] as const) {
    test(`${transport}: mixed batch, metadata refresh and instance restart patch the actual producer card`, async ({ page }, testInfo) => {
        const origin = new URL(String(testInfo.project.use.baseURL)).origin;
        const responses = new Set<ServerResponse>();
        const server = createServer((request, response) => {
            if (request.method === "OPTIONS") {
                response.writeHead(204, { "access-control-allow-origin": origin, vary: "Origin",
                    "access-control-allow-methods": "GET, OPTIONS",
                    "access-control-allow-headers": "Accept, Cache-Control, Last-Event-ID" });
                response.end();
                return;
            }
            response.writeHead(200, {
                "content-type": transport === "sse" ? "text/event-stream" : "application/x-ndjson",
                "access-control-allow-origin": origin, vary: "Origin",
            });
            responses.add(response);
            response.write(transport === "sse" ? ": synthetic browser control\n\n" : "\n");
            response.on("close", () => responses.delete(response));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing test socket address");
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            const streamUrl = `http://127.0.0.1:${address.port}/events/${transport}`;
            await page.goto(`./?fixture=0&connect=${encodeURIComponent(streamUrl)}`);
            const card = page.locator("[data-testid=producer-card]").first();
            await expect(card.locator("[data-testid=producer-state]")).toHaveText("live");
            const send = async (events: ObservatoryEvent[], appended: number) => {
                const text = transport === "sse"
                    ? events.map((e) => `id: ${e.event_id}\ndata: ${JSON.stringify(e)}\n\n`).join("")
                    : events.map((e) => JSON.stringify(e)).join("\n") + "\n";
                for (const response of responses) response.write(text);
                await expect(card.locator('[data-counter="appended"]')).toHaveText(String(appended));
            };
            await send([event("browser-A", 0, true), event("browser-A", 1)], 2);
            await expect(card.locator(".tag-synthetic")).toBeVisible();
            await send([event("browser-A", 2, false, "2")], 3);
            await expect(card.locator(".tag-synthetic")).toBeVisible();
            await expect(card).toContainText("role unknown · 2");
            await send([event("browser-B", 0, false, "3")], 4);
            await expect(card.locator(".tag-synthetic")).toBeHidden();
            await expect(card).toContainText("browser-B");
            await expect(card).toContainText("role unknown · 3");
            // Historical session provenance stays positive independently of the latest card.
            await expect(page.locator("#synthetic-banner")).toBeVisible();
            await expect(card.locator('[data-counter="rejected"]')).toHaveText("0");
            await expect(card.locator('[data-counter="dropped"]')).toHaveText("0");
            expect(errors).toEqual([]);
            await testInfo.attach("instance-provenance-control", {
                body: JSON.stringify({ transport, synthetic_test_data: true, provider_calls: 0, events: 4, errors }), contentType: "application/json",
            });
        } finally {
            await page.goto("about:blank");
            for (const response of responses) response.destroy();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
}
