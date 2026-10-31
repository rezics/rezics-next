import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import definitions from '../src/kernel/recorded/definitions-release.json';
import {
  createScreenProfile,
  screenCreateTypes,
  screenGroups,
  screenInitialFacts,
  screenTarget,
} from '../src/features/catalogue/screen-profile';
import { initialTerms } from '../src/features/catalogue/create-subject';
import { statementInput, type StatementInput } from '../src/features/catalogue/statement-editor';
import { sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { catalogueCreateFixture, catalogueCreatedId } from '../src/kernel/fake/catalogue-create';
import { screenProfileFixture } from '../src/kernel/fake/catalogue-screen-profile';

const release = definitions.release as Release;
const fact = (id: string, content: Extract<StatementInput['value'], { type: 'value' }>['content']): StatementInput => ({
  property: { id },
  value: { type: 'value', content },
  qualifiers: [],
  references: [],
  rank: 'normal',
});

test('Film television and episode editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  expect(
    screenCreateTypes(release, 'en')
      .map((entry) => entry.id)
      .sort(),
  ).toEqual(['schema:Movie', 'schema:TVSeries', 'schema:TVSeason', 'schema:Episode'].sort());
  expect(screenGroups(release, 'schema:Movie').amounts).toContain('schema:duration');
  expect(screenGroups(release, 'schema:TVSeries').amounts).not.toContain('schema:duration');
  expect(screenGroups(release, 'schema:TVSeason').text).not.toContain('schema:seasonNumber');
  expect(screenGroups(release, 'schema:Episode').parts).toContain('schema:isPartOf');
  expect(screenGroups(release, 'schema:Movie').credits).toContain('wdt:P725');
  expect(screenGroups(release, 'rezics:AnimeRelease').credits).toEqual([]);
  expect(screenTarget(release, 'schema:isPartOf', 'schema:TVSeason')).toBe(true);
  expect(screenTarget(release, 'schema:isPartOf', 'rezics:AnimeRelease')).toBe(false);
  const initial = initialTerms('schema:Episode', [
    { language: 'ja', label: '観測所', description: '', aliases: '仮題' },
    { language: 'en', label: 'The observatory', description: 'An original episode', aliases: '' },
  ]).item;
  const part = '00000000-0000-4000-8000-000000000301';
  const facts = [
    fact('schema:duration', { amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' }),
    fact('schema:episodeNumber', '0.5'),
    fact('schema:isPartOf', part),
    fact('schema:datePublished', {
      time: '+2026-10-00T00:00:00Z',
      precision: 10,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    }),
  ];
  facts.push({
    ...fact('wdt:P725', '00000000-0000-4000-8000-000000000302'),
    qualifiers: [
      { property: { id: 'wdt:P453' }, value: { type: 'value', content: '00000000-0000-4000-8000-000000000303' } },
      { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'A. Observer' } },
      { property: { id: 'schema:position' }, value: { type: 'value', content: '2' } },
    ],
  });
  const draft = screenInitialFacts(release, initial, facts);
  expect(draft.errors).toEqual([]);
  expect(
    screenInitialFacts(release, initial, [
      fact('schema:duration', { amount: '+24', unit: 'http://www.wikidata.org/entity/Q7727' }),
    ]).errors.length,
  ).toBeGreaterThan(0);
  expect(screenInitialFacts(release, initial, [fact('schema:seasonNumber', '1')]).errors.length).toBeGreaterThan(0);
  const stale = structuredClone(release);
  stale.types['schema:Episode']!.properties = stale.types['schema:Episode']!.properties.filter(
    (id) => id !== 'schema:duration',
  );
  expect(screenInitialFacts(stale, initial, facts).errors.length).toBeGreaterThan(0);
  const native = catalogueCreateFixture();
  const command = { item: draft.item, key: crypto.randomUUID() };
  const result = await createScreenProfile(
    native.client,
    new Request('https://site.invalid/api', {
      method: 'POST',
      headers: { authorization: 'Bearer fixture' },
    }),
    {},
    command,
    'en',
  );
  expect(result).toMatchObject({
    ok: true,
    id: catalogueCreatedId,
    reader: { state: 'ready', href: `/en/subjects/${catalogueCreatedId}/the-observatory` },
  });
  const write = native.calls.find((call) => call.method === 'POST')!;
  expect(write.body).toEqual(draft.item);
  expect(write.key).toBe(command.key);
  expect(Object.keys(write.body as object).sort()).toEqual(['aliases', 'descriptions', 'labels', 'statements', 'type']);
  expect(native.calls.at(-1)).toMatchObject({
    path: `/v1/subjects/${catalogueCreatedId}`,
    authorization: null,
    session: 'created-session',
  });
});

test('Screen corrections keep unchanged qualifiers and per-field uncertain keys until exact candidate review', async () => {
  const fixture = screenProfileFixture('partial', 'en', true);
  const read = await fixture.facts.transport.read();
  if (!read.ok) throw new Error('Expected current profile');
  const original = structuredClone(read.public.subject);
  const date = stageFact(read, 'schema:datePublished', fixture.facts.date.source.id)!;
  const language = stageFact(read, 'schema:inLanguage', fixture.facts.language.source.id)!;
  expect(date.statement).toEqual(statementInput(fixture.facts.date.source));
  const unchanged = sealFacts(fixture.id, read.release, [date]);
  expect(unchanged[0]!.command).toBeUndefined();
  date.statement.value = {
    type: 'value',
    content: { time: '+2026-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  };
  language.statement.value = { type: 'value', content: 'ja' };
  const commands = sealFacts(fixture.id, read.release, [date, language]);
  const outcomes: boolean[] = [];
  await sendFacts(commands, fixture.facts.transport.propose, (_property, result) => outcomes.push(result.ok));
  expect(outcomes.sort()).toEqual([false, true]);
  const after = await fixture.facts.transport.read();
  expect(after.ok && after.public.subject).toEqual(original);
  expect(commands[0]!.command!.statement.references).toEqual(date.baseline!.references);
  const review = await fixture.facts.review('schema:datePublished').read('schema:datePublished');
  expect(
    review.ok && review.page.candidates.some((candidate) => candidate.id === fixture.facts.date.candidate.id),
  ).toBe(true);
  const uncertain = screenProfileFixture('uncertain', 'en', true);
  const current = await uncertain.facts.transport.read();
  if (!current.ok) throw new Error('Expected current profile');
  const replacement = stageFact(current, 'schema:datePublished', uncertain.facts.date.source.id)!;
  replacement.statement.value = date.statement.value;
  const sealed = sealFacts(uncertain.id, current.release, [replacement]);
  let outcome;
  await sendFacts(sealed, uncertain.facts.transport.propose, (_property, result) => {
    outcome = result;
  });
  expect(outcome).toEqual({ ok: false, reason: 'uncertain' });
  await sendFacts(sealed, uncertain.facts.transport.propose, () => {});
  const writes = uncertain.facts.date.calls.filter((call) => call.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  const creation = catalogueCreateFixture('uncertain');
  const command = {
    key: crypto.randomUUID(),
    item: screenInitialFacts(
      release,
      initialTerms('schema:Episode', [{ language: 'en', label: 'The observatory', description: '', aliases: '' }]).item,
      [fact('schema:episodeNumber', '0.5')],
    ).item,
  };
  const retry = () =>
    createScreenProfile(
      creation.client,
      new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
      {},
      command,
      'en',
    );
  // The native request seam has no definitions producer: retry must still reach native deduplication.
  expect(await retry()).toEqual({ ok: false, reason: 'unavailable' });
  expect(await retry()).toMatchObject({ ok: true, id: catalogueCreatedId });
  const creates = creation.calls.filter((call) => call.method === 'POST');
  expect(creates).toHaveLength(2);
  expect(creates[0]!.body).toEqual(command.item);
  expect(creates[1]!.body).toEqual(creates[0]!.body);
  expect(creates[1]!.key).toBe(command.key);
});
