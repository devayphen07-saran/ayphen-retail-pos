// Test convention: tests are COLOCATED next to source as `*.test.ts(x)`
// (e.g. src/core/sync/engine/drain-queue.ts + drain-queue.test.ts) — the
// standard Expo/RN idiom. There is intentionally no top-level `test/` folder;
// the two `projects` below are routed purely by file PATH, so a test's
// location is what selects its runtime. Moving a test out of its source
// directory silently changes (or drops) which project runs it — update the
// `testMatch` globs here if you ever relocate one.

/** @type {import('jest').Config} */
const ALIAS_MODULE_NAME_MAPPER = {
  // Keep in sync with tsconfig.app.json's "paths" / metro.config.js's ALIASES.
  '^@core/(.*)$': '<rootDir>/src/core/$1',
  '^@features/(.*)$': '<rootDir>/src/features/$1',
  '^@store$': '<rootDir>/src/store/index.ts',
  '^@store/(.*)$': '<rootDir>/src/store/$1',
  '^@ui/(.*)$': '<rootDir>/src/components/$1',
};

module.exports = {
  projects: [
    {
      // Pure logic + real-SQLite (better-sqlite3) tests — engine/repository
      // code with zero React Native imports. Plain Node environment: the
      // jest-expo preset's setupFiles initialize the RN native bridge, which
      // crashes outright outside a real RN runtime and isn't needed here.
      // features/sync/utils/ is included too — display-formatting helpers
      // extracted specifically to stay pure/RN-free (same reasoning as
      // reconcile-mutation-result.ts), just organized by feature rather than
      // under core/sync/.
      displayName: 'sync-engine',
      rootDir: __dirname,
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/src/core/sync/**/*.test.ts',
        '<rootDir>/src/features/sync/utils/**/*.test.ts',
      ],
      transform: { '\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }] },
      // babel-preset-expo inlines `process.env.EXPO_PUBLIC_*` reads (e.g.
      // utils/logger.ts) into a reference to expo/virtual/env.js — a real
      // ESM file. Default Jest ignores everything under node_modules, so
      // without this override that file fails to parse ("Unexpected token
      // 'export'") the moment anything importing logger.ts is required —
      // even though this project needs no other native-module transforms.
      // Two negative lookaheads, not one: under pnpm's isolated node-linker
      // (this workspace's node-linker=isolated, see root .npmrc), `expo`
      // actually resolves through node_modules/.pnpm/expo@.../node_modules/
      // expo/... — two "node_modules/" segments, not one. A single
      // `(?!expo/)` lookahead matches (and so wrongly IGNORES/skips
      // transform) at the OUTER node_modules/.pnpm segment, since ".pnpm"
      // isn't "expo/" either — it never gets to the inner segment that
      // actually is expo. Skipping straight past any `.pnpm` segment lets
      // the second lookahead reach the real expo/ segment underneath it.
      transformIgnorePatterns: ['node_modules/(?!\\.pnpm)(?!expo/)'],
      moduleNameMapper: ALIAS_MODULE_NAME_MAPPER,
    },
    {
      // Screens/components — real RN environment. No tests here yet.
      displayName: 'app',
      preset: 'jest-expo',
      rootDir: __dirname,
      testMatch: ['<rootDir>/src/**/*.test.ts?(x)'],
      testPathIgnorePatterns: ['<rootDir>/src/core/sync/', '<rootDir>/src/features/sync/utils/'],
      moduleNameMapper: ALIAS_MODULE_NAME_MAPPER,
    },
  ],
};
