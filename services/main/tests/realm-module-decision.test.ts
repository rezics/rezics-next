import { expect, test } from 'bun:test';
import { readRealmDecision } from '../src/modules/realm-reads/public-decision-index.ts';
import { readRealmZone } from '../src/modules/realm-reads/read-zone.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession }
  from '../src/modules/work/read-session.ts';

const id = (value: string) => `https://rezics.com/id/${value}`;
const realm = id('00000000-0000-4000-8000-000000000001');
const zone = id('00000000-0000-4000-8000-000000000002');
const decision = id('00000000-0000-4000-8000-000000000003');
const row = (value: string) => ({ value });
const basis = { space: zone, realmRevision: decision, visibility: 'public', reviewMode: 'open', revision: null };

test('exact Decision applies the public relation and denies absent or ambiguous rows', async () => {
  const queries: string[] = [];
  const session = { options: {}, position: { dataEpoch: 'epoch', sequence: '8' },
    realm: async () => basis,
    disclosure: async (targets: readonly unknown[]) => targets.map(() => 'visible'),
    query: async (body: string) => { queries.push(body); return [{ id: row(decision),
      kind: row('adoption'), work: row(zone), subject: row(zone), revisionEpoch: row('epoch'),
      sequence: row('7') }]; },
  } as unknown as WorkReadSession;
  expect(await readRealmDecision(session, realm, decision)).toMatchObject({
    profile: 'realm-decision-v1', id: decision, kind: 'adoption' });
  expect(queries[0]).toContain('FILTER(?id = <' + decision + '>)');
  expect(queries[0]).toContain('rv:disclosure rv:Public');
  await expect(readRealmDecision({ ...session, query: async () => [] } as never,
    realm, decision)).rejects.toBeInstanceOf(WorkReadMissing);
  await expect(readRealmDecision({ ...session, query: async () => [{}, {}] } as never,
    realm, decision)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('Realm Zone resolution returns the stored presentation only for its own public Realm', async () => {
  const session = { options: {}, position: { dataEpoch: 'epoch', sequence: '8' },
    realm: async () => basis, deps: { environment: {} },
    query: async () => [{ zone: row(zone), official: row('true') }],
  } as unknown as WorkReadSession;
  const publication = { zone, realm, space: basis.space, official: 'fiction', revision: decision,
    presentation: DEFAULT_ZONE_PRESENTATION, disclosure: 'public' };
  expect(await readRealmZone(session, realm, async () => publication as never)).toMatchObject({
    profile: 'realm-zone-v1', zone, realm, routeSegment: 'fiction',
    presentationUrl: '/v1/zones/00000000-0000-4000-8000-000000000002/presentation' });
  await expect(readRealmZone(session, realm, async () => ({ ...publication,
    realm: zone }) as never)).rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(readRealmZone({ ...session, query: async () => [] } as never,
    realm)).rejects.toBeInstanceOf(WorkReadMissing);
});
