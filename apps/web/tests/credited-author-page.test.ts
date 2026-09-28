import { describe, expect, test } from 'bun:test';
import { authorName, formatAuthorDate, isoDate, lifespan, retrievedOn } from '../features/author/facts.ts';
import { caoXueqin, conanDoyle, janeAusten, lewisCarroll, unnamedAuthor } from '../features/author/fixtures.ts';
import { messages } from '../features/author/messages.ts';
import zhHans from '../features/author/messages/zh-Hans.ts';
import { authorJsonLd, authorMetadata } from '../features/author/metadata.ts';
import { authorHref, openLibraryAuthorHref, parseCursor, parseOpenLibraryAuthor } from '../features/author/route.ts';
import { materializeData } from 'native-i18n';
import { isPublicPagePath } from '../i18n/locale.ts';
import { discoveryWork } from '../features/discover/cards.ts';
import { works as discoveryFixtures } from '../features/discover/fixtures.ts';

const zh = { ...messages, ...zhHans };
const facts = (author: typeof janeAusten) => author.facts!;

describe('author addresses', () => {
  test('discovery credits retain author destinations for the shared card renderer', () => {
    const item = { ...discoveryFixtures.pride, primaryCredits: [
      { id: discoveryFixtures.pride.id, role: 'author' as const, participantKind: 'external-reference' as const,
        provider: 'open-library' as const, key: '/authors/OL21594A', ordinal: 0, agent: null,
        displayName: 'Jane Austen', handle: null, nameSource: undefined },
      { id: discoveryFixtures.journey.id, role: 'author' as const, participantKind: 'agent' as const,
        provider: null, key: null, ordinal: null, agent: discoveryFixtures.journey.id,
        displayName: 'Lin Mei', handle: 'lin_mei' },
    ] };
    expect(discoveryWork(item, { kind: 'global' }).authors).toEqual([
      { name: 'Jane Austen', href: '/authors/open-library/OL21594A' },
      { name: 'Lin Mei', href: '/@lin_mei' },
    ]);
  });
  test('a segment names an Open Library author only as Open Library writes their ID', () => {
    expect(parseOpenLibraryAuthor('OL21594A')).toBe('/authors/OL21594A');
    for (const segment of ['OL0A', 'OL21594W', 'ol21594a', 'OL21594A.json', '/authors/OL21594A', 'OL1234567890123A']) {
      expect(parseOpenLibraryAuthor(segment)).toBeNull();
    }
  });

  test('author names lead to the author page or the Agent profile', () => {
    expect(openLibraryAuthorHref('/authors/OL21594A')).toBe('/authors/open-library/OL21594A');
    expect(openLibraryAuthorHref('/authors/OL21594A', { kind: 'works' }, 'a b'))
      .toBe('/authors/open-library/OL21594A/works?cursor=a+b');
    expect(authorHref({ kind: 'external', key: '/authors/OL161167A' })).toBe('/authors/open-library/OL161167A');
    expect(authorHref({ kind: 'agent', handle: 'lin_mei' })).toBe('/@lin_mei');
    // A public page: links gain the locale prefix and unprefixed addresses redirect to one.
    expect(isPublicPagePath('/authors/open-library/OL21594A')).toBe(true);
    expect(isPublicPagePath('/zh-Hans/authors/open-library/OL21594A/works')).toBe(true);
    expect(isPublicPagePath('/authorsx')).toBe(false);
    expect(parseCursor(['a'])).toBeUndefined();
    expect(parseCursor('x'.repeat(2049))).toBeUndefined();
  });
});

describe('author facts in the reader’s language', () => {
  test('dates show what the source states, in either language', () => {
    expect(formatAuthorDate(facts(janeAusten).birthDate!, 'en', messages)).toBe('December 16, 1775');
    expect(formatAuthorDate(facts(janeAusten).birthDate!, 'zh-Hans', zh)).toBe('1775年12月16日');
    expect(formatAuthorDate(facts(caoXueqin).birthDate!, 'en', messages)).toBe('c. 1717');
    expect(formatAuthorDate(facts(caoXueqin).birthDate!, 'zh-Hans', zh)).toBe('约1717年');
    // A form Main could not read is kept as the source wrote it.
    expect(formatAuthorDate(facts(lewisCarroll).deathDate!, 'zh-Hans', zh)).toBe('winter of 1898');
    // Years before 100 are not shifted into the twentieth century.
    expect(formatAuthorDate({ ...facts(janeAusten).birthDate!, year: 79, month: null, day: null }, 'en', messages))
      .toBe('79');
  });

  test('the byline gives both years, or the one the source states', () => {
    expect(lifespan(janeAusten.facts, 'en', messages)).toBe('1775–1817');
    expect(lifespan(janeAusten.facts, 'zh-Hans', zh)).toBe('1775年—1817年');
    expect(lifespan(caoXueqin.facts, 'en', messages)).toBe('c. 1717–1763');
    expect(lifespan(lewisCarroll.facts, 'en', messages)).toBe('Born 1832');
    expect(lifespan({ birthDate: null, deathDate: facts(janeAusten).deathDate }, 'zh-Hans', zh)).toBe('卒于1817年');
    expect(lifespan(unnamedAuthor.facts, 'en', messages)).toBeNull();
  });

  test('an unnamed author is named by their Open Library ID', () => {
    const t = materializeData(messages, { locale: 'en' });
    expect(authorName(janeAusten, t)).toBe('Jane Austen');
    expect(authorName(unnamedAuthor, t)).toBe('Open Library author OL15669783A');
    expect(retrievedOn('2026-09-28T02:06:30.948Z', 'en')).toBe('September 28, 2026');
    expect(retrievedOn('not a date', 'en')).toBeNull();
  });
});

describe('author metadata', () => {
  test('titles and descriptions name the author and their years', () => {
    expect(authorMetadata(janeAusten, 'en', messages)).toMatchObject({ title: 'Jane Austen',
      description: 'Jane Austen (1775–1817). Works on REZICS, with ratings and readers.',
      openGraph: { type: 'profile' } });
    expect(authorMetadata(conanDoyle, 'zh-Hans', zh).description)
      .toBe('Arthur Conan Doyle（1859年—1930年）。REZICS 上的作品、评分与读者。');
    expect(authorMetadata(unnamedAuthor, 'en', messages).description)
      .toBe('Works by Open Library author OL15669783A on REZICS: ratings, readers and where to start.');
  });

  test('JSON-LD states plain dates, the same person elsewhere, and cannot close its script', () => {
    const data = JSON.parse(authorJsonLd(janeAusten, 'en', messages));
    expect(data.mainEntity).toEqual({ '@type': 'Person', name: 'Jane Austen',
      identifier: 'https://openlibrary.org/authors/OL21594A', birthDate: '1775-12-16', deathDate: '1817-07-18',
      sameAs: ['https://openlibrary.org/authors/OL21594A', ...facts(janeAusten).identifiers.map(item => item.url)] });
    expect(isoDate(facts(caoXueqin).birthDate)).toBeUndefined();
    expect(isoDate(facts(caoXueqin).deathDate)).toBe('1763');
    const hostile = { ...janeAusten, name: { ...janeAusten.name!, displayName: '</script><script>alert(1)</script>' } };
    expect(authorJsonLd(hostile, 'en', messages)).not.toContain('</script>');
  });
});
