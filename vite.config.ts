import { defineConfig } from "vitest/config";

export default defineConfig({
    // Relative asset paths so the built bundle can be hosted from a file or
    // an embedded WebView (docs/INTEGRATION.md) as well as a web server.
    base: "./",
    server: {
        host: "127.0.0.1",
        port: 5173,
    },
    preview: {
        host: "127.0.0.1",
        port: 4173,
    },
    build: {
        outDir: "dist",
        sourcemap: true,
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
