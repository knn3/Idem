import { describe, expect, it } from 'vitest';
import {
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
  ProtocolError,
  type ClientMessage,
  type ServerMessage,
} from '../src/index.js';

const opId = (lamport: number, replica: string) => ({ lamport, replica });

describe('client messages round-trip', () => {
  const cases: ClientMessage[] = [
    { t: 'hello', docId: 'doc-1', replica: 'replica-a', sinceSeq: 0 },
    {
      t: 'ops',
      ops: [
        { kind: 'insert', id: opId(1, 'a'), originLeft: null, content: 'H' },
        { kind: 'delete', id: opId(2, 'a'), target: opId(1, 'a') },
      ],
    },
    { t: 'presence', anchor: opId(1, 'a'), focus: null },
  ];

  it.each(cases)('round-trips %o', (message) => {
    const wire = serializeMessage(message);
    expect(parseClientMessage(wire)).toEqual(message);
    // also accepts an already-parsed value, not just a JSON string
    expect(parseClientMessage(JSON.parse(wire))).toEqual(message);
  });
});

describe('server messages round-trip', () => {
  const cases: ServerMessage[] = [
    {
      t: 'welcome',
      snapshot: {
        seq: 5,
        items: [{ id: opId(1, 'a'), originLeft: null, content: 'X', deleted: false }],
      },
      ops: [],
      seq: 5,
    },
    {
      t: 'welcome',
      snapshot: null,
      ops: [{ kind: 'insert', id: opId(1, 'a'), originLeft: null, content: 'X' }],
      seq: 1,
    },
    {
      t: 'ops',
      ops: [{ kind: 'insert', id: opId(1, 'a'), originLeft: null, content: 'X' }],
      seq: 1,
    },
    {
      t: 'presence',
      peers: [{ replica: 'a', name: 'Ada', color: '#fff', anchor: null, focus: opId(3, 'a') }],
    },
    { t: 'error', code: 'invalid-client-message', message: 'bad op' },
  ];

  it.each(cases)('round-trips %o', (message) => {
    const wire = serializeMessage(message);
    expect(parseServerMessage(wire)).toEqual(message);
  });
});

describe('rejects malformed messages with a useful error', () => {
  it('unknown discriminant', () => {
    expect(() => parseClientMessage({ t: 'bogus' })).toThrow(ProtocolError);
  });

  it('missing field', () => {
    try {
      parseClientMessage({ t: 'hello', docId: 'doc-1' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe('invalid-client-message');
      expect((err as ProtocolError).message).toMatch(/replica/);
      expect((err as ProtocolError).message).toMatch(/sinceSeq/);
    }
  });

  it('wrong type', () => {
    expect(() => parseClientMessage({ t: 'presence', anchor: 'not-an-opid', focus: null })).toThrow(
      ProtocolError,
    );
  });

  it('insert content longer than one character', () => {
    expect(() =>
      parseClientMessage({
        t: 'ops',
        ops: [{ kind: 'insert', id: opId(1, 'a'), originLeft: null, content: 'ab' }],
      }),
    ).toThrow(ProtocolError);
  });

  it('malformed JSON string', () => {
    expect(() => parseClientMessage('{not json')).toThrow();
  });

  it('server error message with wrong discriminant on client side', () => {
    expect(() => parseClientMessage({ t: 'welcome', snapshot: null, ops: [], seq: 0 })).toThrow(
      ProtocolError,
    );
  });
});
