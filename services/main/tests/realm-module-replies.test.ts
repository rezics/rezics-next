import { expect, test } from 'bun:test';
import { readZoneReplies } from '../src/modules/zone-modules/replies.ts';
import { WorkReadMissing, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (value: string) => `https://rezics.com/id/${value}`;
const realm = id('00000000-0000-4000-8000-000000000001');
const work = id('00000000-0000-4000-8000-000000000002');
const reply = id('00000000-0000-4000-8000-000000000003');
const placement = id('00000000-0000-4000-8000-000000000004');
const review = '00000000-0000-4000-8000-000000000005';
const revision = '00000000-0000-4000-8000-000000000006';
const bind = (value: string) => ({ value });

function fixture(options: { privateRealm?: boolean; approved?: boolean; erased?: boolean } = {}) {
  const calls: string[] = [];
  const session = { options: { limit: 1 }, position: { dataEpoch: 'epoch', sequence: '8' },
    realm: async () => {
      if (options.privateRealm) throw new WorkReadMissing('Realm is unavailable');
      return { space: work, realmRevision: placement, visibility: 'public',
        reviewMode: 'open', revision: null };
    },
    query: async (query: string) => {
      calls.push(query);
      if (query.includes('rv:RestoreCutover')) return [];
      return [{ id: bind(placement), reply: bind(reply), work: bind(work), author: bind(realm),
        authorName: bind('Reader'),
        revision: bind(`urn:rezics:content:revision:${revision}`),
        review: bind(`urn:rezics:realm-review:${review}`),
        revisionEpoch: bind('epoch'), sequence: bind('7'), epochOrder: bind('0') }];
    },
    summaries: async () => [{ status: 'available', disclosure: 'public', type: 'work',
      name: { value: 'Public work', language: 'en', direction: 'ltr', basis: 'fallback' } }],
    deps: { realmReplies: { visible: async () => options.approved === false ? null
      : { placement, revisionId: revision, reviewDecisionId: review } },
    content: { readExactBatch: async () => [{ status: options.erased ? 'erased' : 'available',
      reference: { resourceId: reply }, body: { body: 'A thoughtful public reply about this story.' } }] } },
  } as unknown as WorkReadSession;
  return { session, calls };
}

test('Realm discussions and quote excerpts are bounded by current public placement review', async () => {
  const current = fixture();
  expect(await readZoneReplies(current.session, realm, 'discussions')).toMatchObject({
    profile: 'zone-discussions-v1', items: [{ id: reply, author: realm, authorName: 'Reader',
      work: { id: work, title: { value: 'Public work' } },
      excerpt: 'A thoughtful public reply about this story.' }] });
  expect(current.calls.at(-1)).toContain('FILTER NOT EXISTS { ?id rv:parentReply ?parent }');
  expect(await readZoneReplies(fixture({ approved: false }).session, realm,
    'reader-quotes')).toMatchObject({ items: [] });
  expect(await readZoneReplies(fixture({ erased: true }).session, realm,
    'reader-quotes')).toMatchObject({ items: [] });
  const hidden = fixture({ privateRealm: true });
  await expect(readZoneReplies(hidden.session, realm, 'discussions'))
    .rejects.toBeInstanceOf(WorkReadMissing);
  expect(hidden.calls).toHaveLength(0);
});
