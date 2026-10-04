import { expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { reasonsOf } from '../features/search/types.ts';
import { chapterPlaceHref, postPlaceHref, type PostPlacement } from '../features/work-page/route.ts';

const iri = (tail: string) => `https://rezics.com/id/00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const sid = (tail: string) => uuidToSid(iri(tail).slice(-36));
const placement = (book: string, occurrence: string): PostPlacement => ({ book: iri(book), occurrence: iri(occurrence) });

test('a chapter Post opens at its occurrence in the Book that uses it', () => {
  // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
  expect(postPlaceHref([placement('b1', 'c1')])).toBe(`/w/${sid('b1')}/read/${iri('c1').slice(-36)}`);
});

test('a Post used by several Books opens in the first, or the Book the address names', () => {
  const placements = [placement('b1', 'c1'), placement('b2', 'c2')];
  // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
  expect(postPlaceHref(placements)).toBe(`/w/${sid('b1')}/read/${iri('c1').slice(-36)}`);
  // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
  expect(postPlaceHref(placements, iri('b2').slice(-36))).toBe(`/w/${sid('b2')}/read/${iri('c2').slice(-36)}`);
  // A Book that does not use the Post never wins over the ones that do.
  // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
  expect(postPlaceHref(placements, iri('b9').slice(-36))).toBe(`/w/${sid('b1')}/read/${iri('c1').slice(-36)}`);
});

test('a Book that places the Post twice has no single place, so its Contents opens; no Book means no place', () => {
  // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
  expect(postPlaceHref([placement('b1', 'c1'), placement('b1', 'c2')])).toBe(`/w/${sid('b1')}/contents`);
  expect(postPlaceHref([])).toBeNull();
});

test('the reader language stays on a chapter address', () => {
  expect(chapterPlaceHref({ work: iri('b1'), occurrence: iri('c1') }, 'zh-Hant'))
    // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
    .toBe(`/w/${sid('b1')}/read/${iri('c1').slice(-36)}?language=zh-Hant`);
});

test('a search match in a chapter links to that chapter Post in the result Book', () => {
  const match = { language: 'en', matchedChapter: { post: iri('c1'), book: iri('b1'), title: 'Chapter 3 · Rain' } };
  expect(reasonsOf(match as Parameters<typeof reasonsOf>[0]).chapter).toEqual({ title: 'Chapter 3 · Rain',
    // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
    href: `/w/${sid('b1')}/read/${iri('c1').slice(-36)}?language=en` });
  expect(reasonsOf({ language: 'en' } as Parameters<typeof reasonsOf>[0]).chapter).toBeNull();
});
