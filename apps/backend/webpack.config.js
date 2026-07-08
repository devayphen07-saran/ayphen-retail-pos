const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');
const { readdirSync } = require('fs');

// Nx's default externals detection (webpack-node-externals) only scans the
// workspace-root node_modules. Under pnpm's node-linker=isolated, direct
// deps are symlinked into this app's own node_modules instead of the root,
// so Nx's scan misses them and webpack tries to bundle them — which breaks
// on the optional peer deps they guard behind runtime try/catch (e.g.
// @nestjs/terminus's unused db health indicators). Externalize anything
// actually present here so it's required at runtime instead of bundled.
function localNodeModulesExternals() {
  const modulesDir = join(__dirname, 'node_modules');
  const names = new Set();
  let entries = [];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    // no local node_modules — nothing to externalize
  }
  for (const entry of entries) {
    if (entry === '.bin') continue;
    if (entry.startsWith('@')) {
      let scoped = [];
      try {
        scoped = readdirSync(join(modulesDir, entry));
      } catch {
        // ignore unreadable scope dir
      }
      for (const pkg of scoped) names.add(`${entry}/${pkg}`);
    } else {
      names.add(entry);
    }
  }
  return ({ request }, callback) => {
    if (!request) return callback();
    const parts = request.split('/');
    const pkgName = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (names.has(pkgName)) {
      return callback(null, `commonjs ${request}`);
    }
    callback();
  };
}

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  externals: [localNodeModulesExternals()],
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
      mergeExternals: true,
    }),
  ],
};
