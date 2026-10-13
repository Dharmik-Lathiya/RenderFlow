/**
 * Jest project for `apps/web`.
 *
 * Separate from the `tsProject()` helper the other packages use, because the
 * browser needs three things a Node library does not:
 *
 *  - `jsdom` for a DOM;
 *  - a `.tsx` transform, so component tests type-check the JSX rather than being
 *    stripped to `React.createElement` before ts-jest sees them;
 *  - CSS modules stubbed to their class name, since jest cannot parse them and a
 *    component under test should not care.
 *
 * AGENTS.md section 9 forbids real network in tests, so every test here runs
 * against a stub `fetch` injected through the api-client's `fetchImpl` seam.
 */
const path = require('node:path');

/** @type {import('jest').Config} */
module.exports = {
  displayName: '@renderflow/web',
  rootDir: `${__dirname}`,
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/src/**/*.spec.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  clearMocks: true,
  restoreMocks: true,
  moduleNameMapper: {
    // CSS modules resolve to an identity-obj-style proxy, so `styles.foo` is the
    // string "foo" and a test can assert on class names without jest having to
    // understand the stylesheet.
    '\\.module\\.css$': '<rootDir>/test/style-mock.ts',
    '\\.css$': '<rootDir>/test/style-mock.ts',
  },
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: path.join(__dirname, 'tsconfig.jest.json'),
        diagnostics: true,
      },
    ],
  },
};
