import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Generated from the API OpenAPI document - never hand-edited, so never linted.
      '**/src/generated/**',
      // Build-tool configs. Plain ESM JavaScript that no TS project file covers,
      // so type-aware parsing cannot resolve it. `prettier --check` still runs
      // on them in CI.
      'jest.config.js',
      'jest.integration.config.js',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        // One project covering the whole repo keeps lint rules type-aware
        // (no-floating-promises, no-misused-promises) without per-package config.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      // AGENTS.md section 7: no `any`, no console.log.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // `_`-prefixed names are the convention for deliberately discarded values
      // (e.g. omitting a key via rest destructuring in a test fixture).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'error',
      // Promise correctness: an unhandled rejection in a worker handler silently
      // loses a job, which is exactly what the outbox/reaper design exists to prevent.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'smart'],
      'no-implicit-coercion': 'error',
    },
  },
  {
    // Tests intentionally stub console output and use partial mocks. Async mock
    // factories must return a Promise even when they never await, so
    // `require-await` does not apply here.
    //
    // The `no-unsafe-*` family is also relaxed: an integration suite asserts on
    // live HTTP and database responses, so `res.body.foo` and query results are
    // genuinely untyped at the point of assertion. The production code these
    // tests exercise is still fully type-checked and linted.
    files: ['**/*.spec.ts', '**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // Next.js needs these globals for client components.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // Nest resolves constructor dependencies from `design:paramtypes`, which
    // TypeScript only emits for *value* imports. Turning a provider class into an
    // `import type` compiles cleanly and then fails at runtime with "Nest can't
    // resolve dependencies", so this rule must stay off for the API.
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Plain JavaScript: config files and operational scripts that no tsconfig
    // project covers.
    //
    // The type-aware parser from the block above is still the one doing the
    // parsing - `@eslint/js` exposes no parser to swap in - so what has to be
    // undone here is `project`, not `parser`. Leaving `project` set on a file
    // the project does not include is a hard parse error, which is why this
    // block previously applied its rules but silently failed on any `.mjs`
    // that was not already in `ignores`.
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    languageOptions: {
      parserOptions: {
        project: null,
        projectService: false,
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },
  {
    // Operational scripts. Their entire output IS the interface: a seed that
    // prints nothing, or a smoke run whose assertions nobody can read, has
    // failed at the job it exists to do.
    //
    // AGENTS.md's "no console.log" rule is about application and library code
    // quietly bypassing the shared pino logger. These files are process entry
    // points with no logger to bypass - their output goes to a terminal or a
    // pipe, not to a log aggregator.
    files: ['scripts/**/*.{mjs,js}', '**/scripts/**/*.{mjs,js}', 'tests/tools/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
);
