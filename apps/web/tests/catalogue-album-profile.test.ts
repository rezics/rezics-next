import { expect, test } from 'bun:test';
import { albumDraft, albumFields, albumTarget, validateAlbum } from '../src/features/catalogue/album-profile';
import { sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { statementInput } from '../src/features/catalogue/statement-editor';
import { relationDraft } from '../src/subject/relation-candidates';
import { albumExample, albumFixture, albumId, artistId, roleId } from '../src/kernel/fake/catalogue-album-profile';

test('Released album catalogue editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  const fixture = albumFixture();
  const initial = await fixture.transport.load();
  if (!initial.ok) throw new Error('Expected released album');
  const draft = albumDraft(
    initial.release,
    [{ language: 'en', label: 'Harbour sessions', description: '', aliases: 'Harbour demos' }],
    Object.values(albumExample().statements).flat(),
  );
  expect(draft.errors).toEqual([]);
  const created = await fixture.transport.create({ item: draft.item, key: crypto.randomUUID() });
  expect(created).toEqual({
    ok: true,
    id: albumId,
    reader: {
      state: 'ready',
      href: `/en/subjects/${albumId}/harbour-sessions`,
      identity: { id: albumId, type: 'schema:MusicAlbum', label: 'Harbour sessions' },
    },
  });
  const write = fixture.calls.find((call) => call.method === 'POST')!;
  expect(write).toMatchObject({ path: '/v1/subjects', authorization: 'Bearer fixture', body: draft.item });
  expect(
    fixture.calls.some(
      (call) =>
        call.path === `/v1/subjects/${albumId}` && call.authorization === null && call.session === 'album-session',
    ),
  ).toBe(true);
  expect(fixture.publicRead.subject.sourceRecords).toEqual([]);
  const original = structuredClone(fixture.publicRead);
  const current = await fixture.editors.facts.read();
  if (!current.ok) throw new Error('Expected current album');
  const source = current.public.subject.statements['schema:datePublished']![0]!;
  const field = stageFact(current, 'schema:datePublished', source.id)!;
  field.statement.value = {
    type: 'value',
    content: { time: '+2025-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  };
  const sealed = sealFacts(albumId, current.release, [field]);
  await sendFacts(sealed, fixture.editors.facts.propose, (_property, result) => {
    field.result = result;
  });
  expect(field.result).toMatchObject({ ok: true, kind: 'proposed-awaiting-review' });
  const result = field.result;
  if (!result?.ok) throw new Error('Expected exact proposed candidate');
  const review = await fixture.editors
    .review('schema:datePublished')
    .read('schema:datePublished', undefined, result.session);
  expect(review.ok && review.page?.candidates.some((candidate) => candidate.id === result.candidate)).toBe(true);
  const credit = original.subject.statements['schema:contributor']![0]!;
  const replacement = relationDraft(credit);
  replacement.qualifiers.find((part) => part.property.id === 'schema:position')!.value = {
    type: 'value',
    content: '2',
  };
  const proposed = await fixture.editors.relations.propose({
    id: albumId,
    slot: { property: 'schema:contributor', target: artistId },
    statement: replacement,
    key: crypto.randomUUID(),
  });
  expect(proposed.ok).toBe(true);
  const proposal = fixture.calls.filter((call) => call.path.endsWith('/candidates') && call.method === 'POST').at(-1)!;
  const { rank: _rank, ...nativeInput } = statementInput(credit);
  expect(proposal.body).toEqual({
    statement: {
      ...nativeInput,
      qualifiers: replacement.qualifiers.map(({ property, value }) => ({ property: { id: property.id }, value })),
    },
  });
  expect(fixture.publicRead).toEqual(original);
  expect([...fixture.candidates.values()].every((candidate) => candidate.decision === null)).toBe(true);
  expect(
    fixture.calls.some(
      (call) => call.path.includes(':adopt') || call.path.includes(':accept') || call.method === 'PATCH',
    ),
  ).toBe(false);
  expect(albumTarget(fixture.release, 'schema:contributor', ['schema:Organization'])).toBe(true);
  expect(albumTarget(fixture.release, 'wdt:P3831', ['skos:Concept'])).toBe(true);
  expect(albumTarget(fixture.release, 'wdt:P3831', ['schema:MusicAlbum'])).toBe(false);
  expect(credit.qualifiers.find((part) => part.property.id === 'wdt:P3831')?.value).toEqual({
    type: 'value',
    content: roleId,
  });
});

test('album fields obey emitted constraints and retain exact failed commands and identities', async () => {
  const fixture = albumFixture('uncertain');
  const command = { item: albumExample(), key: crypto.randomUUID() };
  expect(await fixture.transport.create(command)).toMatchObject({ ok: false, reason: 'unavailable' });
  const album = fixture.release.types['schema:MusicAlbum']!;
  delete fixture.release.types['schema:MusicAlbum'];
  expect(await fixture.transport.create(command)).toMatchObject({ ok: true, id: albumId });
  fixture.release.types['schema:MusicAlbum'] = album;
  const writes = fixture.calls.filter((call) => call.method === 'POST');
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  expect(fixture.receipts.size).toBe(1);
  for (const mutate of [
    (item: ReturnType<typeof albumExample>) => {
      item.type = 'schema:MusicRecording';
    },
    (item: ReturnType<typeof albumExample>) => {
      item.statements['schema:duration'] = [
        { property: { id: 'schema:duration' }, value: { type: 'value', content: 'PT30M' }, references: [] },
      ];
    },
    (item: ReturnType<typeof albumExample>) => {
      item.statements['wdt:P361']![0]!.qualifiers = [
        { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
      ];
    },
    (item: ReturnType<typeof albumExample>) => {
      item.statements['schema:contributor']![0]!.qualifiers!.find(
        (part) => part.property.id === 'schema:position',
      )!.value = { type: 'value', content: '0' };
    },
    (item: ReturnType<typeof albumExample>) => {
      Object.assign(item, { source: { kind: 'import' } });
    },
  ]) {
    const item = albumExample();
    mutate(item);
    expect(validateAlbum(fixture.release, item).length).toBeGreaterThan(0);
  }
  expect(albumFields(fixture.release).scalar).toContain('schema:datePublished');
  expect(albumFields(fixture.release).relations).toContain('schema:contributor');
  expect(albumFields(fixture.release).relations).not.toContain('schema:byArtist');
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['conflict', 'conflict'],
    ['invalid', 'invalid'],
  ] as const) {
    fixture.setScenario(scenario);
    expect(await fixture.transport.create(command)).toMatchObject({ ok: false, reason });
  }
  fixture.setScenario('reader-unavailable');
  expect(await fixture.transport.create(command)).toMatchObject({
    ok: true,
    id: albumId,
    reader: { state: 'unavailable' },
  });
  fixture.setScenario('concealed');
  expect(await fixture.transport.read(albumId)).toEqual({ state: 'concealed' });
  fixture.setScenario('ready');
  expect(await fixture.transport.read(albumId)).toMatchObject({ state: 'ready' });
  delete fixture.release.types['schema:MusicAlbum'];
  expect(albumFields(fixture.release)).toEqual({ scalar: [], relations: [], classifications: [], authored: [] });
  expect(validateAlbum(fixture.release, command.item).length).toBeGreaterThan(0);
});
