import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const helperPath = resolve(
  repositoryRoot,
  'native/bin/darwin-arm64/tokenlens-ax-observer',
);

const stat = statSync(helperPath);
if (!stat.isFile() || (stat.mode & 0o777) !== 0o755) {
  throw new Error('The staged TokenLens helper must be a mode-0755 regular file.');
}
accessSync(helperPath, constants.X_OK);

const architectures = execFileSync('lipo', ['-archs', helperPath], {
  encoding: 'utf8',
}).trim();
if (architectures !== 'arm64') {
  throw new Error(`Expected an arm64-only helper, received: ${architectures}`);
}

execFileSync('codesign', ['--verify', '--strict', helperPath], { stdio: 'inherit' });
const signatureResult = spawnSync(
  'codesign',
  ['-d', '--verbose=2', helperPath],
  { encoding: 'utf8' },
);
if (signatureResult.status !== 0) {
  throw new Error('The helper signature metadata could not be read.');
}
const signature = `${signatureResult.stdout}${signatureResult.stderr}`;
if (!signature.includes('Identifier=com.tokenlens.ax-observer')) {
  throw new Error('The helper has an unexpected signing identifier.');
}
const buildVersion = execFileSync('vtool', ['-show-build', helperPath], {
  encoding: 'utf8',
});
if (!/platform MACOS[\s\S]*minos 13\.0/.test(buildVersion)) {
  throw new Error('The helper does not declare the expected macOS 13.0 minimum.');
}
const linkedLibraries = execFileSync('otool', ['-L', helperPath], {
  encoding: 'utf8',
});
if (linkedLibraries.includes('@rpath/')) {
  throw new Error('The helper contains an unresolved @rpath dependency.');
}
const version = execFileSync(helperPath, ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'tokenlens-ax-observer 1') {
  throw new Error(`Unexpected helper version output: ${version}`);
}
const selfTest = execFileSync(helperPath, ['--self-test'], { encoding: 'utf8' }).trim();
if (selfTest !== 'ok') {
  throw new Error(`Native helper self-test failed: ${selfTest}`);
}

console.log('Verified the darwin-arm64 TokenLens helper.');
