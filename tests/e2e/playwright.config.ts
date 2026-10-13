import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the browser journey.
 *
 * **These specs have never been executed in this environment.** There is no
 * browser and no Docker here, so no compose stack to drive. They are written to
 * run where those exist, and `scripts/e2e.sh` reports them as SKIP rather than as
 * a pass - the same rule `tests/chaos/run.sh` follows, because a harness that
 * reports green for what it did not do teaches people to trust it when it is
 * wrong.
 *
 * What IS verified here, every day, is the component layer under jsdom - the
 * .spec.tsx files under apps/web/src. That covers behaviour and accessibility
 * semantics; it does not cover layout, real SSE, or a real HTTP round trip. The
 * split is the honest one.
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
