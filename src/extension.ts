import * as vscode from 'vscode';
import {
  SubmittedPromptBridge,
  type SubmittedPromptDecision,
} from './automaticPrompt/submittedPromptBridge';
import { blockedPromptMessage, estimatePromptByLength } from './simpleEstimator';
import { StatusBarController } from './ui/statusBarController';
import type { EstimateViewState } from './viewState';

const ENABLE_GATE_ACTION = 'Enable estimate gate';
const ESTIMATE_GATE_STATE_KEY = 'enterToEstimateGateV1';

let activePromptBridge: SubmittedPromptBridge | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusBar = new StatusBarController();
  let viewState: EstimateViewState = { kind: 'idle' };
  let promptBridge: SubmittedPromptBridge | undefined;
  let promptBridgeRootsKey = '';
  let bridgeTransition: Promise<void> = Promise.resolve();
  let bridgeDisposed = false;

  const estimateGateEnabled = (): boolean =>
    context.workspaceState.get<boolean>(ESTIMATE_GATE_STATE_KEY, false);

  const render = (): void => {
    statusBar.render(viewState, { gateEnabled: estimateGateEnabled() });
  };

  const handleSubmittedPrompt = (prompt: string): SubmittedPromptDecision => {
    const estimate = estimatePromptByLength(prompt);
    viewState = { kind: 'blocked', estimate };
    render();
    return {
      continue: false,
      user_message: blockedPromptMessage(estimate),
    };
  };

  const synchronizePromptBridge = async (): Promise<void> => {
    const roots = fileWorkspaceRoots();
    const nextRootsKey =
      estimateGateEnabled() && vscode.workspace.isTrusted && roots.length > 0
        ? roots.join('\u0000')
        : '';

    if (
      nextRootsKey !== '' &&
      nextRootsKey === promptBridgeRootsKey &&
      promptBridge !== undefined
    ) {
      return;
    }

    const previousBridge = promptBridge;
    promptBridge = undefined;
    promptBridgeRootsKey = '';
    if (activePromptBridge === previousBridge) {
      activePromptBridge = undefined;
    }
    await previousBridge?.stop();

    if (bridgeDisposed || nextRootsKey === '') {
      return;
    }

    const nextBridge = new SubmittedPromptBridge({
      workspaceRoots: roots,
      onPrompt: handleSubmittedPrompt,
    });
    await nextBridge.start();

    if (bridgeDisposed) {
      await nextBridge.stop();
      return;
    }

    promptBridge = nextBridge;
    promptBridgeRootsKey = nextRootsKey;
    activePromptBridge = nextBridge;
  };

  const queuePromptBridgeSync = async (): Promise<boolean> => {
    const transition = bridgeTransition.then(synchronizePromptBridge);
    bridgeTransition = transition.catch(() => {
      // Keep later transitions usable; the caller reports this failure.
    });
    try {
      await transition;
      return true;
    } catch {
      await vscode.window.showWarningMessage(
        'TokenLens could not start the estimate gate. Cursor prompts will continue normally.',
      );
      return false;
    }
  };

  const enableEstimateGate = async (): Promise<void> => {
    if (estimateGateEnabled()) {
      if (await queuePromptBridgeSync()) {
        await vscode.window.showInformationMessage(
          'The TokenLens estimate gate is already enabled. Pressing Enter stops the prompt before the Agent runs.',
        );
      }
      return;
    }

    if (fileWorkspaceRoots().length === 0) {
      await vscode.window.showWarningMessage(
        'Open a project folder before enabling the TokenLens estimate gate.',
      );
      return;
    }

    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        'Trust this workspace before enabling its Cursor prompt hook.',
      );
      return;
    }

    const selected = await vscode.window.showWarningMessage(
      'Enable the TokenLens Enter-to-estimate gate?',
      {
        modal: true,
        detail:
          'While enabled, every side-chat prompt is stopped before the Agent runs. Cursor shows one local dollar estimate based only on prompt length. Disable the gate when you want prompts to run normally.',
      },
      ENABLE_GATE_ACTION,
    );
    if (selected !== ENABLE_GATE_ACTION) {
      return;
    }

    await context.workspaceState.update(ESTIMATE_GATE_STATE_KEY, true);
    viewState = { kind: 'idle' };
    if (!(await queuePromptBridgeSync())) {
      await context.workspaceState.update(ESTIMATE_GATE_STATE_KEY, false);
    }
    render();
  };

  const disableEstimateGate = async (): Promise<void> => {
    await context.workspaceState.update(ESTIMATE_GATE_STATE_KEY, false);
    await queuePromptBridgeSync();
    viewState = { kind: 'idle' };
    render();
    await vscode.window.showInformationMessage(
      'The TokenLens estimate gate is disabled. Cursor prompts will run normally.',
    );
  };

  const clearEstimate = (): void => {
    viewState = { kind: 'idle' };
    render();
  };

  const showActions = async (): Promise<void> => {
    const actions: ActionItem[] = [
      estimateGateEnabled()
        ? {
            label: '$(stop-circle) Disable estimate gate',
            description: 'Allow Cursor prompts to run normally',
            command: 'tokenlens.disableEstimateGate',
          }
        : {
            label: '$(shield) Enable Enter-to-estimate gate',
            description: 'Stop each submitted prompt and show its estimate',
            command: 'tokenlens.enableEstimateGate',
          },
      ...(viewState.kind === 'blocked'
        ? [
            {
              label: '$(clear-all) Clear last estimate',
              command: 'tokenlens.clearEstimate',
            } satisfies ActionItem,
          ]
        : []),
    ];

    const selected = await vscode.window.showQuickPick(actions, {
      title: 'TokenLens',
      placeHolder: 'Choose an estimate-gate action',
    });
    if (selected !== undefined) {
      await vscode.commands.executeCommand(selected.command);
    }
  };

  render();
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand(
      'tokenlens.enableEstimateGate',
      enableEstimateGate,
    ),
    vscode.commands.registerCommand(
      'tokenlens.disableEstimateGate',
      disableEstimateGate,
    ),
    vscode.commands.registerCommand('tokenlens.clearEstimate', clearEstimate),
    vscode.commands.registerCommand('tokenlens.showActions', showActions),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void queuePromptBridgeSync();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void queuePromptBridgeSync();
    }),
    {
      dispose: () => {
        bridgeDisposed = true;
        const bridge = promptBridge;
        promptBridge = undefined;
        void bridge?.stop();
      },
    },
  );

  await queuePromptBridgeSync();
}

export async function deactivate(): Promise<void> {
  const bridge = activePromptBridge;
  activePromptBridge = undefined;
  await bridge?.stop();
}

function fileWorkspaceRoots(): string[] {
  return (
    vscode.workspace.workspaceFolders
      ?.filter(({ uri }) => uri.scheme === 'file')
      .map(({ uri }) => uri.fsPath)
      .sort() ?? []
  );
}

interface ActionItem extends vscode.QuickPickItem {
  command: string;
}
