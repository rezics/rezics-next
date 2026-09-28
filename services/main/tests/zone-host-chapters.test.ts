import { expect, test } from 'bun:test';
import { chapterLabel, readZoneChapters } from '../src/modules/zone-modules/read.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = (value: string) => ({ value });
const realm = id(1), work = id(2), head = id(3), main = id(4);
const chapters = [id(10), id(11)], placements = [id(30), id(31)];
const owner = '00000000-0000-4000-8000-0000000000ee';

function session(times: Map<string, string> | undefined) {
  const calls: string[] = [];
  const read = {
    options: { limit: 20, language: 'zh-hans' }, position: { dataEpoch: 'epoch', sequence: '7' },
    checkDeadline: () => {},
    realm: async () => ({ space: realm, realmRevision: id(5), visibility: 'public', reviewMode: 'open', revision: null }),
    query: async (body: string) => {
      if (body.includes('SELECT DISTINCT ?work ?head ?main ?chapter')) return chapters.map((chapter, n) => ({
        work: binding(work), head: binding(head), main: binding(main), chapter: binding(chapter),
        placement: binding(placements[n]!), publication: binding(id(20 + n)),
        contentRevision: binding(`urn:rezics:content:revision:${n}`), language: binding('zh-Hans'),
        revisionEpoch: binding('epoch'), sequence: binding(String(9 - n)), epochOrder: binding('0'),
        // The second publication predates owner positions in the graph.
        ...n === 0 ? { ownerEpoch: binding(owner), ownerSequence: binding('42') } : {} }));
      if (body.includes('SELECT ?placement ?label')) {
        calls.push(`labels:${[...body.matchAll(/<([^>]+)>/g)].map(match => match[1]).filter(value => placements.includes(value!)).join(',')}`);
        return [{ placement: binding(placements[0]!), label: { value: 'Chapter 12: Terminus', 'xml:lang': 'en' } },
          { placement: binding(placements[0]!), label: { value: '第十二章 终点站', 'xml:lang': 'zh-Hans' } },
          { placement: binding(placements[1]!), label: { value: 'Untitled chapter', 'xml:lang': 'en' } }];
      }
      if (body.includes('SELECT ?work ?head')) return [{ work: binding(work), head: binding(id(6)) }];
      if (body.includes('SELECT ?state')) return [{ state: binding(JSON.stringify({ kind: 'header',
        originalTitle: null, completionStatus: 'ongoing', localized: [] })) }];
      return [];
    },
    summaries: async (resources: string[]) => resources.map(resource => ({ status: 'available', disclosure: 'public',
      type: 'work', name: { value: '末班地铁', language: 'zh-Hans', direction: 'ltr', basis: 'requested' },
      avatar: { kind: 'fallback', policy: 'test', key: resource, resourceType: 'work' } })),
    deps: times ? { serialStats: { batch: async () => new Map(),
      publicationTimes: async (positions: { epoch: string; sequence: string }[]) => {
        calls.push(`times:${positions.map(position => `${position.epoch}:${position.sequence}`).join(',')}`);
        return times;
      } } } : {},
  };
  return { read: read as unknown as WorkReadSession, calls };
}

test('latest chapters carry the Book’s own chapter label and the Content receipt time, in one batch each', async () => {
  const at = '2026-09-28T03:04:05.000Z';
  const { read, calls } = session(new Map([[`${owner}:42`, at]]));
  const page = await readZoneChapters(read, realm);
  expect(page.items.map(item => [item.chapterTitle?.value ?? null, item.chapterTitle?.basis ?? null,
    item.chapterUpdatedAt])).toEqual([['第十二章 终点站', 'requested', at], [null, null, null]]);
  expect(calls).toEqual([`labels:${placements.join(',')}`, `times:${owner}:42`]);
});

test('a label falls back to its base language, then the first; a placeholder names nothing', () => {
  const labels = [{ value: 'Chapter 1', language: 'en' }, { value: '第一章', language: 'zh-Hant' }];
  expect(chapterLabel(labels, 'zh-hans')?.value).toBe('第一章');
  expect(chapterLabel(labels, 'ja')?.value).toBe('Chapter 1');
  expect(chapterLabel([{ value: '未命名章节', language: 'zh-Hans' }], 'zh-Hans')).toBeNull();
  expect(chapterLabel([], 'en')).toBeNull();
});

test('without the serial owner a chapter keeps its label and says nothing about its time', async () => {
  const page = await readZoneChapters(session(undefined).read, realm);
  expect(page.items[0]).toMatchObject({ chapterTitle: { value: '第十二章 终点站' }, chapterUpdatedAt: null });
});
