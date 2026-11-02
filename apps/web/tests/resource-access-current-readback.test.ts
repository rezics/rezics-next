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
    let reads = 0;
    const controller = new AccessRecovery(ready, {
      read: () => (++reads === 1 ? deferred.promise : Promise.reject(new Error('Unavailable'))),
      save: async () => ({ status: 'saved' }),
      lookup: async () => null,
    });
    const reading = source === 'reload' ? controller.reload('next-page') : controller.submit(change);
    await Promise.resolve();
    controller.dispose();
    controller.activate();
    deferred.resolve(ready);
    await reading;
    expect(controller.snapshot()).toMatchObject({ page: { status: 'unavailable' }, busy: false, pending: null });
    expect(controller.snapshot().phase).toBe(source === 'readback' ? 'saved' : 'idle');
  },
);
