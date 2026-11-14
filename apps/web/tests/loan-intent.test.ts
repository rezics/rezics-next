import { expect, test } from 'bun:test';
import { LoanCommandIntent, type LoanCommand, type LoanIntent, type LoansOrigin } from '../src/library/loan-intent';
import type { LoanWriteResult } from '../src/library/loans-read';
import { illustrativeLoan, loanStoryBoundary } from '../src/kernel/fake/loans';

const command: LoanCommand = {
  operation: 'create',
  input: {
    copyId: 'copy-exact',
    copyRevision: 9,
    direction: 'lent',
    counterparty: { kind: 'name', name: '  Same text 雪  ' },
    startedOn: '2026-11-01',
    dueOn: '2026-11-20',
  },
};
function scope() {
  let token = 'original';
  let active = true;
  const origin: LoansOrigin = { isCurrent: () => active, headers: () => ({ 'x-csrf-token': token }) };
  return {
    origin,
    rotate: () => {
      token = 'replacement';
    },
    retire: () => {
      active = false;
    },
  };
}

test('lost create acknowledgement retries original key, copy revision, text, dates and credential', async () => {
  const visit = scope();
  const calls: { intent: LoanIntent; token: string | null }[] = [];
  const machine = new LoanCommandIntent(
    visit.origin,
    async (intent, headers) => {
      calls.push({ intent, token: new Headers(headers).get('x-csrf-token') });
      if (calls.length === 1) throw new Error('acknowledgement lost');
      return { ok: false, reason: 'conflict' };
    },
    () => 'original-key',
  );
  const draft = structuredClone(command);
  await machine.start(draft);
  draft.input.startedOn = '2026-11-02';
  await machine.start(draft);
  await machine.retry();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[1]!.intent.input).toEqual(command.input);
  expect(machine.snapshot().phase).toBe('uncertain');
  machine.correct();
  expect(machine.snapshot().phase).toBe('uncertain');
});

test.each(['extend', 'return'] as const)(
  '%s replay keeps the original loan revision after a later refusal',
  async (operation) => {
    const calls: LoanIntent[] = [];
    const machine = new LoanCommandIntent(
      scope().origin,
      async (intent) => {
        calls.push(intent);
        return { ok: false, reason: calls.length === 1 ? 'unavailable' : 'forbidden' };
      },
      () => 'same-key',
    );
    await machine.start(
      operation === 'extend'
        ? { operation, input: { loanId: 'exact-loan', revision: 4, dueOn: '2026-12-01' } }
        : { operation, input: { loanId: 'exact-loan', revision: 4, returnedOn: '2026-11-14' } },
    );
    await machine.retry();
    expect(calls[1]).toEqual(calls[0]);
    expect(machine.snapshot().phase).toBe('uncertain');
  },
);

test('only a definitive first refusal permits corrected input with a new key', async () => {
  let keys = 0;
  const calls: LoanIntent[] = [];
  const machine = new LoanCommandIntent(
    scope().origin,
    async (intent) => {
      calls.push(intent);
      return { ok: false, reason: 'invalid' };
    },
    () => `key-${++keys}`,
  );
  await machine.start(command);
  expect(machine.snapshot().phase).toBe('refused');
  machine.correct();
  await machine.start({ ...command, input: { ...command.input, startedOn: '2026-11-02' } });
  expect(calls.map((call) => call.idempotencyKey)).toEqual(['key-1', 'key-2']);
});

test.each(['rotate', 'retire'] as const)('%s prevents retry and late receipt effects', async (change) => {
  const visit = scope();
  let finish!: (result: LoanWriteResult) => void;
  let calls = 0;
  const machine = new LoanCommandIntent(visit.origin, () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = machine.start(command);
  await machine.start(command);
  expect(calls).toBe(1);
  visit[change]();
  finish({ ok: true, loan: illustrativeLoan(), boundary: loanStoryBoundary });
  await pending;
  await machine.retry();
  expect(calls).toBe(1);
  expect(machine.snapshot().phase).toBe('retired');
});

test('unmount closes an in-flight visit before its receipt arrives', async () => {
  let finish!: (result: LoanWriteResult) => void;
  const machine = new LoanCommandIntent(
    scope().origin,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const unmount = machine.mount();
  const pending = machine.start(command);
  unmount();
  finish({ ok: true, loan: illustrativeLoan(), boundary: loanStoryBoundary });
  await pending;
  expect(machine.snapshot().phase).toBe('retired');
});
