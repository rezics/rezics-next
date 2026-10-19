import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkedComponentState, checkedStoredState, semanticChangeDigest, semanticRevisionMetadata,
  type DefinitionState } from '../src/modules/semantic/change.ts';
import { assertAssociationMeaning, type RetainedCreditMapping } from '../src/modules/semantic/association.ts';
import { sealComponentState } from '../src/modules/semantic/command.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { readExactDefinition, roleIri } from '../src/modules/relation/change.ts';
import { systemDisclosure } from '../src/modules/target/disclosed-references.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { semanticError } from '../src/routes/semantic.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const relation = (): DefinitionState => ({ component: 'definition', kind: 'relation', lifecycle: 'active', successor: null,
  roles: [
    { key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
    { key: 'subject', minParticipants: 1, maxParticipants: 4, ordered: true },
  ], workSubjectRole: 'work', association: { kind: 'appearance', workRole: 'work', subjectRoles: ['subject'] } });
const canonical = (state: unknown) => checkedComponentState(state, 'semantic-change-v2') as DefinitionState;

test('authored association meaning is opt-in and its digest never aliases V1', () => {
  const state = relation();
  expect(() => checkedComponentState(state)).toThrow('unsupported fields');
  expect(canonical(state).association).toEqual(state.association);
  const { association: _, ...plain } = state;
  const v1 = checkedComponentState(plain);
  expect(semanticChangeDigest(undefined, null, v1)).not.toBe(semanticChangeDigest(undefined, null, v1, 'semantic-change-v2'));
  expect(canonical(plain).association).toBeUndefined();
  expect(() => checkedStoredState({ ...state })).toThrow('stored semantic state is invalid');
  expect(checkedStoredState({ ...state }, PROFILES.definitionV2)).toEqual(canonical(state));
});

test('association roles must be exact declared Work and subject roles', () => {
  for (const association of [
    { kind: 'appearance', workRole: 'subject', subjectRoles: ['work'] },
    { kind: 'credit', workRole: 'work', subjectRoles: ['work'] },
    { kind: 'credit', workRole: 'work', subjectRoles: ['subject', 'subject'] },
    { kind: 'protagonist', workRole: 'work', subjectRoles: ['subject'] },
    { kind: 'appearance', workRole: 'work', subjectRoles: ['missing'] },
    { kind: 'appearance', workRole: 'work', subjectRoles: ['subject'], inferredSex: 'male' },
  ]) expect(() => canonical({ ...relation(), association })).toThrow();
  expect(() => canonical({ ...relation(), workSubjectRole: undefined })).toThrow();
});

test('retained credit mappings bind exact origins, roles and qualified namespaces', () => {
  const base = { ...relation(), association: { ...relation().association, kind: 'credit' } };
  const mapping: RetainedCreditMapping = { origin: 'source-reported-credit-v1', storedRole: 'transcriber', subjectRole: 'subject',
    externalNamespace: { provider: 'musicbrainz', namespace: 'artist' } };
  expect(canonical({ ...base, retainedCredit: mapping }).retainedCredit).toEqual(mapping);
  for (const retainedCredit of [
    { ...mapping, origin: 'native-agent-credit-v1' }, { ...mapping, subjectRole: 'work' },
    { ...mapping, storedRole: 'protagonist' }, { ...mapping, externalNamespace: { provider: 'MB artist', namespace: 'artist' } },
  ]) expect(() => canonical({ ...base, retainedCredit })).toThrow();
  expect(() => canonical({ ...relation(), retainedCredit: mapping })).toThrow();
});

test('authored bindings cannot be removed or reinterpreted in place; presentation and bounds can refine', async () => {
  const before = canonical(relation());
  expect(() => assertAssociationMeaning(before, canonical({ ...relation(), lifecycle: 'retired', successor: id(3) }))).not.toThrow();
  expect(() => assertAssociationMeaning(before, canonical({ ...relation(), roles: relation().roles.map(role =>
    role.key === 'subject' ? { ...role, maxParticipants: 8 } : role) }))).not.toThrow();
  for (const state of [{ ...relation(), association: undefined },
    { ...relation(), association: { ...relation().association, kind: 'credit' } }]) {
    try { assertAssociationMeaning(before, canonical(state)); throw new Error('expected immutable meaning refusal'); }
    catch (error) { const response = semanticError(error); expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('immutable_meaning'); }
  }
  const { association: _, ...v1 } = relation();
  expect(() => assertAssociationMeaning(checkedComponentState(v1) as DefinitionState, before)).not.toThrow();
});

test('the occurrence assertion is an exact authored property, not a relation or arbitrary property upgrade', () => {
  expect(canonical({ component: 'definition', kind: 'property', roles: [], notation: 'association-occurrence-assertion-v1' }).kind).toBe('property');
  expect(() => canonical({ component: 'definition', kind: 'property', roles: [], notation: 'anything-else' })).toThrow();
  expect(() => canonical({ component: 'definition', kind: 'property', roles: [], notation: 'association-occurrence-assertion-v1',
    association: relation().association })).toThrow();
});

test('exact definition reads use the sealed model revision, never a newer head or label inference', async () => {
  const directory = mkdtempSync(join(import.meta.dir, '../../../.temp/association-definition-'));
  const replies: SparqlResult[] = [];
  const queries: string[] = [];
  const env = { objectDirectory: directory, fuseki: { query: async (query: string) => {
    queries.push(query); const reply = replies.shift(); if (!reply) throw new Error('unexpected query'); return reply;
  } } } as unknown as WorkActivationEnvironment;
  const uri = (value: string) => ({ type: 'uri', value });
  try {
    const definition = id(1), revision = id(2);
    const manifest = await sealComponentState(env, definition, PROFILES.definitionV2, canonical(relation()));
    replies.push({ results: { bindings: [{ definition: uri(definition), manifest: uri(manifest),
      kind: uri('https://rezics.com/vocab/RelationDefinition'), model: uri(PROFILES.definitionV2) }] } });
    const exact = await readExactDefinition(env, revision, systemDisclosure);
    expect(exact?.association).toEqual(relation().association);
    expect(exact?.roleKeys[roleIri(definition, 'subject')]).toBe('subject');
    expect(exact?.modelRevision).toBe(PROFILES.definitionV2);
    expect(queries.every(query => !query.includes('definitionHead'))).toBe(true);
    replies.push({ results: { bindings: [{ generation: uri(id(5)), manifest: uri(manifest) }] } });
    expect(await semanticRevisionMetadata(env, definition, revision)).toEqual({ modelGeneration: id(5), manifest });
    replies.push({ results: { bindings: [] } });
    await expect(semanticRevisionMetadata(env, definition, revision)).rejects.toThrow('receipt revision is unavailable');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
