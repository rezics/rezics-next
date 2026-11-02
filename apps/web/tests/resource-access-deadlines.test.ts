import { afterAll, expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  loadAccess,
  lookupAccessIdentity,
  writeAccess,
  type AccessState,
  type Change,
} from '../src/accounts/resource-access/data';
import { transferOwner, type OwnerTransfer } from '../src/accounts/resource-access/owner-transfer';
import { AccessRecovery } from '../src/accounts/resource-access/recovery';
import { reviewRequest, recipientRequest } from '../src/accounts/resource-access/request';
import { snapshot, managerId, readerId, resourceId } from '../src/stories/pages/accounts-resource-access/fixtures';

const schedule = globalThis.setTimeout;
const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
  schedule(
    fn,
    [10_000, 15_000, 25_000, 35_000].includes(Number(ms)) ? Number(ms) / 1000 : ms,
    ...args,
  )) as typeof setTimeout);
afterAll(() => timer.mockRestore());
const ready: AccessState = { status: 'ready', page: snapshot };
const change: Change = {
  resourceId,
  operation: 'change',
  kind: 'direct',
  subject: { kind: 'account', id: readerId },
  role: null,
  actions: ['collection:update'],
  valid: '[,)',
  key: crypto.randomUUID(),
  previous: { role: null, actions: ['collection:read'], valid: snapshot.grants[0]!.valid },
};
const transfer: OwnerTransfer = {
  kind: 'realm-owner-transfer',
  resource: { route: snapshot.resource.route, id: resourceId },
  fromAccountId: managerId,
  toAccountId: readerId,
  previousValid: change.previous!.valid,
  key: crypto.randomUUID(),
};
const realm: AccessState = {
  status: 'ready',
  page: { ...snapshot, resource: { ...snapshot.resource, type: 'community.realm' } },
};
const stalled = (body: boolean): Promise<Response> =>
  body
    ? Promise.resolve(
        new Response(new ReadableStream(), {
          headers: { 'content-type': 'application/json', 'rezics-session-token': 'native' },
        }),
      )
    : new Promise(() => {});

for (const body of [false, true]) {
  for (const phase of ['review', 'preflight', 'grant', 'lookup'] as const)
    test(`generated ${phase} releases stalled ${body ? 'body' : 'headers'}`, async () => {
      const requests: Request[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return phase === 'review' || phase === 'preflight' || requests.length > 1
            ? stalled(body)
            : Response.json(snapshot);
        }) as typeof fetch,
      });
      if (phase === 'lookup')
        await expect(lookupAccessIdentity(client, 'Bearer current', resourceId, 'aki')).rejects.toThrow();
      else
        expect(
          (
            await (phase === 'review'
              ? loadAccess(client, 'Bearer current', resourceId)
              : writeAccess(client, 'Bearer current', change))
          ).status,
        ).toBe(phase === 'review' ? 'unavailable' : phase === 'preflight' ? 'preparing' : 'uncertain');
      expect(requests.at(-1)!.signal.aborted).toBe(true);
      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(phase === 'grant' ? 1 : 0);
    });
  for (const phase of ['before', 'command', 'readback'] as const)
    test(`transfer ${phase} releases stalled ${body ? 'body' : 'headers'} and keeps the header session`, async () => {
      const sessions: (string | undefined)[] = [];
      let dispatched = 0;
      let nativeSignal: AbortSignal | undefined;
      const result = await transferOwner(
        'https://kernel.test',
        'Bearer current',
        transfer,
        async (session, signal) => {
          sessions.push(session);
          if (phase === 'before' || (phase === 'readback' && sessions.length > 1)) {
            nativeSignal = signal;
            return new Promise(() => {});
          }
          return realm;
        },
        (async (_url, init) => {
          dispatched++;
          nativeSignal = init!.signal!;
          expect(JSON.parse(String(init!.body)).previousValid).toBe(transfer.previousValid);
          expect(new Headers(init!.headers).get('idempotency-key')).toBe(JSON.stringify(transfer.key));
          if (phase === 'command') return stalled(body);
          return Response.json(
            {
              roleGrant: {
                resource: transfer.resource,
                subject: { kind: 'account', id: readerId },
                role: 'community.realm.owner',
                valid: '[2026-11-03,)',
              },
            },
            { headers: { 'rezics-session-token': 'native' } },
          );
        }) as typeof fetch,
      );
      expect(result.status).toBe(phase === 'readback' ? 'saved' : 'uncertain');
      expect(result.current.status).toBe(phase === 'command' ? 'ready' : 'unavailable');
      expect(dispatched).toBe(phase === 'before' ? 0 : 1);
      expect(nativeSignal!.aborted).toBe(true);
      if (phase !== 'before')
        expect(sessions).toEqual([undefined, body || phase === 'readback' ? 'native' : undefined]);
    });
}

test.each(['grant', 'transfer'] as const)(
  'stalled %s BFF preserves its exact pending operation through review and explicit retry',
  async (kind) => {
    const commands: unknown[] = [];
    const late = Promise.withResolvers<{ status: 'saved' }>();
    let signal!: AbortSignal;
    const write = async (input: unknown, caller?: AbortSignal) => {
      commands.push(structuredClone(input));
      signal = caller!;
      return commands.length === 1 ? late.promise : { status: 'saved' as const };
    };
    const controller = new AccessRecovery(ready, {
      read: async () => ready,
      lookup: async () => null,
      save: write,
      transfer: async (input, caller) => ({ ...(await write(input, caller)), current: ready }),
    });
    if (kind === 'grant') await controller.submit(change);
    else await controller.submitTransfer(transfer);
    const original = structuredClone(controller.snapshot().pending);
    expect(controller.snapshot()).toMatchObject({ busy: false, phase: 'uncertain', pending: commands[0] });
    expect(signal.aborted).toBe(true);
    late.resolve({ status: 'saved' });
    await controller.reload();
    expect(controller.snapshot().phase).toBe('uncertain');
    await controller.submit({ ...change, valid: '[2027-01-01,)' });
    expect(commands).toHaveLength(1);
    expect(controller.snapshot().pending).toEqual(original);
    await controller.retry();
    expect(commands).toEqual([original, original]);
    expect(controller.snapshot()).toMatchObject({ busy: false, phase: 'saved', pending: null });
  },
);

test('saved grant with stalled readback retains its result; optional recipient hydration is not required', async () => {
  const client = createKernelClient('https://kernel.test', {
    fetch: (async () => Response.json({ ...snapshot, identities: [] })) as typeof fetch,
  });
  expect((await loadAccess(client, 'Bearer current', resourceId)).status).toBe('ready');
  const controller = new AccessRecovery(ready, {
    lookup: async () => null,
    save: async () => ({ status: 'saved' }),
    read: () => new Promise(() => {}),
  });
  await controller.submit(change);
  expect(controller.snapshot()).toMatchObject({
    busy: false,
    phase: 'saved',
    pending: null,
    page: { status: 'unavailable' },
  });
});

test('caller cancellation releases stalled review and lookup; an already cancelled read never starts', async () => {
  const caller = new AbortController();
  const add = spyOn(caller.signal, 'addEventListener');
  const remove = spyOn(caller.signal, 'removeEventListener');
  let signal!: AbortSignal;
  const reading = reviewRequest((native) => {
    signal = native;
    return new Promise(() => {});
  }, caller.signal);
  caller.abort();
  expect((await reading).status).toBe('unavailable');
  expect(signal.aborted).toBe(true);
  expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]!.slice(0, 2));
  let called = false;
  await expect(
    recipientRequest(() => {
      called = true;
      throw new Error('must not start');
    }, caller.signal),
  ).rejects.toThrow();
  expect(called).toBe(false);
  add.mockRestore();
  remove.mockRestore();
});
