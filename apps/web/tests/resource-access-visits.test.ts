import { expect, test } from 'bun:test';
import { AccessRecoveryVisits } from '../src/accounts/resource-access/visits';
import type { AccessIO, AccessState, Change, WriteResult } from '../src/accounts/resource-access/data';
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

test('return keeps the original uncertain command and transport; a new session gets no old command or rows', async () => {
  const visits = new AccessRecoveryVisits();
  const sent: Change[] = [];
  let response: WriteResult = { status: 'uncertain' };
  const io: AccessIO = {
    read: async () => ({ status: 'denied' }),
    lookup: async () => null,
    save: async (input) => {
      sent.push(structuredClone(input));
      return response;
    },
  };
  const original = visits.resume('session-0:resource', ready, io);
  await original.submit(change);
  const command = structuredClone(original.snapshot().pending);
  visits.release('session-0:resource', original);
  const current = visits.resume('session-1:resource', { status: 'denied' }, io);
  expect(current.snapshot()).toMatchObject({ pending: null, page: { status: 'denied' } });
  const returned = visits.resume('session-0:resource', ready, {
    ...io,
    save: async () => {
      throw new Error('A replacement transport must not receive the original command');
    },
  });
  expect(returned).toBe(original);
  returned.activate();
  await Bun.sleep(0);
  expect(sent).toHaveLength(1);
  for (const status of ['denied', 'refused', 'conflict', 'preparing'] as const) {
    response = { status };
    await returned.retry();
    expect(returned.snapshot()).toMatchObject({ pending: command, phase: 'uncertain' });
  }
  response = { status: 'saved' };
  await returned.retry();
  expect(sent).toEqual(Array.from({ length: 6 }, () => command));
  expect(returned.snapshot()).toMatchObject({ pending: null, phase: 'saved', page: { status: 'denied' } });
  visits.release('session-0:resource', returned);
  expect(visits.resume('session-0:resource', ready, io)).not.toBe(returned);
});
