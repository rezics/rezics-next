import { expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { RetainedRelationInput } from '../src/modules/relation/retained-contract.ts';
import { retainedRelationBindingInput, retainedRelationMapping, storedRetainedCreditOrigin,
  admittedRetainedRelationChange } from '../src/modules/relation/retained-change.ts';
import { retainedRelationOwnerMetadata, selectRetainedRelationHead } from '../src/modules/relation/retained-read.ts';
import { canonicalRelation, type ExactDefinition } from '../src/modules/relation/change.ts';
import { UnsupportedRelationModel } from '../src/modules/relation/v2-schema.ts';
import { hash, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { prepareRetainedCreditBinding } from '../src/modules/work/credit-association-write.ts';
import { RetainedCreditReadUnavailable } from '../src/modules/work/credit-association-read.ts';
import type { CreditOwnerWitness } from '../src/modules/work/credit-verification.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (): RetainedRelationInput => ({ profile: 'relation-change-v2', mode: 'bind-retained-credit',
  retained: { profile: 'work-author-credit-v1', credit: id(1), origin: { kind: 'stored-credit', revision: id(2) } },
  expectedAssociationHead: null, mappingRevision: id(3), attributionSupports: [], actingSubject: id(4) });
const witness = (): CreditOwnerWitness => ({ profile: 'work-author-credit-v1',
  value: { credit: id(1), revision: id(2), work: id(5), expectedHead: id(6), sourceKey: '0042',
    sourceRoleKey: 'original-editor', nativeOrdinal: 7, actingSubject: id(4),
    provider: 'openlibrary', namespace: 'author', role: 'editor' },
  receipt: { receipt: `urn:rezics:receipt:${hash('actual-native-command')}`, admissionId: id(7).slice(-36),
    requestDigest: hash('actual-native-command'), authorityEpoch: '1', scope: `work:edit:${id(5)}`,
    dataEpoch: 'original', sequence: '9', credit: id(1), revision: id(2), work: id(5), expectedHead: id(6), sourceIntent: id(1) } });
const definition = (): ExactDefinition => ({ definition: id(8), revision: id(3), lifecycle: 'active', modelRevision: PROFILES.definitionV2,
  workSubjectRole: 'work', association: { kind: 'credit', workRole: 'work', subjectRoles: ['subject'] },
  retainedCredit: { origin: 'work-author-credit-v1', storedRole: 'editor', subjectRole: 'subject',
    externalNamespace: { provider: 'openlibrary', namespace: 'author' } },
  roles: [{ role: `${id(8)}/role/work`, minParticipants: 1, maxParticipants: 1, ordered: false },
    { role: `${id(8)}/role/subject`, minParticipants: 1, maxParticipants: 1, ordered: true }],
  roleKeys: { [`${id(8)}/role/work`]: 'work', [`${id(8)}/role/subject`]: 'subject' } });

test('stored origin keeps exact native Work basis, ordinal, role and external key without inferring names or absences', () => {
  const original = witness(), request = input(), before = structuredClone({ original, request });
  const origin = storedRetainedCreditOrigin(request, original);
  expect(origin).toEqual({ credit: id(1), creditRevision: id(2), work: id(5), workRevision: id(6), retainedProfile: original.profile,
    role: 'editor', origin: request.retained.origin, subject: { participant: { kind: 'external', provider: 'openlibrary', namespace: 'author', key: '0042' },
      position: 7, attributionSupports: [] } });
  expect(origin.subject).not.toHaveProperty('sourceIdentity');
  expect(origin.subject).not.toHaveProperty('creditedName');
  expect({ original, request }).toEqual(before);
  for (const changed of [{ ...original, profile: 'native-agent-credit-v1' as const },
    { ...original, value: { ...original.value, credit: id(99) } },
    { ...original, value: { ...original.value, revision: id(99) } },
    { ...original, value: { ...original.value, role: undefined } }]) {
    expect(() => storedRetainedCreditOrigin(request, changed)).toThrow('original retained credit is unavailable');
  }
});

test('authored mapping rejects origin, role, kind, Work role, subject role and namespace mismatches', () => {
  const request = input(), authored = definition(), original = storedRetainedCreditOrigin(request, witness());
  expect(retainedRelationMapping(authored, request, original)).toEqual({ definition: id(8), revision: id(3),
    workRole: `${id(8)}/role/work`, subjectRole: `${id(8)}/role/subject`, originProfile: 'work-author-credit-v1',
    originRole: 'editor', externalNamespace: { provider: 'openlibrary', namespace: 'author' } });
  for (const changed of [{ ...authored, modelRevision: PROFILES.definition }, { ...authored, revision: id(99) },
    { ...authored, association: { ...authored.association!, kind: 'appearance' as const } },
    { ...authored, workSubjectRole: 'subject' }, { ...authored, association: { ...authored.association!, subjectRoles: ['subject', 'other'] } },
    { ...authored, retainedCredit: { ...authored.retainedCredit!, storedRole: 'author' as const } },
    { ...authored, retainedCredit: { ...authored.retainedCredit!, origin: 'native-agent-credit-v1' as const } },
    { ...authored, retainedCredit: { ...authored.retainedCredit!, externalNamespace: { provider: 'openlibrary', namespace: 'work' } } }]) {
    expect(() => retainedRelationMapping(changed, request, original)).toThrow();
  }
  for (const changed of [{ ...original, credit: id(99) }, { ...original, origin: { kind: 'stored-credit' as const, revision: id(99) } }])
    expect(() => retainedRelationBindingInput(request, authored, changed)).toThrow('another occurrence');
});

test('native Performer uses its actual Agent and has no invented ordinal or external namespace', () => {
  const request = input(); request.retained.profile = 'native-agent-credit-v1';
  const native = witness(); native.profile = 'native-agent-credit-v1'; native.value.agent = id(40); native.value.role = 'performer';
  const origin = storedRetainedCreditOrigin(request, native);
  expect(origin.subject.participant).toEqual({ kind: 'resource', ref: id(40) });
  expect(origin.subject.position).toBeUndefined();
  expect(origin.role).toBe('performer');
  const authored = definition(); authored.retainedCredit = { origin: native.profile, storedRole: 'performer', subjectRole: 'subject' };
  authored.roles[1]!.ordered = false;
  const binding = retainedRelationBindingInput(request, authored, origin);
  expect(binding.mapping.externalNamespace).toBeNull();
  expect(binding.role).toBe('performer');
});

test('prepared binding reuses occurrence-local allocations on replay and keeps repeated native credits distinct', async () => {
  const env = { fuseki: { query: () => { throw new Error('an initial preparation cannot read or write a replacement child'); } } } as unknown as WorkActivationEnvironment;
  const request = input(), authored = definition(), original = storedRetainedCreditOrigin(request, witness());
  const binding = retainedRelationBindingInput(request, authored, original);
  const first = await prepareRetainedCreditBinding(env, binding);
  expect(await prepareRetainedCreditBinding(env, binding)).toEqual(first);
  const parts = canonicalRelation(authored, { profile: 'relation-change-v2', definition: authored.revision,
    participations: first.state.participations.map(({ id: _id, role, ...part }) => ({ ...part, role: authored.roleKeys[role]! })) });
  expect(parts.participations).toHaveLength(2);
  expect(parts.participations.find(part => part.role === first.state.mapping.subjectRole)?.position).toBe(7);
  const repeated = await prepareRetainedCreditBinding(env, { ...binding, credit: id(41) });
  expect(repeated.state.workParticipation).not.toBe(first.state.workParticipation);
  expect(repeated.state.subjectParticipation).not.toBe(first.state.subjectParticipation);
  expect(repeated.state.participations[1]!.participant).toEqual(first.state.participations[1]!.participant);
  const unsupported = { ...binding, subject: { ...binding.subject, attributionSupports: [{ basis: { kind: 'native-credit' as const,
    credit: id(1), revision: id(2) }, fields: ['creditedName' as const], evidence: [id(70)] }] } };
  await expect(prepareRetainedCreditBinding(env, unsupported)).rejects.toThrow();
});

test('untrusted replacement fields are refused before any account, authority or native owner call', async () => {
  const work = new Proxy({}, { get() { throw new Error('closed input must fail before touching an owner'); } }) as MainWorkDependencies;
  await expect(admittedRetainedRelationChange(work, new Request('https://main.test/v1/relations/changes'),
    { ...input(), participant: { kind: 'resource', ref: id(99) } } as RetainedRelationInput, 'attempt-1')).rejects.toThrow('command is closed');
});

test('exact retained selection never retargets an old revision and refuses ambiguous current heads', async () => {
  const seen: string[] = [];
  const env = { fuseki: { query: async (query: string) => { seen.push(query); return { results: { bindings: [] } }; } } } as unknown as WorkActivationEnvironment;
  expect(await selectRetainedRelationHead(env, id(1), id(2))).toBeNull();
  expect(seen[0]).toContain(`VALUES ?head { <${id(2)}> }`);
  expect(seen[0]).not.toContain('associationHead');
  const ambiguous = { fuseki: { query: async () => ({ results: { bindings: [{ head: { value: id(2) } }, { head: { value: id(3) } }] } }) } } as unknown as WorkActivationEnvironment;
  await expect(selectRetainedRelationHead(ambiguous, id(1))).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
});

test('exact envelope requires a real operation and sealed generation instead of inventing them from IDs or current state', async () => {
  const generation = `urn:rezics:model-generation:${hash('original-generation')}`, operation = id(80);
  const env = (rows: unknown[]) => ({ fuseki: { query: async () => ({ results: { bindings: rows } }) } }) as unknown as WorkActivationEnvironment;
  const row = { operation: { value: operation }, generation: { value: generation } };
  expect(await retainedRelationOwnerMetadata(env([row]), id(1), id(2), witness().receipt.receipt)).toEqual({ operation, modelGeneration: generation });
  for (const rows of [[], [row, row], [{ ...row, operation: { value: witness().receipt.receipt } }],
    [{ ...row, generation: { value: id(2) } }], [{ generation: row.generation }]]) {
    await expect(retainedRelationOwnerMetadata(env(rows), id(1), id(2), witness().receipt.receipt))
      .rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  }
  expect(new UnsupportedRelationModel().modelRevision).toContain('relation-occurrence-v2');
  expect(new UnsupportedRelationModel('https://rezics.com/definition/retained-credit-associations-v1').schema)
    .toBe('https://rezics.com/definition/retained-credit-associations-v1');
});
