import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the workspace.
 *
 * Two rules here are not style rules and must not be relaxed:
 *
 *  - `no-restricted-syntax` on `SET`/`SET LOCAL` of an `app.*` setting. The
 *    tenant-isolation spike (SPIKE-REPORT §7.2) attaches this as a **condition**
 *    of its CONFIRM verdict: the only way to write `SET LOCAL app.tenant = ...`
 *    is to interpolate the tenant id into SQL, which puts an injection surface
 *    at the single most security-critical statement in the system.
 *    `set_config(name, value, true)` is the sole permitted spelling.
 *  - `no-restricted-globals`/`no-restricted-properties` keeping client code away
 *    from absolute URLs is handled by a dedicated gate rather than by lint,
 *    because the built bundle has to be scanned too.
 */
export default tseslint.config(
  {
    ignores: [
      // Worktrees are separate checkouts, each linted in its own context; the
      // root run must not race their red-case fixture plants (found 2026-08-02
      // when a root lint caught a worktree's planted violation mid-run).
      '.worktrees/**',
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'scripts/red-cases/*/fixture/**',
      'schedulepoint-research/**',
      'spikes/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/(?:^|[^a-zA-Z_])SET\\s+(?:SESSION\\s+|LOCAL\\s+)?["\']?app\\./i]',
          message:
            'Tenant settings are established only with set_config(name, value, true). Every SET / SET SESSION / SET LOCAL form requires interpolating the tenant id into SQL (SPIKE-REPORT §7.2).',
        },
        {
          selector:
            'TemplateElement[value.raw=/(?:^|[^a-zA-Z_])SET\\s+(?:SESSION\\s+|LOCAL\\s+)?["\']?app\\./i]',
          message:
            'Tenant settings are established only with set_config(name, value, true). Every SET / SET SESSION / SET LOCAL form requires interpolating the tenant id into SQL (SPIKE-REPORT §7.2).',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      // Gate scripts are CLIs; writing to stdout is their output contract.
      'no-console': 'off',
    },
  },
);
