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
    files: ['**/*.spec.ts', '**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/require-await': 'off',
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
    // Config files are plain ESM JavaScript, so they are parsed by the default
    // JS parser (espree) rather than the type-aware TypeScript parser.
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    languageOptions: {
      parser: js.configs.recommended.languageOptions?.parser ?? undefined,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },
);
