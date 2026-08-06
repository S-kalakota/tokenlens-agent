import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ExtensionManifest {
  version: string;
  description: string;
  files: string[];
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string }>;
    configuration: {
      properties: Record<
        string,
        {
          type: string;
          default: unknown;
          scope: string;
          ignoreSync: boolean;
        }
      >;
    };
    [key: string]: unknown;
  };
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as ExtensionManifest;

const supportedCommands = [
  'tokenlens.showActions',
  'tokenlens.enableLiveEstimate',
  'tokenlens.disableLiveEstimate',
  'tokenlens.requestAccessibilityPermission',
  'tokenlens.diagnoseLiveDraftDetection',
];

describe('extension manifest', () => {
  it('contributes only the live status-chip workflow', () => {
    expect(manifest.version).toBe('0.4.0');
    expect(manifest.description).toMatch(/live cost estimate/i);
    expect(manifest.contributes.commands.map(({ command }) => command)).toEqual(
      supportedCommands,
    );
    expect(manifest.contributes).not.toHaveProperty('keybindings');
    expect(
      manifest.contributes.configuration.properties[
        'tokenlens.liveEstimate.enabled'
      ],
    ).toMatchObject({
      type: 'boolean',
      default: false,
      scope: 'application',
      ignoreSync: true,
    });
  });

  it('activates at startup and for every live command', () => {
    expect(manifest.activationEvents).toContain('onStartupFinished');
    for (const command of supportedCommands) {
      expect(manifest.activationEvents).toContain(`onCommand:${command}`);
    }
  });

  it('packages the arm64 helper and no legacy hook', () => {
    expect(manifest.files).toEqual([
      'dist/**',
      'native/bin/darwin-arm64/tokenlens-ax-observer',
      'README.md',
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(
      /enableEstimateGate|disableEstimateGate|clearEstimate|tokenlens-before-submit/,
    );
  });
});
