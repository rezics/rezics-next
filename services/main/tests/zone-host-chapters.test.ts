import { expect, test } from 'bun:test';
import { readZoneChapters } from '../src/modules/zone-modules/read.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = (value: string) => ({ value });
const realm = id(1), work = id(2), head = id(3), main = id(4);
const chapters = [id(10), id(11)];

function session(times: Map<string, string> | undefined) {
  const calls: string[] = [];
  const read = {
    options: { limit: 20, language: 'zh-hans' }, position: { dataEpoch: 'epoch', sequence: '7' },
    checkDeadline: () => {},
    realm: async () => ({ space: realm, realmRevision: id(5), visibility: 'public', reviewMode: 'open', revision: null }),
    query: async (body: string) => {
      if (body.includes('SELECT DISTINCT ?work ?head ?main ?chapter')) return chapters.map((chapter, n) => ({
        work: binding(work), head: binding(head), main: binding(main), chapter: binding(chapter),
        publication: binding(id(20 + n)), contentRevision: binding(`urn:rezics:content:revision:${n}`),
        language: binding('zh-Hans'), revisionEpoch: binding('epoch'), sequence: binding(String(9 - n)),
        epochOrder: binding('0') }));
      if (body.includes('SELECT ?work ?head')) return [{ work: binding(work), head: binding(id(6)) }];
      if (body.includes('SELECT ?state')) return [{ state: binding(JSON.stringify({ kind: 'header',
        originalTitle: null, completionStatus: 'ongoing', localized: [] })) }];
      return [];
    },
    summaries: async (resources: string[]) => {
      calls.push(`summaries:${resources.join(',')}`);
      return resources.map(resource => resource === chapters[1] ? { status: 'unavailable', reference: resource }
        : { status: 'available', disclosure: 'public', type: 'work',
          name: { value: resource === work ? '末班地铁' : '第十二章 终点站', language: 'zh-Hans', direction: 'ltr',
            basis: 'requested' },
          avatar: { kind: 'fallback', policy: 'test', key: resource, resourceType: 'work' } });
    },
    deps: times ? { serialStats: { batch: async () => new Map(), chapterTimes: async (ids: string[], sequence: string) => {
      calls.push(`times:${ids.join(',')}@${sequence}`);
      return times;
    } } } : {},
  };
  return { read: read as unknown as WorkReadSession, calls };
}

test('latest chapters carry each chapter\'s own title and when its text was recorded, in two batches', async () => {
  const at = '2026-09-28T03:04:05.000Z';
  const { read, calls } = session(new Map([[chapters[0]!, at]]));
  const page = await readZoneChapters(read, realm);
  expect(page.items.map(item => [item.chapterTitle?.value ?? null, item.chapterUpdatedAt]))
    .toEqual([['第十二章 终点站', at], [null, null]]);
  // One summary batch names every chapter on the page, and one serial batch dates them at the read's graph cut.
  expect(calls.filter(call => call.startsWith('summaries') && call.includes(chapters[0]!)))
    .toEqual([`summaries:${chapters.join(',')}`]);
  expect(calls.filter(call => call.startsWith('times'))).toEqual([`times:${chapters.join(',')}@7`]);
});

test('without serial statistics a chapter keeps its title and says nothing about its time', async () => {
  const page = await readZoneChapters(session(undefined).read, realm);
  expect(page.items[0]).toMatchObject({ chapterTitle: { value: '第十二章 终点站' }, chapterUpdatedAt: null });
});
