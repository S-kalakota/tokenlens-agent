import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDirectory = join(repositoryRoot, 'native', 'macos', 'Sources');
const outputDirectory = join(repositoryRoot, 'native', 'bin', 'darwin-arm64');
const outputPath = join(outputDirectory, 'tokenlens-ax-observer');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('TokenLens native builds currently require darwin-arm64.');
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tokenlens-native-build-'));
const temporaryBinary = join(temporaryDirectory, basename(outputPath));
const stagedBinary = `${outputPath}.next`;

try {
  const sdkPath = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
    encoding: 'utf8',
  }).trim();
  const sources = [
    'main.m',
    'TLProtocol.m',
    'TLComposerClassifier.m',
    'TLAccessibilityObserver.m',
  ].map((name) => join(sourceDirectory, name));

  execFileSync(
    'xcrun',
    [
      '--sdk',
      'macosx',
      'clang',
      '-fobjc-arc',
      '-fmodules',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-target',
      'arm64-apple-macos13.0',
      '-isysroot',
      sdkPath,
      '-framework',
      'Foundation',
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      ...sources,
      '-o',
      temporaryBinary,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('strip', ['-x', temporaryBinary], { stdio: 'inherit' });
  execFileSync(
    'codesign',
    [
      '--force',
      '--sign',
      '-',
      '--identifier',
      'com.tokenlens.ax-observer',
      temporaryBinary,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--verify', '--strict', temporaryBinary], {
    stdio: 'inherit',
  });
  execFileSync(temporaryBinary, ['--self-test'], { stdio: 'inherit' });

  mkdirSync(outputDirectory, { recursive: true });
  copyFileSync(temporaryBinary, stagedBinary);
  chmodSync(stagedBinary, 0o755);
  renameSync(stagedBinary, outputPath);
  console.log(`Built ${outputPath}`);
} finally {
  rmSync(stagedBinary, { force: true });
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
