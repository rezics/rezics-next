import { expect, test } from 'bun:test';
import { changeZoneLifecycle, type ZoneLifecycleClient } from '../src/features/catalogue/lifecycle-zone-commands.ts';

test('the catalogue Zone lifecycle client hides, restores and refuses a second owner without borrowing configuration', async () => {
  const client: ZoneLifecycleClient = {
    zones() {
      return {
        async delete(_body, options) {
          expect(options.headers.authorization).toBe('Bearer owner');
          return {
            status: 200,
            data: { zone: { revision: '2', deletedAt: '2026-11-06T00:00:00.000Z', restoreUntil: '2026-12-06T00:00:00.000Z' } },
          };
        },
        $restore: {
          async post(_body, options) {
            return options.headers.authorization === 'Bearer owner'
              ? { status: 200, data: { zone: { revision: '3', deletedAt: null, restoreUntil: null } } }
              : { status: 403, data: null };
          },
        },
      };
    },
  };
  const address = {
    id: '018f1a2b-3c4d-7000-8000-000000000001',
    revision: '1',
    key: '11111111-1111-4111-8111-111111111111',
  };
  expect(await changeZoneLifecycle(client, 'Bearer owner', { ...address, operation: 'delete' })).toEqual({
    ok: true,
    operation: 'delete',
    revision: '2',
    deletedAt: '2026-11-06T00:00:00.000Z',
    restoreUntil: '2026-12-06T00:00:00.000Z',
  });
  expect(
    await changeZoneLifecycle(client, 'Bearer other', { ...address, revision: '2', operation: 'restore' }),
  ).toEqual({ ok: false, reason: 'denied' });
  expect(
    await changeZoneLifecycle(client, 'Bearer owner', { ...address, revision: '2', operation: 'restore' }),
  ).toEqual({
    ok: true,
    operation: 'restore',
    revision: '3',
    deletedAt: null,
    restoreUntil: null,
  });
});
