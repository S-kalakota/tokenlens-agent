import { describe, expect, it } from 'vitest';
import {
  encodeHelperCommand,
  HelperMessageDecoder,
  LIVE_DRAFT_PROTOCOL_VERSION,
  MAX_DIAGNOSTIC_ATTRIBUTE_COUNT,
  MAX_DIAGNOSTIC_CLASS_COUNT,
  MAX_DIAGNOSTIC_PARENT_DEPTH,
  MAX_DIAGNOSTIC_STRING_LENGTH,
  MAX_DRAFT_CHARACTERS,
  MAX_JSON_LINE_BYTES,
  parseHelperCommandLine,
  parseHelperMessageLine,
  ProtocolViolation,
  type HelperCommand,
  type DiagnosticFocusedMetadata,
  type HelperMessage,
} from '../src/liveDraft/protocol';

const permissionMessage: HelperMessage = {
  version: LIVE_DRAFT_PROTOCOL_VERSION,
  type: 'permission',
  trusted: true,
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function expectViolation(
  action: () => unknown,
  code: ProtocolViolation['code'],
): void {
  try {
    action();
    throw new Error('Expected a protocol violation.');
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation);
    expect((error as ProtocolViolation).code).toBe(code);
  }
}

function diagnosticWith(
  overrides: Partial<DiagnosticFocusedMetadata>,
): HelperMessage {
  return {
    version: 1,
    type: 'diagnostic',
    metadata: {
      trusted: true,
      frontmostIsCursor: true,
      focused: {
        role: 'AXTextArea',
        subrole: '',
        identifier: '',
        domIdentifier: '',
        domClasses: ['aislash-editor-input'],
        valueAttributeSupported: true,
        attributeNames: ['AXValue'],
        parents: [],
        ...overrides,
      },
      classifiedAsComposer: true,
    },
  };
}

describe('live draft helper protocol', () => {
  it.each<HelperMessage>([
    permissionMessage,
    {
      version: 1,
      type: 'permission',
      trusted: false,
    },
    {
      version: 1,
      type: 'state',
      state: 'waiting-for-cursor',
      generation: 0,
      observation: 0,
    },
    {
      version: 1,
      type: 'state',
      state: 'waiting-for-chat',
      generation: 2,
      observation: 4,
    },
    {
      version: 1,
      type: 'state',
      state: 'draft-empty',
      generation: 2,
      observation: 4,
    },
    {
      version: 1,
      type: 'state',
      state: 'unsupported',
      generation: 3,
      observation: 5,
    },
    {
      version: 1,
      type: 'draft-length',
      characters: MAX_DRAFT_CHARACTERS,
      generation: Number.MAX_SAFE_INTEGER,
      observation: Number.MAX_SAFE_INTEGER,
    },
    {
      version: 1,
      type: 'error',
      code: 'cursor-observer-unavailable',
      generation: 2,
    },
    {
      version: 1,
      type: 'diagnostic',
      metadata: {
        trusted: true,
        frontmostIsCursor: true,
        focused: {
          role: 'AXTextArea',
          subrole: '',
          identifier: 'chat-input',
          domIdentifier: '',
          domClasses: ['aislash-editor-input'],
          valueAttributeSupported: true,
          attributeNames: ['AXDOMClassList', 'AXValue'],
          parents: [
            {
              role: 'AXGroup',
              subrole: '',
              identifier: 'composer',
              domIdentifier: '',
              domClasses: ['composer-input-blur-wrapper'],
            },
          ],
        },
        classifiedAsComposer: true,
      },
    },
  ])('accepts a strict $type helper message', (message) => {
    expect(parseHelperMessageLine(json(message))).toEqual(message);
  });

  it.each([
    { ...permissionMessage, version: 2 },
    { ...permissionMessage, type: 'unknown' },
    { ...permissionMessage, prompt: 'private prompt' },
    { ...permissionMessage, text: 'private prompt' },
    {
      version: 1,
      type: 'state',
      state: 'draft-empty',
      generation: 1,
      observation: -1,
    },
    {
      version: 1,
      type: 'state',
      state: 'other',
      generation: 1,
      observation: 1,
    },
    {
      version: 1,
      type: 'state',
      state: 'draft-empty',
      generation: -1,
      observation: 1,
    },
    {
      version: 1,
      type: 'draft-length',
      characters: -1,
      generation: 1,
      observation: 1,
    },
    {
      version: 1,
      type: 'draft-length',
      characters: 1.5,
      generation: 1,
      observation: 1,
    },
    {
      version: 1,
      type: 'draft-length',
      characters: MAX_DRAFT_CHARACTERS + 1,
      generation: 1,
      observation: 1,
    },
    {
      version: 1,
      type: 'draft-length',
      characters: 1,
      generation: 1,
      observation: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      version: 1,
      type: 'error',
      code: 'Error with unsafe details',
      generation: 1,
    },
    {
      version: 1,
      type: 'diagnostic',
      metadata: {
        trusted: true,
        frontmostIsCursor: true,
        prompt: 'private prompt',
      },
    },
    {
      version: 1,
      type: 'diagnostic',
      metadata: {
        trusted: true,
        frontmostIsCursor: true,
        focused: {
          role: 'AXTextArea',
          subrole: '',
          identifier: 'chat-input',
          domIdentifier: '',
          domClasses: ['aislash-editor-input'],
          valueAttributeSupported: true,
          attributeNames: ['AXValue'],
          parents: [],
          text: 'private prompt',
        },
        classifiedAsComposer: true,
      },
    },
  ])('rejects unknown, unsafe, or invalid helper data', (message) => {
    expectViolation(
      () => parseHelperMessageLine(json(message)),
      'invalid-message',
    );
  });

  it('accepts each diagnostic metadata field at its native/TypeScript boundary', () => {
    const parent = {
      role: 'AXGroup',
      subrole: '',
      identifier: '',
      domIdentifier: '',
      domClasses: [],
    };
    const messages = [
      diagnosticWith({
        identifier: 'x'.repeat(MAX_DIAGNOSTIC_STRING_LENGTH),
      }),
      diagnosticWith({
        domClasses: Array.from(
          { length: MAX_DIAGNOSTIC_CLASS_COUNT },
          () => 'x',
        ),
      }),
      diagnosticWith({
        attributeNames: Array.from(
          { length: MAX_DIAGNOSTIC_ATTRIBUTE_COUNT },
          () => 'x',
        ),
      }),
      diagnosticWith({
        parents: Array.from(
          { length: MAX_DIAGNOSTIC_PARENT_DEPTH },
          () => parent,
        ),
      }),
    ];

    for (const message of messages) {
      expect(parseHelperMessageLine(json(message))).toEqual(message);
    }
  });

  it('rejects diagnostic metadata beyond every native/TypeScript boundary', () => {
    const parent = {
      role: 'AXGroup',
      subrole: '',
      identifier: '',
      domIdentifier: '',
      domClasses: [],
    };
    const messages = [
      diagnosticWith({
        identifier: 'x'.repeat(MAX_DIAGNOSTIC_STRING_LENGTH + 1),
      }),
      diagnosticWith({
        domClasses: Array.from(
          { length: MAX_DIAGNOSTIC_CLASS_COUNT + 1 },
          () => 'x',
        ),
      }),
      diagnosticWith({
        attributeNames: Array.from(
          { length: MAX_DIAGNOSTIC_ATTRIBUTE_COUNT + 1 },
          () => 'x',
        ),
      }),
      diagnosticWith({
        parents: Array.from(
          { length: MAX_DIAGNOSTIC_PARENT_DEPTH + 1 },
          () => parent,
        ),
      }),
    ];

    for (const message of messages) {
      expectViolation(
        () => parseHelperMessageLine(json(message)),
        'invalid-message',
      );
    }
  });

  it('frames partial and multiple stdout messages incrementally', () => {
    const decoder = new HelperMessageDecoder();
    const first = `${json(permissionMessage)}\n`;
    const second: HelperMessage = {
      version: 1,
      type: 'draft-length',
      characters: 42,
      generation: 2,
      observation: 7,
    };
    const combined = Buffer.from(`${first}${json(second)}\n`);

    expect(decoder.push(combined.subarray(0, 9))).toEqual([]);
    expect(decoder.push(combined.subarray(9))).toEqual([
      permissionMessage,
      second,
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('accepts exactly 4 KiB including LF and permanently rejects larger frames', () => {
    const exactDecoder = new HelperMessageDecoder();
    const payload = json(permissionMessage).padEnd(
      MAX_JSON_LINE_BYTES - 1,
      ' ',
    );
    const exactFrame = `${payload}\n`;
    expect(Buffer.byteLength(exactFrame)).toBe(MAX_JSON_LINE_BYTES);
    expect(exactDecoder.push(exactFrame)).toEqual([permissionMessage]);

    const oversizedDecoder = new HelperMessageDecoder();
    const oversizedFrame = `${payload} \n`;
    expect(Buffer.byteLength(oversizedFrame)).toBe(MAX_JSON_LINE_BYTES + 1);
    expectViolation(
      () => oversizedDecoder.push(oversizedFrame),
      'line-too-large',
    );
    expectViolation(
      () => oversizedDecoder.push(`${json(permissionMessage)}\n`),
      'decoder-failed',
    );
  });

  it('rejects invalid UTF-8 and an unterminated final frame safely', () => {
    const invalidUtf8 = new HelperMessageDecoder();
    expectViolation(
      () => invalidUtf8.push(Buffer.from([0xff, 0x0a])),
      'invalid-utf8',
    );

    const unterminated = new HelperMessageDecoder();
    expect(unterminated.push(json(permissionMessage))).toEqual([]);
    expectViolation(() => unterminated.finish(), 'unterminated-line');
  });

  it.each<HelperCommand>([
    { version: 1, command: 'set-active', active: true, generation: 1 },
    { version: 1, command: 'set-active', active: false, generation: 2 },
    { version: 1, command: 'request-permission' },
    { version: 1, command: 'diagnose' },
    { version: 1, command: 'shutdown' },
  ])('encodes and parses the strict $command command', (command) => {
    const line = encodeHelperCommand(command);
    expect(line.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_JSON_LINE_BYTES);
    expect(parseHelperCommandLine(line.slice(0, -1))).toEqual(command);
  });

  it('requires a safe activation generation on set-active', () => {
    for (const generation of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const command = {
        version: 1,
        command: 'set-active',
        active: true,
        ...(generation === undefined ? {} : { generation }),
      };
      expectViolation(
        () => parseHelperCommandLine(json(command)),
        'invalid-command',
      );
    }
  });

  it('rejects extra prompt or text fields in extension commands', () => {
    for (const forbidden of ['prompt', 'text']) {
      const command = {
        version: 1,
        command: 'diagnose',
        [forbidden]: 'private prompt',
      } as unknown as HelperCommand;
      expectViolation(() => encodeHelperCommand(command), 'invalid-command');
    }
  });

  it('never places rejected helper output in protocol errors', () => {
    const secret = 'private prompt that must not escape';
    try {
      parseHelperMessageLine(
        json({ ...permissionMessage, prompt: secret }),
      );
      throw new Error('Expected a protocol violation.');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
