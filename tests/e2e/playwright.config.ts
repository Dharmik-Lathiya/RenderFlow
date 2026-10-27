import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the browser journey.
 *
 * The suite runs against a real web server and API. Locally that is `pnpm dev`
 * (or the compose stack); CI starts compose first. `scripts/e2e.sh` reports SKIP
 * rather than a pass when Playwright, a browser, or the app is missing - the same
 * rule `tests/chaos/run.sh` follows, because a harness that reports green for
 * what it did not do teaches people to trust it when it is wrong.
 *
 * These tests cover what jsdom cannot: layout, real SSE, and real HTTP round
 * trips. The component-layer .spec.tsx files under apps/web/src remain the fast
 * feedback loop for behaviour and accessibility semantics.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  // A journey that takes screenshots and videos on failure is worth more than
  // the disk it costs when CI fails at 2am.
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // A phone viewport, because "responsive on mobile" is half the Phase 8 DoD
    // and a desktop-only run cannot see it.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  // A hung server is a failure, not a slow pass.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  // The journey mutates one account's data; running specs against each other in
  // parallel makes failures depend on ordering.
  workers: 1,
});
