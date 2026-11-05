import { expect, test } from 'bun:test';
import { AccessRecovery } from '../src/accounts/resource-access/recovery';
import type { AccessState, Change, WriteResult } from '../src/accounts/resource-access/data';
import { snapshot, resourceId } from '../src/stories/pages/accounts-resource-access/fixtures';

const ready: AccessState = { status: 'ready', page: snapshot };
const change: Omit<Change, 'key'> = {
  resourceId,
  operation: 'revoke',
  kind: 'direct',
  subject: { kind: 'active_accounts' },
  role: null,
  actions: ['collection:read'],
  valid: '[,)',
};

test.each(['saved', 'lost'] as const)(
  'retired %s writes retain only the original explicit retry command',
  async (outcome) => {
    const deferred = Promise.withResolvers<WriteResult>();
    const commands: Change[] = [];
    const controller = new AccessRecovery(ready, {
      read: async () => ({ status: 'denied' }),
      lookup: async () => null,
      save: async (command) => {
        commands.push(command);
        return commands.length === 1 ? deferred.promise : { status: 'saved' };
      },
    });
    const writing = controller.submit(change);
    const original = structuredClone(controller.snapshot().pending);
    controller.dispose();
    controller.activate();
    await Promise.resolve();
    await Promise.resolve();
    if (outcome === 'lost') deferred.reject(new Error('Lost response'));
    else deferred.resolve({ status: 'saved' });
    await writing;
    expect(controller.snapshot()).toMatchObject({
      page: { status: 'denied' },
      pending: original,
      phase: 'uncertain',
      busy: false,
    });
    await controller.retry();
    expect(commands).toEqual([original, original]);
    expect(controller.snapshot()).toMatchObject({ page: { status: 'denied' }, phase: 'saved', pending: null });
  },
);

test.each(['reload', 'readback'] as const)(
  'retired %s cannot replace a later disclosure; missing readback is not write failure',
  async (source) => {
    const deferred = Promise.withResolvers<AccessState>();
    const firstReadStarted = Promise.withResolvers<void>();
    let reads = 0;
    const first = structuredClone(snapshot);
    first.next = 'next-page';
    const initial = source === 'reload' ? { status: 'ready' as const, page: first } : ready;
    const restarted = Promise.withResolvers<void>();
    const controller = new AccessRecovery(initial, {
      read: () => {
        reads++;
        if (reads === 1) {
          firstReadStarted.resolve();
          return deferred.promise;
        }
        return Promise.reject(new Error('Unavailable'));
      },
      save: async () => ({ status: 'saved' }),
      lookup: async () => null,
    });
    const unsubscribe = controller.subscribe(() => {
      const state = controller.snapshot();
      if (state.page.status === 'unavailable' && !state.busy) restarted.resolve();
    });
    const reading = source === 'reload' ? controller.next() : controller.submit(change);
    await firstReadStarted.promise;
    controller.dispose();
    controller.activate();
    deferred.resolve(ready);
    await reading;
    await restarted.promise;
    unsubscribe();
    expect(controller.snapshot()).toMatchObject({ page: { status: 'unavailable' }, busy: false, pending: null });
    expect(controller.snapshot().phase).toBe(source === 'readback' ? 'saved' : 'idle');
  },
);

test('an admitted command readback starts at First and cannot restore a pre-command window', async () => {
  const reads: (string | undefined)[] = [];
  const first = structuredClone(snapshot);
  first.next = 'before-write';
  const controller = new AccessRecovery(
    { status: 'ready', page: first },
    {
      read: async (cursor) => {
        reads.push(cursor);
        const page = structuredClone(snapshot);
        page.next = cursor === 'before-write' ? 'stale-next' : 'after-write';
        return { status: 'ready', page };
      },
      save: async () => ({ status: 'saved' }),
      lookup: async () => null,
    },
  );

  await controller.next();
  expect(controller.snapshot().canPrevious).toBe(true);
  await controller.submit(change);
  expect(reads).toEqual(['before-write', undefined]);
  expect(controller.snapshot()).toMatchObject({ phase: 'saved', pending: null, canPrevious: false, canFirst: false });
  expect(await controller.previous()).toBe(false);
  await controller.next();
  expect(reads).toEqual(['before-write', undefined, 'after-write']);
});
