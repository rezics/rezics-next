import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { releaseDigest } from '@rezics/definitions';
import {
  storyArcProfileFixture,
  storyArcProfileId,
  storyArcSiblingId,
  storyArcCreatedId,
} from '../src/kernel/fake/catalogue-story-arc-profile';
import {
  storyArcFacts,
  storyArcRelations,
  storyArcType,
  storyArcProperty,
  storyArcWork,
} from '../src/features/catalogue/story-arc-profile';
import { initialTerms } from '../src/features/catalogue/create-subject';
import { relationDraft } from '../src/subject/relation-candidates';
import { sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { collectEditorialEntries, contributionMenu } from '../src/features/catalogue/editorial-entry';
import { StoryArcProfileEntry, storyArcEntry } from '../src/features/catalogue/story-arc-profile-entry';
import { contributionHref } from '../src/features/catalogue/catalogue-entry';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Narrative story-arc editor uses current admitted native fields and actual candidate-reader semantics', async () => {
  const fixture = storyArcProfileFixture();
  const read = await fixture.transport.load({ id: storyArcProfileId, work: fixture.work.id });
  if (!read.ok) throw new Error('Expected current arc and work');
  expect(fixture.calls.find((call) => call.path.startsWith('/v1/definitions/releases/'))).toMatchObject({
    method: 'GET',
    path: `/v1/definitions/releases/${encodeURIComponent(releaseDigest(fixture.release))}`,
  });
  expect(read.release.types[storyArcType]).toEqual(fixture.release.types[storyArcType]);
  expect(read.release.properties[storyArcProperty]).toEqual(fixture.release.properties[storyArcProperty]);
  expect(read.arc?.subject.type).toBe(storyArcType);
  expect(storyArcWork(read.release, read.work!.subject.type)).toBe(true);
  const relation = storyArcRelations(await fixture.work.transport.read(), read.release, true);
  if (!relation.ok) throw new Error('Expected emitted work relation');
  expect(relation.fields.map((field) => field.id)).toEqual([storyArcProperty]);
  expect(relation.fields[0]!.qualifiers.map((field) => field.id)).toEqual([
    'rezics:firstPart',
    'rezics:lastPart',
    'schema:position',
  ]);
  expect(relation.fields[0]!.slotKey).toBeUndefined();
  expect(read.release.types[storyArcType]!.properties).toEqual(
    expect.arrayContaining(['wdt:P179', 'wdt:P361', 'wdt:P155']),
  );

  const draft = initialTerms(storyArcType, [
    { language: 'en', label: 'A real arc', description: 'A named narrative range', aliases: '' },
    { language: 'ja', label: '旅の編', description: '', aliases: '旅路編' },
  ]);
  expect(draft.errors).toEqual([]);
  const key = crypto.randomUUID();
  const result = await fixture.transport.creation.submit({ item: draft.item, key });
  expect(result).toMatchObject({
    ok: true,
    id: storyArcCreatedId,
    reader: { state: 'ready', href: expect.stringContaining(`/subjects/${storyArcCreatedId}/a-real-arc`) },
  });
  expect(fixture.creation.calls.find((call) => call.method === 'POST')).toMatchObject({
    path: '/v1/subjects',
    key,
    body: draft.item,
  });
  expect(fixture.creation.calls.at(-1)!.path).toBe(`/v1/subjects/${storyArcCreatedId}`);
  expect(draft.item).not.toHaveProperty('source');
  expect(draft.item).not.toHaveProperty('statements');
  expect(fixture.work.publicRead.subject.statements[storyArcProperty]).toHaveLength(2);

  const slot = { property: storyArcProperty, target: storyArcProfileId };
  const statement = relationDraft(fixture.original);
  statement.qualifiers.find((part) => part.property.id === 'schema:position')!.value = { type: 'value', content: '3' };
  const proposed = await fixture.work.transport.propose({
    id: fixture.work.id,
    slot,
    statement,
    key: crypto.randomUUID(),
  });
  if (!proposed.ok) throw new Error('Expected ordinary candidate proposal');
  expect(fixture.work.publicRead.subject.statements[storyArcProperty]![0]!.id).toBe(fixture.original.id);
  const write = fixture.work.calls.find((call) => call.method === 'POST');
  expect(write?.path).toBe(`/v1/subjects/${fixture.work.id}/candidates`);
  const nativePart = ({ property, value }: (typeof statement.qualifiers)[number]) => ({
    property: { id: property.id },
    value,
  });
  expect(write?.body).toMatchObject({
    statement: {
      value: { type: 'value', content: storyArcProfileId },
      qualifiers: statement.qualifiers.map(nativePart),
      references: statement.references.map(({ parts }) => ({ parts: parts.map(nativePart) })),
    },
  });
  const accepted = await fixture.work.transport.confirm({
    id: fixture.work.id,
    slot,
    candidate: proposed.candidate,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
  });
  expect(accepted).toMatchObject({ ok: true, kind: 'accepted' });
  const comparison = await fixture.work.transport.read(slot);
  if (!comparison.ok) throw new Error('Expected current slot comparison');
  const selected = await fixture.work.transport.confirm({
    id: fixture.work.id,
    slot,
    candidate: proposed.candidate,
    operation: 'adopt',
    head: comparison.page!.adoption!.head,
    rank: 'preferred',
    key: crypto.randomUUID(),
  });
  expect(selected).toMatchObject({ ok: true, kind: 'selected' });
  expect(fixture.work.publicRead.subject.statements[storyArcProperty]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: proposed.candidate, rank: 'preferred' }),
      expect.objectContaining({ value: { type: 'value', content: storyArcSiblingId } }),
    ]),
  );
});

test('arc corrections keep multilingual current facts and independent partial results until native review', async () => {
  const fixture = storyArcProfileFixture();
  const read = await fixture.transport.load({ id: storyArcProfileId });
  if (!read.ok) throw new Error('Expected arc');
  const facts = storyArcFacts(read);
  if (!facts.ok) throw new Error('Expected facts');
  const baseline = structuredClone(fixture.arc);
  const keywords = stageFact(facts, 'schema:keywords', facts.public.subject.statements['schema:keywords']![0]!.id)!;
  expect(sealFacts(storyArcProfileId, read.release, [keywords])[0]!.command).toBeUndefined();
  keywords.statement.value = { type: 'value', content: 'a corrected theme' };
  const url = stageFact(facts, 'schema:url', null)!;
  url.statement.value = { type: 'value', content: 'https://example.org/arc' };
  const sealed = sealFacts(storyArcProfileId, read.release, [keywords, url]);
  const outcomes: unknown[] = [];
  await sendFacts(
    sealed,
    (command) =>
      command.statement.property.id === 'schema:url'
        ? Promise.resolve({ ok: false, reason: 'denied' })
        : fixture.props.facts(storyArcProfileId).propose(command),
    (_property, result) => outcomes.push(result),
  );
  expect(outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ok: true, kind: 'proposed-awaiting-review' }),
      { ok: false, reason: 'denied' },
    ]),
  );
  expect(fixture.arc).toEqual(baseline);
  expect(fixture.candidates[0]!.statement.references).toEqual(
    baseline.subject.statements['schema:keywords']![0]!.references.map((reference) => ({
      ...reference,
      hash: 'citation',
    })),
  );
  expect(stageFact(facts, 'schema:name', null)).toBeNull();
  expect(stageFact(facts, 'schema:numberOfPages', null)).toBeNull();
  const entry = storyArcEntry({
    id: storyArcProfileId,
    label: 'The journey arc',
    work: fixture.work.id,
    locale: 'en',
    realm: 'a realm',
  });
  expect(entry.href).toContain(
    `/subjects/${storyArcProfileId}/the-journey-arc/story-arc?work=${fixture.work.id}&realm=a+realm`,
  );
  expect(new URL(contributionHref(entry, true), 'https://site.invalid').searchParams.get('return_to')).toBe(entry.href);
  const collected = collectEditorialEntries(
    createElement(StoryArcProfileEntry, { id: storyArcProfileId, label: 'The journey arc', locale: 'en' }),
  );
  expect(collected.retained).toEqual([]);
  expect(contributionMenu(collected.entries, 'en', false)).toHaveLength(1);
});

test('uncertain creation reuses its key and an unselected adoption stays pending in the actual reader', async () => {
  const fixture = storyArcProfileFixture('uncertain');
  const { item } = initialTerms(storyArcType, [{ language: 'en', label: 'Arc', description: '', aliases: '' }]);
  const command = { item, key: crypto.randomUUID() };
  expect(await fixture.transport.creation.submit(command)).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await fixture.transport.creation.submit(command)).toMatchObject({ ok: true, id: storyArcCreatedId });
  expect(fixture.creation.calls.filter((call) => call.method === 'POST').map((call) => call.key)).toEqual([
    command.key,
    command.key,
  ]);
  const pending = storyArcProfileFixture('pending');
  const slot = { property: storyArcProperty, target: storyArcProfileId };
  await pending.work.transport.confirm({
    id: pending.work.id,
    slot,
    candidate: pending.work.candidate.id,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
  });
  const comparison = await pending.work.transport.read(slot);
  if (!comparison.ok) throw new Error('Expected current slot');
  expect(
    await pending.work.transport.confirm({
      id: pending.work.id,
      slot,
      candidate: pending.work.candidate.id,
      operation: 'adopt',
      head: comparison.page!.adoption!.head,
      key: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: true, kind: 'pending' });
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['wrong-type', 'invalid'],
    ['stale', 'unavailable'],
    ['unavailable', 'unavailable'],
  ] as const)
    expect(await storyArcProfileFixture(scenario).transport.load({ id: storyArcProfileId })).toEqual({
      ok: false,
      reason,
    });
  expect(await storyArcProfileFixture('concealed').transport.creation.read(storyArcCreatedId)).toEqual({
    state: 'concealed',
  });
});

