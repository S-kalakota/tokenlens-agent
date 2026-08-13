import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_ORDER } from '../src/features/validation.mjs';

const GATE = fileURLToPath(new URL('../scripts/gate.mjs', import.meta.url));

let home;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'tokenlens-home-'));
});

/** Drives the hook exactly the way Claude Code does: JSON in, decision out. */
function runHook(payload, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [GATE], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'),
        TOKENLENS_HOME: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      resolve({
        code,
        durationMs: performance.now() - startedAt,
        stderr,
        stdout: trimmed,
        decision: trimmed === '' ? null : JSON.parse(trimmed),
      });
    });

    child.stdin.end(stdin ?? JSON.stringify(payload));
  });
}

const submit = (prompt, extra = {}) => ({
  session_id: 'session-under-test',
  hook_event_name: 'UserPromptSubmit',
  cwd: '/tmp',
  prompt,
  ...extra,
});

describe('the gate as Claude Code runs it', () => {
  it('pauses the first submission and sends the second unchanged one', async () => {
    const prompt = 'rewrite the billing module';

    const first = await runHook(submit(prompt));
    expect(first.code).toBe(0);
    expect(first.decision.decision).toBe('block');
    expect(first.decision.reason).toContain('TokenLens paused this prompt');
    expect(first.decision.reason).toMatch(/Estimated cost\s+\$/);

    const second = await runHook(submit(prompt));
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('');
    expect(second.decision).toBeNull();

    const log = await readFile(path.join(home, 'logs', 'ml-features.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
  });

  it('pauses again after the prompt is edited', async () => {
    await runHook(submit('rewrite the billing module'));
    const edited = await runHook(submit('rewrite the billing module carefully'));
    expect(edited.decision.decision).toBe('block');

    const log = await readFile(path.join(home, 'logs', 'ml-features.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(2);
  });

  it('keeps sessions independent', async () => {
    const prompt = 'shared text';
    await runHook(submit(prompt, { session_id: 'session-a' }));
    const other = await runHook(submit(prompt, { session_id: 'session-b' }));
    expect(other.decision.decision).toBe('block');
  });

  it('turns itself off and on without reaching the model', async () => {
    const off = await runHook(submit('tokenlens off'));
    expect(off.decision.decision).toBe('block');
    expect(off.decision.reason).toContain('now OFF');

    const passed = await runHook(submit('this should sail straight through'));
    expect(passed.decision).toBeNull();

    const on = await runHook(submit('tokenlens on'));
    expect(on.decision.reason).toContain('now ON');

    const gated = await runHook(submit('this should be paused again'));
    expect(gated.decision.decision).toBe('block');
  });

  it('reports status without changing anything', async () => {
    const status = await runHook(submit('tokenlens status'));
    expect(status.decision.reason).toContain('TokenLens gate is ON');
  });

  it('lets slash commands and empty prompts through', async () => {
    expect((await runHook(submit('/clear'))).decision).toBeNull();
    expect((await runHook(submit('   '))).decision).toBeNull();
  });

  it('ignores events that are not UserPromptSubmit', async () => {
    const other = await runHook(submit('anything', { hook_event_name: 'Stop' }));
    expect(other.decision).toBeNull();
  });

  it('fails open on malformed input rather than blocking the user', async () => {
    for (const stdin of ['', 'not json at all', '[]', '{"prompt": 42}']) {
      const result = await runHook(null, { stdin });
      expect(result.code, `stdin: ${stdin}`).toBe(0);
      expect(result.decision, `stdin: ${stdin}`).toBeNull();
    }
  });

  it('stores prompt text only in the explicit feature log', async () => {
    const prompt = 'my-feature-inspection-prompt';
    await runHook(submit(prompt));

    const pending = path.join(home, 'pending');
    const files = await readdir(pending);
    expect(files).toHaveLength(1);
    const stored = await readFile(path.join(pending, files[0]), 'utf8');
    expect(stored).not.toContain(prompt);
    expect(JSON.parse(stored).fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const log = await readFile(path.join(home, 'logs', 'ml-features.jsonl'), 'utf8');
    const record = JSON.parse(log.trim());
    expect(record.prompt).toBe(prompt);
    expect(Object.keys(record.features)).toEqual(FEATURE_ORDER);
    expect(Object.keys(record.features)).toHaveLength(14);
    expect(record).not.toHaveProperty('cwd');
    expect(record).not.toHaveProperty('transcript_path');
  });

  it('fails open with clean stdout when pending state cannot be written', async () => {
    const notDirectory = path.join(home, 'not-a-directory');
    await writeFile(notDirectory, 'occupied', 'utf8');
    home = notDirectory;

    const result = await runHook(submit('this cannot persist pending state'));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.decision).toBeNull();
    expect(result.stderr).toContain('TokenLens skipped this prompt after an internal error.');
  });

  it('handles a literal @ mention fixture within Claude Code\'s hook timeout', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'tokenlens-hook-at-'));
    await writeFile(path.join(workspace, 'parser.ts'), 'export const parser = true;\n', 'utf8');
    const result = await runHook(
      submit('Refactor @parser.ts and return a concise patch.', { cwd: workspace }),
    );
    expect(result.decision?.decision).toBe('block');
    expect(result.durationMs).toBeLessThan(10_000);
  });
});
