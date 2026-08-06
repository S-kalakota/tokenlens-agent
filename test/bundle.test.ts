import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bundlePath = fileURLToPath(
  new URL('../dist/extension.js', import.meta.url),
);

describe('production extension bundle', () => {
  it('loads without unresolved package-relative imports', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle).not.toMatch(/require\(["']\.\/impl\//);
    expect(bundle).not.toContain('node:http');
    expect(bundle).not.toContain('SubmittedPromptBridge');
    expect(bundle).not.toContain('PromptConfirmationGate');

    const smokeTest = `
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return {};
        return originalLoad.call(this, request, parent, isMain);
      };
      const extension = require(${JSON.stringify(bundlePath)});
      if (typeof extension.activate !== 'function') process.exit(2);
      if (typeof extension.deactivate !== 'function') process.exit(3);
    `;

    expect(() =>
      execFileSync(process.execPath, ['-e', smokeTest], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
