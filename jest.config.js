/**
 * RenderFlow unit tests.
 *
 * A single root Jest config with `projects` rather than one config per package:
 * it keeps jest + ts-jest resolvable from the workspace root (pnpm's isolated
 * node_modules does not hoist them into each package) and gives one place to
 * enforce the coverage gates from PROJECT.md section 13.6.
 *
 *   pnpm test              run every unit suite
 *   pnpm test:coverage     run with coverage + gates
 */

/**
 * @param {string} dir workspace-relative directory
 * @param {string} displayName
 * @returns {import('jest').Config}
 */
const tsProject = (dir, displayName) => ({
  displayName,
  // Resolved against the root config's rootDir, i.e. the workspace root.
  rootDir: `<rootDir>/${dir}`,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  restoreMocks: true,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // Inside a project config `<rootDir>` is the *project's* rootDir, so
        // this resolves to <workspace>/libs/common/tsconfig.json.
        tsconfig: '<rootDir>/tsconfig.json',
        // Surface real type errors in tests instead of transpiling silently.
        diagnostics: true,
      },
    ],
  },
});

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    tsProject('libs/common', '@renderflow/common'),
    tsProject('libs/db', '@renderflow/db'),
    tsProject('libs/queue', '@renderflow/queue'),
    tsProject('libs/storage', '@renderflow/storage'),
    tsProject('libs/observability', '@renderflow/observability'),
    tsProject('packages/api-client', '@renderflow/api-client'),
  ],

  // Coverage options are global-only in a multi-project config, so the report
  // aggregates across every workspace and one gate covers the whole repo.
  // These globs are resolved against each *project's* rootDir, hence the
  // project-relative `src/**` form rather than `libs/*/src/**`.
  collectCoverageFrom: ['src/**/*.ts', '!**/*.spec.ts', '!src/index.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text-summary', 'lcov'],

  // PROJECT.md section 13.6: overall >= 80%; libs/credits and the state machines
  // >= 95% (the per-path gate for libs/credits is added when it lands in Phase 2).
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
