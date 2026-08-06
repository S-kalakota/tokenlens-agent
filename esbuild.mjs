import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  // Prefer ESM package entries so esbuild can statically include their
  // relative imports. jsonc-parser's UMD entry uses a dynamic require alias
  // that otherwise survives bundling and fails after VSIX installation.
  mainFields: ['module', 'main'],
  target: 'node20',
  outfile: 'dist/extension.js',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('TokenLens build watcher is ready.');
} else {
  await esbuild.build(options);
}
