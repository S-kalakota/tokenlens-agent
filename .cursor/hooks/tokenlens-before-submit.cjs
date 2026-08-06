'use strict';

const { readFile } = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const BRIDGE_DIRECTORY_NAME = '.tokenlens';
const BRIDGE_REGISTRATION_NAME = 'bridge.json';
const SUBMITTED_PROMPT_PATH = '/v1/submitted-prompt';
const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES = 16 * 1024;
const BRIDGE_TIMEOUT_MS = 1_000;

async function main() {
  const input = await readHookInput();
  if (
    input === undefined ||
    (input.hook_event_name !== undefined &&
      input.hook_event_name !== 'beforeSubmitPrompt') ||
    typeof input.prompt !== 'string' ||
    input.prompt.trim().length === 0
  ) {
    return allowPrompt();
  }

  const registration = await findRegistration(input.workspace_roots);
  if (registration === undefined) {
    return allowPrompt();
  }

  return (await requestDecision(registration, input.prompt)) ?? allowPrompt();
}

async function readHookInput() {
  const chunks = [];
  let size = 0;
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_HOOK_INPUT_BYTES) {
      return undefined;
    }
    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(chunks.join(''));
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

async function findRegistration(workspaceRoots) {
  const roots = [
    process.cwd(),
    ...(Array.isArray(workspaceRoots)
      ? workspaceRoots.filter((root) => typeof root === 'string')
      : []),
  ];

  for (const root of new Set(roots)) {
    const registrationFile = path.join(
      root,
      BRIDGE_DIRECTORY_NAME,
      BRIDGE_REGISTRATION_NAME,
    );
    try {
      const value = JSON.parse(await readFile(registrationFile, 'utf8'));
      if (validRegistration(value)) {
        return value;
      }
    } catch {
      // The estimate gate is disabled or the extension is not running here.
    }
  }

  return undefined;
}

function validRegistration(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.version === 1 &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65_535 &&
    typeof value.token === 'string' &&
    /^[a-f0-9]{64}$/.test(value.token)
  );
}

async function requestDecision(registration, prompt) {
  const body = JSON.stringify({ prompt });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision) => {
      if (!settled) {
        settled = true;
        resolve(decision);
      }
    };
    const request = http.request(
      {
        host: '127.0.0.1',
        port: registration.port,
        path: SUBMITTED_PROMPT_PATH,
        method: 'POST',
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(undefined);
          return;
        }

        const chunks = [];
        let size = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_BRIDGE_RESPONSE_BYTES) {
            response.destroy();
            finish(undefined);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const decision = JSON.parse(chunks.join(''));
            finish(validDecision(decision) ? decision : undefined);
          } catch {
            finish(undefined);
          }
        });
        response.on('error', () => finish(undefined));
      },
    );

    request.setTimeout(BRIDGE_TIMEOUT_MS, () => {
      request.destroy();
      finish(undefined);
    });
    request.on('error', () => finish(undefined));
    request.end(body);
  });
}

function validDecision(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.continue === 'boolean' &&
    (value.user_message === undefined ||
      (typeof value.user_message === 'string' &&
        value.user_message.trim().length > 0 &&
        value.user_message.length <= 4_000))
  );
}

function allowPrompt() {
  return { continue: true };
}

main()
  .catch(() => allowPrompt())
  .then((decision) => {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  });
