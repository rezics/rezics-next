import { expect, test } from 'bun:test';
import { checkedComponentState, ownedTriples } from '../src/modules/semantic/change.ts';
import { baselineTarget } from '../src/modules/access/baseline.ts';
import { canonicalRelation, readDefinitionByKey, readExactDefinition, relationChangeDigest, roleIri, type ExactDefinition } from '../src/modules/relation/change.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { relationSubjectWork } from '../src/modules/relation/work-authority.ts';
import { derivationTriples, validateWorkDerivation, workDerivationDigest, type WorkDerivationInput } from '../src/modules/work/derivations.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { definitionKeyIri, definitionKeyTriples } from '../src/modules/lexicon/definition-key.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { readMainOutboxEnvelope, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { GRAPHS, RV, hash } from '../src/modules/work/activate.ts';

const native = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;

test('G-831: occurrence envelopes prove scoped Work participation and preserve legacy relation scopes', async () => {
  const component = native(), revision = native(), work = native(), expectedHead = native();
  const admissionId = Bun.randomUUIDv7();
  const receipt = `urn:rezics:receipt:${hash(`${admissionId}\0relation-change`)}`;
  const eventId = `urn:rezics:event:${hash(`${receipt}\0semantic-write`)}`;
  const batch: MainOutboxBatch = { batchId: `urn:rezics:outbox:${hash(receipt)}`,
    dataEpoch: 'epoch-1', sequence: '5', routingEpoch: 'routing-1', eventIds: [eventId] };
  const fixture = (scope: string, participant = true, expected?: string) => {
    const queries: string[] = [];
    const binding = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
      .map(([key, value]) => [key, { type: 'literal', value }]));
    const fuseki = { query: async (query: string) => {
      queries.push(query);
      if (query.includes('ASK')) return { boolean: participant };
      return { results: { bindings: [binding(queries.length === 1
        ? { kind: `${RV}RelationChangedEvent`, ordinal: '0', action: 'relation.change', receipt,
          outcome: `${RV}Succeeded`, admissionId, digest: 'a'.repeat(64), authorityEpoch: '1', scope,
          epoch: batch.dataEpoch, sequence: batch.sequence, ...(expected ? { expectedHead: expected } : {}) }
        : { component, revision, manifest: `urn:rezics:sha256:${'b'.repeat(64)}`,
          generation: `urn:rezics:model-generation:${'c'.repeat(64)}`, ...(expected ? { expected } : {}) })] } };
    } } as unknown as FusekiClient;
    return { read: () => readMainOutboxEnvelope(fuseki, batch, eventId), queries };
  };
  for (const expected of [undefined, expectedHead]) {
    const f = fixture(`work:edit:${work}`, true, expected);
    expect((await f.read()).data.receipt).toMatchObject({ scope: `work:edit:${work}`, work, component, revision });
    expect(f.queries[2]).toContain(`<${GRAPHS.revisions}>`);
    expect(f.queries[2]).toContain(`<${revision}>`);
    expect(f.queries[2]).toContain(`rv:participant <${work}>`);
    expect(f.queries[2]).not.toContain(`<${GRAPHS.current}>`);
  }
  await expect(fixture(`work:edit:${work}`, false).read()).rejects.toThrow('not a retained participant');
  await expect(fixture('work:edit:https://example.com/work').read()).rejects.toThrow('invalid Work scope');
  await expect(fixture(`work:read:${work}`).read()).rejects.toThrow('differs from its admitted receipt');
  expect((await fixture('relation:create:root').read()).data.receipt).toMatchObject({ scope: 'relation:create:root' });
  expect((await fixture(`relation:edit:${component}`, true, expectedHead).read()).data.receipt)
    .toMatchObject({ scope: `relation:edit:${component}`, expectedHead });
});

test('G-831: unreadable definition anchors do not load or disclose retained bytes', async () => {
  const definition = native(), revision = native();
  let queries = 0;
  const env = { fuseki: { query: async () => {
    queries++;
    return { results: { bindings: [{ definition: { value: definition }, head: { value: revision },
      manifest: { value: 'urn:rezics:sha256:missing' } }] } };
  } } } as unknown as WorkActivationEnvironment;
  expect(await readDefinitionByKey(env, 'private', async () => false)).toBeNull();
  expect(await readExactDefinition(env, revision, async () => false)).toBeNull();
  expect(queries).toBe(2);
});

test('G-831: bootstrap persists canonical keys without conflicting with original seed receipts', async () => {
  const writes: { key: string; state: Record<string, unknown> }[] = [];
  await seedRelationLexicon({
    post: async <T>(_path: string, body: object, key: string) => {
      writes.push({ key, state: (body as { state: Record<string, unknown> }).state });
      return { component: native(), revision: native() } as T;
    },
    authorizeDefinition: async () => {},
  }, native(), 'g831-upgrade', relationLexiconSeed.slice(0, 1), '.temp/g831/bootstrap-unit.json');
  expect(writes[0]!.key).toBe('g831-upgrade:lexicon:v2:adaptation:meaning');
  expect(writes[0]!.state).toMatchObject({ notation: 'adaptation', workSubjectRole: 'adaptation' });
  expect(writes.every(write => write.key.startsWith('g831-upgrade:lexicon:v2:'))).toBe(true);
});

test('G-831: a sixth derivation kind is an ordinary DefinitionRef, including unresolved sources', () => {
  const input: WorkDerivationInput = { targetWork: native(), targetMainVersion: native(), expectedTargetHead: native(),
    sourceWork: native(), sourceMainVersion: null, sourceMainRevision: null,
    kind: native() as WorkDerivationInput['kind'], evidence: 'https://example.com/evidence', actingSubject: native() };
  expect(() => validateWorkDerivation(input)).not.toThrow();
  const triples = derivationTriples(native(), input, Bun.randomUUIDv7(), '1');
  expect(triples).toContain(`rv:derivationKind <${input.kind}>`);
  expect(triples).toContain('rv:LexiconWorkDerivation');
  expect(triples).toContain('rv:sourceVersionStatus rv:Unresolved');
  expect(workDerivationDigest({ ...input, idempotencyKey: 'sixth' })).not.toBe(workDerivationDigest({ ...input,
    kind: 'adaptation', idempotencyKey: 'sixth' }));
});

test('G-831: definition data selects exactly one native subject and relation evidence survives canonicalization', () => {
  const definition = native(), subject = native(), counterpart = native();
  const meaning: ExactDefinition = { definition, revision: native(), lifecycle: 'active', workSubjectRole: 'sequel',
    roles: ['predecessor', 'sequel'].map(key => ({ role: roleIri(definition, key), minParticipants: 1, maxParticipants: 1, ordered: false })),
    roleKeys: Object.fromEntries(['predecessor', 'sequel'].map(key => [roleIri(definition, key), key])) };
  const state = canonicalRelation(meaning, { definition: meaning.revision, evidence: 'https://example.com/source',
    participations: [{ role: 'sequel', participant: { kind: 'resource', ref: subject } },
      { role: 'predecessor', participant: { kind: 'resource', ref: counterpart } }] });
  expect(relationSubjectWork(meaning, state)).toBe(subject);
  expect(state.evidence).toBe('https://example.com/source');
  expect(relationChangeDigest(undefined, null, state)).not.toBe(relationChangeDigest(undefined, null,
    { ...state, evidence: 'https://example.com/different' }));
  expect(() => canonicalRelation(meaning, { definition: meaning.revision, evidence: 'javascript:alert(1)',
    participations: [] })).toThrow();
});

test('G-831: stable keys and singleton Work authority roles are validated as definition data', () => {
  const roles = ['source', 'sixth'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false }));
  expect(checkedComponentState({ component: 'definition', kind: 'relation', notation: 'sixth', workSubjectRole: 'sixth', roles }))
    .toMatchObject({ notation: 'sixth', workSubjectRole: 'sixth' });
  const definition = native();
  expect(ownedTriples(definition, { component: 'definition', kind: 'relation', lifecycle: 'active', successor: null,
    notation: 'sixth', workSubjectRole: 'sixth', roles }, native()).some(triple => triple.includes('notation'))).toBe(false);
  expect(definitionKeyTriples(definition, 'sixth')).toContain(`<${definitionKeyIri(definition)}> a <https://rezics.com/vocab/DefinitionKey>`);
  expect(definitionKeyTriples(definition, 'sixth')).toContain('"sixth"^^<http://www.w3.org/2001/XMLSchema#string>');
  expect(() => checkedComponentState({ component: 'definition', kind: 'relation', notation: 'Bad key', roles })).toThrow();
  expect(() => checkedComponentState({ component: 'definition', kind: 'relation', workSubjectRole: 'source',
    roles: roles.map(role => ({ ...role, maxParticipants: 64 })) })).toThrow();
  for (const action of ['relation.change', 'work.derive']) {
    expect(baselineTarget(action, `work:edit:${native()}`)?.kind).toBe('author-work');
    expect(baselineTarget(action, 'relation:create:root')).toBeNull();
  }
});
