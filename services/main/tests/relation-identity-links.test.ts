import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relationLexiconSeed, variantKindConcepts } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { canonicalRelation, relationChangeDigest, type ExactDefinition } from '../src/modules/relation/change.ts';
import { PARTICIPATION_FORMAT_V2, checkedParticipations, type RelationRoleDefinition } from '../src/modules/relation/schema.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { SemanticChangeRejected } from '../src/modules/semantic/command.ts';

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
