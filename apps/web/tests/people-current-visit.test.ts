import { expect, test } from 'bun:test';
import { peopleBiographyAddress } from '../src/features/catalogue/people-biography/current-visit';
import { candidateContext } from '../src/subject/candidates';
import {
  peopleCurrentVisitGlobalHref,
  peopleCurrentVisitHref,
  peopleCurrentVisitNeedsGlobal,
  validatePeopleCurrentVisitSearch,
} from '../src/features/catalogue/people-current-visit';

const personId = '00000000-0000-4000-8000-000000000101';
const contextId = '00000000-0000-4000-8000-000000000102';
const realmId = '00000000-0000-4000-8000-000000000103';

function searchOf(href: string): Record<string, unknown> {
  const search = new URL(href, 'https://rezics.invalid').searchParams;
  const result: Record<string, unknown> = {};
  for (const [key, value] of search) {
    const current = result[key];
    result[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return result;
}

function originFrom(href: string) {
  const search = searchOf(href);
  const visit = validatePeopleCurrentVisitSearch(search, personId, 'en');
  if (visit.kind !== 'origin') throw new Error('Expected a valid Person origin');
  return visit.origin;
}

test('Person current visit keeps a bounded return origin and requires a fresh Global choice for nonGlobal sources', () => {
  const href = peopleCurrentVisitHref({
    id: personId,
    label: 'Mira Sato',
    locale: 'en',
    context: contextId,
    realm: realmId,
    definition: 'released:sha256-story-release',
    reader: 'source-reader-3',
    sourceAddress: `/en/subjects/${personId}/mira-sato?context=${contextId}&realm=${realmId}`,
  });
  const search = searchOf(href);
  const unsupported = validatePeopleCurrentVisitSearch(search, personId, 'en');
  expect(unsupported.kind).toBe('origin');
  if (unsupported.kind !== 'origin') return;
  expect(unsupported.origin).toMatchObject({
    id: personId,
    context: contextId,
    realm: realmId,
    locale: 'en',
    definition: 'released:sha256-story-release',
    reader: 'source-reader-3',
  });
  expect(peopleCurrentVisitNeedsGlobal(unsupported.origin)).toBe(true);

  const choice = peopleCurrentVisitGlobalHref(new URL(href, 'https://rezics.invalid').pathname, unsupported.origin);
  const selected = validatePeopleCurrentVisitSearch(searchOf(choice), personId, 'en');
  expect(selected).toMatchObject({ kind: 'origin', correction: 'global' });

  const directGlobal = peopleCurrentVisitHref({
    id: personId,
    label: 'Mira Sato',
    locale: 'en',
    context: candidateContext,
    definition: 'released:sha256-story-release',
  });
  const admittedGlobal = validatePeopleCurrentVisitSearch(searchOf(directGlobal), personId, 'en');
  expect(admittedGlobal.kind).toBe('origin');
  if (admittedGlobal.kind === 'origin') expect(peopleCurrentVisitNeedsGlobal(admittedGlobal.origin)).toBe(false);
});

test('Person current visit rejects wrong Person, locale, nested return, contradictory origin and overbudget query', () => {
  const origin = originFrom(
    peopleCurrentVisitHref({
      id: personId,
      label: 'Mira Sato',
      locale: 'en',
      context: contextId,
      definition: 'released:sha256-story-release',
      sourceAddress: `/en/subjects/${personId}/mira-sato?context=${contextId}`,
    }),
  );
  const invalid = (value: unknown) =>
    validatePeopleCurrentVisitSearch({ visit: JSON.stringify(value) }, personId, 'en');
  expect(
    validatePeopleCurrentVisitSearch({ visit: JSON.stringify(origin) }, '00000000-0000-4000-8000-000000000999', 'en'),
  ).toEqual({
    kind: 'invalid',
  });
  expect(validatePeopleCurrentVisitSearch({ visit: JSON.stringify(origin) }, personId, 'fr')).toEqual({
    kind: 'invalid',
  });
  expect(
    invalid({
      ...origin,
      returnAddress: `${origin.returnAddress}&via=${encodeURIComponent(origin.returnAddress)}`,
    }),
  ).toEqual({ kind: 'invalid' });
  expect(invalid({ ...origin, realm: realmId, returnAddress: origin.returnAddress })).toEqual({ kind: 'invalid' });
  expect(
    invalid({
      ...origin,
      returnAddress: `/en/subjects/${personId}/${'x'.repeat(1800)}?context=${contextId}`,
    }),
  ).toEqual({ kind: 'invalid' });
  expect(
    invalid({
      ...origin,
      returnAddress: `/fr/subjects/${personId}/mira-sato?context=${contextId}`,
    }),
  ).toEqual({ kind: 'invalid' });
  expect(
    invalid({
      ...origin,
      returnAddress: `/en/subjects/${personId}/mira-sato?context=${contextId}&context=${contextId}`,
    }),
  ).toEqual({ kind: 'invalid' });
  expect(invalid({ ...origin, unexpected: 'return-to' })).toEqual({ kind: 'invalid' });
  expect(invalid({ ...origin, definition: '' })).toEqual({ kind: 'invalid' });
  expect(validatePeopleCurrentVisitSearch({ visit: 'x'.repeat(2049) }, personId, 'en')).toEqual({ kind: 'invalid' });
  expect(validatePeopleCurrentVisitSearch({ correction: 'global' }, personId, 'en')).toEqual({ kind: 'invalid' });
});

test('biography returns admit the inner Global window and restore the separate same-Person outer heading', () => {
  const outer = `/en/subjects/${personId}/mira-sato?context=${contextId}&realm=${realmId}#person-biography`;
  const href = peopleBiographyAddress(
    personId,
    'Mira Sato',
    'en',
    candidateContext,
    'occupations',
    'wdt:P106',
    undefined,
    outer,
  );
  const url = new URL(href, 'https://rezics.invalid');
  expect(validatePeopleCurrentVisitSearch(searchOf(href), personId, 'en', url.hash)).toEqual({
    kind: 'biography',
    returnHref: outer,
  });
  expect(validatePeopleCurrentVisitSearch({ context: candidateContext }, personId, 'en', url.hash)).toEqual({
    kind: 'biography',
  });
  for (const search of [
    { ...searchOf(href), context: contextId },
    { ...searchOf(href), via: `/fr/subjects/${personId}/mira-sato` },
    { ...searchOf(href), via: `/en/subjects/${realmId}/other` },
    { ...searchOf(href), via: [outer, outer] },
    { ...searchOf(href), visit: '{}' },
  ])
    expect(validatePeopleCurrentVisitSearch(search, personId, 'en', url.hash)).toEqual({ kind: 'invalid' });
  expect(
    validatePeopleCurrentVisitSearch({ context: candidateContext }, personId, 'en', '#person-biography?field=bad'),
  ).toEqual({ kind: 'invalid' });
});
