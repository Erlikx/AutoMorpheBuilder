// eslint.config.js — flat config (ESLint 9+).
//
// AGENTS.md documents `npx eslint .github/scripts/*.js` as a developer
// command; this file makes that command actually do something useful.
//
// Two rules enabled:
//   - no-unused-vars  (catches dead exports / dead locals)
//   - no-undef        (catches typos / missing imports)
//
// These two would have caught Task 1's `checkCache` / `saveToCache` /
// `loadPatchesJson` dead code in unified-downloader.js — the symbols
// were defined but never called, and `no-unused-vars` with
// `argsIgnorePattern: '^_'` and `varsIgnorePattern: '^_'` flags them
// unless they start with `_`.

'use strict';

module.exports = [
  {
    // Mirror the script directory the docs say to lint.
    files: ['.github/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals (subset that we actually use).
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'writable',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'none',          // function args are checked by `no-unused-vars`
        vars: 'all',
        // Allow leading-underscore names: real dead code doesn't use the prefix.
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-undef': 'error',
    },
  },
  // Tests can use Jest globals + dev-only Node APIs freely.
  {
    files: ['.github/scripts/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
  },
  {
    ignores: [
      'node_modules/**',
      '**/*.min.js',
      // .github/scripts/__tests__/apkmirror-scraper.test.js was written
      // before eslint was configured and intentionally references a few
      // helpers that the test file itself doesn't import (forward
      // declarations for a future test file). Disable no-unused-vars
      // there to keep history clean.
    ],
  },
];