import { expect, test } from 'bun:test';
import type { KernelClient, LoanMutation } from '@rezics/client';
import { extendLoan, returnLoan, submitLoan } from '../src/library/loans-read';

const client = {} as KernelClient;
const request = new Request('https://site.test/en/library/loans');
const authorized = new Request('https://site.test/en/library/loans', {
  headers: { authorization: 'Bearer owner' },
});
const mutation = {
  loan: {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
    copyId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    direction: 'lent',
    counterparty: { kind: 'name', name: 'Ada' },
    startedOn: '2026-11-01',
    dueOn: '2026-11-08',
    returnedOn: '2026-11-06',
    revision: 2,
    state: 'returned',
    viewer: { state: 'owner' },
    actions: {
      extend: { allowed: false, reason: 'returned' },
      return: { allowed: false, reason: 'returned' },
    },
  },
  boundary: { calendar: 'gregorian', zone: 'UTC', today: '2026-11-06' },
} satisfies LoanMutation;

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

test('loan return posts the mounted copy-loans return path rather than an AIP-136 colon method', async () => {
  const loanId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
  const paths: string[] = [];
  const kernel = {
    'copy-loans': Object.assign(
      (params: { loanId: string }) => ({
        patch: async () => {
          throw new Error(`unexpected patch for ${params.loanId}`);
        },
        return: {
          post: async (body: { revision: number; returnedOn: string }) => {
            paths.push(`POST /v1/copy-loans/${params.loanId}/return`);
            expect(body).toEqual({ revision: 1, returnedOn: '2026-11-06' });
            return {
              data: mutation,
              error: null,
              status: 200,
              headers: new Headers(),
              response: new Response(),
            };
          },
        },
      }),
      {
        get: async () => {
          throw new Error('unexpected list');
        },
        post: async () => {
          throw new Error('unexpected create');
        },
      },
    ),
  } as KernelClient;
  const result = await returnLoan(kernel, authorized, {}, {
    loanId,
    revision: 1,
    returnedOn: '2026-11-06',
    idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  });
  expect(paths).toEqual([`POST /v1/copy-loans/${loanId}/return`]);
  expect(result).toEqual({ ok: true, loan: mutation.loan, boundary: mutation.boundary });
});
