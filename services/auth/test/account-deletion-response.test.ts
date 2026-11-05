import { expect, test } from 'bun:test';
import { accountOperationTransport, type AccountOperationAccess } from '../src/account-operations-transport';
import type { AuthService } from '../src/index';
import type { createAccountWorkflows } from '../src/workflows';
const reference = 'A'.repeat(4052) + '.' + 'a'.repeat(43);
const approval = { reference, expiresAt: new Date(Date.now() + 60000).toISOString() };
const service = {
  verifier: { issuer: 'https://auth.test' },
  internal: {
    withFreshHuman: async (_: unknown, use: (proof: unknown) => unknown) => use({}),
    accessTokenForProof: async () => 'native-token',
  },
} as unknown as AuthService;
const access = {
  context: () => ({}),
  approve: async () => approval,
  resolveForCaller: async () => ({}),
} as unknown as AccountOperationAccess;
const request = (phase: string, operation = { kind: 'delete', accountId: 'original' }) =>
  new Request(`https://auth.test/account-operations/${phase}`, {
    method: 'POST',
    headers: { origin: 'https://auth.test', 'content-type': 'application/json' },
    body: JSON.stringify({ operationKey: 'key', operation, ...(phase === 'execute' ? { reference } : {}) }),
  });
test('deletion projects finite exact native success/replay and never fabricates not_applied after dispatch', async () => {
  for (const result of [
    { accountId: 'original' },
    { accountId: 'wrong' },
    { accountId: 'original', extra: true },
    { accountId: 'original', expired: true },
    undefined,
    new Error('after commit'),
  ]) {
    const workflows = {
      deleteAccount: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as ReturnType<typeof createAccountWorkflows>;
    const transport = accountOperationTransport(
      service,
      workflows,
      async () => new Response(null, { status: 404 }),
      access,
    );
    for (let replay = 0; replay < 2; replay++) {
      const reply = await transport(request('execute'));
      expect(reply.status).toBe(
        result && !(result instanceof Error) && Object.keys(result).length === 1 && result.accountId === 'original'
          ? 200
          : 503,
      );
      expect(await reply.json()).toEqual(reply.status === 200 ? { accountId: 'original' } : { error: 'unavailable' });
    }
    const approved = await transport(request('approve'));
    expect(await approved.json()).toEqual(approval);
    const invalid = accountOperationTransport(service, workflows, async () => new Response(), {
      ...access,
      approve: async () => ({ ...approval, reference: '' }),
    });
    expect(await (await invalid(request('approve'))).json()).toEqual({ error: 'unavailable' });
  }
});
