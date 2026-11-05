import { expect, test } from 'bun:test';
import { AccessRecovery } from '../src/accounts/resource-access/recovery';
import {
  parseOwnerTransfer,
  transferableOwner,
  transferOwner,
  type OwnerTransfer,
} from '../src/accounts/resource-access/owner-transfer.ts';
import type { AccessSnapshot, AccessState, AccessIO } from '../src/accounts/resource-access/data';
import { snapshot, managerId, readerId } from '../src/stories/pages/accounts-resource-access/fixtures';

const owner = 'community.realm.owner';
function realm(): AccessSnapshot {
  return {
    ...structuredClone(snapshot),
    resource: { ...snapshot.resource, type: 'community.realm' },
    roles: [{ id: owner, actions: ['realm:read', 'realm:manage', 'access:grant'], delegable: true }],
    grants: [
      {
        ...snapshot.grants[0]!,
        kind: 'role',
        role: owner,
        subject: { kind: 'account', id: managerId },
        actions: ['realm:read', 'realm:manage', 'access:grant'],
      },
    ],
  };
}
const intent = (page = realm()): OwnerTransfer =>
  parseOwnerTransfer({
    kind: 'realm-owner-transfer',
    resource: { route: page.resource.route, id: page.resource.id },
    fromAccountId: managerId,
    toAccountId: readerId,
    previousValid: page.grants[0]!.valid,
    key: crypto.randomUUID(),
  });
const saved = (input: OwnerTransfer) => ({
  roleGrant: {
    resource: input.resource,
    subject: { kind: 'account', id: readerId },
    role: owner,
    valid: '[2026-10-31,)',
  },
});

test('only an actual current manageable direct Realm owner and delegable owner role offers transfer', () => {
  const page = realm();
  const grant = page.grants[0]!;
  expect(transferableOwner(page, grant)).toBe(true);
  for (const other of [
    snapshot,
    { ...page, mutationState: 'realm_guard_unavailable' as const },
    { ...page, roles: page.roles.map((role) => ({ ...role, delegable: false })) },
  ])
    expect(transferableOwner(other, grant)).toBe(false);
  for (const other of [
    { ...grant, state: 'scheduled' as const },
    { ...grant, manageable: false },
    { ...grant, subject: { kind: 'realm' as const, id: managerId, role: 'owner' as const } },
    { ...grant, kind: 'direct' as const },
    { ...grant, role: 'community.realm.member' },
  ])
    expect(transferableOwner(page, other)).toBe(false);
  expect(() => parseOwnerTransfer({ ...intent(), toAccountId: managerId })).toThrow();
  expect(() => parseOwnerTransfer({ ...intent(), callerIsOwner: true })).toThrow();
});

test('real local transfer wire uses the original interval, header key, current credential and receipt session for private readback', async () => {
  const input = intent();
  const reads: (string | undefined)[] = [];
  const page = realm();
  let calls = 0;
  const result = await transferOwner(
    'https://kernel.test',
    'Bearer current',
    input,
    async (session) => {
      reads.push(session);
      return { status: 'ready', page };
    },
    (async (url, init) => {
      calls++;
      const request = new Request(url, init);
      expect(request.url).toBe('https://kernel.test/v1/roleGrants:transferRealmOwner');
      expect(request.headers.get('authorization')).toBe('Bearer current');
      expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(input.key));
      expect(await request.json()).toEqual({
        resource: input.resource,
        fromAccountId: managerId,
        toAccountId: readerId,
        previousValid: input.previousValid,
      });
      expect(init?.cache).toBe('no-store');
      return Response.json(saved(input), { headers: { 'rezics-session-token': 'native-version' } });
    }) as typeof fetch,
  );
  expect(calls).toBe(1);
  expect(reads).toEqual([undefined, 'native-version']);
  expect(result).toEqual({ status: 'saved', current: { status: 'ready', page } });
});

test('unknown response cannot mint a second effect, change recipient or interval, or optimistically remove the source', async () => {
  const page = realm();
  const calls: OwnerTransfer[] = [];
  const receipts = new Map<string, unknown>();
  let effects = 0;
  let available = true;
  const read = async (): Promise<AccessState> => (available ? { status: 'ready', page } : { status: 'unavailable' });
  const io: AccessIO = {
    read,
    save: async () => {
      throw new Error('Wrong command');
    },
    lookup: async () => null,
    transfer: (input) =>
      transferOwner('https://kernel.test', 'Bearer current', input, read, (async (_url, init) => {
        calls.push(structuredClone(input));
        expect(JSON.parse(String(init?.body)).previousValid).toBe(input.previousValid);
        if (receipts.has(input.key)) return Response.json(receipts.get(input.key));
        effects++;
        receipts.set(input.key, saved(input));
        throw new Error('Lost response after native commit');
      }) as typeof fetch),
  };
  const recovery = new AccessRecovery({ status: 'ready', page }, io);
  const { key: _key, kind: _kind, ...selection } = intent(page);
  await recovery.submitTransfer(selection);
  expect(recovery.snapshot().phase).toBe('uncertain');
  expect(recovery.snapshot().page).toEqual({ status: 'ready', page });
  const original = structuredClone(recovery.snapshot().pending);
  await recovery.submitTransfer({ ...selection, previousValid: '(,)' });
  await recovery.submit({
    resourceId: page.resource.id,
    operation: 'revoke',
    kind: 'role',
    role: owner,
    subject: { kind: 'account', id: managerId },
    actions: [],
    valid: '(,)',
  });
  expect(calls).toHaveLength(1);
  available = false;
  await recovery.retry();
  expect(recovery.snapshot().pending).toEqual(original);
  expect(recovery.snapshot().phase).toBe('uncertain');
  available = true;
  await recovery.reload();
  expect(recovery.snapshot().pending).toEqual(original);
  await recovery.retry();
  expect(calls[1]).toEqual(calls[0]);
  expect(effects).toBe(1);
  expect(recovery.snapshot().phase).toBe('saved');
  expect(recovery.snapshot().pending).toBeNull();
});

test('stale source refusal and authority loss clear private observations; unavailable readback cannot claim a new owner', async () => {
  const input = intent();
  for (const [http, phase] of [
    [403, 'refused'],
    [409, 'conflict'],
    [422, 'conflict'],
    [401, 'denied'],
  ] as const) {
    let reads = 0;
    const result = await transferOwner(
      'https://kernel.test',
      'Bearer current',
      input,
      async () => (++reads === 1 ? { status: 'ready', page: realm() } : { status: 'denied' }),
      (async () => Response.json({ type: 'forbidden' }, { status: http })) as typeof fetch,
    );
    expect(result).toEqual({ status: phase, current: { status: 'denied' } });
  }
  let reads = 0;
  expect(
    await transferOwner(
      'https://kernel.test',
      'Bearer current',
      input,
      async () => (++reads === 1 ? { status: 'ready', page: realm() } : { status: 'unavailable' }),
      (async () => Response.json(saved(input))) as typeof fetch,
    ),
  ).toEqual({ status: 'saved', current: { status: 'unavailable' } });
  let writes = 0;
  expect(
    await transferOwner(
      'https://kernel.test',
      'Bearer stranger',
      input,
      async () => ({ status: 'denied' }),
      (async () => {
        writes++;
        throw new Error('No call');
      }) as typeof fetch,
    ),
  ).toEqual({ status: 'denied', current: { status: 'denied' } });
  expect(writes).toBe(0);
});
