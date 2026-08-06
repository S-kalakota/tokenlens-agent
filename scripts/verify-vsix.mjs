import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const argument = process.argv[2];
if (argument === undefined) {
  throw new Error('Pass the packaged VSIX path to verify-vsix.mjs.');
}
const vsixPath = isAbsolute(argument) ? argument : resolve(process.cwd(), argument);
const entries = execFileSync('unzip', ['-Z1', vsixPath], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

const expectedEntries = new Set([
  'extension.vsixmanifest',
  '[Content_Types].xml',
  'extension/package.json',
  'extension/readme.md',
  'extension/dist/extension.js',
  'extension/dist/extension.js.map',
  'extension/native/bin/darwin-arm64/tokenlens-ax-observer',
]);
const unexpectedEntries = entries.filter((entry) => !expectedEntries.has(entry));
const missingEntries = [...expectedEntries].filter(
  (entry) => !entries.includes(entry),
);
if (unexpectedEntries.length > 0 || missingEntries.length > 0) {
  throw new Error(
    `Unexpected VSIX contents; extra: ${unexpectedEntries.join(', ') || 'none'}; missing: ${missingEntries.join(', ') || 'none'}`,
  );
}

const helperEntry =
  'extension/native/bin/darwin-arm64/tokenlens-ax-observer';
if (entries.filter((entry) => entry === helperEntry).length !== 1) {
  throw new Error('The VSIX must contain exactly one darwin-arm64 helper.');
}

const forbidden = entries.filter(
  (entry) =>
    entry.includes('/.cursor/') ||
    entry.includes('/.tokenlens/') ||
    entry.includes('tokenlens-before-submit') ||
    entry.includes('/native/macos/') ||
    entry.includes('/node_modules/') ||
    entry.includes('/darwin-x64/'),
);
if (forbidden.length > 0) {
  throw new Error(`The VSIX contains forbidden entries: ${forbidden.join(', ')}`);
}

const zipDetails = execFileSync('zipinfo', ['-l', vsixPath], {
  encoding: 'utf8',
});
const helperLine = zipDetails
  .split('\n')
  .find((line) => line.endsWith(` ${helperEntry}`));
if (helperLine === undefined || !helperLine.trimStart().startsWith('-rwxr-xr-x')) {
  throw new Error('The helper executable mode was not preserved in the VSIX.');
}

const vsixManifest = execFileSync(
  'unzip',
  ['-p', vsixPath, 'extension.vsixmanifest'],
  { encoding: 'utf8' },
);
if (!vsixManifest.includes('TargetPlatform="darwin-arm64"')) {
  throw new Error('The VSIX manifest is not targeted to darwin-arm64.');
}

const extensionManifest = JSON.parse(
  execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], {
    encoding: 'utf8',
  }),
);
if (extensionManifest.version !== '0.4.0') {
  throw new Error('The VSIX contains an unexpected TokenLens version.');
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tokenlens-vsix-check-'));
const extractedHelper = join(temporaryDirectory, basename(helperEntry));
try {
  const packagedHelper = execFileSync('unzip', ['-p', vsixPath, helperEntry], {
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
  });
  const stagedHelper = readFileSync(
    join(repositoryRoot, 'native/bin/darwin-arm64/tokenlens-ax-observer'),
  );
  if (!packagedHelper.equals(stagedHelper)) {
    throw new Error('The packaged helper does not match the staged helper.');
  }
  writeFileSync(extractedHelper, packagedHelper);
  chmodSync(extractedHelper, 0o755);
  const architecture = execFileSync('lipo', ['-archs', extractedHelper], {
    encoding: 'utf8',
  }).trim();
  if (architecture !== 'arm64') {
    throw new Error(`Unexpected packaged helper architecture: ${architecture}`);
  }
  execFileSync('codesign', ['--verify', '--strict', extractedHelper]);
  const signatureResult = spawnSync(
    'codesign',
    ['-d', '--verbose=2', extractedHelper],
    { encoding: 'utf8' },
  );
  if (signatureResult.status !== 0) {
    throw new Error('The packaged helper signature metadata could not be read.');
  }
  const signature = `${signatureResult.stdout}${signatureResult.stderr}`;
  if (!signature.includes('Identifier=com.tokenlens.ax-observer')) {
    throw new Error('The packaged helper has an unexpected signing identifier.');
  }
  const selfTest = execFileSync(extractedHelper, ['--self-test'], {
    encoding: 'utf8',
  }).trim();
  if (selfTest !== 'ok') {
    throw new Error(`Packaged helper self-test failed: ${selfTest}`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

for (const [archivePath, workspacePath] of [
  ['extension/dist/extension.js', 'dist/extension.js'],
  ['extension/dist/extension.js.map', 'dist/extension.js.map'],
  ['extension/readme.md', 'README.md'],
]) {
  const packagedFile = execFileSync('unzip', ['-p', vsixPath, archivePath], {
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!packagedFile.equals(readFileSync(join(repositoryRoot, workspacePath)))) {
    throw new Error(`${archivePath} does not match the current workspace build.`);
  }
}

console.log(`Verified ${vsixPath}`);
