import { expect, test } from 'bun:test';
import { relationFixture, relationProperty, relationActor, relationRole } from '../src/kernel/fake/catalogue-relations';
import { candidateContext } from '../src/subject/candidates';
import {
  relationFields,
  validRelationSlot,
  type RelationConfirmation,
  type RelationTypeDescriptor,
} from '../src/subject/relation-candidates';

const confirmation = (
  fixture: ReturnType<typeof relationFixture>,
  candidate: string,
  operation: 'accept' | 'adopt',
  head: number | null,
): RelationConfirmation => ({
  id: fixture.id,
  slot: fixture.slot,
  candidate,
  operation,
  head,
  key: crypto.randomUUID(),
  rank: 'preferred',
});

test('Contribute and review a relation or qualified credit in its exact slot through the existing API and reader with honest failure states', async () => {
  const fixture = relationFixture();
  const read = await fixture.transport.read(fixture.slot);
  if (!read.ok || !read.page) throw new Error('Expected exact-slot review');
  expect(read.page.candidates.map((item) => item.id)).toEqual([fixture.candidate.id]);
  expect(read.fields.find((field) => field.id === relationProperty)?.slotKey).toBe('wdt:P453');
  expect(relationFields(fixture.descriptor, 'en').some((field) => field.id === 'schema:genre')).toBe(false);
  expect(fixture.calls.find((call) => call.path.endsWith('/candidates'))?.query).toMatchObject({
    property: relationProperty,
    target: relationActor,
    key: relationRole,
    context: candidateContext,
  });
  expect(fixture.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  expect(validRelationSlot({ ...fixture.slot, sameAs: 'https://example.org/actor' })).toBe(false);

  const proposal = {
    id: fixture.id,
    slot: fixture.slot,
    statement: structuredClone(fixture.draft),
    key: crypto.randomUUID(),
  };
  proposal.statement.qualifiers.push({
    property: { id: 'schema:position', data_type: 'string' },
    value: { type: 'value', content: '2' },
  });
  const proposed = await fixture.transport.propose(proposal);
  if (!proposed.ok) throw new Error('Expected proposal');
  const write = fixture.calls.find((call) => call.method === 'POST' && call.path.endsWith('/candidates'))!;
  expect(write.body).toEqual({
    statement: {
      property: { id: relationProperty },
      value: { type: 'value', content: relationActor },
      qualifiers: [
        { property: { id: 'wdt:P453' }, value: { type: 'value', content: relationRole } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Original credit' } },
        { property: { id: 'schema:position' }, value: { type: 'value', content: '2' } },
      ],
      references: [
        {
          parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/credits' } }],
        },
      ],
    },
  });
  expect(write.key).toBe(proposal.key);
  expect(write.authorization).toBe('Bearer fixture');
  expect(write.session).toBe('relation-session');
  expect(fixture.publicRead.subject.statements[relationProperty]?.map((item) => item.id)).not.toContain(
    proposed.candidate,
  );
  const accepted = await fixture.transport.confirm(confirmation(fixture, proposed.candidate, 'accept', null));
  expect(accepted).toMatchObject({ ok: true, kind: 'accepted' });
  const refreshed = await fixture.transport.read(fixture.slot);
  if (!refreshed.ok || !refreshed.page) throw new Error('Expected current candidate heads');
  expect(refreshed.page.candidates.find((item) => item.id === proposed.candidate)?.head).toBe(1);
  const adopt = {
    ...confirmation(fixture, proposed.candidate, 'adopt', refreshed.page.adoption!.head),
    cursor: 'credit-continuation',
  };
  const result = await fixture.transport.confirm(adopt);
  if (!result.ok || !result.public) throw new Error('Expected public reader');
  expect(result.kind).toBe('selected');
  expect(
    fixture.calls.filter((call) => call.method === 'GET' && call.path.endsWith('/candidates')).at(-1)?.query.cursor,
  ).toBe('credit-continuation');
  expect(result.public.subject.statements[relationProperty]).toEqual([
    fixture.sibling,
    fixture.neighbor,
    expect.objectContaining({
      id: proposed.candidate,
      rank: 'preferred',
      qualifiers: proposal.statement.qualifiers,
      references: proposal.statement.references.map((reference) => ({ ...reference, hash: 'citation' })),
    }),
  ]);
  expect(fixture.calls.find((call) => call.path.endsWith(':adopt'))?.body).toEqual({
    context: candidateContext,
    ...fixture.slot,
    mode: 'replace',
    selection: [{ candidate: proposed.candidate, rank: 'preferred' }],
    expected_head: 7,
  });
  expect(fixture.calls.at(-1)).toMatchObject({ method: 'GET', authorization: null, session: 'relation-session' });

  const unresolved = relationFixture('unresolved');
  const external = await unresolved.transport.read({
    property: 'schema:author',
    sameAs: 'https://example.org/people/original',
  });
  if (!external.ok || !external.page) throw new Error('Expected unresolved source slot');
  expect(external.page.candidates[0]?.statement.value).toEqual({ type: 'somevalue' });
  const query = unresolved.calls.find((call) => call.path.endsWith('/candidates'))!.query;
  expect(query.sameAs).toBe('https://example.org/people/original');
  expect(query.target).toBeUndefined();
  expect(query.key).toBeUndefined();
});

test('an exact descriptor for another active release admits its localized relation and qualifier definitions', async () => {
  const fixture = relationFixture('ready', 'fr');
  const typeId = 'test:CrossReleaseWork';
  const propertyId = 'test:relatedWork';
  const qualifierId = 'test:workRole';
  const relation = structuredClone(fixture.release.properties[relationProperty]!);
  relation.labels = { en: 'related work', fr: 'œuvre liée' };
  relation.targets = ['schema:Book'];
  relation.qualifiers = [qualifierId];
  relation.relation = { group: 'association', slotKey: qualifierId };
  const qualifier = structuredClone(fixture.release.properties[relationRole]!);
  qualifier.labels = { en: 'work role', fr: 'rôle lié' };
  const descriptor: RelationTypeDescriptor = {
    typeId,
    releaseDigest: `sha256:${'d'.repeat(64)}`,
    definition: {
      ...structuredClone(fixture.release.types['schema:Movie']!),
      properties: [propertyId, 'schema:url'],
    },
    properties: {
      [propertyId]: relation,
      [qualifierId]: qualifier,
      'schema:url': fixture.release.properties['schema:url']!,
    },
  };
  fixture.publicRead.subject.type = typeId;
  fixture.setDescriptor(descriptor);

  const read = await fixture.transport.read();
  if (!read.ok) throw new Error('Expected the exact cross-release Type descriptor');
  expect(fixture.release.types[typeId]).toBeUndefined();
  expect(read.descriptor.releaseDigest).toBe(descriptor.releaseDigest);
  expect(read.fields).toEqual([
    expect.objectContaining({
      id: propertyId,
      label: 'œuvre liée',
      targets: ['schema:Book'],
      slotKey: qualifierId,
      qualifiers: [expect.objectContaining({ id: qualifierId, label: 'rôle lié', targets: ['wd:Q95074'] })],
    }),
  ]);
});

test('a missing descriptor is unavailable, then the same Type read recovers when its descriptor returns', async () => {
  const fixture = relationFixture();
  const complete = fixture.descriptor;
  fixture.setDescriptorAvailable(false);
  expect(await fixture.transport.read(fixture.slot)).toEqual({ ok: false, reason: 'unavailable' });

  fixture.setDescriptorAvailable(true);
  const incompleteProperties = { ...complete.properties };
  delete incompleteProperties['wdt:P453'];
  fixture.setDescriptor({ ...complete, properties: incompleteProperties });
  expect(await fixture.transport.read(fixture.slot)).toEqual({ ok: false, reason: 'unavailable' });

  fixture.setDescriptor(complete);
  const recovered = await fixture.transport.read(fixture.slot);
  if (!recovered.ok) throw new Error('Expected relation metadata recovery');
  expect(recovered.fields.some((field) => field.id === relationProperty)).toBe(true);
  expect(recovered.page?.candidates.map((candidate) => candidate.id)).toEqual([fixture.candidate.id]);
});

test('uncertain proposal replay keeps the exact native command when its current descriptor becomes unavailable', async () => {
  const fixture = relationFixture('lost-proposal-response');
  const proposal = {
    id: fixture.id,
    slot: fixture.slot,
    statement: structuredClone(fixture.draft),
    key: crypto.randomUUID(),
  };

  expect(await fixture.transport.propose(proposal)).toEqual({ ok: false, reason: 'unavailable', retry: true });
  const first = fixture.calls.find((call) => call.method === 'POST' && call.path.endsWith('/candidates'))!;
  fixture.setDescriptorAvailable(false);
  const beforeReplay = fixture.calls.length;
  const retried = await fixture.transport.propose({ ...proposal, retry: true });
  if (!retried.ok) throw new Error('Expected native idempotent replay');

  const replay = fixture.calls.slice(beforeReplay);
  expect(replay.filter((call) => call.method === 'GET')).toHaveLength(0);
  expect(replay.find((call) => call.method === 'POST')).toMatchObject({
    key: proposal.key,
    body: first.body,
  });
});

test('stale exact-slot decisions retain the intended statement and require reread; uncertain retries retain keys and never substitute private JSON for public selection', async () => {
  const fixture = relationFixture();
  const intended = structuredClone(fixture.draft);
  const accept = confirmation(fixture, fixture.candidate.id, 'accept', null);
  expect(await fixture.transport.confirm(accept)).toMatchObject({ ok: true, kind: 'accepted' });
  const stale = confirmation(fixture, fixture.candidate.id, 'adopt', 6);
  expect(await fixture.transport.confirm(stale)).toEqual({ ok: false, reason: 'stale' });
  expect(fixture.adopted).toBe(false);
  expect(fixture.draft).toEqual(intended);
  const current = await fixture.transport.read(fixture.slot);
  if (!current.ok || !current.page) throw new Error('Expected refreshed slot');
  const explicit = confirmation(fixture, fixture.candidate.id, 'adopt', current.page.adoption!.head);
  expect(explicit.key).not.toBe(stale.key);
  fixture.setScenario('lost-response');
  expect(await fixture.transport.confirm(explicit)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await fixture.transport.confirm(explicit)).toMatchObject({ ok: true, kind: 'selected' });
  const retries = fixture.calls.filter((call) => call.path.endsWith(':adopt')).slice(-2);
  expect(retries.map((call) => call.key)).toEqual([explicit.key, explicit.key]);
  expect(retries[0]?.body).toEqual(retries[1]?.body);

  const pending = relationFixture('pending');
  await pending.transport.confirm(confirmation(pending, pending.candidate.id, 'accept', null));
  expect(await pending.transport.confirm(confirmation(pending, pending.candidate.id, 'adopt', 7))).toMatchObject({
    ok: true,
    kind: 'pending',
  });
  expect(
    pending.publicRead.subject.statements[relationProperty]?.some((item) => item.id === pending.candidate.id),
  ).toBe(false);
  const denied = relationFixture('denied');
  expect(await denied.transport.read(denied.slot)).toEqual({ ok: false, reason: 'denied' });
  expect(denied.calls.some((call) => call.method === 'POST')).toBe(false);
  for (const state of ['retracted', 'ready'] as const) {
    const blocked = relationFixture(state);
    if (state === 'ready') {
      blocked.candidate.decision = 'accepted';
      blocked.candidate.rank = 'deprecated';
    }
    expect(await blocked.transport.confirm(confirmation(blocked, blocked.candidate.id, 'adopt', 7))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(blocked.calls.some((call) => call.path.endsWith(':adopt'))).toBe(false);
  }
});
