import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { CoverSummary } from '@rezics/ui/cover';
import type { SubjectPageData } from '../src/features/pages/subject';
import { projectShareCardPage } from '../src/media/share-card-page';
import * as cards from '../src/shell/share-card';
import recording from '../src/kernel/recorded/subject-page.json';

// Head-only tests never invoke Worker bindings; use the existing Web unit-test environment convention.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { subjectHead } = await import('../src/features/pages/subject-head');
const { subjectBody } = await import('../src/features/pages/subject');

const origin = 'https://rezics.example.test';
const id = recording.subject;
const path = `/en/subjects/${id}/current-label`;
const cover: CoverSummary = {
  media: 'current-public-cover',
  width: 1200,
  height: 1800,
  placeholder: { thumbhash: '', color: '#777' },
  variants: [
    { format: 'webp', width: 240 },
    { format: 'avif', width: 1200 },
    { format: 'webp', width: 1200 },
  ],
  focalPoint: null,
  credit: null,
};

function pageWithCover(value: CoverSummary | null = null): SubjectPageData {
  const page = structuredClone(recording) as SubjectPageData;
  const read = page.reads.r0!;
  const body = read.body as typeof recording.reads.r0.body;
  read.body = { ...body, summary: { ...body.summary, cover: value } };
  return page;
}

function head(page: SubjectPageData, extras: Partial<Parameters<typeof subjectHead>[1]> = {}) {
  const shareCard = projectShareCardPage({ kind: 'page', page }, { id, locale: 'en' });
  return subjectHead(page, { origin, locale: 'en', path, typeLabel: 'Book', shareCard, ...extras });
}

function tag(result: ReturnType<typeof head>, key: string): string | undefined {
  const item = result.meta.find(
    (entry) => ('property' in entry && entry.property === key) || ('name' in entry && entry.name === key),
  );
  return item && 'content' in item ? item.content : undefined;
}

let selection: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  selection?.mockRestore();
  selection = undefined;
});

test('the genuine current public cover keeps its largest variant, dimensions and localized alternative', () => {
  const page = pageWithCover(cover);
  const result = head(page);
  expect(tag(result, 'og:image')).toBe(`${origin}/media/current-public-cover/webp-1200`);
  expect(tag(result, 'og:image:width')).toBe('1200');
  expect(tag(result, 'og:image:height')).toBe('1800');
  expect(tag(result, 'og:image:alt')).toBe(subjectBody(page)!.subject.labels.en);
  expect(result.links.find((link) => link.rel === 'preload')?.imagesrcset).toContain('webp-1200');
});

test('uncovered and withheld pages consume the actual shared projection and image helper', () => {
  for (const value of [null, { ...cover, withheld: true }]) {
    const page = pageWithCover(value);
    const projection = projectShareCardPage({ kind: 'page', page }, { id, locale: 'en' });
    const image = cards.shareCardImage(projection);
    const result = head(page);
    expect(tag(result, 'og:image')).toBe(new URL(image.url, origin).href);
    expect(tag(result, 'twitter:image')).toBe(new URL(image.url, origin).href);
    expect(tag(result, 'og:image:alt')).toBe(image.alt);
    expect((result.links ?? []).some((link) => link.rel === 'preload')).toBe(false);
  }
});

test('a shared generated image changes only sharing image fields, preserving the existing metadata formula', () => {
  const page = pageWithCover();
  const before = head(page);
  // The owner module is absent in this base. This exercises its output seam, not native readiness or rendering.
  selection = spyOn(cards, 'shareCardImage').mockReturnValue({
    url: `/en/cards/${id}.png`,
    width: 1200,
    height: 630,
    alt: 'Shared public card',
  });
  const after = head(page);
  expect(tag(after, 'og:image')).toBe(`${origin}/en/cards/${id}.png`);
  expect(tag(after, 'twitter:image')).toBe(tag(after, 'og:image'));
  expect(tag(after, 'og:image:width')).toBe('1200');
  expect(tag(after, 'og:image:height')).toBe('630');
  const nonImage = (result: ReturnType<typeof head>) =>
    result.meta.filter(
      (entry) =>
        !('property' in entry && entry.property?.startsWith('og:image')) &&
        !('name' in entry && entry.name?.startsWith('twitter:image')),
    );
  expect(nonImage(after)).toEqual(nonImage(before));
  expect(after.links).toEqual(before.links);
  expect(after.scripts).toEqual(before.scripts);
  expect(selection).toHaveBeenCalledTimes(1);
});

test('Realm data cannot expose its body, cover or generated card in the public head', () => {
  selection = spyOn(cards, 'shareCardImage').mockReturnValue({
    url: `/en/cards/${id}.png`,
    width: 1200,
    height: 630,
    alt: 'Private title canary',
  });
  const page = pageWithCover({ ...cover, media: 'private-cover-canary' });
  const result = head(page, { realm: '00000000-0000-8000-8000-000000000001' });
  expect(tag(result, 'og:title')).toBe('REZICS');
  expect(tag(result, 'description')).toBeUndefined();
  expect(tag(result, 'og:image')).toBe(`${origin}/cards/default.png`);
  expect(tag(result, 'og:image:alt')).toBe('REZICS');
  expect(tag(result, 'robots')).toBe('noindex, follow');
  expect(result.scripts).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('private-cover-canary');
  expect(selection).not.toHaveBeenCalled();
});

test('denied or unavailable current subject reads keep static branding without old body metadata', () => {
  for (const status of [403, 404, 503]) {
    const page = pageWithCover({ ...cover, media: 'stale-cover-canary' });
    page.reads.r0!.status = status;
    const result = head(page);
    expect(tag(result, 'og:title')).toBe('REZICS');
    expect(tag(result, 'description')).toBeUndefined();
    expect(tag(result, 'og:image')).toBe(`${origin}/cards/default.png`);
    expect(result.scripts).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('stale-cover-canary');
    expect(tag(result, 'og:url')).toBe(`${origin}${path}`);
  }
});

test('missing and redirected loads cannot acquire public readiness through the unavailable boundary', () => {
  for (const loaded of [{ kind: 'missing' }, { kind: 'redirect', id }] as const) {
    const projection = projectShareCardPage(loaded, { id, locale: 'en' });
    expect(cards.shareCardImage(projection)).toEqual({
      url: '/cards/default.png',
      width: 1200,
      height: 630,
      alt: 'REZICS',
    });
  }
});
