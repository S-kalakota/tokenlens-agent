import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_DIRECTORY_NAME,
  BRIDGE_REGISTRATION_NAME,
  SUBMITTED_PROMPT_PATH,
  SubmittedPromptBridge,
  type SubmittedPromptDecision,
} from '../src/automaticPrompt/submittedPromptBridge';
import {
  blockedPromptMessage,
  estimatePromptByLength,
} from '../src/simpleEstimator';

interface Registration {
  version: number;
  port: number;
  token: string;
}

const hookScript = fileURLToPath(
  new URL('../.cursor/hooks/tokenlens-before-submit.cjs', import.meta.url),
);

const temporaryRoots: string[] = [];
const bridges: SubmittedPromptBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(async (bridge) => bridge.stop()));
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe('SubmittedPromptBridge', () => {
  it('registers the forwarding script as a project beforeSubmitPrompt hook', async () => {
    const raw = await readFile(
      fileURLToPath(new URL('../.cursor/hooks.json', import.meta.url)),
      'utf8',
    );
    const config = JSON.parse(raw) as {
      version?: unknown;
      hooks?: { beforeSubmitPrompt?: Array<{ command?: unknown }> };
    };

    expect(config.version).toBe(1);
    expect(config.hooks?.beforeSubmitPrompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'node .cursor/hooks/tokenlens-before-submit.cjs',
        }),
      ]),
    );
  });

  it('accepts an authenticated loopback prompt without persisting it', async () => {
    const root = await temporaryRoot();
    const received: string[] = [];
    const bridge = await startedBridge(root, (prompt) => {
      received.push(prompt);
      return blockedDecision(prompt);
    });
    const { registration, raw } = await readRegistration(root);
    const prompt = 'Estimate this submitted side-chat prompt.';

    expect(raw).not.toContain(prompt);
    const response = await fetch(
      `http://127.0.0.1:${registration.port}${SUBMITTED_PROMPT_PATH}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(blockedDecision(prompt));
    expect(received).toEqual([prompt]);
    expect(await readFile(registrationPath(root), 'utf8')).not.toContain(prompt);

    await bridge.stop();
    await expect(
      readFile(registrationPath(root), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a request that does not have the per-session secret', async () => {
    const root = await temporaryRoot();
    const received: string[] = [];
    await startedBridge(root, (prompt) => {
      received.push(prompt);
      return blockedDecision(prompt);
    });
    const { registration } = await readRegistration(root);

    const response = await fetch(
      `http://127.0.0.1:${registration.port}${SUBMITTED_PROMPT_PATH}`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer not-the-bridge-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'Do not accept this.' }),
      },
    );

    expect(response.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('receives Cursor beforeSubmitPrompt input through the project hook', async () => {
    const root = await temporaryRoot();
    const received: string[] = [];
    await startedBridge(root, (submittedPrompt) => {
      received.push(submittedPrompt);
      return blockedDecision(submittedPrompt);
    });
    const prompt = 'Automatically recalculate this prompt.';

    const result = await runHook(root, {
      hook_event_name: 'beforeSubmitPrompt',
      prompt,
      model: 'example-model',
      attachments: [{ type: 'file', file_path: '/not-forwarded.txt' }],
      workspace_roots: [root],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(blockedDecision(prompt));
    expect(received).toEqual([prompt]);
  });

  it('fails open when the extension bridge is not running', async () => {
    const root = await temporaryRoot();

    const result = await runHook(root, {
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'Cursor should still submit this prompt.',
      workspace_roots: [root],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  it('fails open when local estimation cannot return a decision', async () => {
    const root = await temporaryRoot();
    await startedBridge(root, () => {
      throw new Error('test failure');
    });

    const result = await runHook(root, {
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'Cursor should not be blocked by an estimator failure.',
      workspace_roots: [root],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokenlens-bridge-test-'));
  temporaryRoots.push(root);
  return root;
}

async function startedBridge(
  root: string,
  onPrompt: (
    prompt: string,
  ) => SubmittedPromptDecision | Promise<SubmittedPromptDecision>,
): Promise<SubmittedPromptBridge> {
  const bridge = new SubmittedPromptBridge({
    workspaceRoots: [root],
    onPrompt,
  });
  bridges.push(bridge);
  await bridge.start();
  return bridge;
}

function blockedDecision(prompt: string): SubmittedPromptDecision {
  return {
    continue: false,
    user_message: blockedPromptMessage(estimatePromptByLength(prompt)),
  };
}

async function readRegistration(
  root: string,
): Promise<{ registration: Registration; raw: string }> {
  const raw = await readFile(registrationPath(root), 'utf8');
  return { registration: JSON.parse(raw) as Registration, raw };
}

function registrationPath(root: string): string {
  return join(root, BRIDGE_DIRECTORY_NAME, BRIDGE_REGISTRATION_NAME);
}

async function runHook(
  root: string,
  input: Record<string, unknown>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
