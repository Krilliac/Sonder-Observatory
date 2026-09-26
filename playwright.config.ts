import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests for the web renderer (feat/e2e). See docs/integration/e2e.md.
 *
 * By default the suite builds the app (which regenerates the synthetic
 * fixture via the `prebuild` script) and serves dist/ with `vite preview`.
 * Set E2E_BASE_URL to test an already running server instead.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);
const externalBaseURL = process.env.E2E_BASE_URL;
const baseURL = externalBaseURL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: "e2e",
    outputDir: "test-results/e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    timeout: 30_000,
    expect: { timeout: 5_000 },
    reporter: process.env.CI
        ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
        : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
    use: {
        baseURL,
        viewport: { width: 1440, height: 1000 },
        colorScheme: "dark",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }],
    webServer: externalBaseURL
        ? undefined
        : {
              command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
              url: baseURL,
              // Opt-in only: silently reusing whatever already listens on the port can test the wrong build.
              reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
              timeout: 180_000,
              stdout: "ignore",
              stderr: "pipe",
          },
});
