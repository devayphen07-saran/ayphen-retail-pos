import type { Config } from 'jest';

const config: Config = {
  displayName: '@ayphen/backend',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // tsconfig.json at project root is a bare project-references shell
  // (files: [], include: []) with no experimentalDecorators — without this,
  // ts-jest compiles Nest's decorators with TC39 semantics instead of the
  // legacy ones Nest expects, and DI blows up at class-definition time.
  //
  // The .js match (+ allowJs below) is for `jose`: it ships ESM-only with no
  // CJS build, so its plain .js needs the same CJS-emitting transform as our
  // .ts sources, or `require('jose')` fails on a bare `export` token.
  transform: {
    '^.+\\.(t|j)sx?$': ['ts-jest', {
      tsconfig: '<rootDir>/test/tsconfig.jest.json', // tsconfig.app.json + allowJs + isolatedModules, for the jose passthrough
    }],
  },
  // Only jose is exempted from the default "don't transform node_modules"
  // rule — it's ESM-only with no CJS build. The lookahead is anchored with
  // a trailing .* so it doesn't accidentally un-ignore nested packages that
  // happen to sit next to jose in a deeper node_modules path (e.g.
  // testcontainers/node_modules/undici).
  transformIgnorePatterns: ['node_modules/(?!jose/)(?!.*/jose/)'],
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
  // setupFiles run before the test framework installs — env vars must land
  // here, before any test file imports src/config/env.ts (which validates
  // process.env at import time and process.exit(1)s if vars are missing).
  setupFiles: ['<rootDir>/test/setup/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup/after-env.ts'],
  testTimeout: 30_000,
  maxWorkers: 1,
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  // src/** uses NodeNext-style relative imports with explicit .js extensions
  // (needed for tsx/native ESM); ts-jest's CommonJS transform doesn't resolve
  // those back to the .ts source, so strip the extension before resolution.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.d.ts',
    '!src/main.ts',
  ],
};

export default config;
