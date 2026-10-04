import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relationLexiconSeed, variantKindConcepts } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { canonicalRelation, relationChangeDigest, type ExactDefinition } from '../src/modules/relation/change.ts';
import { PARTICIPATION_FORMAT_V2, checkedParticipations, type RelationRoleDefinition } from '../src/modules/relation/schema.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { SemanticChangeRejected } from '../src/modules/semantic/command.ts';
import { selectedProjection } from '../src/modules/lexicon/render.ts';
import { seedRelationLexicon, type SeedLexiconClient } from '../../../scripts/dev/seed/relation-lexicon.ts';

const DEFINITION = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000d1';
const ref = (n: number) => ({ kind: 'resource' as const, ref: `https://rezics.com/id/01990000-0000-7000-8000-${String(n).padStart(12, '0')}` });
const role = (key: string): RelationRoleDefinition => ({ role: `${DEFINITION}/role/${key}`, minParticipants: 1,
  maxParticipants: 1, ordered: false });
const definition: ExactDefinition = { revision: 'https://rezics.com/id/01990000-0000-7000-8000-0000000000d2',
  definition: DEFINITION, lifecycle: 'active', roles: ['variant', 'hub', 'kind'].map(role),
  roleKeys: {}, star: { leaf: 'variant', hub: 'hub' } };
const input = (variant: unknown, hub: unknown, extra: object = {}) => ({ definition: definition.revision,
  participations: [{ role: 'variant', participant: variant, ...extra }, { role: 'hub', participant: hub },
    { role: 'kind', participant: ref(9) }] });

test('credited names: language-tagged, bounded and kept on the participation only', () => {
  const roles = [role('variant'), role('hub')];
  const named = checkedParticipations(roles, [
    { role: roles[0]!.role, participant: ref(1), creditedName: { lexical: 'Saber', language: 'en' } },
    { role: roles[1]!.role, participant: ref(2) }]);
  expect(named[0]!.creditedName).toEqual({ lexical: 'Saber', language: 'en' });
  expect(named[1]!.creditedName).toBeUndefined();
  for (const bad of [{ lexical: '', language: 'en' }, { lexical: '  ', language: 'en' }, { lexical: 'x', language: '' },
    { lexical: 'x'.repeat(201), language: 'en' }, { lexical: 'x', language: 'en', direction: 'rtl' }, 'Saber', null]) {
    expect(() => checkedParticipations(roles, [{ role: roles[0]!.role, participant: ref(1), creditedName: bad },
      { role: roles[1]!.role, participant: ref(2) }])).toThrow('credited name');
  }
});

test('credited names change the command digest; absent names keep the v1 digest', () => {
  const state = (name?: object) => canonicalRelation(definition, input(ref(1), ref(2), name ? { creditedName: name } : {}));
  const plain = relationChangeDigest(undefined, null, state());
  expect(relationChangeDigest(undefined, null, state({ lexical: 'Saber', language: 'en' }))).not.toBe(plain);
  expect(relationChangeDigest(undefined, null, state({ lexical: 'Saber', language: 'en' })))
    .not.toBe(relationChangeDigest(undefined, null, state({ lexical: 'Saber', language: 'ja' })));
  expect(JSON.stringify(state().participations)).not.toContain('creditedName');
});

test('star definitions name two distinct roles; occurrences keep leaf and hub apart', () => {
  const base = { component: 'definition', kind: 'relation', roles: ['variant', 'hub', 'kind'].map(key =>
    ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) };
  expect(checkedComponentState({ ...base, star: { leaf: 'variant', hub: 'hub' } })).toMatchObject({
    star: { leaf: 'variant', hub: 'hub' } });
  for (const star of [{ leaf: 'variant', hub: 'variant' }, { leaf: 'variant', hub: 'absent' }, { leaf: 'variant' },
    { leaf: 'variant', hub: 'hub', extra: 1 }, 'variant']) {
    expect(() => checkedComponentState({ ...base, star })).toThrow(SemanticChangeRejected);
  }
  expect(() => canonicalRelation(definition, input(ref(1), ref(1)))).toThrow('both leaf and hub');
  expect(() => canonicalRelation(definition, input({ kind: 'external', provider: 'p', namespace: 'n', key: 'k' }, ref(2))))
    .toThrow('star roles take native resources');
  expect(canonicalRelation(definition, input(ref(1), ref(2))).participations).toHaveLength(3);
});

test('lexicon seed: identity definitions carry the star, no Work authority and eight locales', () => {
  const seed = (key: string) => relationLexiconSeed.find(item => item.key === key)!;
  expect(seed('variant-of')).toMatchObject({ roles: ['hub', 'variant'], extraRoles: ['kind'],
    star: { leaf: 'variant', hub: 'hub' }, workAuthority: false });
  expect(seed('holds-title').roles).toEqual(['title', 'holder']);
  expect(seed('represents').roles).toEqual(['character', 'unit']);
  expect(seed('in-continuity').roles).toContain('work');
  for (const key of ['variant-of', 'holds-title', 'represents', 'in-continuity']) {
    expect(seed(key).labels.map(label => label[0]).sort())
      .toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);
    expect(seed(key).labels.every(label => label.every(text => text.length > 0))).toBe(true);
  }
  expect(seed('variant-of').labels[0]).toEqual(['en', 'Variant', 'Variants', 'Variant of', 'Variants of']);
  expect(variantKindConcepts.map(kind => kind.key)).toEqual(['persona', 'counterpart']);
  expect(variantKindConcepts.every(kind => kind.labels.length === 8)).toBe(true);
});

test('canonical routing: participations with the v2 format take the v2 shape, others keep v1', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../../generated/model/manifest.json'), 'utf8')) as {
    canonical: { type: string; routes: { profile: string; when: { path: string; value: string }[] }[] }[] };
  const routes = manifest.canonical.find(entry => entry.type === 'https://rezics.com/vocab/RelationParticipation')!.routes;
  expect(routes.map(route => route.profile)).toEqual(['relation-occurrence-v2', 'relation-occurrence-v1']);
  expect(routes[0]!.when).toEqual([{ path: 'https://rezics.com/vocab/participationFormat', value: PARTICIPATION_FORMAT_V2 }]);
  expect(routes[1]!.when).toEqual([]);
});

const native = (n: number) => `https://rezics.com/id/01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

test('revelation position: validated, part of the command digest and kept out of the stored occurrence', () => {
  const state = (revealedAt?: unknown) => canonicalRelation(definition, { ...input(ref(1), ref(2)),
    ...(revealedAt === undefined ? {} : { revealedAt: revealedAt as never }) });
  const at = { work: native(40), occurrence: native(41) };
  expect(state(at).revealedAt).toEqual(at);
  expect(state().revealedAt).toBeUndefined();
  const plain = relationChangeDigest(undefined, null, state());
  expect(relationChangeDigest(undefined, null, state(at))).not.toBe(plain);
  expect(relationChangeDigest(undefined, null, state(at)))
    .not.toBe(relationChangeDigest(undefined, null, state({ ...at, occurrence: native(42) })));
  for (const bad of [{ work: native(40) }, { work: 'https://example.test/w', occurrence: native(41) }, { ...at, extra: 1 }, 'x', null]) {
    expect(() => state(bad)).toThrow();
  }
});

test('role members: a role with declared members takes only those native resources', () => {
  const roles = [{ ...role('kind'), members: [native(50), native(51)] }, role('variant')];
  const write = (kind: unknown) => checkedParticipations(roles, [{ role: roles[0]!.role, participant: kind },
    { role: roles[1]!.role, participant: ref(1) }]);
  expect(write({ kind: 'resource', ref: native(51) })).toHaveLength(2);
  expect(() => write({ kind: 'resource', ref: native(52) })).toThrow('admitted member');
  expect(() => write({ kind: 'external', provider: 'p', namespace: 'n', key: 'k' })).toThrow('admitted member');
  // A role without members stays open.
  expect(checkedParticipations([role('variant')], [{ role: roles[1]!.role, participant: ref(7) }])).toHaveLength(1);
});

test('definition state: role members are bounded native resources and the star hub takes exactly one participant', () => {
  const roles = (extra: object = {}, hub: object = {}) => ['variant', 'hub', 'kind'].map(key => ({ key,
    minParticipants: 1, maxParticipants: 1, ordered: false, ...(key === 'kind' ? extra : {}), ...(key === 'hub' ? hub : {}) }));
  const base = (r: unknown[], star: object | null = { leaf: 'variant', hub: 'hub' }) => ({ component: 'definition',
    kind: 'relation', roles: r, ...(star ? { star } : {}) });
  const checked = checkedComponentState(base(roles({ members: [native(51), native(50)] })));
  const stored = (checked as { roles: { key: string; members?: string[] }[] }).roles;
  expect(stored.find(item => item.key === 'kind')!.members).toEqual([native(50), native(51)]);
  expect(stored.find(item => item.key === 'hub')!.members).toBeUndefined();
  for (const members of [[], [native(50), native(50)], ['not-an-iri'], 'x', Array.from({ length: 9 }, (_, i) => native(60 + i))]) {
    expect(() => checkedComponentState(base(roles({ members })))).toThrow(SemanticChangeRejected);
  }
  expect(() => checkedComponentState(base(roles({}, { minParticipants: 0 })))).toThrow('exactly one participant');
  expect(() => checkedComponentState(base(roles({}, { maxParticipants: 2 })))).toThrow('exactly one participant');
  // Without a star the hub role is an ordinary role.
  expect(checkedComponentState(base(roles({}, { maxParticipants: 2 }), null))).toMatchObject({ component: 'definition' });
});

test('seed: the variant-of kind role is bound to the two seeded Concepts', () => {
  const seed = relationLexiconSeed.find(item => item.key === 'variant-of')!;
  expect([...seed.roleMembers!.kind!]).toEqual(variantKindConcepts.map(kind => kind.key));
  expect(relationLexiconSeed.filter(item => item.key !== 'variant-of').some(item => 'roleMembers' in item)).toBe(false);
});

test('rendered arguments never carry the credited name of an unavailable participant', () => {
  const credit = { lexical: 'Saber Alter', language: 'en' };
  const projection = selectedProjection([], 'variant', 'hub', ['en'], [
    { role: 'variant', participant: { kind: 'unavailable-reference' }, creditedName: credit },
    { role: 'hub', participant: ref(2), creditedName: credit }]);
  expect(projection.arguments.find(item => item.role === 'variant')).not.toHaveProperty('creditedName');
  expect(projection.arguments.find(item => item.role === 'hub')!.creditedName).toEqual(credit);
});

test('seed: kind members reach the definition state, and an older revision without them is revised', async () => {
  const concepts = { persona: native(70), counterpart: native(71) };
  const data = [{ ...relationLexiconSeed.find(item => item.key === 'variant-of')!, labels: [] as const }];
  const file = `/tmp/relation-identity-links-${Bun.randomUUIDv7()}.json`;
  const posted: { target?: string; state: { roles: { key: string; members?: string[] }[] } }[] = [];
  const component = native(72), head = native(73);
  const roleState = (members?: string[]) => ['hub', 'kind', 'variant'].map(key => ({ key, minParticipants: 1,
    maxParticipants: 1, ordered: false, ...(key === 'kind' && members ? { members } : {}) }));
  const client = (current: { members?: string[] } | null): SeedLexiconClient => ({
    post: async <T>(_path: string, body: object) => { posted.push(body as never); return { component, revision: native(74) } as T; },
    authorizeDefinition: async () => {},
    currentDefinition: async () => current && { component, revision: head, state: { component: 'definition',
      kind: 'relation', lifecycle: 'active', successor: null, notation: 'variant-of', star: { leaf: 'variant', hub: 'hub' },
      roles: roleState(current.members) } as never },
  });
  await seedRelationLexicon(client(null), native(75), 'ns-members', data, file, concepts);
  expect(posted.at(-1)!.state.roles.find(item => item.key === 'kind')!.members).toEqual([concepts.persona, concepts.counterpart].sort());
  expect(posted.at(-1)!.state.roles.find(item => item.key === 'hub')!.members).toBeUndefined();
  posted.length = 0;
  await seedRelationLexicon(client({}), native(75), 'ns-members', data, file, concepts);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.target).toBe(component);
  expect(posted[0]!.state.roles.find(item => item.key === 'kind')!.members).toHaveLength(2);
  posted.length = 0;
  await seedRelationLexicon(client({ members: [concepts.persona, concepts.counterpart].sort() }), native(75), 'ns-members', data, file, concepts);
  expect(posted).toHaveLength(0);
  // Without the Concepts the role stays open, as before.
  await seedRelationLexicon(client(null), native(75), 'ns-members', data, file);
  expect(posted.at(-1)!.state.roles.find(item => item.key === 'kind')!.members).toBeUndefined();
});
