import { expect, test } from 'bun:test';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { subjectPageJsonLd, type SubjectPageData } from '../src/features/pages/subject';
import fixture from '../src/kernel/recorded/subject-page.json';

const realm = '00000000-0000-8000-8000-000000000050';
const base: SubjectPageData = { ...fixture, template: { ...fixture.template, scope: 'base' } };

test.each([
  ['en', 'the-little-prince'],
  ['fr', 'le-petit-prince'],
  ['ja', '星の王子さま'],
])('structured page identity retains the Realm and disclosure in %s', (locale, slug) => {
  const url = `https://rezics.com/${locale}/subjects/${fixture.subject}/${encodeURIComponent(slug)}`;
  const global = JSON.parse(subjectPageJsonLd(base, locale)!);
  const [subject, breadcrumbs] = global['@graph'];
  const [home, type, leaf] = breadcrumbs.itemListElement;
  expect(subject.url).toBe(url);
  expect(leaf.item).toBe(url);

  for (const population of [{ kind: 'realm', id: realm, title: 'Readers' }, { kind: 'global' }] as const) {
    const requestedRealm = population.kind === 'global' ? realm : undefined;
    const id = population.kind === 'realm' ? '00000000-0000-8000-8000-000000000060' : PAGE_GLOBAL_CONTEXT;
    const page = { ...base, requestedRealm, context: { id, population } };
    const realmUrl = `${url}?realm=${realm}`;
    expect(JSON.parse(subjectPageJsonLd(page, locale)!)).toEqual({
      ...global,
      '@graph': [
        { ...subject, url: realmUrl },
        { ...breadcrumbs, itemListElement: [home, type, { ...leaf, item: realmUrl }] },
      ],
    });
  }
});
