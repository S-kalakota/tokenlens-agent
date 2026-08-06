import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ExtensionManifest {
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string }>;
    keybindings: Array<{ command: string; key: string; mac?: string }>;
    configuration: {
      properties: Record<string, { scope?: string }>;
    };
  };
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as ExtensionManifest;

const captureCommands = [
  'tokenlens.estimateClipboardPrompt',
  'tokenlens.estimateSelectedText',
  'tokenlens.estimateQuickInput',
];

describe('extension manifest', () => {
  it('contributes and activates all explicit prompt-capture commands', () => {
    const contributedCommands = manifest.contributes.commands.map(
      ({ command }) => command,
    );

    for (const command of captureCommands) {
      expect(contributedCommands).toContain(command);
      expect(manifest.activationEvents).toContain(`onCommand:${command}`);
    }
  });

  it('provides rebindable defaults for each capture workflow', () => {
    const boundCommands = manifest.contributes.keybindings.map(
      ({ command }) => command,
    );

    expect(boundCommands).toEqual(expect.arrayContaining(captureCommands));
    for (const binding of manifest.contributes.keybindings) {
      expect(binding.key).toBeTruthy();
      expect(binding.mac).toBeTruthy();
    }
  });

  it('prevents workspaces from overriding prompt destination metadata', () => {
    const properties = manifest.contributes.configuration.properties;
    for (const setting of [
      'tokenlens.estimatorMode',
      'tokenlens.endpoint',
      'tokenlens.model',
      'tokenlens.accessMode',
    ]) {
      expect(properties[setting]?.scope).toBe('machine');
    }
  });

  it('contributes an opt-in automatic side-chat workflow', () => {
    const commands = manifest.contributes.commands.map(({ command }) => command);
    expect(commands).toEqual(
      expect.arrayContaining([
        'tokenlens.enableAutomaticEstimates',
        'tokenlens.disableAutomaticEstimates',
      ]),
    );
    expect(manifest.activationEvents).toContain(
      'onCommand:tokenlens.enableAutomaticEstimates',
    );
  });
});
