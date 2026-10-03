import { expect, test } from 'bun:test';
import { RealmReplyStore, visibleRealmReply } from '../src/modules/realm-reply/store.ts';
import { RealmReplyDenied } from '../src/modules/realm-reply/content-store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RV } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = id(1), reply = id(2), root = id(3);
const binding = (value: string) => ({ type: 'uri', value });

function fixture(changed = false, privateRealm = false) {
  let policyReads = 0, placementReads = 0, reviews = 0;
  const policy = { space: binding(id(4)), disclosure: binding(`${RV}${privateRealm ? 'Private' : 'Public'}`) };
  const placement = { reply: binding(reply), placement: binding(id(5)),
    revision: binding('urn:rezics:content:revision:00000000-0000-4000-8000-000000000006'),
    review: binding('urn:rezics:realm-review:00000000-0000-4000-8000-000000000007'),
    root: binding(root), rootRevision: binding(id(8)), author: binding(id(9)), preparation: binding('g-986-reply') };
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: '0' }, fuseki: { query: async (sql: string) => {
    if (sql.includes('SELECT ?space ?realmRevision')) {
      policyReads++;
      return { results: { bindings: changed && policyReads > 1 ? [] : [policy] } };
    }
    placementReads++;
    return { results: { bindings: [placement] } };
  } } } as unknown as WorkActivationEnvironment;
  const content = { currentReview: async () => { reviews++; return true; } };
  return { env, content, counts: () => ({ policyReads, placementReads, reviews }) };
}

test('G-986: exact reply visibility uses two live policy reads and one placement/review', async () => {
  const f = fixture();
  expect(await visibleRealmReply(f.content, {}, f.env, realm, reply)).toMatchObject({ reply, realm, rootTarget: root });
  expect(f.counts()).toEqual({ policyReads: 2, placementReads: 1, reviews: 1 });
});

test('G-986: a changed Realm policy or denied exact Content review hides the reply', async () => {
  const changed = fixture(true);
  expect(await visibleRealmReply(changed.content, {}, changed.env, realm, reply)).toBeNull();
  const denied = fixture();
  expect(await visibleRealmReply({ currentReview: async () => false }, {}, denied.env, realm, reply)).toBeNull();
  const privateRealm = fixture(false, true);
  expect(await visibleRealmReply(privateRealm.content, {}, privateRealm.env, realm, reply)).toBeNull();
  expect(privateRealm.counts()).toEqual({ policyReads: 1, placementReads: 0, reviews: 0 });
});

test('G-986: a root count shares its Realm fence and still checks every exact placement/review', async () => {
  const f = fixture();
  const store = new RealmReplyStore(f.content as never, {} as never, {} as never, f.env);
  expect(await store.rootCount(realm, root)).toEqual({ realm, rootTarget: root, count: 1, complete: true });
  expect(f.counts()).toEqual({ policyReads: 2, placementReads: 2, reviews: 1 });
  const changed = fixture(true);
  const fenced = new RealmReplyStore(changed.content as never, {} as never, {} as never, changed.env);
  await expect(fenced.rootCount(realm, root)).rejects.toBeInstanceOf(RealmReplyDenied);
});
