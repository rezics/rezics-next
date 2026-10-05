import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { book, chapterOne, names } from '../features/manage/fixtures.ts';
import { messages } from '../features/manage/messages.ts';
import de from '../features/manage/messages/de.ts';
import es from '../features/manage/messages/es.ts';
import fr from '../features/manage/messages/fr.ts';
import ja from '../features/manage/messages/ja.ts';
import ko from '../features/manage/messages/ko.ts';
import zhHans from '../features/manage/messages/zh-Hans.ts';
import zhHant from '../features/manage/messages/zh-Hant.ts';
import { SubjectName } from '../features/manage/queue-context.tsx';
import { subjectOf } from '../features/manage/queue-subject.ts';
import { readSubjects } from '../features/manage/read.ts';
import type { MainClient } from '../features/manage/types.ts';

const locales = { en: messages, de, es, fr, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };
const title = names.works[book]!.title.value;
const expected = {
  en: `A chapter of ${title}`,
  de: `Ein Kapitel von ${title}`,
  es: `Un capítulo de ${title}`,
  fr: `Un chapitre de ${title}`,
  ja: `『${title}』の章`,
  ko: `${title}의 한 장`,
  'zh-Hans': `《${title}》的一个章节`,
  'zh-Hant': `《${title}》的一個章節`,
};

for (const [locale, translations] of Object.entries(locales)) {
  test(`an unreadable chapter label names its placing Book in ${locale}`, () => {
    const t = materializeData({ ...messages, ...translations }, { locale });
    for (const chapters of [
      {},
      ...[null, '', '  '].map((value) => ({
        [chapterOne]: {
          ...names.chapters[chapterOne]!,
          label: value === null ? null : { value, language: 'zh-Hans' },
        },
      })),
    ]) {
      const subject = subjectOf(chapterOne, { ...names, chapters }, t);
      expect(subject.text).toBe(expected[locale as keyof typeof expected]);
      expect(subject).toMatchObject({
        isChapter: true,
        work: undefined,
        title: null,
        cover: { iri: book },
      });
      const rendered = renderToStaticMarkup(
        <SubjectName subject={subject} fallback={t.workFallback} />,
      );
      expect(rendered).toContain(expected[locale as keyof typeof expected]);
      expect(rendered.split(title)).toHaveLength(2);
      expect(rendered).not.toContain(t.workFallback);
    }
  });
}

test('a chapter whose Book header is unavailable retains its chapter kind', () => {
  const t = materializeData(messages, { locale: 'en' });
  const subject = subjectOf(chapterOne, { ...names, works: {}, chapters: {} }, t);
  expect(subject.text).toBe('Chapter');
  expect(renderToStaticMarkup(<SubjectName subject={subject} fallback={t.workFallback} />)).toBe(
    '<span>Chapter</span>',
  );
});

test('moderation context supplies Post placement after the Work header rejects the Post', async () => {
  const headers: string[] = [],
    chapterReads: string[] = [];
  const client = {
    v1: {
      works: ({ id }: { id: string }) => ({
        get: async () => {
          headers.push(id);
          return id === book.slice(-36)
            ? { data: { ...names.works[book]!, chapterCount: 3 }, error: null }
            : { data: null, error: { status: 404, value: {} } };
        },
      }),
      realms: () => ({
        moderation: {
          context: {
            get: async () => ({
              data: {
                works: [names.facts[chapterOne]],
                people: [],
              },
              error: null,
            }),
          },
        },
      }),
      chapters: ({ id }: { id: string }) => ({
        get: async () => {
          chapterReads.push(id);
          return { data: null, error: { status: 404, value: {} } };
        },
      }),
    },
  } as unknown as MainClient;
  const found = await readSubjects(client, 'realm', [chapterOne], {
    language: 'en',
    actingSubject: 'agent',
  });
  expect(Object.keys(found.works)).toEqual([book]);
  expect(headers).toEqual([chapterOne.slice(-36), book.slice(-36)]);
  expect(chapterReads).toEqual([names.facts[chapterOne]!.partOf!.occurrence!.slice(-36)]);
  expect(subjectOf(chapterOne, found, materializeData(messages, { locale: 'en' })).text).toBe(
    expected.en,
  );
});
