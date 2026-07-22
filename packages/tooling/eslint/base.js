// @flash/tooling/eslint/base
//
// Shared flat-config base for every workspace package. Consumers spread this
// array into their own `eslint.config.mjs` (`export default [...spreadHere]`).
// Type-aware linting is enabled via `projectService`, which auto-discovers the
// nearest tsconfig relative to each linted file — no per-package parserOptions
// wiring required.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
// Pinned to eslint-config-prettier ^9.1.0 (contract §8): the `/flat` subpath export
// was only added in v10. On 9.x the default export is already flat-config-compatible
// (see project changelog: "the config ... has always been compatible with eslint.config.js").
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // `allowDefaultProject` lets the config file itself (e.g. `eslint.config.mjs`,
        // not part of any tsconfig `include`) be type-aware-linted against a default
        // project instead of erroring as "not found by the project service".
        projectService: {
          allowDefaultProject: ['*.mjs', '*.js', '*.cjs'],
        },
        tsconfigRootDir: process.cwd(),
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Must be last: turns off any core/plugin rules that conflict with Prettier
  // formatting so lint and format never fight each other.
  prettier,
];
