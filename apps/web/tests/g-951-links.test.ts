import type { CanonicalAddress } from '@rezics/model/address';
import type { AvailableSummary } from '../features/work-levels/types.ts';
import { summaryHref } from '../features/entity-page/views.tsx';
import { standaloneHrefFor } from '../features/entity-page/route.ts';
import { describe, expect, test } from 'bun:test';
import { identityKeyUuid, uuidToSid } from '@rezics/model/address';
import { addressPath, type AddressTarget, spaceHref } from '../features/address/path.ts';
import { editHref } from '../features/work-levels-edit/route.ts';
import { connectionsHref, editionsHref } from '../features/work-levels/route.ts';
import { chapterHref, globalWorkHref, textHref, workHref } from '../features/work-page/route.ts';
import { wikiHref } from '../features/work-page/wiki.ts';
import { memberHref } from '../features/wiki/links.ts';
import { zoneFor } from '../features/wiki/fixtures.ts';

const work = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const space = '8a1b2c3d-4e5f-4678-9abc-def012345678';
const chapter = 'b5c7d9e1-f3a5-4b7c-9d1e-000000000003';
const iri = (id: string) => `https://rezics.com/id/${id}`;

function parsed(href: string) {
  const url = new URL(href, 'https://rezics.com');
  const path = addressPath(url.pathname);
  expect(path).not.toBeNull();
  return { url, path: path! };
}

describe('G-951 durable links preserve navigation state', () => {
  test('entity summaries carry Main canonical policy through the section adapter', () => {
    const address: CanonicalAddress = {
      prefix: '/w/',
      key: 'spring-story',
      suffixSource: 'Spring story',
    };
    const summary = {
      status: 'available',
      reference: iri(work),
      base: 'work',
      type: 'work',
      address,
    } as AvailableSummary & { address: CanonicalAddress };
    const hrefFor = summaryHref(standaloneHrefFor({}, globalWorkHref(work)));
    expect(parsed(hrefFor(summary)!).path.lookup.key).toBe('spring-story');
    expect(hrefFor({ ...summary, base: null })).toBeNull();
  });

  test('a UUID, native IRI and SID all point to the same short Work identity', () => {
    const links = [
      globalWorkHref(work),
      globalWorkHref(iri(work)),
      globalWorkHref(uuidToSid(work)),
    ];
    expect(new Set(links).size).toBe(1);
    const { path } = parsed(links[0]!);
    expect(path.lookup.scope).toBe('work');
    expect(path.lookup.key).toBe(uuidToSid(work));
    expect(identityKeyUuid(path.lookup.key)).toBe(work);
  });

  test('a supplied name address follows Main policy and encodes its segment', () => {
    const named: AddressTarget = {
      prefix: '/w/',
      key: '海の地図',
      suffixSource: 'The Cartographer of Tides',
    };
    expect(parsed(globalWorkHref(named)).path.lookup.key).toBe('海の地図');
    const identity: AddressTarget = { ...named, key: uuidToSid(work) };
    const { path } = parsed(globalWorkHref(identity));
    expect(path.lookup.key).toBe(`${uuidToSid(work)}-the-cartographer-of-tides`);
    expect(identityKeyUuid(path.lookup.key)).toBe(work);
  });

  test('tabs retain Realm scope and cursor without using a capability UUID as an address', () => {
    const { path, url } = parsed(
      workHref(work, 'versions', { kind: 'realm', realm: space }, { cursor: 'a/b+c' }),
    );
    expect(path.tail).toEqual(['versions']);
    expect(url.searchParams.get('realm')).toBe(space);
    expect(url.searchParams.get('cursor')).toBe('a/b+c');
    expect(path.lookup.key).toBe(uuidToSid(work));
  });

  test('the reader leaves a mounted Work for its global reader and keeps its language', () => {
    const at = { ref: work, path: spaceHref(space, 'site', ['books', 'named-book']), realm: space };
    const { path, url } = parsed(chapterHref(at, chapter, 'zh-Hant'));
    expect(path.lookup.scope).toBe('work');
    expect(path.lookup.key).toBe(uuidToSid(work));
    expect(path.tail).toEqual(['read', chapter]);
    expect(url.searchParams.get('language')).toBe('zh-Hant');
    expect(parsed(textHref(at, 'ja')).path.tail).toEqual(['read']);
    expect(parsed(workHref(at, 'discussion', { kind: 'realm', realm: space })).url.search).toBe('');
  });

  test('connection, edition and edit links retain their specific section and query', () => {
    const connections = parsed(
      connectionsHref(work, { grain: 'parts', partsAfter: 'next/page' }, 'parts'),
    );
    expect(connections.path.tail).toEqual(['connections']);
    expect(connections.url.searchParams.get('grain')).toBe('parts');
    expect(connections.url.searchParams.get('partsAfter')).toBe('next/page');
    expect(connections.url.hash).toBe('#parts');
    expect(parsed(editionsHref(work, { releasesAfter: 'next' }, 'releases')).path.tail).toEqual([
      'editions',
    ]);
    expect(parsed(editHref(work, 'relations')).path.tail).toEqual(['edit', 'relations']);
    expect(parsed(editHref(work, 'relations')).path.lookup.key).toBe(uuidToSid(work));
  });

  test('wiki links use the site surface and member links preserve the reader position', () => {
    const wiki = parsed(wikiHref(space, 'characters'));
    expect(wiki.path.surface).toBe('site');
    expect(wiki.path.lookup.key).toBe(uuidToSid(space));
    expect(wiki.path.tail).toEqual(['characters']);
    const member = parsed(
      memberHref({ ref: space, choice: { kind: 'all' } }, 'characters', iri(work)),
    );
    expect(member.path.surface).toBe('site');
    expect(member.path.tail).toEqual(['characters', uuidToSid(work)]);
    expect(member.url.searchParams.get('position')).toBe('all');
  });

  test('wiki story context separates the site from its community discussion and governance', () => {
    const zone = zoneFor('ja');
    expect(parsed(zone.links.home).path.surface).toBe('site');
    expect(parsed(zone.links.discussions).path.surface).toBe('community');
    expect(parsed(zone.links.about).path.tail).toEqual(['about']);
    expect(new URL(zone.links.home, 'https://rezics.com').pathname.split('/')[1]).toBe('ja');
  });
});
