const { getDefaultConfig } = require('@expo/metro-config');
const { mergeConfig } = require('metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

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
    // Block any nested react/react-native copy so only the root instance is loaded
    blockList: /node_modules\/.+\/node_modules\/(react|react-native)\/.*/,
    // Force a single copy of these packages across the monorepo
    extraNodeModules: {
      'react': path.resolve(workspaceRoot, 'node_modules/react'),
      'react-native': path.resolve(workspaceRoot, 'node_modules/react-native'),
    },
    // App-internal aliases — keep in sync with tsconfig.app.json's "paths".
    // Metro has no built-in `resolver.alias`; rewrite via resolveRequest instead.
    resolveRequest: (context, moduleName, platform) => {
      const ALIASES = {
        '@core': path.resolve(projectRoot, 'src/core'),
        '@features': path.resolve(projectRoot, 'src/features'),
        '@store': path.resolve(projectRoot, 'src/store'),
        '@ui': path.resolve(projectRoot, 'src/components'),
      };
      for (const [alias, target] of Object.entries(ALIASES)) {
        if (moduleName === alias || moduleName.startsWith(`${alias}/`)) {
          const rest = moduleName.slice(alias.length);
          return context.resolveRequest(context, `${target}${rest}`, platform);
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
