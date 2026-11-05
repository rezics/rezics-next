import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { subjectFactsFixture } from '../src/kernel/fake/subject-facts';
import { candidateIsPublic, publicCandidateSelection } from '../src/subject/candidates';
import {
  factChanged,
  factGroups,
  factLocked,
  sealFacts,
  sendFacts,
  stageFact,
  proposeFact,
  type FactDraft,
  type FactsCurrent,
} from '../src/features/catalogue/subject-facts';

function changedFields(read: FactsCurrent) {
  const date = stageFact(read, 'schema:datePublished', read.public.subject.statements['schema:datePublished']![0]!.id)!;
  const language = stageFact(read, 'schema:inLanguage', read.public.subject.statements['schema:inLanguage']![0]!.id)!;
  date.statement.value = {
    type: 'value',
    content: {
      time: '+1946-04-06T00:00:00Z',
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    },
  };
  language.statement.value = { type: 'value', content: 'de' };
  return [date, language];
}
async function send(drafts: FactDraft[], propose: Parameters<typeof sendFacts>[1]) {
  const results = [...drafts];
  await sendFacts(drafts, propose, (property, result) => {
    const index = results.findIndex((draft) => draft.property === property);
    results[index] = { ...results[index]!, result };
  });
  return results;
}

test('Edit a released subject profile with honest per-field proposal results through existing native authority and current reading', async () => {
  const fixture = subjectFactsFixture();
  const read = await fixture.transport.read();
  if (!read.ok) throw new Error('Expected current facts');
  const publicBefore = structuredClone(read.public.subject.statements);
  const drafts = changedFields(read);
  const sealed = sealFacts(fixture.date.id, read.release, drafts);
  const results = await send(sealed, fixture.transport.propose);
  expect(results.every((draft) => draft.result?.ok)).toBe(true);
  expect(read.public.subject.statements).toEqual(publicBefore);
  for (const [index, slot] of [fixture.date, fixture.language].entries()) {
    const result = results[index]!.result;
    if (!result?.ok) throw new Error('Expected individual proposal');
    expect(result.kind).toBe('proposed-awaiting-review');
    expect(result.candidate).toBe(slot.candidate.id);
    expect(slot.candidate.decision).toBeNull();
    const write = slot.calls.find((call) => call.method === 'POST')!;
    expect(write.path).toBe(`/v1/subjects/${slot.id}/candidates`);
    expect(write.body).toEqual({ statement: sealed[index]!.command!.statement });
    expect(write.authorization).toBe('Bearer fixture');
    expect(write.key).toBe(sealed[index]!.command!.key);
    expect(slot.candidate.statement.references[0]!.parts).toMatchObject(drafts[index]!.statement.references[0]!.parts);
    const review = await slot.review.read(slot.address.property);
    if (!review.ok) throw new Error('Expected exact review');
    expect(candidateIsPublic(review.public, slot.address.property, result.candidate)).toBe(false);
    const accepted = await slot.review.confirm({
      id: slot.id,
      property: slot.address.property,
      candidate: result.candidate,
      operation: 'accept',
      head: slot.candidate.head,
      key: crypto.randomUUID(),
      session: result.session,
    });
    expect(accepted.ok && accepted.kind).toBe('accepted');
    const refreshed = await slot.review.read(slot.address.property);
    if (!refreshed.ok) throw new Error('Expected current selection');
    const existing = index === 1 ? publicCandidateSelection(refreshed.public, slot.address.property) : [];
    const selected = await slot.review.confirm({
      id: slot.id,
      property: slot.address.property,
      candidate: result.candidate,
      operation: 'adopt',
      head: refreshed.page!.adoption!.head,
      key: crypto.randomUUID(),
      selection: [...existing, { candidate: result.candidate, rank: 'normal' }],
    });
    expect(selected.ok && selected.kind).toBe('selected');
    expect(
      selected.ok && selected.public && candidateIsPublic(selected.public, slot.address.property, result.candidate),
    ).toBe(true);
    if (selected.ok && selected.public && index === 1)
      expect(publicCandidateSelection(selected.public, slot.address.property)).toHaveLength(existing.length + 1);
  }
  expect((await send(results, fixture.transport.propose)).every((draft) => draft.result?.ok)).toBe(true);
  expect(fixture.date.calls.filter((call) => call.path.endsWith('/candidates') && call.method === 'POST')).toHaveLength(
    1,
  );
});

test('unchanged and excluded fields do nothing; blank drafts fail without clearing; emitted fields and citations survive', async () => {
  const fixture = subjectFactsFixture();
  const read = await fixture.transport.read();
  if (!read.ok) throw new Error('Expected facts');
  const source = read.public.subject.statements['schema:datePublished']![0]!;
  const unchanged = stageFact(read, source.property.id, source.id)!;
  expect(factChanged(unchanged)).toBe(false);
  const excluded = changedFields(read)[1]!;
  excluded.included = false;
  const initial = sealFacts(fixture.date.id, read.release, [unchanged, excluded]);
  await send(initial, fixture.transport.propose);
  expect(fixture.date.calls.some((call) => call.method === 'POST')).toBe(false);
  expect(fixture.language.calls.some((call) => call.method === 'POST')).toBe(false);
  unchanged.statement.value = { type: 'value', content: '' };
  const invalid = sealFacts(fixture.date.id, read.release, [unchanged]);
  expect(invalid[0]!.result).toMatchObject({ ok: false, reason: 'invalid' });
  expect(invalid[0]!.command).toBeUndefined();
  expect(unchanged.statement.references).toEqual(
    source.references.map((reference) => ({
      parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
    })),
  );
  expect(stageFact(read, 'schema:name', null)).toBeNull();
  expect(stageFact(read, 'schema:author', null)).toBeNull();
  expect(stageFact(read, source.property.id, crypto.randomUUID())).toBeNull();
  expect(Object.values(factGroups(read)).flat()).not.toContain('schema:name');
  // The same emitted metadata works for another released Type without a Book field inventory.
  const person = structuredClone(read);
  person.public.subject.type = 'schema:Person';
  expect(
    Object.values(factGroups(person))
      .flat()
      .every((id) => person.release.types['schema:Person']!.properties.includes(id)),
  ).toBe(true);
});

test('partial refusal and uncertain delivery retain exact drafts and keys, retry only unresolved fields, and preserve session continuity', async () => {
  for (const scenario of ['partial', 'stale', 'invalid', 'unavailable', 'lost-response'] as const) {
    const fixture = subjectFactsFixture(scenario);
    const read = await fixture.transport.read();
    if (!read.ok) throw new Error('Expected facts');
    const sealed = sealFacts(fixture.date.id, read.release, changedFields(read));
    sealed[0]!.command!.session = 'prior-session';
    const before = structuredClone(sealed);
    const first = await send(sealed, fixture.transport.propose);
    const failed = first.filter((draft) => !draft.result?.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(sealed).toEqual(before);
    expect(first[1]!.result).toMatchObject({
      ok: false,
      reason: scenario === 'partial' ? 'denied' : scenario === 'lost-response' ? 'uncertain' : scenario,
    });
    if (scenario === 'lost-response') expect(factLocked(first[0]!)).toBe(true);
    const retry = sealFacts(fixture.date.id, read.release, first);
    const second = await send(retry, fixture.transport.propose);
    const dateWrites = fixture.date.calls.filter((call) => call.method === 'POST');
    expect(dateWrites).toHaveLength(scenario === 'partial' ? 1 : 2);
    expect(dateWrites[0]!.session).toBe('prior-session');
    if (dateWrites.length === 2) {
      expect(dateWrites[0]!.key).toBe(dateWrites[1]!.key);
      expect(dateWrites[0]!.body).toEqual(dateWrites[1]!.body);
    }
    if (scenario === 'lost-response') expect(second.every((draft) => draft.result?.ok)).toBe(true);
    if (scenario === 'partial') expect(first[0]!.result).toEqual(second[0]!.result);
  }
  const fixture = subjectFactsFixture();
  const read = await fixture.transport.read();
  if (!read.ok) throw new Error('Expected facts');
  const command = sealFacts(fixture.date.id, read.release, changedFields(read))[0]!.command!;
  const unserved = createKernelClient('https://unserved.test', {
    fetch: (async () =>
      new Response('{"code":"not_found"}', {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      })) as typeof fetch,
  });
  expect(await proposeFact(unserved, 'Bearer fixture', command)).toEqual({ ok: false, reason: 'unavailable' });
});
