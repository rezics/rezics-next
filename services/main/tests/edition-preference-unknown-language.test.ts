import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { editionChoice, editionPreference, InvalidEditionPreference, type EditionChoice } from '../src/modules/session/preference-contract.ts';
import { EditionPreferenceStore } from '../src/modules/session/preference-store.ts';
import { preferenceReleaseMatches } from '../src/modules/session/preference-release.ts';
import { checkedRelease, type ReleaseV2Record } from '../src/modules/release/schema.ts';
import { progressSummariesRoutes } from '../src/routes/progress-summaries.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const owner = { principal: { issuer: 'https://account.test', subject: 'reader' }, agent: id(1) };
const choice = { language: null, edition: { kind: 'release' as const, resource: id(3), revision: id(4) } };

test('a visitor choosing a retained release with unknown language reaches authentication', async () => {
  let verified = 0;
  const work = { editionPreferences: {}, account: { verify: async () => {
    verified++; throw new AccountAssertionDenied('Authentication required');
  } } } as unknown as MainWorkDependencies;
  const response = await progressSummariesRoutes(work).handle(new Request(
    `http://main.test/v1/me/edition-preferences/${uuid(2)}`, { method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'unknown-language' },
      body: JSON.stringify({ actingSubject: owner.agent, expectedVersion: 0, ...choice }) }));
  expect(response.status).toBe(401);
  expect(verified).toBe(1);
  expect((await response.json()).code).toBe('account_assertion_denied');
});

test('an unknown language needs a retained release pin before storage is touched', async () => {
  let queries = 0;
  const store = new EditionPreferenceStore({ connect: async () => { queries++; throw new Error('unexpected storage'); } } as unknown as Pool);
  for (const edition of [null, { kind: 'realization', resource: id(3), revision: id(4) }]) {
    await expect(store.write(owner, id(2), { language: null, edition } as unknown as EditionChoice,
      0, 'unknown-language', async () => {})).rejects.toBeInstanceOf(InvalidEditionPreference);
  }
  expect(queries).toBe(0);
});

const release = (languages: string[], work = id(2)) => checkedRelease({
  profile: 'release-v1', expectedHead: null, actingSubject: id(1), id: id(3),
  kind: 'formal', status: 'official', contentLanguages: languages, isTranslation: false,
  originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
  title: { value: 'Book', language: 'en' }, editionStatement: null, publisher: null,
  publicationYear: 1900, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
}, work);

test('an unknown retained release language stays unknown, with exact Work coverage', () => {
  const unknown = release([]);
  expect(preferenceReleaseMatches(unknown, id(2), null)).toBe(true);
  expect(preferenceReleaseMatches(unknown, id(9), null)).toBe(false);
  expect(preferenceReleaseMatches(unknown, id(2), 'en')).toBe(false);
  expect(preferenceReleaseMatches(release(['en']), id(2), null)).toBe(false);
  expect(preferenceReleaseMatches(release(['en']), id(2), 'en')).toBe(true);
  expect(preferenceReleaseMatches(release(['en']), id(2), 'fr')).toBe(false);
  expect(Value.Check(editionChoice, choice)).toBe(true);
  expect(Value.Check(editionPreference, { work: id(2), ...choice, version: 1 })).toBe(true);
});

test('realization-backed release coverage still requires its recorded language and Work', () => {
  const record = { ...release(['en']), profile: 'release-v2', resolvedCoverage: [
    { work: id(2), realization: id(5), revision: id(6), language: 'en', kind: 'original', status: 'official' },
  ] } as unknown as ReleaseV2Record;
  expect(preferenceReleaseMatches(record, id(2), 'en')).toBe(true);
  expect(preferenceReleaseMatches(record, id(2), null)).toBe(false);
  expect(preferenceReleaseMatches(record, id(2), 'fr')).toBe(false);
  expect(preferenceReleaseMatches(record, id(9), 'en')).toBe(false);
});
