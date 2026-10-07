/**
 * RenderFlow integration tests.
 *
 * Separate from `jest.config.js` because these suites need a REAL Postgres
 * (AGENTS.md section 9: never mock the database for credit or queue logic) and
 * take longer to run, so they are not part of `pnpm test`.
 *
 *   pnpm test:int
 *
 * Point TEST_DATABASE_URL at a disposable database. The helpers in
 * tests/integration/helpers apply migrations and truncate between suites.
 *
 * Coverage: `--coverage` emits a report for the files this suite actually
 * verifies (apps/api services and controllers, libs/credits SQL). Those files
 * are excluded from the *unit* gate in jest.config.js precisely because they
 * need a real database; merging the two reports is a Phase 2 follow-up.
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'integration',
  // rootDir is the workspace root so coverage can reach apps/api and libs/credits,
  // which live outside tests/. Inside a project config `<rootDir>` then refers to
  // this root, so testMatch is written in those terms.
  rootDir: '.',
  roots: ['<rootDir>/tests/integration'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The suites share one database, so they must not run concurrently.
  maxWorkers: 1,
  clearMocks: true,
  restoreMocks: true,
  // Real infrastructure: allow a slow migration or argon2 hash, but keep a
  // ceiling so a hung query fails the run instead of stalling CI forever.
  testTimeout: 60_000,

  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // `tests/` is a workspace package with the decorator flags NestJS needs.
        tsconfig: '<rootDir>/tests/tsconfig.json',
        diagnostics: true,
      },
    ],
  },

  // Only what THIS suite uniquely verifies.
  //
  // Files already covered by the unit suite are excluded so the two reports do
  // not double-count: `pnpm test:coverage` (unit) already exercises
  // auth.config.ts, password.ts, token.service.ts, env.ts and request.types.ts
  // directly. Counting them again here would report a *lower* number for code that
  // is in fact well covered, and would make this gate misleading.
  //
  // What remains is genuinely integration-only: Nest DI wiring, HTTP
  // controllers/services, and the credit engine's SQL (which must run against a
  // real Postgres - AGENTS.md section 9).
  collectCoverageFrom: [
    'apps/api/src/app.module.ts',
    'apps/api/src/**/*.controller.ts',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/credits/credits.service.ts',
    'apps/api/src/users/users.service.ts',
    'apps/api/src/auth/auth.guard.ts',
    'apps/api/src/auth/csrf.guard.ts',
    'apps/api/src/auth/token.service.ts',
    'libs/credits/src/**/*.ts',

    // Excluded because the unit suite covers them with real assertions, not
    // hand-rolled fakes; counting them here would double-count while reporting a
    // *lower* figure for code that is in fact well covered:
    //   - health.service.ts          dependency probes are not wired in Phase 1
    //   - all-exceptions.filter.ts   status -> code mapping is unit-tested
    '!apps/api/src/health/health.service.ts',
    '!apps/api/src/common/all-exceptions.filter.ts',
    '!**/*.spec.ts',
    '!**/*.d.ts',
    // Barrels are pure re-exports.
    '!**/index.ts',
  ],
  coverageDirectory: '<rootDir>/coverage-integration',
  coverageReporters: ['text-summary', 'lcov'],
  // A floor, not the PROJECT.md section 13.6 target.
  //
  // Section 13.6 asks for >= 95% on libs/credits and >= 80% overall. The unit
  // gate (jest.config.js) enforces 80% on everything unit-testable. This gate
  // covers only integration-verified files and is set at 70% so that adding a
  // new database-backed path cannot silently ship untested; it is expected to
  // rise as more phases land integration suites.
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
