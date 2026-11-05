import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { workPartId, workPartsFixture } from '../src/kernel/fake/work-parts';
import { partCorrection, partSlot, partStreams, readWorkParts } from '../src/features/catalogue/work-parts';
import type { RelationConfirmation, RelationProposal } from '../src/subject/relation-candidates';

test('Propose an ordered work composition with real qualified part relations through existing current APIs with honest incomplete or denied states', async () => {
  const fixture = workPartsFixture('partial');
  const loaded = await fixture.transport.read();
  if (!loaded.ok || !loaded.stream) throw new Error('Expected a current part stream');
  expect(loaded.next).toBe('native-next');
  expect(loaded.count).toEqual({ value: 2, exact: false });
  const correction = partCorrection(loaded.rows[0]!, loaded.stream)!;
  expect(correction.id).toBe(workPartId);
  expect(correction.slot).toEqual({ property: 'wdt:P179', target: fixture.id });
  const original = structuredClone(correction.statement);
  correction.statement.qualifiers[0]!.value = { type: 'value', content: '10' };
  const command: RelationProposal = {
    id: correction.id,
    slot: correction.slot,
    statement: correction.statement,
    key: '00000000-0000-4000-8000-000000000811',
  };
  const relation = fixture.transport.relation(correction.id);
  const proposed = await relation.propose(command);
  if (!proposed.ok) throw new Error('Expected a native proposal');
  expect(fixture.holder.subject.statements['wdt:P179']![0]!.qualifiers).toEqual(original.qualifiers);
  const post = fixture.calls.find((call) => call.method === 'POST')!;
  expect(post.path).toBe(`/v1/subjects/${workPartId}/candidates`);
  expect(post.authorization).toBe('Bearer contributor');
  expect(post.key).toBe(command.key);
  expect(post.body).toMatchObject({
    statement: {
      references: original.references.map(({ parts }) => ({
        parts: parts.map(({ property, value }) => ({ property: { id: property.id }, value })),
      })),
      qualifiers: [{ value: { content: '10' } }],
    },
  });
  expect(post.body).not.toHaveProperty('source');
  expect(post.body).not.toHaveProperty('statement.source');
  expect(post.body).not.toHaveProperty('statement.qualifiers.0.property.data_type');
  const compared = await relation.read(correction.slot, undefined, proposed.session);
  if (!compared.ok || !compared.page) throw new Error('Expected an exact-slot comparison');
  expect(compared.page.candidates[0]!.id).toBe(proposed.candidate);
  expect(compared.page.candidates[0]!.decision).toBeNull();
  const confirmation: RelationConfirmation = {
    id: correction.id,
    slot: correction.slot,
    candidate: proposed.candidate,
    operation: 'accept',
    head: null,
    key: '00000000-0000-4000-8000-000000000812',
  };
  const accepted = await relation.confirm(confirmation);
  expect(accepted.ok && accepted.kind).toBe('accepted');
  expect(fixture.holder.subject.statements['wdt:P179']![0]!.id).toBe(fixture.original.id);
  const adopted = await relation.confirm({
    ...confirmation,
    operation: 'adopt',
    head: compared.page.adoption!.head,
    key: '00000000-0000-4000-8000-000000000813',
  });
  expect(adopted.ok && adopted.kind).toBe('selected');
  const reread = await fixture.transport.read(loaded.stream.key, undefined, adopted.ok ? adopted.session : undefined);
  expect(reread.ok && reread.rows[0]!.statement?.id).toBe(proposed.candidate);
  expect(
    fixture.calls
      .filter((call) => call.path === `/v1/subjects/${workPartId}`)
      .every((call) => call.authorization === 'Bearer contributor'),
  ).toBe(true);
  expect(reread.ok && reread.rows[0]!.statement?.qualifiers[0]!.value).toEqual({ type: 'value', content: '10' });
  fixture.setScenario('denied');
  expect(await fixture.transport.read(loaded.stream.key)).toEqual({ ok: false, reason: 'denied' });
});

test('continuation keeps the native anchor, property, language and cursor without per-row hydration', async () => {
  const fixture = workPartsFixture('partial', 'ja');
  const first = await fixture.transport.read();
  if (!first.ok || !first.stream) throw new Error('Expected a current page');
  const next = await fixture.transport.read(first.stream.key, first.next!, first.session);
  expect(next.ok && next.rows[0]!.summary?.label?.value).toBe('Volume Ten');
  expect(next.ok && next.next).toBeNull();
  const calls = fixture.calls.filter((call) => call.path.endsWith('/links'));
  expect(calls[1]!.query).toMatchObject({ property: 'wdt:P179', cursor: 'native-next', language: 'ja', limit: '20' });
  expect(calls[1]!.session).toBe('parts-session');
  expect(fixture.calls.filter((call) => call.path === `/v1/subjects/${workPartId}`)).toHaveLength(0);
  expect(
    await readWorkParts(
      fixture.client,
      'Bearer contributor',
      fixture.release,
      fixture.id,
      'ja',
      undefined,
      'native-next',
    ),
  ).toEqual({ ok: false, reason: 'invalid' });
});

test('only the actual emitted position qualifier is editable; inverse names are never write properties', async () => {
  const fixture = workPartsFixture('no-position');
  const page = await fixture.transport.read();
  if (!page.ok || !page.stream) throw new Error('Expected an episode stream');
  expect(page.stream).toMatchObject({ property: 'schema:isPartOf', direction: 'inverse', positionEditable: false });
  const correction = partCorrection(page.rows[0]!, page.stream)!;
  expect(correction.statement).toEqual({
    property: fixture.original.property,
    value: fixture.original.value,
    qualifiers: [],
    references: fixture.original.references.map(({ parts }) => ({ parts })),
  });
  expect(partSlot(page.stream, correction.statement)).toEqual({ property: 'schema:isPartOf', target: fixture.id });
  correction.statement.qualifiers.push({
    property: { id: 'schema:position', data_type: 'string' },
    value: { type: 'value', content: '1' },
  });
  const denied = await fixture.transport
    .relation(correction.id)
    .propose({ ...correction, key: '00000000-0000-4000-8000-000000000814' });
  expect(denied).toEqual({ ok: false, reason: 'invalid' });
  expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false);
  expect(
    partStreams(bundledRelease, 'rezics:AnimeRelease', 'en').find((stream) => stream.property === 'bf:hasPart'),
  ).toMatchObject({ direction: 'forward', positionEditable: false });
  expect(
    partStreams(bundledRelease, 'schema:BookSeries', 'en').every(
      (stream) => !!bundledRelease.properties[stream.property],
    ),
  ).toBe(true);
});

test('unavailable delivery preserves the exact proposal and key and deduplicates its native retry', async () => {
  const fixture = workPartsFixture('uncertain');
  const page = await fixture.transport.read();
  if (!page.ok || !page.stream) throw new Error('Expected a current page');
  const correction = partCorrection(page.rows[0]!, page.stream)!;
  const command = { ...correction, key: '00000000-0000-4000-8000-000000000815' };
  const before = structuredClone(command);
  const transport = fixture.transport.relation(correction.id);
  expect(await transport.propose(command)).toEqual({ ok: false, reason: 'unavailable' });
  expect((await transport.propose(command)).ok).toBe(true);
  expect(command).toEqual(before);
  expect(fixture.receipts.size).toBe(1);
  const posts = fixture.calls.filter((call) => call.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0]!.body).toEqual(posts[1]!.body);
  expect(posts[0]!.key).toBe(posts[1]!.key);
  fixture.setScenario('stale');
  const read = await transport.read(correction.slot);
  if (!read.ok || !read.page) throw new Error('Expected retained comparison');
  const result = await transport.confirm({
    id: correction.id,
    slot: correction.slot,
    candidate: read.page.candidates[0]!.id,
    operation: 'accept',
    head: null,
    key: '00000000-0000-4000-8000-000000000816',
  });
  expect(result).toEqual({ ok: false, reason: 'stale' });
  expect(command).toEqual(before);
});

test('absent assertions, projection lag, genuine emptiness and unavailable reads remain distinct', async () => {
  const missing = workPartsFixture('missing-assertion');
  const page = await missing.transport.read();
  if (!page.ok || !page.stream) throw new Error('Expected a bounded readable row');
  expect(page.rows).toHaveLength(1);
  expect(partCorrection(page.rows[0]!, page.stream)).toBeUndefined();
  expect(workPartsFixture('pending').snapshot()).toMatchObject({ ok: true, caughtUp: false });
  expect(await workPartsFixture('empty').transport.read()).toMatchObject({ ok: true, rows: [], next: null });
  expect(await workPartsFixture('unavailable').transport.read()).toEqual({ ok: false, reason: 'unavailable' });
});
