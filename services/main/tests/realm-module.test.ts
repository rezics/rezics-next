import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readZoneChapters, readZoneDecisions, readZoneWorks }
  from '../src/modules/zone-modules/read.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../src/modules/work/read-session.ts';

const realm = `https://rezics.com/id/${randomUUID()}`;
const work = `https://rezics.com/id/${randomUUID()}`;
const revision = `https://rezics.com/id/${randomUUID()}`;
const credit = `https://rezics.com/id/${randomUUID()}`;
const secondCredit = `https://rezics.com/id/${randomUUID()}`;
const chapter = `https://rezics.com/id/${randomUUID()}`;
const sourceKey = '/authors/OL1A';
const secondSourceKey = '/authors/OL2A';
const nameSource = { record: revision, observation: revision, revision, sourceRevision: 'open-library-revision:2',
  digest: 'digest', url: `https://openlibrary.org${sourceKey}.json`, fetchedAt: '2026-09-28T00:00:00Z',
  basis: 'facts' as const, field: '/name' as const };
const binding = (value: string) => ({ value });

function session(options: { cursor?: string; candidate?: boolean; privateRealm?: boolean;
  status?: 'completed' | 'ongoing'; chapter?: boolean; authorName?: string | null } = {}) {
  const calls: string[] = [];
  const nameBatches: string[][] = [];
  const read = {
    options: { limit: 1, ...options }, position: { dataEpoch: 'epoch', sequence: '5' },
    deps: { sourceAuthorNames: { batch: async (keys: string[]) => {
      nameBatches.push(keys);
      return options.authorName ? new Map([
        [sourceKey, { displayName: options.authorName, nameSource }],
        [secondSourceKey, { displayName: 'Charlotte Brontë', nameSource }],
      ])
        : new Map();
    } } },
    checkDeadline: () => {},
    realm: async () => {
      calls.push('realm basis');
      if (options.privateRealm) throw new WorkReadMissing('Realm is unavailable');
      return { space: work, realmRevision: revision, visibility: 'public',
        reviewMode: 'open', revision: null };
    },
    query: async (body: string) => {
      calls.push(body);
      if (body.includes('rv:RestoreCutover')) return [];
      if (body.includes('SELECT DISTINCT ?work ?head ?main ?chapter')) return options.chapter ? [{
        work: binding(work), head: binding(revision), main: binding(realm), chapter: binding(chapter),
        placement: binding(chapter), publication: binding(revision), contentRevision: binding(revision), language: binding('en'),
        revisionEpoch: binding('epoch'), sequence: binding('4'), epochOrder: binding('0'),
      }] : [];
      if (body.includes('SELECT DISTINCT ?work ?head')) return options.candidate ? [{
        work: binding(work), head: binding(revision), main: binding(realm), evidence: binding(revision),
        revisionEpoch: binding('epoch'), sequence: binding('4'), epochOrder: binding('0'),
      }] : [];
      if (body.includes('SELECT ?work ?head')) return [{ work: binding(work), head: binding(revision) }];
      if (body.includes('SELECT ?state')) return [{ state: binding(JSON.stringify({ kind: 'header',
        originalTitle: null, completionStatus: options.status ?? 'completed', localized: [] })) }];
      if (body.includes('SELECT ?work ?type')) return [];
      if (body.includes('SELECT ?id ?key ?ordinal ?agent')) return [
        { id: binding(credit), key: binding(sourceKey), ordinal: binding('1') },
        { id: binding(secondCredit), key: binding(secondSourceKey), ordinal: binding('2') },
      ];
      return [];
    },
    summaries: async () => [{ status: 'available', disclosure: 'public', type: 'work',
      name: { value: 'Serial', language: 'en', direction: 'ltr', basis: 'fallback' },
      avatar: { kind: 'fallback', policy: 'test', key: work, resourceType: 'work' } }],
  };
  return { read: read as unknown as WorkReadSession, calls, nameBatches };
}

test('Zone modules reject private Realms and tampered cursors before candidate enumeration', async () => {
  const privateRead = session({ privateRealm: true });
  await expect(readZoneWorks(privateRead.read, realm, 'new-adoptions')).rejects.toBeInstanceOf(WorkReadMissing);
  expect(privateRead.calls).toHaveLength(1);
  const tampered = session({ cursor: 'bad-token' });
  await expect(readZoneWorks(tampered.read, realm, 'new-adoptions')).rejects.toBeInstanceOf(WorkReadInvalid);
  expect(tampered.calls).toHaveLength(1);
});

test('Zone modules expose bounded page counts and reject a stale completed-status projection', async () => {
  const empty = session();
  expect(await readZoneWorks(empty.read, realm, 'new-adoptions')).toMatchObject({
    profile: 'zone-new-adoptions-v1', realm, items: [], nextCursor: null,
    count: { value: 0, kind: 'exact-page', total: null } });
  const stale = session({ candidate: true, status: 'ongoing' });
  await expect(readZoneWorks(stale.read, realm, 'recently-completed'))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('Zone Work and chapter cards resolve every retained Open Library credit within a page batch', async () => {
  const adoption = session({ candidate: true, authorName: 'Jane Austen' });
  const works = await readZoneWorks(adoption.read, realm, 'new-adoptions');
  expect(works.items[0]?.primaryCredits).toMatchObject([
    { key: sourceKey, displayName: 'Jane Austen', nameSource },
    { key: secondSourceKey, displayName: 'Charlotte Brontë', nameSource },
  ]);
  expect(adoption.nameBatches).toEqual([[sourceKey, secondSourceKey]]);

  const chapters = session({ chapter: true, authorName: 'Jane Austen' });
  const page = await readZoneChapters(chapters.read, realm);
  expect(page.items[0]?.work.primaryCredits).toMatchObject([
    { key: sourceKey, displayName: 'Jane Austen', nameSource },
    { key: secondSourceKey, displayName: 'Charlotte Brontë', nameSource },
  ]);
  expect(chapters.nameBatches).toEqual([[sourceKey, secondSourceKey]]);

  const removed = session({ candidate: true, authorName: null });
  expect((await readZoneWorks(removed.read, realm, 'new-adoptions')).items[0]?.primaryCredits)
    .toMatchObject([{ key: sourceKey, displayName: null },
      { key: secondSourceKey, displayName: null }]);
});

test('recent decision summary describes only the public decision page', async () => {
  const empty = session();
  expect(await readZoneDecisions(empty.read, realm)).toMatchObject({
    profile: 'zone-recent-decisions-v1', realm,
    summary: { adoption: 0, classification: 0, semanticRuleChange: 0, basis: 'exact-page' } });
});
