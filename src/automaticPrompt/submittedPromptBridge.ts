import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { MAX_PROMPT_LENGTH } from '../simpleEstimator';

export const BRIDGE_DIRECTORY_NAME = '.tokenlens';
export const BRIDGE_REGISTRATION_NAME = 'bridge.json';
export const SUBMITTED_PROMPT_PATH = '/v1/submitted-prompt';

const BRIDGE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = MAX_PROMPT_LENGTH * 6 + 1_024;

interface BridgeRegistration {
  version: typeof BRIDGE_VERSION;
  port: number;
  token: string;
}

export interface SubmittedPromptDecision {
  continue: boolean;
  user_message?: string;
}

export interface SubmittedPromptBridgeOptions {
  workspaceRoots: readonly string[];
  onPrompt: (
    prompt: string,
  ) => SubmittedPromptDecision | Promise<SubmittedPromptDecision>;
}

/**
 * Receives submitted Cursor prompts from the project hook over authenticated
 * loopback HTTP. The registration file contains connection metadata only;
 * prompt text is never written to disk.
 */
export class SubmittedPromptBridge {
  private readonly token = randomBytes(32).toString('hex');
  private server: Server | undefined;
  private registrationFiles: string[] = [];
  private stopPromise: Promise<void> | undefined;

  public constructor(private readonly options: SubmittedPromptBridgeOptions) {}

  public async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    const workspaceRoots = [...new Set(this.options.workspaceRoots)];
    if (workspaceRoots.length === 0) {
      throw new Error('A file-system workspace is required for the prompt bridge.');
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    try {
      await listenOnLoopback(server);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('TokenLens could not determine its loopback port.');
      }

      const registration: BridgeRegistration = {
        version: BRIDGE_VERSION,
        port: address.port,
        token: this.token,
      };
      for (const root of workspaceRoots) {
        this.registrationFiles.push(await writeRegistration(root, registration));
      }
      this.server = server;
    } catch (error) {
      server.close();
      await this.removeRegistrations();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      server.closeAllConnections();
      await closeServer(server);
    }
    await this.removeRegistrations();
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== SUBMITTED_PROMPT_PATH) {
      respond(response, 404);
      return;
    }

    if (!authorized(request.headers.authorization, this.token)) {
      respond(response, 401);
      return;
    }

    const body = await readRequestBody(request);
    if (body === undefined) {
      respond(response, 413);
      return;
    }

    const prompt = parsePrompt(body);
    if (prompt === undefined) {
      respond(response, 400);
      return;
    }

    let decision: SubmittedPromptDecision;
    try {
      decision = await this.options.onPrompt(prompt);
    } catch {
      respond(response, 500);
      return;
    }

    if (!validDecision(decision)) {
      respond(response, 500);
      return;
    }

    respondJson(response, 200, decision);
  }

  private async removeRegistrations(): Promise<void> {
    const files = this.registrationFiles;
    this.registrationFiles = [];
    await Promise.all(
      files.map(async (registrationFile) => {
        if (!(await registrationBelongsToBridge(registrationFile, this.token))) {
          return;
        }

        try {
          await unlink(registrationFile);
        } catch {
          return;
        }

        try {
          await rmdir(dirname(registrationFile));
        } catch {
          // Preserve the directory if it contains any user-owned files.
        }
      }),
    );
  }
}

async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function writeRegistration(
  workspaceRoot: string,
  registration: BridgeRegistration,
): Promise<string> {
  const directory = join(workspaceRoot, BRIDGE_DIRECTORY_NAME);
  const destination = join(directory, BRIDGE_REGISTRATION_NAME);
  const temporary = join(
    directory,
    `${BRIDGE_REGISTRATION_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(registration)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, destination);
  return destination;
}

async function registrationBelongsToBridge(
  registrationFile: string,
  token: string,
): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(registrationFile, 'utf8'));
    return (
      typeof value === 'object' &&
      value !== null &&
      'token' in value &&
      value.token === token
    );
  } catch {
    return false;
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined) {
    return false;
  }

  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readRequestBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        request.destroy();
        return undefined;
      }
      chunks.push(buffer);
    }
  } catch {
    return undefined;
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parsePrompt(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('prompt' in value) ||
      typeof value.prompt !== 'string' ||
      value.prompt.trim().length === 0 ||
      value.prompt.length > MAX_PROMPT_LENGTH
    ) {
      return undefined;
    }
    return value.prompt;
  } catch {
    return undefined;
  }
}

function validDecision(value: unknown): value is SubmittedPromptDecision {
  return (
    typeof value === 'object' &&
    value !== null &&
    'continue' in value &&
    typeof value.continue === 'boolean' &&
    (!('user_message' in value) ||
      value.user_message === undefined ||
      (typeof value.user_message === 'string' &&
        value.user_message.trim().length > 0 &&
        value.user_message.length <= 4_000))
  );
}

function respond(response: ServerResponse, statusCode: number): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-length': '0',
  });
  response.end();
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  value: SubmittedPromptDecision,
): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
