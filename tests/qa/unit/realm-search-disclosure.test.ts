import { expect, test } from 'bun:test';
import { configureDisclosure, DisclosureUnavailable, type DisclosureDecision, type DisclosureTarget }
  from '../../../services/main/src/modules/disclosure/read.ts';
import { withPublicRealmSearch } from '../../../services/main/src/modules/search/realm-disclosure.ts';
import { withDisclosureViewer } from '../../../services/main/src/modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../../../services/main/src/modules/suitability/policy.ts';
import { PublicQueryUnavailable, PublicRealmUnavailable } from '../../../services/main/src/modules/work/search-public.ts';
import { RV, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const head = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const value = (text: string) => ({ value: text });

function fixture() {
  const state = { present: true, visibility: 'public', decision: 'visible' as DisclosureDecision,
    policyReads: 0, targets: [] as DisclosureTarget[][], audience: [] as boolean[] };
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => {
      if (query.includes('SELECT ?space ?realmRevision')) {
        state.policyReads++;
        return { results: { bindings: state.present ? [{ space: value(space), realmRevision: value(head),
          visibility: value(state.visibility), disclosure: value(`${RV}${state.visibility === 'private' ? 'Private' : 'Public'}`) }] : [] } };
      }
      return { results: { bindings: [{ work: value(realm), head: value(head) }] } };
    },
  } } as unknown as WorkActivationEnvironment;
  configureDisclosure(env, { read: async (targets, viewer, channel) => {
    expect(channel).toBe('search');
    state.targets.push([...targets]);
    state.audience.push(viewer.signedIn);
    return targets.map(() => state.decision);
  } });
  return { env, state };
}

test('Realm search answers closed, absent and private scopes as unavailable before matching or cursor decoding', async () => {
  for (const condition of ['closed', 'absent', 'private', 'restricted', 'tombstone']) {
    const { env, state } = fixture();
    if (condition === 'absent') state.present = false;
    if (condition === 'private' || condition === 'restricted') state.visibility = condition;
    if (condition === 'closed') state.decision = 'hidden';
    if (condition === 'tombstone') state.decision = 'tombstone';
    let executions = 0;
    await expect(withPublicRealmSearch(env, realm, async () => { executions++; return { next: 'old-cursor' }; }))
      .rejects.toBeInstanceOf(PublicRealmUnavailable);
    expect(executions).toBe(0);
  }
});

test('Realm search discards hydrated results, counts and context when closure takes effect during the read', async () => {
  for (const signedIn of [false, true]) {
    for (const results of [[], [{ work: 'independent-original', selection: 'realm-adoption' }]]) {
      const { env, state } = fixture();
      await expect(withDisclosureViewer({ ...ANONYMOUS_VIEWER, signedIn },
        () => withPublicRealmSearch(env, realm, async () => {
          state.decision = 'hidden';
          return { context: { id: realm }, results, count: results.length, next: 'cursor' };
        }))).rejects.toBeInstanceOf(PublicRealmUnavailable);
      expect(state.targets).toHaveLength(2);
      expect(state.targets.flat().every(target => target.resource === realm
        && target.component === 'record' && target.revision === head)).toBe(true);
      expect(state.audience).toEqual([signedIn, signedIn]);
    }
  }
});

test('Realm search preserves open answers and global originals without a Realm dependency', async () => {
  const { env, state } = fixture();
  const answer = { results: [{ work: 'independent-original' }], total: 1, next: null };
  expect(await withPublicRealmSearch(env, realm, async () => answer)).toBe(answer);
  expect(state.targets).toHaveLength(2);
  state.targets.length = 0;
  state.policyReads = 0;
  state.decision = 'hidden';
  expect(await withPublicRealmSearch(env, undefined, async () => answer)).toBe(answer);
  expect(state.targets).toEqual([]);
  expect(state.policyReads).toBe(0);
});

test('Realm search cannot treat an unavailable disclosure owner as an empty public answer', async () => {
  const { env } = fixture();
  configureDisclosure(env, null);
  await expect(withPublicRealmSearch(env, realm, async () => []))
    .rejects.toBeInstanceOf(PublicQueryUnavailable);
  configureDisclosure(env, { read: async () => { throw new DisclosureUnavailable('owner offline'); } });
  await expect(withPublicRealmSearch(env, realm, async () => []))
    .rejects.toBeInstanceOf(DisclosureUnavailable);
});
