import { expect, test } from 'bun:test';
import {
  characterProfileFixture,
  characterCreatedId,
  characterProfileId,
} from '../src/kernel/fake/catalogue-character-profile';
import {
  characterDraft,
  characterGroups,
  characterRelations,
  characterType,
  characterWorkDefinitions,
  characterWorkFields,
  filterCharacterWorks,
  isCurrentCharacterRead,
  validateCharacter,
} from '../src/features/catalogue/character-profile';
import { readCreatedSubject } from '../src/features/catalogue/create-subject-request';
import { relationActor, relationRole } from '../src/kernel/fake/catalogue-relations';
import { factChanged, sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { characterFacts } from '../src/features/catalogue/character-profile';

test('retained Character reads are disclosed only for a settled successful exact-address match', async () => {
  const fixture = characterProfileFixture();
  const read = await fixture.transport.load({ id: characterProfileId });
  if (!read.ok) throw new Error('Expected Character');
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: false }, { id: characterProfileId })).toBe(true);
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: true }, { id: characterProfileId })).toBe(false);
  expect(isCurrentCharacterRead(read, { isSuccess: false, isFetching: false }, { id: characterProfileId })).toBe(false);
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: false }, { id: characterCreatedId })).toBe(false);
  expect(
    isCurrentCharacterRead(
      read,
      { isSuccess: true, isFetching: false },
      { id: characterProfileId, work: characterCreatedId },
    ),
  ).toBe(false);
});

test('selected-work eligibility uses the exact current Type from another release and bounds picker reads', async () => {
  const fixture = characterProfileFixture();
  const type = 'example:AnotherWork';
  const original = fixture.work.publicRead.subject.type;
  const definition = fixture.release.types[original]!;
  fixture.work.publicRead.subject.type = type;
  const descriptor = {
    typeId: type,
    releaseDigest: `sha256:${'b'.repeat(64)}`,
    label: 'Another work',
    language: 'en',
    description: null,
    descriptionLanguage: null,
    definition,
    properties: Object.fromEntries(definition.properties.map((id) => [id, fixture.release.properties[id]!])),
  };
  fixture.descriptorResponses.set(type, { status: 200, body: descriptor });
  const read = await fixture.transport.load({ id: characterProfileId, work: fixture.work.id });
  if (!read.ok) throw new Error('Expected a work from another active release');
  expect(read.workDescriptor).toEqual(descriptor);
  expect(read.work?.subject.release).toBe(fixture.work.publicRead.subject.release);
  expect(characterWorkFields(characterWorkDefinitions(descriptor), type)).toContain('wdt:P725');
  expect(read.release.types[type]).toBeUndefined();
  const entries = Array.from({ length: 12 }, (_, id) => ({ id, types: [type] }));
  const start = fixture.calls.length;
  expect(await filterCharacterWorks(entries, fixture.transport.workType!, new AbortController().signal)).toEqual(
    entries.slice(0, 8),
  );
  expect(fixture.calls.slice(start).map((call) => call.path)).toEqual([
    `/v1/definitionTypes/${encodeURIComponent(type)}`,
  ]);
});

test('failed and mismatched descriptors conceal retained reads and recover at the same selected address', async () => {
  const fixture = characterProfileFixture();
  const address = { id: characterProfileId, work: fixture.work.id };
  const retained = await fixture.transport.load(address);
  if (!retained.ok || !retained.workDescriptor) throw new Error('Expected selected work');
  const draft = characterDraft(
    retained.release,
    [{ language: 'en', label: 'Retained traveler', description: '', aliases: '' }],
    [],
  );
  const command = { item: draft.item, key: crypto.randomUUID() };
  const exact = structuredClone(command);
  const type = retained.workDescriptor.typeId;
  for (const response of [
    { status: 503, body: {} },
    { status: 200, body: { ...retained.workDescriptor, typeId: characterType } },
  ]) {
    fixture.descriptorResponses.set(type, response);
    expect(await fixture.transport.load(address)).toEqual({ ok: false, reason: 'unavailable' });
    expect(isCurrentCharacterRead(retained, { isSuccess: false, isFetching: false }, address)).toBe(false);
    await expect(
      filterCharacterWorks([{ types: [type] }], fixture.transport.workType!, new AbortController().signal),
    ).rejects.toThrow();
    expect(command).toEqual(exact);
  }
  fixture.descriptorResponses.set(type, { status: 404, body: {} });
  expect(await fixture.transport.load(address)).toEqual({ ok: false, reason: 'invalid' });
  fixture.descriptorResponses.delete(type);
  const recovered = await fixture.transport.load(address);
  expect(isCurrentCharacterRead(recovered, { isSuccess: true, isFetching: false }, address)).toBe(true);
  expect(command).toEqual(exact);
});

test('Character identity and credit editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  const fixture = characterProfileFixture();
  const read = await fixture.transport.load({ work: fixture.work.id });
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('Expected current release');
  expect(read.character).toBeNull();
  expect(read.work?.subject.id).toBe(fixture.work.id);
  expect(characterGroups(read.release).traits).toContain('schema:gender');
  expect(characterGroups(read.release).measurements).toContain('schema:height');
  const draft = characterDraft(
    read.release,
    [
      { language: 'en', label: 'A new traveler', description: '', aliases: '' },
      { language: 'ja', label: '新しい旅人', description: '', aliases: '旅人' },
    ],
    [
      {
        property: { id: 'schema:height' },
        value: { type: 'value', content: { amount: '+168', unit: 'http://www.wikidata.org/entity/Q174728' } },
        qualifiers: [],
        references: [],
        rank: 'normal',
      },
    ],
  );
  expect(draft.errors).toEqual([]);
  expect(draft.item.type).toBe(characterType);
  expect(Object.keys(draft.item.statements)).toEqual(['schema:height']);
  const command = { item: draft.item, key: crypto.randomUUID() };
  const result = await fixture.transport.create(command);
  expect(result).toMatchObject({ ok: true, id: characterCreatedId, reader: { state: 'ready' } });
  const write = fixture.calls.find((call) => call.method === 'POST');
  expect(write).toEqual({ method: 'POST', path: '/v1/subjects', key: command.key, body: draft.item });
  expect(fixture.calls.at(-1)?.path).toBe(`/v1/subjects/${characterCreatedId}`);
  expect(draft.item).not.toHaveProperty('source');
  expect(draft.item.statements).not.toHaveProperty('schema:character');
  expect(validateCharacter(read.release, { ...draft.item, type: 'schema:Person' }).length).toBeGreaterThan(0);
  expect(
    validateCharacter(read.release, {
      ...draft.item,
      statements: {
        'wdt:P725': [
          {
            property: { id: 'wdt:P725' },
            value: { type: 'value', content: relationActor },
            qualifiers: [],
            references: [],
          },
        ],
      },
    }).length,
  ).toBeGreaterThan(0);
  const fields = characterRelations(await fixture.work.transport.read(), read.release);
  expect(fields.ok).toBe(true);
  if (!fields.ok) throw new Error('Expected native work credit fields');
  expect(fields.fields.find((field) => field.id === 'wdt:P725')?.slotKey).toBe('wdt:P453');
  const proposed = await fixture.work.transport.propose({
    id: fixture.work.id,
    slot: { property: 'wdt:P725', target: relationActor, key: relationRole },
    statement: structuredClone(fixture.work.draft),
    key: crypto.randomUUID(),
  });
  expect(proposed.ok).toBe(true);
  const creditWrite = fixture.work.calls.find((call) => call.method === 'POST');
  expect(creditWrite?.path).toBe(`/v1/subjects/${fixture.work.id}/candidates`);
  expect(creditWrite?.body).toMatchObject({
    statement: {
      property: { id: 'wdt:P725' },
      qualifiers: expect.arrayContaining([
        { property: { id: 'wdt:P453' }, value: { type: 'value', content: characterProfileId } },
      ]),
    },
  });
  expect(fixture.work.adopted).toBe(false);
  expect(fixture.work.publicRead.subject.statements['wdt:P725']).toHaveLength(3);
});

test('character correction and uncertain creation retain native facts, keys and exact readback', async () => {
  const fixture = characterProfileFixture();
  const read = await fixture.transport.load({ id: characterProfileId });
  if (!read.ok) throw new Error('Expected character');
  const current = characterFacts(read);
  if (!current.ok) throw new Error('Expected facts');
  const staged = stageFact(current, 'schema:height', current.public.subject.statements['schema:height']![0]!.id)!;
  expect(factChanged(staged)).toBe(false);
  expect(sealFacts(characterProfileId, read.release, [staged])[0]?.command).toBeUndefined();
  staged.statement.value = {
    type: 'value',
    content: { amount: '+171', unit: 'http://www.wikidata.org/entity/Q174728' },
  };
  const sealed = sealFacts(characterProfileId, read.release, [staged]);
  let candidate: string | undefined;
  await sendFacts(sealed, fixture.props.facts(characterProfileId).propose, (_property, result) => {
    if (result.ok) candidate = result.candidate;
  });
  expect(candidate).toBeDefined();
  expect(fixture.candidates[0]?.id).toBe(candidate);
  expect(fixture.character.subject.labels).toEqual({ en: 'The traveler', ja: '旅人' });
  expect(fixture.character.subject.statements['schema:height']![0]!.value).toEqual(staged.baseline!.value);
  const lost = characterProfileFixture('uncertain');
  const draft = characterDraft(lost.release, [{ language: 'en', label: 'Traveler', description: '', aliases: '' }], []);
  const command = { item: draft.item, key: crypto.randomUUID() };
  expect(await lost.transport.create(command)).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await lost.transport.create(command)).toMatchObject({ ok: true, id: characterCreatedId });
  expect(lost.calls.filter((call) => call.method === 'POST').map((call) => call.key)).toEqual([
    command.key,
    command.key,
  ]);
  const concealed = characterProfileFixture('concealed');
  expect(await readCreatedSubject(concealed.client, characterCreatedId, 'en')).toEqual({ state: 'concealed' });
  expect(await characterProfileFixture('stale').transport.load({})).toEqual({ ok: false, reason: 'unavailable' });
});
