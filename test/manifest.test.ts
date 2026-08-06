import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ExtensionManifest {
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string }>;
    [key: string]: unknown;
  };
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as ExtensionManifest;

const supportedCommands = [
  'tokenlens.showActions',
  'tokenlens.enableEstimateGate',
  'tokenlens.disableEstimateGate',
  'tokenlens.clearEstimate',
];

describe('extension manifest', () => {
  it('contributes only the single estimate-gate workflow', () => {
    expect(
      manifest.contributes.commands.map(({ command }) => command),
    ).toEqual(supportedCommands);
    expect(manifest.contributes).not.toHaveProperty('keybindings');
    expect(manifest.contributes).not.toHaveProperty('configuration');
  });

  it('activates the gate commands and startup bridge', () => {
    expect(manifest.activationEvents).toContain('onStartupFinished');
    for (const command of supportedCommands) {
      expect(manifest.activationEvents).toContain(`onCommand:${command}`);
    }
  });
});
