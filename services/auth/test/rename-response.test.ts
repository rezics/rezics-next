import { expect, test } from 'bun:test';
import {
  parseRenameApprovalResponse,
  parseRenameExecutionResponse,
  RENAME_APPROVAL_MAX_RESPONSE_BYTES,
  RENAME_EXECUTION_MAX_RESPONSE_BYTES,
} from '@rezics/auth-contract';
import { seal } from '../../kernel/src/tokens/seal.ts';
import { accountOperationTransport } from '../src/account-operations-transport.ts';

test('the real Access seal and canonical expiry fit the browser projection without treating a reference as a UUID', () => {
  const reference = seal({ current: 255, keys: new Map([[255, new Uint8Array(32)]]) }, 'access.workflow-approval.v1', {
    route: 123,
    id: '00000000-0000-4000-8000-000000000001',
    binding: 'a'.repeat(64),
  });
  const value = { reference, expiresAt: new Date(Date.now() + 300000).toISOString() };
  expect(parseRenameApprovalResponse(value)).toEqual(value);
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(RENAME_APPROVAL_MAX_RESPONSE_BYTES);
  expect(parseRenameApprovalResponse({ ...value, reference: reference + '\n' })).toBeNull();
  const result = { accountId: '\0'.repeat(4096) };
  expect(parseRenameExecutionResponse(result)).toEqual(result);
  expect(Buffer.byteLength(JSON.stringify(result))).toBe(RENAME_EXECUTION_MAX_RESPONSE_BYTES);
});

test('rename projection refuses invalid approval before execute and leaves incompatible completion unknown; unrelated routing is unchanged', async () => {
  type Service = Parameters<typeof accountOperationTransport>[0];
  type Workflows = Parameters<typeof accountOperationTransport>[1];
  type Access = NonNullable<Parameters<typeof accountOperationTransport>[3]>;
  const approval = { reference: 'AQ.' + 'a'.repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString() };
  let nativeApproval: unknown = approval,
    result: unknown = { accountId: 'opaque' },
    calls = 0;
  const transport = accountOperationTransport(
    {
      verifier: { issuer: 'https://auth.test' },
      internal: {
        withFreshHuman: async (_: unknown, fn: (proof: unknown) => unknown) => fn({}),
        accessTokenForProof: async () => 'native',
      },
    } as unknown as Service,
    {
      renameHandle: async () => {
        calls++;
        return result;
      },
      createOrganization: async () => result,
    } as unknown as Workflows,
    async () => new Response(null, { status: 404 }),
    {
      context: () => ({ pool: null, deadline: 123 }),
      approve: async () => nativeApproval,
      resolveForCaller: async () => {},
      admitGroup: async () => true,
    } as Access,
  );
  const send = (phase: string, kind = 'rename') =>
    transport(
      new Request(`https://auth.test/account-operations/${phase}`, {
        method: 'POST',
        headers: { origin: 'https://auth.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationKey: 'key',
          operation:
            kind === 'rename'
              ? { kind, accountId: 'opaque', handle: 'after', expectedHandle: 'before' }
              : { kind, handle: 'org' },
          ...(phase === 'execute' ? { reference: approval.reference } : {}),
        }),
      }),
    );
  expect(await (await send('approve')).json()).toEqual(approval);
  for (let replay = 0; replay < 2; replay++)
    expect(await (await send('execute')).json()).toEqual({ accountId: 'opaque' });
  for (result of [
    { accountId: 'opaque', expired: true },
    { accountId: 'other' },
    { accountId: 'opaque', extra: true },
  ]) {
    const response = await send('execute');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  }
  nativeApproval = { ...approval, reference: 'invalid' };
  const before = calls;
  expect((await send('approve')).status).toBe(503);
  expect(calls).toBe(before);
  expect(await (await send('approve', 'organization')).json()).toEqual(nativeApproval);
  expect(await (await send('execute', 'organization')).json()).toEqual(result);
});
