export const LIVE_DRAFT_PROTOCOL_VERSION = 1 as const;

/** Maximum size of one complete JSONL frame, including its trailing LF. */
export const MAX_JSON_LINE_BYTES = 4 * 1024;
export const MAX_DRAFT_CHARACTERS = 1_000_000;

const MAX_JSON_PAYLOAD_BYTES = MAX_JSON_LINE_BYTES - 1;
export const MAX_DIAGNOSTIC_STRING_LENGTH = 1_024;
export const MAX_DIAGNOSTIC_PARENT_DEPTH = 8;
export const MAX_DIAGNOSTIC_CLASS_COUNT = 32;
export const MAX_DIAGNOSTIC_ATTRIBUTE_COUNT = 96;

export const HELPER_STATES = [
  'waiting-for-cursor',
  'waiting-for-chat',
  'draft-empty',
  'unsupported',
] as const;

export type HelperState = (typeof HELPER_STATES)[number];

export interface DiagnosticParentMetadata {
  role: string;
  subrole: string;
  identifier: string;
  domIdentifier: string;
  domClasses: string[];
}

export interface DiagnosticFocusedMetadata extends DiagnosticParentMetadata {
  valueAttributeSupported: boolean;
  attributeNames: string[];
  parents: DiagnosticParentMetadata[];
}

export interface HelperDiagnosticMetadata {
  trusted: boolean;
  frontmostIsCursor: boolean;
  focused?: DiagnosticFocusedMetadata;
  classifiedAsComposer?: boolean;
}

export type HelperMessage =
  | {
      version: typeof LIVE_DRAFT_PROTOCOL_VERSION;
      type: 'permission';
      trusted: boolean;
    }
  | {
      version: typeof LIVE_DRAFT_PROTOCOL_VERSION;
      type: 'state';
      state: HelperState;
      generation: number;
      observation: number;
    }
  | {
      version: typeof LIVE_DRAFT_PROTOCOL_VERSION;
      type: 'draft-length';
      characters: number;
      generation: number;
      observation: number;
    }
  | {
      version: typeof LIVE_DRAFT_PROTOCOL_VERSION;
      type: 'error';
      code: string;
      generation: number;
    }
  | {
      version: typeof LIVE_DRAFT_PROTOCOL_VERSION;
      type: 'diagnostic';
      metadata: HelperDiagnosticMetadata;
    };

export type HelperCommand =
  | {
      version: typeof LIVE_DRAFT_PROTOCOL_VERSION;
      command: 'set-active';
      active: boolean;
      generation: number;
    }
  | {
      version: typeof LIVE_DRAFT_PROTOCOL_VERSION;
      command: 'request-permission' | 'diagnose' | 'shutdown';
    };

export type ProtocolViolationCode =
  | 'decoder-failed'
  | 'invalid-command'
  | 'invalid-json'
  | 'invalid-message'
  | 'invalid-utf8'
  | 'line-too-large'
  | 'unterminated-line';

/** A prompt-safe protocol failure which never embeds helper output. */
export class ProtocolViolation extends Error {
  public override readonly name = 'ProtocolViolation';

  public constructor(public readonly code: ProtocolViolationCode) {
    super(protocolViolationMessage(code));
  }
}

/**
 * Incrementally frames helper stdout. A frame is accepted only when its JSON
 * payload plus the LF delimiter is at most 4 KiB. The decoder is permanently
 * failed after the first violation so bytes following malformed output cannot
 * be interpreted as trusted state.
 */
export class HelperMessageDecoder {
  private pending = Buffer.alloc(0);
  private failed = false;

  public push(chunk: Uint8Array | string): HelperMessage[] {
    this.assertUsable();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    const messages: HelperMessage[] = [];
    let offset = 0;

    try {
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline === -1) {
          this.append(bytes.subarray(offset));
          break;
        }

        this.append(bytes.subarray(offset, newline));
        messages.push(parseHelperMessageBytes(this.pending));
        this.pending = Buffer.alloc(0);
        offset = newline + 1;
      }
      return messages;
    } catch (error) {
      this.failed = true;
      this.pending = Buffer.alloc(0);
      throw error;
    }
  }

  public finish(): void {
    this.assertUsable();
    if (this.pending.length === 0) {
      return;
    }

    this.failed = true;
    this.pending = Buffer.alloc(0);
    throw new ProtocolViolation('unterminated-line');
  }

  private append(bytes: Uint8Array): void {
    if (this.pending.length + bytes.byteLength > MAX_JSON_PAYLOAD_BYTES) {
      throw new ProtocolViolation('line-too-large');
    }
    if (bytes.byteLength > 0) {
      this.pending = Buffer.concat([this.pending, bytes]);
    }
  }

  private assertUsable(): void {
    if (this.failed) {
      throw new ProtocolViolation('decoder-failed');
    }
  }
}

/** Parses a helper-to-extension JSON payload without its LF delimiter. */
export function parseHelperMessageLine(
  line: Uint8Array | string,
): HelperMessage {
  const bytes = typeof line === 'string' ? Buffer.from(line) : Buffer.from(line);
  if (bytes.byteLength > MAX_JSON_PAYLOAD_BYTES) {
    throw new ProtocolViolation('line-too-large');
  }
  return parseHelperMessageBytes(bytes);
}

/** Parses an extension-to-helper JSON payload without its LF delimiter. */
export function parseHelperCommandLine(
  line: Uint8Array | string,
): HelperCommand {
  const value = parseJsonLine(line);
  const command = parseHelperCommandValue(value);
  if (command === undefined) {
    throw new ProtocolViolation('invalid-command');
  }
  return command;
}

/** Encodes one strict command as a bounded LF-terminated JSONL frame. */
export function encodeHelperCommand(command: HelperCommand): string {
  const parsed = parseHelperCommandValue(command);
  if (parsed === undefined) {
    throw new ProtocolViolation('invalid-command');
  }

  const line = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(line) > MAX_JSON_LINE_BYTES) {
    throw new ProtocolViolation('line-too-large');
  }
  return line;
}

function parseHelperMessageBytes(bytes: Uint8Array): HelperMessage {
  const value = parseJsonBytes(bytes);
  const message = parseHelperMessageValue(value);
  if (message === undefined) {
    throw new ProtocolViolation('invalid-message');
  }
  return message;
}

function parseJsonLine(line: Uint8Array | string): unknown {
  const bytes = typeof line === 'string' ? Buffer.from(line) : Buffer.from(line);
  if (bytes.byteLength > MAX_JSON_PAYLOAD_BYTES) {
    throw new ProtocolViolation('line-too-large');
  }
  return parseJsonBytes(bytes);
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolViolation('invalid-utf8');
  }

  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new ProtocolViolation('invalid-json');
  }
}

function parseHelperMessageValue(value: unknown): HelperMessage | undefined {
  if (!isRecord(value) || value.version !== LIVE_DRAFT_PROTOCOL_VERSION) {
    return undefined;
  }

  switch (value.type) {
    case 'permission':
      return hasExactKeys(value, ['version', 'type', 'trusted']) &&
        typeof value.trusted === 'boolean'
        ? {
            version: LIVE_DRAFT_PROTOCOL_VERSION,
            type: 'permission',
            trusted: value.trusted,
          }
        : undefined;
    case 'state':
      return hasExactKeys(value, [
        'version',
        'type',
        'state',
        'generation',
        'observation',
      ]) &&
        isHelperState(value.state) &&
        isSequenceNumber(value.generation) &&
        isObservation(value.observation)
        ? {
            version: LIVE_DRAFT_PROTOCOL_VERSION,
            type: 'state',
            state: value.state,
            generation: value.generation,
            observation: value.observation,
          }
        : undefined;
    case 'draft-length':
      return hasExactKeys(value, [
        'version',
        'type',
        'characters',
        'generation',
        'observation',
      ]) &&
        isDraftCharacterCount(value.characters) &&
        isSequenceNumber(value.generation) &&
        isObservation(value.observation)
        ? {
            version: LIVE_DRAFT_PROTOCOL_VERSION,
            type: 'draft-length',
            characters: value.characters,
            generation: value.generation,
            observation: value.observation,
          }
        : undefined;
    case 'error':
      return hasExactKeys(value, ['version', 'type', 'code', 'generation']) &&
        isErrorCode(value.code) &&
        isSequenceNumber(value.generation)
        ? {
            version: LIVE_DRAFT_PROTOCOL_VERSION,
            type: 'error',
            code: value.code,
            generation: value.generation,
          }
        : undefined;
    case 'diagnostic': {
      if (!hasExactKeys(value, ['version', 'type', 'metadata'])) {
        return undefined;
      }
      const metadata = parseDiagnosticMetadata(value.metadata);
      return metadata === undefined
        ? undefined
        : {
            version: LIVE_DRAFT_PROTOCOL_VERSION,
            type: 'diagnostic',
            metadata,
          };
    }
    default:
      return undefined;
  }
}

function parseHelperCommandValue(value: unknown): HelperCommand | undefined {
  if (
    !isRecord(value) ||
    value.version !== LIVE_DRAFT_PROTOCOL_VERSION ||
    typeof value.command !== 'string'
  ) {
    return undefined;
  }

  if (value.command === 'set-active') {
    return hasExactKeys(value, [
      'version',
      'command',
      'active',
      'generation',
    ]) &&
      typeof value.active === 'boolean' &&
      isSequenceNumber(value.generation)
      ? {
          version: LIVE_DRAFT_PROTOCOL_VERSION,
          command: 'set-active',
          active: value.active,
          generation: value.generation,
        }
      : undefined;
  }

  if (
    value.command === 'request-permission' ||
    value.command === 'diagnose' ||
    value.command === 'shutdown'
  ) {
    return hasExactKeys(value, ['version', 'command'])
      ? {
          version: LIVE_DRAFT_PROTOCOL_VERSION,
          command: value.command,
        }
      : undefined;
  }

  return undefined;
}

function parseDiagnosticMetadata(
  value: unknown,
): HelperDiagnosticMetadata | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'trusted',
      'frontmostIsCursor',
      'focused',
      'classifiedAsComposer',
    ]) ||
    !hasRequiredKeys(value, ['trusted', 'frontmostIsCursor']) ||
    typeof value.trusted !== 'boolean' ||
    typeof value.frontmostIsCursor !== 'boolean'
  ) {
    return undefined;
  }

  const hasFocused = Object.hasOwn(value, 'focused');
  const hasClassification = Object.hasOwn(value, 'classifiedAsComposer');
  if (hasFocused !== hasClassification) {
    return undefined;
  }

  if (!hasFocused) {
    return {
      trusted: value.trusted,
      frontmostIsCursor: value.frontmostIsCursor,
    };
  }

  const focused = parseFocusedMetadata(value.focused);
  if (focused === undefined || typeof value.classifiedAsComposer !== 'boolean') {
    return undefined;
  }

  return {
    trusted: value.trusted,
    frontmostIsCursor: value.frontmostIsCursor,
    focused,
    classifiedAsComposer: value.classifiedAsComposer,
  };
}

function parseFocusedMetadata(
  value: unknown,
): DiagnosticFocusedMetadata | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'role',
      'subrole',
      'identifier',
      'domIdentifier',
      'domClasses',
      'valueAttributeSupported',
      'attributeNames',
      'parents',
    ]) ||
    !isDiagnosticString(value.role) ||
    !isDiagnosticString(value.subrole) ||
    !isDiagnosticString(value.identifier) ||
    !isDiagnosticString(value.domIdentifier) ||
    !isDiagnosticStringArray(value.domClasses, MAX_DIAGNOSTIC_CLASS_COUNT) ||
    typeof value.valueAttributeSupported !== 'boolean' ||
    !isDiagnosticStringArray(
      value.attributeNames,
      MAX_DIAGNOSTIC_ATTRIBUTE_COUNT,
    ) ||
    !Array.isArray(value.parents) ||
    value.parents.length > MAX_DIAGNOSTIC_PARENT_DEPTH
  ) {
    return undefined;
  }

  const parents: DiagnosticParentMetadata[] = [];
  for (const parentValue of value.parents) {
    const parent = parseParentMetadata(parentValue);
    if (parent === undefined) {
      return undefined;
    }
    parents.push(parent);
  }

  return {
    role: value.role,
    subrole: value.subrole,
    identifier: value.identifier,
    domIdentifier: value.domIdentifier,
    domClasses: value.domClasses,
    valueAttributeSupported: value.valueAttributeSupported,
    attributeNames: value.attributeNames,
    parents,
  };
}

function parseParentMetadata(
  value: unknown,
): DiagnosticParentMetadata | undefined {
  return isRecord(value) &&
    hasExactKeys(value, [
      'role',
      'subrole',
      'identifier',
      'domIdentifier',
      'domClasses',
    ]) &&
    isDiagnosticString(value.role) &&
    isDiagnosticString(value.subrole) &&
    isDiagnosticString(value.identifier) &&
    isDiagnosticString(value.domIdentifier) &&
    isDiagnosticStringArray(value.domClasses, MAX_DIAGNOSTIC_CLASS_COUNT)
    ? {
        role: value.role,
        subrole: value.subrole,
        identifier: value.identifier,
        domIdentifier: value.domIdentifier,
        domClasses: value.domClasses,
      }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function isHelperState(value: unknown): value is HelperState {
  return (
    typeof value === 'string' &&
    (HELPER_STATES as readonly string[]).includes(value)
  );
}

function isDraftCharacterCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DRAFT_CHARACTERS
  );
}

function isObservation(value: unknown): value is number {
  return isSequenceNumber(value);
}

function isSequenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z][a-z0-9-]{0,63}$/.test(value)
  );
}

function isDiagnosticString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_DIAGNOSTIC_STRING_LENGTH
  );
}

function isDiagnosticStringArray(
  value: unknown,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumLength &&
    value.every(isDiagnosticString)
  );
}

function protocolViolationMessage(code: ProtocolViolationCode): string {
  switch (code) {
    case 'decoder-failed':
      return 'The helper protocol decoder has already failed.';
    case 'invalid-command':
      return 'The helper command does not match the protocol.';
    case 'invalid-json':
      return 'The helper emitted invalid JSON.';
    case 'invalid-message':
      return 'The helper emitted an unsupported message.';
    case 'invalid-utf8':
      return 'The helper emitted invalid UTF-8.';
    case 'line-too-large':
      return 'The helper emitted an oversized protocol line.';
    case 'unterminated-line':
      return 'The helper exited with an unterminated protocol line.';
  }
}
