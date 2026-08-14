import * as vscode from 'vscode';
import { createEstimatorClient } from './client/clientFactory';
import type { MockScenario } from './client/mockFixtures';
import { estimateFailure } from './client/types';
import { buildEstimateRequest, type AccessMode, type EstimateRequest } from './contract';
import { EstimateSession, type EstimateViewState } from './estimateSession';
import {
  describeEndpointDestination,
  validateCapturedPrompt,
} from './promptCapture';
import {
  readTokenLensSettings,
  type TokenLensSettings,
} from './settings';
import { StatusBarController } from './ui/statusBarController';

const PREVIEW_PROMPT = 'TokenLens local Phase 1–4 preview request.';
const SEND_PROMPT_ACTION = 'Send prompt';

let activeSession: EstimateSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new StatusBarController();
  let viewState: EstimateViewState = { kind: 'idle' };

  const render = (state: EstimateViewState) => {
    viewState = state;
    const settings = readTokenLensSettings();
    statusBar.render(state, {
      model: settings.model,
      accessMode: settings.accessMode,
      estimatorMode: settings.estimatorMode,
    });
  };

  const session = new EstimateSession(render);
  activeSession = session;
  render(viewState);

  const estimatePrompt = async (capturedValue: string): Promise<void> => {
    let transientPrompt = capturedValue;
    let request: EstimateRequest | undefined;

    try {
      const validation = validateCapturedPrompt(transientPrompt);
      if (!validation.ok) {
        await vscode.window.showWarningMessage(validation.message);
        return;
      }
      transientPrompt = validation.prompt;

      const settings = readTokenLensSettings();
      try {
        request = buildEstimateRequest({
          prompt: transientPrompt,
          model: settings.model,
          accessMode: settings.accessMode,
          clientVersion: extensionVersion(context),
          ...(settings.budgetThreshold === undefined
            ? {}
            : { budgetThreshold: settings.budgetThreshold }),
        });
      } catch {
        const failure = estimateFailure(
          'invalid_request',
          'Check the configured model and estimate preferences.',
          false,
        );
        if (!failure.ok) {
          session.showFailure(failure.error);
        }
        return;
      }

      if (
        settings.estimatorMode === 'endpoint' &&
        !(await confirmEndpointSend(settings))
      ) {
        return;
      }

      const client = createEstimatorClient({
        mode: settings.estimatorMode,
        endpoint: settings.endpoint,
        mockScenario: settings.mockScenario,
        mockDelayMs: settings.mockDelayMs,
      });
      await session.run(client, request, settings.requestTimeoutMs);
    } finally {
      transientPrompt = '';
      request = undefined;
    }
  };

  const previewEstimate = async () => {
    await estimatePrompt(PREVIEW_PROMPT);
  };

  const estimateClipboardPrompt = async () => {
    let clipboardPrompt = '';
    try {
      clipboardPrompt = await vscode.env.clipboard.readText();
    } catch {
      await vscode.window.showErrorMessage(
        'TokenLens could not read the clipboard. No prompt was sent.',
      );
      return;
    }

    try {
      await estimatePrompt(clipboardPrompt);
    } finally {
      clipboardPrompt = '';
    }
  };

  const estimateSelectedText = async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.selection.isEmpty) {
      await vscode.window.showWarningMessage(
        'Select prompt text in an editor before running this command.',
      );
      return;
    }

    let selectedPrompt = editor.document.getText(editor.selection);
    try {
      await estimatePrompt(selectedPrompt);
    } finally {
      selectedPrompt = '';
    }
  };

  const estimateQuickInput = async () => {
    const settings = readTokenLensSettings();
    let inputPrompt = await vscode.window.showInputBox({
      title: 'TokenLens: Estimate Prompt',
      prompt:
        settings.estimatorMode === 'mock'
          ? 'Type or paste a prompt. It will remain local in mock mode.'
          : `Type or paste a prompt. You will confirm before it is sent to ${describeEndpointDestination(settings.endpoint)}.`,
      placeHolder: 'Enter the prompt to estimate',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const validation = validateCapturedPrompt(value);
        return validation.ok ? undefined : validation.message;
      },
    });

    if (inputPrompt === undefined) {
      return;
    }

    try {
      await estimatePrompt(inputPrompt);
    } finally {
      inputPrompt = undefined;
    }
  };

  const selectMockScenario = async () => {
    const selected = await vscode.window.showQuickPick(mockScenarioItems(), {
      title: 'TokenLens mock scenario',
      placeHolder: 'Choose the fixed fixture returned by the local mock',
    });
    if (selected === undefined) {
      return;
    }

    const configuration = vscode.workspace.getConfiguration('tokenlens');
    await configuration.update(
      'mockScenario',
      selected.scenario,
      vscode.ConfigurationTarget.Global,
    );

    if (selected.accessMode !== undefined) {
      await configuration.update(
        'accessMode',
        selected.accessMode,
        vscode.ConfigurationTarget.Global,
      );
    }
  };

  const selectEstimatorMode = async () => {
    const current = readTokenLensSettings().estimatorMode;
    const items: EstimatorModeItem[] = [
      {
        label: '$(beaker) Local mock',
        detail: 'Prompt text stays in the extension process.',
        ...(current === 'mock' ? { description: 'Current' } : {}),
        mode: 'mock',
      },
      {
        label: '$(cloud) Configured endpoint',
        detail: 'Every prompt send requires confirmation.',
        ...(current === 'endpoint' ? { description: 'Current' } : {}),
        mode: 'endpoint',
      },
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: 'TokenLens estimator mode',
      placeHolder: 'Choose where explicit estimate requests are sent',
    });
    if (selected !== undefined) {
      await vscode.workspace
        .getConfiguration('tokenlens')
        .update('estimatorMode', selected.mode, vscode.ConfigurationTarget.Global);
    }
  };

  const selectAccessMode = async () => {
    const current = readTokenLensSettings().accessMode;
    const items: AccessModeItem[] = [
      {
        label: 'Subscription',
        detail: 'Relative usage impact; not a per-prompt charge.',
        ...(current === 'subscription' ? { description: 'Current' } : {}),
        mode: 'subscription',
      },
      {
        label: 'Token-based API',
        detail: 'Predicted metered API cost range.',
        ...(current === 'api' ? { description: 'Current' } : {}),
        mode: 'api',
      },
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: 'TokenLens access mode',
      placeHolder: 'This is a user setting; TokenLens does not detect it',
    });
    if (selected !== undefined) {
      await vscode.workspace
        .getConfiguration('tokenlens')
        .update('accessMode', selected.mode, vscode.ConfigurationTarget.Global);
    }
  };

  const showActions = async () => {
    const settings = readTokenLensSettings();
    const actions: ActionItem[] = [
      {
        label: '$(clippy) Estimate clipboard prompt',
        description: 'Reads the clipboard only after this action',
        command: 'tokenlens.estimateClipboardPrompt',
      },
      ...(hasSelectedText()
        ? [
            {
              label: '$(selection) Estimate selected text',
              command: 'tokenlens.estimateSelectedText',
            } satisfies ActionItem,
          ]
        : []),
      {
        label: '$(edit) Type or paste a prompt',
        command: 'tokenlens.estimateQuickInput',
      },
      {
        label: '$(play) Preview with synthetic prompt',
        description: 'Uses fixed non-sensitive text',
        command: 'tokenlens.previewEstimate',
      },
      ...(session.isLoading
        ? [
            {
              label: '$(debug-stop) Cancel estimate',
              command: 'tokenlens.cancelEstimate',
            } satisfies ActionItem,
          ]
        : []),
      {
        label: '$(clear-all) Clear estimate',
        command: 'tokenlens.clearEstimate',
      },
      {
        label: '$(server-environment) Select estimator mode',
        description: settings.estimatorMode,
        action: selectEstimatorMode,
      },
      ...(settings.estimatorMode === 'mock'
        ? [
            {
              label: '$(beaker) Select mock scenario',
              description: settings.mockScenario,
              command: 'tokenlens.selectMockScenario',
            } satisfies ActionItem,
          ]
        : []),
      {
        label: '$(symbol-enum) Select access mode',
        description: settings.accessMode,
        action: selectAccessMode,
      },
      {
        label: '$(gear) Open TokenLens settings',
        description: settings.model,
        command: 'tokenlens.openSettings',
      },
    ];

    const selected = await vscode.window.showQuickPick(actions, {
      title: 'TokenLens',
      placeHolder: 'Choose an explicit prompt or settings action',
    });
    if (selected?.command !== undefined) {
      await vscode.commands.executeCommand(selected.command);
    } else if (selected?.action !== undefined) {
      await selected.action();
    }
  };

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('tokenlens.previewEstimate', previewEstimate),
    vscode.commands.registerCommand(
      'tokenlens.estimateClipboardPrompt',
      estimateClipboardPrompt,
    ),
    vscode.commands.registerCommand(
      'tokenlens.estimateSelectedText',
      estimateSelectedText,
    ),
    vscode.commands.registerCommand(
      'tokenlens.estimateQuickInput',
      estimateQuickInput,
    ),
    vscode.commands.registerCommand('tokenlens.selectMockScenario', selectMockScenario),
    vscode.commands.registerCommand('tokenlens.cancelEstimate', () => session.reset()),
    vscode.commands.registerCommand('tokenlens.clearEstimate', () => session.reset()),
    vscode.commands.registerCommand('tokenlens.showActions', showActions),
    vscode.commands.registerCommand('tokenlens.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'TokenLens'),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tokenlens')) {
        session.reset();
      }
    }),
    {
      dispose: () => session.dispose(),
    },
  );
}

export function deactivate(): void {
  activeSession?.dispose();
  activeSession = undefined;
}

async function confirmEndpointSend(settings: TokenLensSettings): Promise<boolean> {
  const destination = describeEndpointDestination(settings.endpoint);
  const modelLabel = safeSettingLabel(settings.model);
  const selected = await vscode.window.showWarningMessage(
    `Send this prompt to ${destination}?`,
    {
      modal: true,
      detail: `TokenLens will send the prompt with model “${modelLabel}” and ${accessModeLabel(settings.accessMode)} access mode. TokenLens does not store the prompt after the request completes.`,
    },
    SEND_PROMPT_ACTION,
  );
  return selected === SEND_PROMPT_ACTION;
}

function hasSelectedText(): boolean {
  const editor = vscode.window.activeTextEditor;
  return editor !== undefined && !editor.selection.isEmpty;
}

function accessModeLabel(accessMode: AccessMode): string {
  return accessMode === 'api' ? 'token-based API' : 'subscription';
}

function safeSettingLabel(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/g, ' ').trim();
  return singleLine === '' ? 'not configured' : singleLine.slice(0, 120);
}

interface ActionItem extends vscode.QuickPickItem {
  command?: string;
  action?: () => Promise<void>;
}

interface MockScenarioItem extends vscode.QuickPickItem {
  scenario: MockScenario;
  accessMode?: AccessMode;
}

interface EstimatorModeItem extends vscode.QuickPickItem {
  mode: 'mock' | 'endpoint';
}

interface AccessModeItem extends vscode.QuickPickItem {
  mode: AccessMode;
}

function mockScenarioItems(): MockScenarioItem[] {
  return [
    {
      label: 'Auto',
      description: 'Ready fixture matching the configured access mode',
      scenario: 'auto',
    },
    {
      label: 'API ready',
      description: 'Sets access mode to API',
      scenario: 'api-ready',
      accessMode: 'api',
    },
    {
      label: 'Subscription ready',
      description: 'Sets access mode to subscription',
      scenario: 'subscription-ready',
      accessMode: 'subscription',
    },
    {
      label: 'Over budget',
      description: 'Ready fixture with the warning flag set',
      scenario: 'over-budget',
    },
    {
      label: 'Unavailable',
      description: 'Validated ESTIMATOR_UNAVAILABLE response',
      scenario: 'unavailable',
    },
    {
      label: 'Malformed',
      description: 'Invalid response for parser testing',
      scenario: 'malformed',
    },
  ];
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const version = (context.extension.packageJSON as { version?: unknown }).version;
  return typeof version === 'string' && version.trim() !== '' ? version : '0.1.0';
}
