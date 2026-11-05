import { expect, test } from 'bun:test';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { subjectPageJsonLd, type SubjectPageData } from '../src/features/pages/subject';
import fixture from '../src/kernel/recorded/subject-page.json';

const realm = '00000000-0000-8000-8000-000000000050';
const base = fixture as unknown as SubjectPageData;
test.each(['en', 'fr', 'ja'])('structured page identity retains the Realm and disclosure in %s', (locale) => {
  const global = JSON.parse(subjectPageJsonLd(base, locale)!);
  expect(global.url).toContain(`/${locale}/subjects/${fixture.subject}/`);
  for (const population of [{ kind: 'realm', id: realm, title: 'Readers' }, { kind: 'global' }] as const) {
    const requestedRealm = population.kind === 'global' ? realm : undefined;
    const id = population.kind === 'realm' ? '00000000-0000-8000-8000-000000000060' : PAGE_GLOBAL_CONTEXT;
    const page = { ...base, requestedRealm, context: { id, population } };
    expect(JSON.parse(subjectPageJsonLd(page, locale)!)).toEqual({ ...global, url: `${global.url}?realm=${realm}` });
  }
});
