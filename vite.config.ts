import { defineConfig } from "vitest/config";

/**
 * Browser Content-Security-Policy aligned with src-tauri/tauri.conf.json:
 * denies plugins, form actions, <base> hijacking, and framing; permits
 * loopback + TLS telemetry endpoints and local Tauri IPC.
 */
const BROWSER_CSP_DIRECTIVES = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:* ws://localhost:* ws://[::1]:* wss: http://127.0.0.1:* http://localhost:* http://[::1]:* https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
] as const;

export const BROWSER_CSP_META = BROWSER_CSP_DIRECTIVES.join("; ");
export const BROWSER_CSP_HEADER = [...BROWSER_CSP_DIRECTIVES, "frame-ancestors 'none'"].join("; ");

const SECURITY_HEADERS = {
    "Content-Security-Policy": BROWSER_CSP_HEADER,
};

export default defineConfig({
    // Keep Tauri's Rust output visible in `npm run tauri dev`.
    clearScreen: false,
    // Relative asset paths so the built bundle can be hosted from a file or
    // an embedded WebView (docs/INTEGRATION.md) as well as a web server.
    base: "./",
    server: {
        host: "127.0.0.1",
        port: 5173,
        // src-tauri/tauri.conf.json devUrl expects exactly this port.
        strictPort: true,
        headers: SECURITY_HEADERS,
    },
    preview: {
        host: "127.0.0.1",
        port: 4173,
        headers: SECURITY_HEADERS,
    },
    build: {
        outDir: "dist",
        sourcemap: true,
    },
    test: {
        // Keep performance tests reliable and memory bounded on large shared hosts.
        maxWorkers: 2,
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
