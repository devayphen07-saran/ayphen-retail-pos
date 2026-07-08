const { getDefaultConfig } = require('@expo/metro-config');
const { mergeConfig } = require('metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

// Resolve via Node's own algorithm rather than assuming a hoisted-root path —
// pnpm's node-linker can be `hoisted` (flat root node_modules) or `isolated`
// (per-project symlinks only), and this must find the single shared copy
// either way.
const resolvePkgDir = (pkg) =>
  path.dirname(require.resolve(`${pkg}/package.json`, { paths: [projectRoot] }));
const reactDir = resolvePkgDir('react');
const reactNativeDir = resolvePkgDir('react-native');
// @tanstack/react-query isn't a "vendored nested copy" case like react/react-native
// below — it's a legitimate pnpm duplication: libs-common/api-manager declares it as
// a devDependency without an explicit `react` peer, so pnpm resolves it against a
// different react build than apps/mobile's own copy. Two module instances means two
// separately-created QueryClientContext objects, so this app's QueryClientProvider
// silently doesn't satisfy useQuery/useMutation calls made from that lib ("No
// QueryClient set" even though the provider is clearly mounted).
const reactQueryDir = resolvePkgDir('@tanstack/react-query');

const defaultConfig = getDefaultConfig(projectRoot);
const { assetExts, sourceExts } = defaultConfig.resolver;

/** @type {import('metro-config').MetroConfig} */
const config = {
  projectRoot,
  watchFolders: [workspaceRoot],
  cacheVersion: '@ayphen/mobile',
  transformer: {
    babelTransformerPath: require.resolve('react-native-svg-transformer'),
  },
  resolver: {
    assetExts: assetExts.filter((ext) => ext !== 'svg'),
    sourceExts: [...sourceExts, 'cjs', 'mjs', 'svg'],
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    // Block any *genuinely vendored* nested react/react-native copy (some
    // dependency bundling its own private version) so only the single
    // instance resolved below is loaded. Must exclude pnpm's own store
    // layout (node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/...) —
    // that's the canonical package location under pnpm, not a duplicate,
    // and this regex would otherwise block the real copy our own redirect
    // below resolves to.
    blockList: /node_modules\/(?!\.pnpm\/).+\/node_modules\/(react|react-native)\/.*/,
    // App-internal aliases — keep in sync with tsconfig.app.json's "paths".
    // Metro has no built-in `resolver.alias`; rewrite via resolveRequest instead.
    resolveRequest: (context, moduleName, platform) => {
      // Force a single copy of react/react-native across the monorepo: pnpm
      // gives every workspace member its own symlink to the same physical
      // package, but a second, differently-versioned copy can still exist
      // elsewhere in the tree, and Metro's hierarchical lookup doesn't
      // otherwise guarantee it picks the canonical one. Rewriting to an
      // absolute path (rather than `extraNodeModules`) keeps subpath imports
      // like `react/jsx-runtime` working — `extraNodeModules` doesn't
      // consult a package's `exports` map for subpaths, so it 404s on them.
      const FORCED_SINGLE_COPY = {
        react: reactDir,
        'react-native': reactNativeDir,
        '@tanstack/react-query': reactQueryDir,
      };
      const ALIASES = {
        '@core': path.resolve(projectRoot, 'src/core'),
        '@features': path.resolve(projectRoot, 'src/features'),
        '@store': path.resolve(projectRoot, 'src/store'),
        '@ui': path.resolve(projectRoot, 'src/components'),
      };
      for (const [name, target] of Object.entries({ ...FORCED_SINGLE_COPY, ...ALIASES })) {
        if (moduleName === name || moduleName.startsWith(`${name}/`)) {
          const rest = moduleName.slice(name.length);
          return context.resolveRequest(context, `${target}${rest}`, platform);
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
