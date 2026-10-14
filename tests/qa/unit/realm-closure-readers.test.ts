import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { configureDisclosure, configureDisclosurePool, DisclosureStore, DisclosureUnavailable,
  type DisclosureChannel } from '../../../services/main/src/modules/disclosure/read.ts';
import { discloseNotifications } from '../../../services/main/src/modules/disclosure/notifications.ts';
import { visibleFeedSources } from '../../../services/main/src/modules/feed/read.ts';
import { readNewSince } from '../../../services/main/src/modules/feed/new-since.ts';
import { WorkReadMissing, WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { readRankings } from '../../../services/main/src/modules/rankings/read.ts';
import type { ReadRankingProjection } from '../../../services/main/src/modules/rankings/projection.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import type { NotificationSubjectReader, SubjectResolution } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from '../../../services/main/tests/support/disclosure-ancestry.ts';
import { ANONYMOUS_VIEWER } from '../../../services/main/src/modules/suitability/policy.ts';
import { defaultPreferences } from '../../../services/main/src/modules/feed/personal.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';

const native = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = native(1), liveRealm = native(2), work = native(3), author = native(4);
const uri = (value: string) => ({ type: 'uri' as const, value });

function fixture() {
  const state = { closed: false, unavailable: false, closeAtReviewFence: false };
  const calls: DisclosureChannel[] = [];
  const checkpoint = { data_epoch: 'epoch', sequence: '30', revision: '1', review_sequence: '0',
    after_id: '\uffff', rebuild_epoch: null };
  const rows = Array.from({ length: 22 }, (_, i) => ({ id: native(10 + i), kind: 'adoption', group_key: native(10 + i) }));
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/realm-closure-readers', fuseki: { query: async (query: string) => {
      const selected = [...query.matchAll(/<([^>]+)>/g)].map(match => match[1]);
      if (query.includes('SELECT ?resource ?head WHERE')) {
        return { results: { bindings: [{ resource: uri(work), head: uri(native(5)) }] } };
      }
      return { results: { bindings: rows.filter(row => selected.includes(row.id)).map(row => ({
        id: uri(row.id), kind: uri(row.kind), sequence: uri('1'), actor: uri(author),
        target: uri(work), work: uri(work), ...(row === rows.at(-1) ? {} : { realm: uri(realm) }),
      })) } };
    } } } as unknown as MainWorkDependencies['environment'];
  configureFixtureDisclosureAncestry(environment, target => target.work
    ? { resource: target.work, head: native(5) } : undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async (targets, _viewer, channel) => {
    if (state.unavailable) throw new DisclosureUnavailable('Realm owner unavailable');
    calls.push(channel);
    return targets.map(target => state.closed && target.resource === realm ? 'hidden' : 'visible');
  }));
  const deps = { environment, feed: {
    checkpoint: async () => checkpoint, since: async () => rows, reviewPending: async () => {
      if (state.closeAtReviewFence) state.closed = true;
      return false;
    },
  }, relayPosition: { read: async () => ({ streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '30' }) },
  homePersonal: { read: async () => ({ revision: '1', preferences: defaultPreferences, exclusions: [] }),
    fence: async () => ({ revision: '1' }) },
  follows: { matches: async (_principal: unknown, _agent: string, identities: string[][]) => {
    return { revision: '1', matches: identities.map(() => true) };
  } }, access: {} } as unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps, new Request('https://main.test/v1/feed'), {},
    { dataEpoch: 'epoch', sequence: '30' });
  const pool = {} as Pool;
  const reader = new DisclosureStore(pool);
  reader.environment = environment;
  configureDisclosurePool(pool, reader);
  return { state, rows, session, pool, calls };
}

test('feed sources omit Realm occurrences while retaining the same Work on its independent original', async () => {
  const f = fixture();
  const page = [...f.rows.slice(0, 19), f.rows.at(-1)!];
  expect(await visibleFeedSources(f.session(), page)).toHaveLength(20);
  f.state.closed = true;
  const sources = await visibleFeedSources(f.session(), page);
  expect(sources).toMatchObject([{ id: f.rows.at(-1)!.id, realm: null, work, actor: author }]);
  f.state.unavailable = true;
  await expect(visibleFeedSources(f.session(), page)).rejects.toThrow(DisclosureUnavailable);
});

test('a closed Realm head is exact zero even when the retained probe exceeds its cap', async () => {
  const f = fixture();
  f.state.closed = true;
  const head = await readNewSince(f.session(), '0', `realm:${realm}`,
    { principal: { issuer: 'account', subject: 'reader' }, agent: author });
  expect(head.newPosts).toEqual({ value: 0, kind: 'exact' });
  expect(f.calls).toContain('count');
});

test('head counts recheck closure after the final projection-owner read', async () => {
  const f = fixture();
  f.state.closeAtReviewFence = true;
  const head = await readNewSince(f.session(), '0', 'all');
  expect(head.newPosts.value).toBe(0);
});

for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator']) {
  test(`${persona} gets the ordinary missing result for a closed Realm ranking scope`, async () => {
    const f = fixture();
    f.state.closed = true;
    const session = f.session();
    if (persona !== 'visitor') session.principal = { issuer: 'account', subject: persona };
    session.realm = async resource => {
      if (resource !== realm) throw new WorkReadMissing('Realm is unavailable');
      return { realmRevision: native(5) } as Awaited<ReturnType<WorkReadSession['realm']>>;
    };
    const projection = { capture: async () => { throw new Error('A hidden scope must not open rankings'); } } as unknown as ReadRankingProjection;
    for (const order of ['score', 'growth'] as const) {
      for (const scope of [realm, native(999)]) {
        await expect(readRankings(session, projection,
          { realm: scope, metric: 'reads', interval: 'week', order })).rejects.toThrow(new WorkReadMissing('Realm is unavailable'));
      }
    }
  });
}

for (const channel of ['inbox', 'count', 'digest', 'email', 'push'] as const) {
  test(`${channel} suppresses closed content while independent and unrelated notices remain eligible`, async () => {
    const f = fixture();
    type Input = Parameters<NotificationSubjectReader['resolve']>[0];
    const input = (place: string | null, basis = 'realm-reply-v1'): Input => ({
      principalId: 'recipient', owner: 'graph', ref: work, revision: null, realm: place, disclosureBasis: basis,
    });
    const result: SubjectResolution = { status: 'available', subject: { private: false,
      fields: { linkTarget: work, excerpt: 'Reply text', realm, realmName: 'Closed Realm', realmRouteSegment: 'closed' } } };
    f.state.closed = true;
    const answer = await discloseNotifications(f.pool, [
      { input: input(realm), result }, { input: input(liveRealm), result }, { input: input(null), result },
      { input: { ...input(realm, 'moderation-outcome-v1'), owner: 'access' }, result },
    ], channel, ANONYMOUS_VIEWER);
    expect(answer[0]).toEqual({ status: 'undisclosed' });
    expect(answer[1]).toEqual(result);
    expect(answer[2]).toEqual(result);
    expect(answer[3]).toEqual({ status: 'available', subject: { private: false, fields: {} } });
  });
}
