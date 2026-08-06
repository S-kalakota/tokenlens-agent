import * as vscode from 'vscode';
import {
  LEGACY_ESTIMATE_GATE_STATE_KEY,
  LEGACY_HOOK_REMOVAL_MIGRATION_VERSION,
  LEGACY_HOOK_REMOVAL_STATE_KEY,
  removeLegacyPromptHookArtifacts,
  type LegacyHookRemovalMigrationState,
} from './automaticPrompt/legacyHookRemoval';
import { LiveEstimateCoordinator } from './liveDraft/liveEstimateCoordinator';
import type { HelperDiagnosticMetadata } from './liveDraft/protocol';
import { StatusBarController } from './ui/statusBarController';

const LEGACY_LIVE_ESTIMATE_STATE_KEY = 'tokenlens.liveEstimate.enabled.v1';
const LIVE_ESTIMATE_CONFIGURATION = 'tokenlens.liveEstimate.enabled';
const LIVE_ESTIMATE_SETTING = 'liveEstimate.enabled';
const ENABLE_ACTION = 'Enable Live Estimate';
const REQUEST_PERMISSION_ACTION = 'Request Accessibility Permission';
const OPEN_ACCESSIBILITY_SETTINGS_ACTION = 'Open Accessibility Settings';
const HELPER_RELATIVE_PATH =
  'native/bin/darwin-arm64/tokenlens-ax-observer';

let activeCoordinator: LiveEstimateCoordinator | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusBar = new StatusBarController();
  const diagnosticOutput = vscode.window.createOutputChannel('TokenLens');
  let migrationQueue: Promise<void> = Promise.resolve();

  const runLegacyMigration = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted) return;

    const transition = migrationQueue.then(async () => {
      if (!vscode.workspace.isTrusted) return;

      const roots = fileWorkspaceRoots();
      const state = readMigrationState(context);
      const completed = new Set(state.completedWorkspaceRoots);
      const pending = roots.filter((root) => !completed.has(root));
      if (pending.length === 0) return;

      try {
        const result = await removeLegacyPromptHookArtifacts({
          workspaceRoots: pending,
        });
        result.roots.forEach(({ workspaceRoot }) => completed.add(workspaceRoot));
        await context.workspaceState.update(
          LEGACY_HOOK_REMOVAL_STATE_KEY,
          {
            version: LEGACY_HOOK_REMOVAL_MIGRATION_VERSION,
            completedWorkspaceRoots: [...completed].sort(),
          } satisfies LegacyHookRemovalMigrationState,
        );
        await context.workspaceState.update(
          LEGACY_ESTIMATE_GATE_STATE_KEY,
          false,
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'an unknown migration error';
        await vscode.window.showWarningMessage(
          `TokenLens 0.4 did not start a prompt bridge, but it could not safely remove an older project hook. Inspect the project hook files before deleting them. ${reason}`,
        );
      }
    });
    migrationQueue = transition.catch(() => undefined);
    await transition;
  };

  // Version 0.3.1's bridge is already gone from this extension. Cleanup runs
  // before the new observer starts, and every newly added file-workspace root
  // receives the same ownership-checked migration once.
  await runLegacyMigration();
  await migrateLegacyLiveEstimateSetting(context);

  const liveEstimateEnabled = (): boolean =>
    vscode.workspace
      .getConfiguration('tokenlens')
      .get<boolean>(LIVE_ESTIMATE_SETTING, false);

  const coordinator = new LiveEstimateCoordinator({
    helperPath: context.asAbsolutePath(HELPER_RELATIVE_PATH),
    platform: process.platform,
    architecture: process.arch,
    enabled: liveEstimateEnabled(),
    windowFocused: vscode.window.state.focused,
    onState: (state) => statusBar.render(state),
    onDiagnostic: (metadata) => {
      appendDiagnostic(diagnosticOutput, metadata);
    },
  });
  activeCoordinator = coordinator;

  const enableLiveEstimate = async (): Promise<void> => {
    if (liveEstimateEnabled()) {
      await coordinator.setEnabled(true);
      return;
    }
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      await vscode.window.showWarningMessage(
        'TokenLens live estimates currently require native Apple-silicon Cursor on macOS.',
      );
      return;
    }

    const selected = await vscode.window.showWarningMessage(
      'Enable TokenLens live prompt estimates?',
      {
        modal: true,
        detail:
          'macOS Accessibility permission can read broad UI content. TokenLens deliberately restricts itself to a positively identified Cursor chat field, counts Unicode characters in memory, and sends only the count to this extension. It never intercepts Enter, logs prompt text, uses the clipboard, or sends prompt data over a network.',
      },
      ENABLE_ACTION,
    );
    if (selected !== ENABLE_ACTION) return;

    await vscode.workspace
      .getConfiguration('tokenlens')
      .update(LIVE_ESTIMATE_SETTING, true, vscode.ConfigurationTarget.Global);
    await coordinator.setEnabled(true);
    await requestAccessibilityPermission(true);
  };

  const disableLiveEstimate = async (): Promise<void> => {
    await vscode.workspace
      .getConfiguration('tokenlens')
      .update(LIVE_ESTIMATE_SETTING, false, vscode.ConfigurationTarget.Global);
    await coordinator.setEnabled(false);
  };

  const requestAccessibilityPermission = async (
    privacyConfirmed = false,
  ): Promise<void> => {
    if (!liveEstimateEnabled()) {
      await vscode.window.showWarningMessage(
        'Enable TokenLens live estimates before requesting Accessibility permission.',
      );
      return;
    }
    if (!privacyConfirmed) {
      const selected = await vscode.window.showWarningMessage(
        'Allow TokenLens to request macOS Accessibility permission?',
        {
          modal: true,
          detail:
            'Accessibility permission is broad. TokenLens restricts itself to the positively identified Cursor chat field and sends only a character count to the extension.',
        },
        REQUEST_PERMISSION_ACTION,
      );
      if (selected !== REQUEST_PERMISSION_ACTION) return;
    }
    if (!(await coordinator.requestPermission())) {
      return;
    }

    const selected = await vscode.window.showInformationMessage(
      'If macOS does not show a permission prompt, add the TokenLens helper under Privacy & Security → Accessibility.',
      OPEN_ACCESSIBILITY_SETTINGS_ACTION,
    );
    if (selected === OPEN_ACCESSIBILITY_SETTINGS_ACTION) {
      await vscode.env.openExternal(
        vscode.Uri.parse(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        ),
      );
    }
  };

  const diagnoseLiveDraftDetection = async (): Promise<void> => {
    if (!liveEstimateEnabled()) {
      await vscode.window.showWarningMessage(
        'Enable TokenLens live estimates before running diagnostics.',
      );
      return;
    }
    diagnosticOutput.appendLine('TokenLens live-draft diagnostic requested.');
    diagnosticOutput.appendLine(
      'Only roles, DOM identifiers/classes, attribute names, and booleans are shown; AXValue is never included.',
    );
    diagnosticOutput.show(true);
    if (!(await coordinator.diagnose())) {
      diagnosticOutput.appendLine('The native helper is not currently available.');
    }
  };

  const showActions = async (): Promise<void> => {
    const actions: ActionItem[] = liveEstimateEnabled()
      ? [
          {
            label: '$(stop-circle) Disable live estimate',
            description: 'Stop the helper and leave Enter unchanged',
            command: 'tokenlens.disableLiveEstimate',
          },
          {
            label: '$(lock) Request Accessibility permission',
            description: 'Ask macOS to allow local Cursor chat observation',
            command: 'tokenlens.requestAccessibilityPermission',
          },
          {
            label: '$(tools) Diagnose live draft detection',
            description: 'Show metadata only—never prompt content',
            command: 'tokenlens.diagnoseLiveDraftDetection',
          },
        ]
      : [
          {
            label: '$(pulse) Enable live estimate',
            description: 'Update the chip while typing in Cursor chat',
            command: 'tokenlens.enableLiveEstimate',
          },
        ];

    const selected = await vscode.window.showQuickPick(actions, {
      title: 'TokenLens',
      placeHolder: 'Choose a live-estimate action',
    });
    if (selected !== undefined) {
      await vscode.commands.executeCommand(selected.command);
    }
  };

  context.subscriptions.push(
    statusBar,
    diagnosticOutput,
    vscode.commands.registerCommand(
      'tokenlens.enableLiveEstimate',
      enableLiveEstimate,
    ),
    vscode.commands.registerCommand(
      'tokenlens.disableLiveEstimate',
      disableLiveEstimate,
    ),
    vscode.commands.registerCommand(
      'tokenlens.requestAccessibilityPermission',
      () => requestAccessibilityPermission(),
    ),
    vscode.commands.registerCommand(
      'tokenlens.diagnoseLiveDraftDetection',
      diagnoseLiveDraftDetection,
    ),
    vscode.commands.registerCommand('tokenlens.showActions', showActions),
    vscode.window.onDidChangeWindowState(({ focused }) => {
      if (!focused) {
        coordinator.setWindowFocused(false);
        return;
      }
      void coordinator.setEnabled(liveEstimateEnabled()).then(() => {
        if (vscode.window.state.focused) coordinator.setWindowFocused(true);
      });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(LIVE_ESTIMATE_CONFIGURATION)) {
        void coordinator.setEnabled(liveEstimateEnabled());
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void runLegacyMigration();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void runLegacyMigration();
    }),
    {
      dispose: () => {
        if (activeCoordinator === coordinator) activeCoordinator = undefined;
        void coordinator.dispose();
      },
    },
  );

  await coordinator.start();
}

async function migrateLegacyLiveEstimateSetting(
  context: vscode.ExtensionContext,
): Promise<void> {
  const legacyValue = context.globalState.get<boolean>(
    LEGACY_LIVE_ESTIMATE_STATE_KEY,
  );
  const configuration = vscode.workspace.getConfiguration('tokenlens');
  const configuredValue = configuration.inspect<boolean>(
    LIVE_ESTIMATE_SETTING,
  )?.globalValue;
  if (configuredValue === undefined && legacyValue === true) {
    await configuration.update(
      LIVE_ESTIMATE_SETTING,
      true,
      vscode.ConfigurationTarget.Global,
    );
  }
  if (legacyValue !== undefined) {
    await context.globalState.update(LEGACY_LIVE_ESTIMATE_STATE_KEY, undefined);
  }
}

export async function deactivate(): Promise<void> {
  const coordinator = activeCoordinator;
  activeCoordinator = undefined;
  await coordinator?.dispose();
}

function fileWorkspaceRoots(): string[] {
  return (
    vscode.workspace.workspaceFolders
      ?.filter(({ uri }) => uri.scheme === 'file')
      .map(({ uri }) => uri.fsPath)
      .sort() ?? []
  );
}

function readMigrationState(
  context: vscode.ExtensionContext,
): LegacyHookRemovalMigrationState {
  const value = context.workspaceState.get<unknown>(
    LEGACY_HOOK_REMOVAL_STATE_KEY,
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== LEGACY_HOOK_REMOVAL_MIGRATION_VERSION ||
    !('completedWorkspaceRoots' in value) ||
    !Array.isArray(value.completedWorkspaceRoots) ||
    !value.completedWorkspaceRoots.every((root) => typeof root === 'string')
  ) {
    return {
      version: LEGACY_HOOK_REMOVAL_MIGRATION_VERSION,
      completedWorkspaceRoots: [],
    };
  }
  return {
    version: LEGACY_HOOK_REMOVAL_MIGRATION_VERSION,
    completedWorkspaceRoots: [...new Set(value.completedWorkspaceRoots)],
  };
}

function appendDiagnostic(
  output: vscode.OutputChannel,
  metadata: HelperDiagnosticMetadata,
): void {
  output.appendLine(JSON.stringify(metadata, undefined, 2));
}

interface ActionItem extends vscode.QuickPickItem {
  command: string;
}
