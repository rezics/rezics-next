import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { extendLoan, returnLoan, submitLoan } from '../src/library/loans-read';

const client = {} as KernelClient;
const request = new Request('https://site.test/en/library/loans');

test('loan writes validate copy identity, calendar days and named counterparties at the boundary', async () => {
  const copyId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const loanId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
  const key = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
  expect(await submitLoan(client, request, {}, null)).toEqual({ ok: false, reason: 'invalid' });
  expect(
    await submitLoan(client, request, {}, {
      copyId,
      copyRevision: 1,
      direction: 'lent',
      counterparty: { kind: 'name', name: '   ' },
      startedOn: '2026-11-06',
      idempotencyKey: key,
    }),
  ).toEqual({ ok: false, reason: 'invalid' });
  expect(
    await submitLoan(client, request, {}, {
      copyId,
      copyRevision: 1,
      direction: 'lent',
      counterparty: { kind: 'name', name: 'Ada' },
      startedOn: '2026-02-30',
      idempotencyKey: key,
    }),
  ).toEqual({ ok: false, reason: 'invalid' });
  expect(await extendLoan(client, request, {}, { loanId, revision: 1, dueOn: '2026-13-01', idempotencyKey: key })).toEqual(
    { ok: false, reason: 'invalid' },
  );
  expect(
    await returnLoan(client, request, {}, { loanId, revision: 0, returnedOn: '2026-11-06', idempotencyKey: key }),
  ).toEqual({ ok: false, reason: 'invalid' });
});
