import { describe, expect, test } from 'vitest';
import { browserZoneRealmAttachment, type ZoneRealmAttachmentWrite } from './api.ts';

const zoneId = '00000000-0000-4000-8000-000000000901';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000902';
const head = 'https://rezics.com/id/00000000-0000-4000-8000-000000000903';
const moved = 'https://rezics.com/id/00000000-0000-4000-8000-000000000904';
const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000905';
type Answer = { data: unknown; error: { status: number; value: unknown } | null };

function client(answer: Answer) {
  const writes: unknown[] = [];
  const nameQueries: unknown[] = [];
  let reads = 0;
  const main = { v1: {
    zones: ({ id }: { id: string }) => {
      expect(id).toBe(zoneId);
      return { configuration: {
        get: async ({ query }: { query: { actingSubject: string } }) => {
          expect(query.actingSubject).toBe(actor);
          reads += 1;
          return answer;
        },
        put: async (body: ZoneRealmAttachmentWrite, options: unknown) => {
          writes.push({ body, options });
          return answer;
        },
      } };
    },
    realms: ({ realm: id }: { realm: string }) => {
      expect(id).toBe(realm.slice(-36));
      return { get: async (options: unknown) => {
        nameQueries.push(options);
        return { data: { name: { value: 'Tides community' } }, error: null };
      } };
    },
  } };
  return { api: browserZoneRealmAttachment(main as never), writes, nameQueries, reads: () => reads };
}

describe('Realm attachment browser adapter', () => {
  test('a stale removal preserves refusal without reading a newer head or dispatching another write', async () => {
    const fake = client({ data: null, error: { status: 409, value: { code: 'stale_zone_head', currentHead: moved } } });
    const body = { expectedHead: head, actingSubject: actor, defaultRealm: null };
    expect(await fake.api.saveConfiguration(zoneId, body, 'one-command')).toEqual({ ok: false, failure: 'stale', currentHead: moved });
    expect(fake.reads()).toBe(0);
    expect(fake.writes).toEqual([{ body, options: { headers: { 'idempotency-key': 'one-command' } } }]);
  });

  test('review reads the current attachment identity and its authorized name together', async () => {
    const fake = client({ data: { revision: moved, configuration: { defaultRealm: realm } }, error: null });
    expect(await fake.api.readConfiguration(zoneId, actor)).toEqual({ ok: true,
      data: { revision: moved, realm, name: 'Tides community' } });
    expect(fake.nameQueries).toEqual([{ query: { actingSubject: actor } }]);
  });

  test('keeps a committed receipt revision and replay flag', async () => {
    const fake = client({ data: { revision: head, replayed: true }, error: null });
    expect(await fake.api.saveConfiguration(zoneId, { expectedHead: moved, actingSubject: actor, defaultRealm: realm }, 'same-key'))
      .toEqual({ ok: true, data: { revision: head, replayed: true } });
  });

  test('preserves the attachment-limit reason as a terminal refusal', async () => {
    const fake = client({ data: null, error: { status: 409, value: { code: 'realm_attachment_limit' } } });
    expect(await fake.api.saveConfiguration(zoneId, { expectedHead: head, actingSubject: actor, defaultRealm: realm }, 'same-key'))
      .toEqual({ ok: false, failure: 'invalid', reason: 'attachment-limit' });
  });

  test.each([{ status: 401, failure: 'sign-in' }, { status: 403, failure: 'denied' }, { status: 503, failure: 'unavailable' }])
    ('keeps attachment save failure $failure', async ({ status, failure }) => {
      const fake = client({ data: null, error: { status, value: {} } });
      expect(await fake.api.saveConfiguration(zoneId, { expectedHead: head, actingSubject: actor, defaultRealm: realm }, 'same-key'))
        .toEqual({ ok: false, failure });
    });
});
