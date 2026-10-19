import { afterEach, beforeEach, expect, test } from 'bun:test';
import { replaceModule } from './support/module-replacement.ts';
import { chapter, text, work as header, workRef } from '../features/work-page/fixtures.ts';
import { englishMessages as messages } from '../features/work-page/messages.ts';
import type { WorkResolution } from '../features/work-page/read.ts';
const reads = { ...await import('../features/work-page/read.ts') };
const seo = { ...await import('../features/seo/work.ts') };
const i18n = { ...await import('../i18n/server.ts') };
let work: WorkResolution;
let chapterRead: Awaited<ReturnType<typeof reads.readChapter>>;
let textRead: Awaited<ReturnType<typeof reads.readText>>;
const reading = { resolveWork: async () => work, readChapter: async () => chapterRead, readText: async () => textRead };
const titles = { workTitle: async (_work: WorkResolution, section?: string) => section ?? 'Anonymous public title',
  workPageMetadata: async () => ({ description: 'Successful public metadata' }) };
const language = { requestLocale: async () => 'en', getTranslation: async () => ({ t: messages }) };
const restoreReads = replaceModule(import.meta.resolve('../features/work-page/read.ts'), reads, reading);
const restoreSeo = replaceModule(import.meta.resolve('../features/seo/work.ts'), seo, titles);
const restoreI18n = replaceModule(import.meta.resolve('../i18n/server.ts'), i18n, language);
beforeEach(() => {
  work = { kind: 'work', id: workRef, header }; chapterRead = { ok: true, data: chapter }; textRead = { ok: true, data: text };
  restoreReads.set(reading); restoreSeo.set(titles); restoreI18n.set(language);
});
afterEach(() => { restoreReads(); restoreSeo(); restoreI18n(); });
async function metadata(kind: 'chapter' | 'text', query: Record<string, string> = {}, address = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b') {
  const props = { params: Promise.resolve({ ref: workRef, chapter: address }), searchParams: Promise.resolve(query) };
  return kind === 'chapter'
    ? (await import('../app/[locale]/w/[ref]/read/[chapter]/page.tsx')).generateMetadata(props)
    : (await import('../app/[locale]/w/[ref]/read/page.tsx')).generateMetadata(props);
}
for (const kind of ['chapter', 'text'] as const) {
  test(`${kind} preserves successful public metadata`, async () => {
    expect(await metadata(kind)).toEqual({ title: 'Anonymous public title', description: 'Successful public metadata' });
  });
  test(`${kind} distinguishes a missing Work from unavailable and redirected Works`, async () => {
    work = { kind: 'missing' }; expect((await metadata(kind)).title).toBe(messages.notFoundTitle);
    work = { kind: 'unavailable' }; expect(await metadata(kind)).toEqual({ title: messages.unavailableTitle, robots: { index: false } });
    work = { kind: 'moved', key: workRef }; expect((await metadata(kind)).title).toBeUndefined();
  });
  test(`${kind} reserves not-found for a missing read or malformed language`, async () => {
    chapterRead = { ok: false, failure: 'missing' }; textRead = { ok: false, failure: 'missing' };
    const title = kind === 'chapter' ? messages.chapterNotFoundTitle : messages.textNotFoundTitle;
    expect(await metadata(kind)).toEqual({ title, robots: { index: false } });
    expect(await metadata(kind, { language: '%%' })).toEqual({ title, robots: { index: false } });
  });
  for (const failure of ['unavailable', 'sign-in', 'pending', 'moved', 'invalid', 'budget'] as const) {
    test(`${kind} ${failure} is unavailable, never a missing-title claim`, async () => {
      chapterRead = { ok: false, failure }; textRead = { ok: false, failure };
      expect(await metadata(kind)).toEqual({ title: kind === 'chapter' ? messages.chapterUnavailableTitle : messages.textUnavailableTitle,
        robots: { index: false } });
    });
  }
}
test('a chapter belonging to another Work is missing at this address', async () => {
  chapterRead = { ok: true, data: { ...chapter, work: 'https://rezics.com/id/0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b' } };
  expect((await metadata('chapter')).title).toBe(messages.chapterNotFoundTitle);
});
test('a malformed chapter address remains missing', async () => {
  expect((await metadata('chapter', {}, 'invalid')).title).toBe(messages.chapterNotFoundTitle);
});
