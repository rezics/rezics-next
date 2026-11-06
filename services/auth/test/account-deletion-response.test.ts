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

test('deletion execute confirmation matches the current handle when Access binds a reader', async () => {
  const workflows = { deleteAccount: async () => ({ accountId: 'original' }) } as unknown as ReturnType<
    typeof createAccountWorkflows
  >;
  const bound = {
    ...access,
    readDeletionHandle: async () => 'Caf\u00e9_Handle',
  };
  const transport = accountOperationTransport(
    service,
    workflows,
    async () => new Response(null, { status: 404 }),
    bound,
  );
  const execute = (confirmation: string) =>
    new Request('https://auth.test/account-operations/execute', {
      method: 'POST',
      headers: { origin: 'https://auth.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        operationKey: 'key',
        operation: { kind: 'delete', accountId: 'original' },
        reference,
        confirmation,
      }),
    });
  const refused = await transport(execute('incorrect confirmation'));
  expect(refused.status).toBe(403);
  expect(refused.headers.get('content-type')).toContain('application/problem+json');
  expect(await refused.json()).toEqual({ error: 'account_operation_denied', effect_status: 'not_applied' });
  const accepted = await transport(execute('cafe\u0301_handle'));
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get('content-type')).toContain('application/json');
  expect(await accepted.json()).toEqual({ accountId: 'original' });
  const omitted = await transport(request('execute'));
  expect(omitted.status).toBe(403);
  expect(await omitted.json()).toEqual({ error: 'account_operation_denied', effect_status: 'not_applied' });
  const handleless = accountOperationTransport(service, workflows, async () => new Response(null, { status: 404 }), {
    ...access,
    readDeletionHandle: async () => null,
  });
  const handlelessReply = await handleless(request('execute'));
  expect(handlelessReply.status).toBe(200);
  expect(await handlelessReply.json()).toEqual({ accountId: 'original' });
});
