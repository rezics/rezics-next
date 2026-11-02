import { afterAll, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';

const origin = 'https://type-display.invalid';
let authority = 'reader-a';
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: origin } }));
mock.module('../src/kernel/client.ts', () => ({
  requestLocale: () => 'de',
  kernelClient: () => createKernelClient(origin, { headers: { authorization: authority } }),
}));
const { typeNames, nameSubjectTypes, typeFrame, displayTypeLabel } = await import('../src/subject/definitions');
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
let status = 200;
let label = 'écran';
let definition: Record<string, unknown> = { bases: ['external:Base'], coverRatio: '9:16', schemaOrgType: 'https://schema.org/3DModel' };
const reads: { type: string; locale: string | null; authority: string | null }[] = [];
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  expect(url.pathname.startsWith('/v1/definitionTypes/')).toBe(true);
  const type = decodeURIComponent(url.pathname.slice('/v1/definitionTypes/'.length));
  reads.push({ type, locale: url.searchParams.get('locale'), authority: request.headers.get('authorization') });
  if (status !== 200 || type === 'unknown' || type === 'retired') return new Response(null, { status: status === 200 ? 404 : status });
  return Response.json({
    typeId: type, releaseDigest: type === 'schema:Book' ? 'legacy-release' : 'another-active-release',
    label: type === 'schema:Book' ? 'book' : label, language: type === 'schema:Book' ? 'en' : 'fr', definition,
  });
}) as typeof fetch;

test('Type display resolves only distinct requested Types beyond the legacy release with selected-language casing and effective hints', async () => {
  const subjects = [{ type: 'external:Poster' }, { type: 'external:Poster' }, { type: 'schema:Book' }, { type: 'unknown' }, { type: 'retired' }];
  await nameSubjectTypes(subjects);
  expect(subjects).toEqual([{ type: 'external:Poster', typeLabel: 'Écran' }, { type: 'external:Poster', typeLabel: 'Écran' }, { type: 'schema:Book', typeLabel: 'Book' }, { type: 'unknown' }, { type: 'retired' }]);
  expect(reads.map((read) => read.type).sort()).toEqual(['external:Poster', 'retired', 'schema:Book', 'unknown']);
  expect(reads.every((read) => read.locale === 'de')).toBe(true);
  expect(await typeFrame('external:Poster', 'de')).toEqual({ label: 'Écran', ratio: '9:16', schemaOrgType: 'https://schema.org/3DModel' });
  expect(reads.some((read) => read.type === 'external:Base')).toBe(false);
  expect(displayTypeLabel('𐐨film', 'en')).toBe('𐐀film');
});

test('Type display retries failed metadata without retaining labels across catalogue or caller changes', async () => {
  const subject = { type: 'external:Poster', typeLabel: 'Écran' };
  status = 503;
  await nameSubjectTypes([subject]);
  expect(subject).toEqual({ type: 'external:Poster' });
  expect(await typeFrame(subject.type, 'de')).toEqual({});
  status = 200;
  label = 'nouvelle édition';
  authority = 'reader-b';
  expect(await typeNames([subject.type], 'de')).toEqual(new Map([[subject.type, 'Nouvelle édition']]));
  expect(reads.at(-1)?.authority).toBe('reader-b');
  status = 401;
  expect(await typeNames([subject.type], 'de')).toEqual(new Map());
  status = 200;
});

test('Type display rejects unsafe optional hints and does not fetch parents to repair them', async () => {
  label = 'nouvelle édition';
  for (const schemaOrgType of ['https://schema.org/Book?bad', 'https://schema.org/Book\n', 'https://evil.test/Book', 4]) {
    definition = { bases: ['external:Base'], coverRatio: '65:1', schemaOrgType };
    expect(await typeFrame('external:Poster', 'de')).toEqual({ label: 'Nouvelle édition' });
  }
  const before = reads.length;
  expect(await typeNames([], 'de')).toEqual(new Map());
  expect(reads).toHaveLength(before);
});
