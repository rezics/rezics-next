import { expect, test } from 'bun:test';
import { accountOperationTransport } from '../src/account-operations-transport.ts';

test('transfer native seam closes incompatible producer output without asserting not_applied after workflow entry', async () => {
  const issuer = 'https://transfer.auth.test';
  const subject = '00000000-0000-7000-8000-000000000001';
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (proof: unknown) => Promise<unknown>) => work({}),
      accessTokenForProof: async () => 'native',
    },
  } as unknown as Parameters<typeof accountOperationTransport>[0];
  const operation = {
    kind: 'transfer',
    previous: { subjectAccountId: subject },
    expectedVersion: '1',
    operatorAccountId: subject,
    acceptance: 'acceptance',
  };
  for (const result of [
    { accountId: subject, expired: true },
    { accountId: subject, pending: true },
    { accountId: subject, extra: 'private' },
    { accountId: 'other' },
  ]) {
    const workflows = { transferOperator: async () => result } as unknown as Parameters<
      typeof accountOperationTransport
    >[1];
    const transport = accountOperationTransport(service, workflows, async () => new Response(), {
      context: () => ({ pool: null, deadline: 0 }),
      approve: async () => ({ reference: 'reference', expiresAt: new Date().toISOString() }),
      resolveForCaller: async () => ({}),
      admitGroup: async () => true,
    });
    const response = await transport(
      new Request(`${issuer}/account-operations/execute`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ operationKey: 'key', operation, reference: 'reference' }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'account_operation_unavailable' });
  }
});
