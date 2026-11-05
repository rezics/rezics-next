import { expect, test } from 'bun:test';
import type { OpeningInput } from '../src/operator-session-opening';
import { readOpenedSession } from '../src/operator-session-opening';
import { managementOperationProfile } from '../src/management-operations';

const subject = '33333333-3333-4333-8333-333333333333';
const input: OpeningInput = {
  accountId: '11111111-1111-4111-8111-111111111111',
  operationKey: 'readback-only',
  operation: {
    kind: 'opening',
    operatorAccountId: '22222222-2222-4222-8222-222222222222',
    subjectAccountId: subject,
  },
};

test('one explicit session readback makes one native read and no approval or opening request', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((path) => {
    calls.push(String(path));
    return Promise.resolve(
      Response.json({
        account_id: input.operation.subjectAccountId,
        client_id: managementOperationProfile('opening').client_id,
        scope: ['subject:read'],
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['operator'],
      }),
    );
  }) as typeof fetch;
  try {
    expect((await readOpenedSession(input)).kind).toBe('opened');
    expect(calls).toEqual(['/session']);
  } finally {
    globalThis.fetch = original;
  }
});

test('readback deadline covers hung headers and body; retirement cancels the call before and after it starts', async () => {
  const original = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((_path, init) => {
    signals.push(init?.signal as AbortSignal);
    return signals.length === 1
      ? new Promise<Response>(() => {})
      : Promise.resolve({ status: 200, json: () => new Promise<never>(() => {}) } as Response);
  }) as typeof fetch;
  try {
    const results = await Promise.all([readOpenedSession(input), readOpenedSession(input)]);
    expect(results.map((result) => result.kind)).toEqual(['unknown', 'unknown']);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    const retiredBeforeStart = new AbortController();
    retiredBeforeStart.abort();
    expect((await readOpenedSession(input, retiredBeforeStart.signal)).kind).toBe('unknown');
    expect(signals).toHaveLength(2);

    const retiredDuringRead = new AbortController();
    const late = Promise.withResolvers<Response>();
    globalThis.fetch = ((_path, init) => {
      signals.push(init?.signal as AbortSignal);
      return late.promise;
    }) as typeof fetch;
    const result = readOpenedSession(input, retiredDuringRead.signal);
    await Promise.resolve();
    await Promise.resolve();
    retiredDuringRead.abort();
    expect((await result).kind).toBe('unknown');
    expect(signals[2]!.aborted).toBe(true);
    late.resolve(Response.json({ account_id: subject }));
  } finally {
    globalThis.fetch = original;
  }
});
