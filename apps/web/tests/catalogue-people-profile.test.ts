import { expect, test } from 'bun:test';
import { peopleProfileFixture, peopleCreatedId, peopleCandidateId } from '../src/kernel/fake/catalogue-people-profile';
import { initialTerms } from '../src/features/catalogue/create-subject';
import { peopleInitialItem, peopleProfiles, validatePeopleItem } from '../src/features/catalogue/people-profile';
import { sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import type { StatementInput } from '../src/features/catalogue/statement-editor';

const fact = (): StatementInput => ({
  property: { id: 'schema:url' },
  value: { type: 'value', content: 'https://example.org/studio' },
  qualifiers: [],
  rank: 'normal',
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/credits' } }] },
  ],
});
const terms = (type: string) =>
  initialTerms(type, [
    { language: 'en', label: 'Paper Lantern Studio', description: '', aliases: 'Lantern' },
    { language: 'ja', label: '灯籠', description: '', aliases: '' },
  ]).item;

test('Person and organization catalogue editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  for (const type of ['schema:Person', 'schema:Organization']) {
    const fixture = peopleProfileFixture();
    const read = await fixture.transport.load();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Expected current emitted metadata');
    expect(read.credits).toEqual(['schema:contributor']);
    const profiles = peopleProfiles(fixture.release, 'ja');
    expect(profiles.map((entry) => entry.id)).toEqual(['schema:Person', 'schema:Organization']);
    expect(
      profiles
        .find((entry) => entry.id === type)
        ?.fields.every((property) => fixture.release.types[type]!.properties.includes(property)),
    ).toBe(true);
    expect(profiles.find((entry) => entry.id === 'schema:Organization')?.fields).not.toContain('schema:birthDate');
    expect(profiles.find((entry) => entry.id === type)?.fields).not.toContain('schema:name');
    expect(profiles.find((entry) => entry.id === type)?.relations).toEqual(['rezics:penNameOf']);
    const item = peopleInitialItem(terms(type), { 'schema:url': fact() });
    expect(validatePeopleItem(item, fixture.release)).toEqual([]);
    const command = { item, key: crypto.randomUUID() };
    const result = await fixture.transport.create(command);
    expect(result).toEqual({
      ok: true,
      id: peopleCreatedId,
      reader: { state: 'ready', href: `/en/subjects/${peopleCreatedId}/paper-lantern-studio` },
    });
    const write = fixture.calls.find((call) => call.path === '/v1/subjects' && call.method === 'POST');
    expect(write).toMatchObject({ body: item, key: command.key, authorization: 'Bearer fixture' });
    expect(Object.keys(write!.body as object).sort()).toEqual([
      'aliases',
      'descriptions',
      'labels',
      'statements',
      'type',
    ]);
    expect(fixture.calls.at(-1)).toMatchObject({
      method: 'GET',
      path: `/v1/subjects/${peopleCreatedId}`,
      authorization: null,
    });
    const current = await fixture.client.subjects({ id: peopleCreatedId }).get();
    expect(current.data?.subject).toMatchObject({
      type,
      labels: item.labels,
      aliases: item.aliases,
      sourceRecords: [],
    });
    expect(current.data?.subject.statements['schema:url']?.[0]?.value).toEqual(fact().value);
    expect(peopleInitialItem(terms(type), {})).not.toHaveProperty('statements');
    expect(validatePeopleItem({ ...item, type: 'schema:SoftwareApplication' }, fixture.release)).not.toEqual([]);
    expect(validatePeopleItem(peopleInitialItem(terms(type), { 'schema:name': fact() }), fixture.release)).not.toEqual(
      [],
    );
    expect(
      validatePeopleItem(peopleInitialItem(terms(type), { 'rezics:biography': fact() }), fixture.release),
    ).not.toEqual([]);
  }
  const item = peopleInitialItem(terms('schema:Person'), { 'schema:url': fact() });
  const command = { item, key: crypto.randomUUID() };
  const uncertain = peopleProfileFixture('uncertain');
  expect(await uncertain.transport.create(command)).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await uncertain.transport.create(command)).toMatchObject({ ok: true, id: peopleCreatedId });
  const attempts = uncertain.calls.filter((call) => call.method === 'POST');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.body).toEqual(attempts[1]?.body);
  expect(attempts[0]?.key).toBe(attempts[1]?.key);
  expect(uncertain.receipts.size).toBe(1);
  const denied = peopleProfileFixture('denied');
  expect(await denied.transport.create(command)).toMatchObject({ ok: false, reason: 'denied' });
  expect(denied.receipts.size).toBe(0);
  const stale = peopleProfileFixture('stale');
  expect(await stale.transport.load()).toMatchObject({ ok: false, reason: 'stale' });
  expect(stale.calls.some((call) => call.method === 'POST')).toBe(false);
  for (const [scenario, state] of [
    ['reader-unavailable', 'unavailable'],
    ['concealed', 'concealed'],
  ] as const) {
    const fixture = peopleProfileFixture(scenario);
    expect(await fixture.transport.create(command)).toMatchObject({ ok: true, id: peopleCreatedId, reader: { state } });
    await fixture.transport.read(peopleCreatedId);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  }
});

test('profile corrections preserve terms and citations, retain uncertain keys, and read the exact candidate before selection', async () => {
  const fixture = peopleProfileFixture('uncertain', 'en', 'person');
  const result = await fixture.transport.load();
  if (!result.ok || !result.public) throw new Error('Expected current person');
  const read = { ok: true as const, public: result.public, release: result.release, source: null };
  const before = structuredClone(fixture.current.subject);
  const draft = stageFact(read, 'schema:url', before.statements['schema:url']![0]!.id)!;
  draft.statement.value = { type: 'value', content: 'https://example.org/corrected' };
  let sealed = sealFacts(fixture.id, fixture.release, [draft]);
  const key = sealed[0]!.command!.key;
  await sendFacts(sealed, fixture.propose, (_property, outcome) => {
    sealed = sealed.map((entry) => ({ ...entry, result: outcome }));
  });
  expect(sealed[0]?.result).toMatchObject({ ok: false, reason: 'uncertain' });
  expect(fixture.current.subject).toEqual(before);
  sealed = sealFacts(fixture.id, fixture.release, sealed);
  expect(sealed[0]?.command?.key).toBe(key);
  await sendFacts(sealed, fixture.propose, (_property, outcome) => {
    sealed = sealed.map((entry) => ({ ...entry, result: outcome }));
  });
  expect(sealed[0]?.result).toMatchObject({ ok: true, kind: 'proposed-awaiting-review', candidate: peopleCandidateId });
  expect(sealed[0]?.command?.statement.references).toEqual(draft.baseline?.references);
  expect(fixture.current.subject).toEqual(before);
  const writes = fixture.calls.filter((call) => call.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body).toEqual({ statement: draft.statement });
  expect(writes[0]?.key).toBe(writes[1]?.key);
  await sendFacts(sealed, fixture.propose, () => {
    throw new Error('Confirmed proposal must not be replayed');
  });
  expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  const review = fixture.review('schema:url');
  const candidates = await review.read('schema:url');
  expect(candidates.ok && candidates.page?.candidates[0]?.id).toBe(peopleCandidateId);
  expect(
    await review.confirm({
      id: fixture.id,
      property: 'schema:url',
      candidate: peopleCandidateId,
      operation: 'accept',
      head: null,
      key: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: true, kind: 'accepted' });
  expect(fixture.current.subject).toEqual(before);
  expect(
    await review.confirm({
      id: fixture.id,
      property: 'schema:url',
      candidate: peopleCandidateId,
      operation: 'adopt',
      head: 1,
      key: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: true, kind: 'selected' });
  const current = await fixture.client.subjects({ id: fixture.id }).get();
  expect(current.data?.subject.labels).toEqual(before.labels);
  expect(current.data?.subject.aliases).toEqual(before.aliases);
  expect(current.data?.subject.statements['schema:url']?.[0]?.value).toEqual(draft.statement.value);
});
