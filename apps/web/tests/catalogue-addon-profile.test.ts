import { expect, test } from 'bun:test';
import {
  addonBase,
  addonDraft,
  addonFacts,
  addonFields,
  addonType,
  validateAddon,
} from '../src/features/catalogue/addon-profile';
import {
  addonProfileFixture,
  addonProfileId,
  addonCreatedId,
  addonWorkId,
  addonPlatformId,
  addonCreatorId,
} from '../src/kernel/fake/catalogue-addon-profile';
import { factChanged, sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { selectCandidate } from '../src/subject/candidates';
import { catalogueEntries, contributionHref } from '../src/features/catalogue/catalogue-entry';
import type { StatementInput } from '../src/features/catalogue/statement-editor';

const fact = (property: string, content: unknown): StatementInput => ({
  property: { id: property },
  value: { type: 'value', content },
  qualifiers: [],
  references: [],
});
const terms = [{ language: 'en', label: 'Northern lights', description: '', aliases: '' }];
const date = { time: '+2026-10-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' };

test('Add-on and expansion editor uses current admitted native fields and actual candidate-reader semantics', async () => {
  const fixture = addonProfileFixture();
  const read = await fixture.transport.load({ work: addonWorkId });
  if (!read.ok) throw new Error('Expected active add-on profile');
  expect(read.public).toBeNull();
  expect(read.release.types[addonType]?.library?.profileId).toBe('game.addon');
  expect(addonFields(read.release)).toEqual(
    expect.arrayContaining([addonBase, 'schema:gamePlatform', 'schema:inLanguage', 'schema:datePublished', 'wdt:P178']),
  );
  const base = fact(addonBase, addonWorkId);
  base.references = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/expansion' } }] },
  ];
  const platform = fact('schema:gamePlatform', addonPlatformId);
  platform.qualifiers = [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }];
  const creator = fact('wdt:P178', addonCreatorId);
  creator.qualifiers = [{ property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Original credit' } }];
  const draft = addonDraft(
    read.release,
    [...terms, { language: 'ja', label: '北の光', description: '', aliases: '' }],
    [base, platform, creator, fact('schema:datePublished', date)],
  );
  expect(draft.errors).toEqual([]);
  expect(draft.item.type).toBe(addonType);
  expect(draft.item.statements).not.toHaveProperty('schema:inLanguage');
  expect(draft.item).not.toHaveProperty('source');
  const command = { item: draft.item, key: crypto.randomUUID() };
  expect(await fixture.transport.create(command)).toMatchObject({
    ok: true,
    id: addonCreatedId,
    reader: { state: 'ready' },
  });
  expect(fixture.calls.find((call) => call.method === 'POST')).toMatchObject({
    path: '/v1/subjects',
    key: command.key,
    body: draft.item,
  });
  expect(fixture.calls.at(-1)?.path).toBe(`/v1/subjects/${addonCreatedId}`);
  const created = await fixture.client.subjects({ id: addonCreatedId }).get();
  expect(created.data?.subject.statements[addonBase]?.[0]?.references[0]?.parts[0]?.value).toEqual(
    base.references[0]!.parts[0]!.value,
  );
  expect(created.data?.subject.statements['schema:gamePlatform']?.[0]?.qualifiers[0]?.value).toEqual(
    platform.qualifiers[0]!.value,
  );
  expect(validateAddon(read.release, { ...draft.item, type: 'schema:VideoGame' }).length).toBeGreaterThan(0);
  expect(addonDraft(read.release, terms, [fact('schema:inLanguage', 'not a language')]).errors.length).toBeGreaterThan(
    0,
  );
  expect(
    addonDraft(read.release, terms, [
      fact('schema:datePublished', { ...date, precision: 11, time: '+2026-02-30T00:00:00Z' }),
    ]).errors.length,
  ).toBeGreaterThan(0);
  const correction = await fixture.transport.load({ id: addonProfileId });
  if (!correction.ok) throw new Error('Expected add-on reader');
  const relationRead = await fixture.props.relations(addonProfileId).read();
  if (!relationRead.ok) throw new Error('Expected emitted relation fields');
  expect(relationRead.fields.find((field) => field.id === 'wdt:P725')?.slotKey).toBe('wdt:P453');
  expect(relationRead.fields.find((field) => field.id === addonBase)?.targets).toEqual(['schema:VideoGame']);
  expect(await fixture.transport.load({ id: addonWorkId })).toEqual({ ok: false, reason: 'invalid' });
  const suggested = await fixture.transport.load({ work: addonProfileId });
  expect(suggested).toMatchObject({ ok: true, public: null, workIssue: 'invalid' });
  if (!suggested.ok) throw new Error('Expected disclosed work suggestion');
  expect(suggested.work?.subject.id).toBe(addonProfileId);
  expect(suggested.work?.subject.type).toBe(addonType);
});

test('changed fields retain independent partial results and current publication is established by the actual reader', async () => {
  const fixture = addonProfileFixture('partial');
  const read = await fixture.transport.load({ id: addonProfileId });
  if (!read.ok) throw new Error('Expected current reading');
  const current = addonFacts(read);
  if (!current.ok) throw new Error('Expected scalar facts');
  const unchanged = stageFact(
    current,
    'schema:inLanguage',
    current.public.subject.statements['schema:inLanguage']![0]!.id,
  )!;
  expect(factChanged(unchanged)).toBe(false);
  expect(sealFacts(addonProfileId, read.release, [unchanged])[0]?.command).toBeUndefined();
  const language = structuredClone(unchanged);
  language.statement.value = { type: 'value', content: 'ko' };
  const published = stageFact(current, 'schema:datePublished', null)!;
  published.statement.value = { type: 'value', content: date };
  const sealed = sealFacts(addonProfileId, read.release, [language, published]);
  const results: unknown[] = [];
  await sendFacts(sealed, fixture.props.facts(addonProfileId).propose, (_property, result) => results.push(result));
  expect(results).toContainEqual({ ok: false, reason: 'denied' });
  expect(
    results.some(
      (result) =>
        typeof result === 'object' && result !== null && Reflect.get(result, 'kind') === 'proposed-awaiting-review',
    ),
  ).toBe(true);
  expect(fixture.current.subject.statements['schema:inLanguage']![0]!.value).toEqual(unchanged.statement.value);
  expect(fixture.current.subject.statements['schema:datePublished']).toBeUndefined();
  const candidate = fixture.candidates[0]!;
  const accepted = await selectCandidate(fixture.client, 'Bearer fixture', {
    id: addonProfileId,
    property: 'schema:datePublished',
    candidate: candidate.id,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
  });
  expect(accepted).toMatchObject({ ok: true, kind: 'accepted' });
  const selected = await selectCandidate(fixture.client, 'Bearer fixture', {
    id: addonProfileId,
    property: 'schema:datePublished',
    candidate: candidate.id,
    operation: 'adopt',
    head: null,
    key: crypto.randomUUID(),
  });
  expect(selected).toMatchObject({ ok: true, kind: 'selected' });
  const pending = addonProfileFixture('pending');
  const proposed = await pending.props
    .facts(addonProfileId)
    .propose({ id: addonProfileId, statement: fact('schema:inLanguage', 'fr'), key: crypto.randomUUID() });
  if (!proposed.ok) throw new Error('Expected proposal');
  expect(
    await selectCandidate(pending.client, 'Bearer fixture', {
      id: addonProfileId,
      property: 'schema:inLanguage',
      candidate: proposed.candidate,
      operation: 'adopt',
      head: null,
      key: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: true, kind: 'pending' });
});

test('uncertain creation preserves exact keys and failed readback and entry navigation preserve identity', async () => {
  const fixture = addonProfileFixture('uncertain');
  const draft = addonDraft(fixture.release, terms, []);
  const command = { item: draft.item, key: crypto.randomUUID() };
  expect(await fixture.transport.create(command)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await fixture.transport.create(command)).toMatchObject({ ok: true, id: addonCreatedId });
  expect(
    fixture.calls.filter((call) => call.method === 'POST').map((call) => ({ key: call.key, body: call.body })),
  ).toEqual([
    { key: command.key, body: draft.item },
    { key: command.key, body: draft.item },
  ]);
  for (const [scenario, state] of [
    ['reader-unavailable', 'unavailable'],
    ['concealed', 'concealed'],
  ] as const) {
    const readback = addonProfileFixture(scenario);
    expect(await readback.transport.create(command)).toMatchObject({ ok: true, id: addonCreatedId, reader: { state } });
    await readback.transport.read(addonCreatedId);
    expect(readback.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  }
  expect(await addonProfileFixture('stale').transport.load({})).toEqual({ ok: false, reason: 'unavailable' });
  const entry = catalogueEntries.addon({ locale: 'ja', work: addonWorkId });
  expect(entry.href).toBe(`/ja/catalogue/addon?work=${addonWorkId}`);
  expect(contributionHref(entry, true)).toBe(`/auth/sign-in?return_to=${encodeURIComponent(entry.href)}`);
  expect(catalogueEntries.addon({ locale: 'en', id: addonProfileId, label: 'Expansion' }).href).toBe(
    `/en/subjects/${addonProfileId}/expansion/addon`,
  );
});
