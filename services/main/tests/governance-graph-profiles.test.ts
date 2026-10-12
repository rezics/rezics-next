import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import manifest from '../../../generated/model/manifest.json';
import { commandBindingRead, selectCommandProfile } from '../../../model/compiler/registry.ts';
import type { ContentModeration } from '../../content/src/moderation.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { ownerModerationEffects } from '../src/modules/governance/effects.ts';
import { CANONICAL_TYPES, semanticOwnerTypes } from '../src/modules/semantic/change.ts';
import { GovernanceConflict, GovernanceStale, type DecisionTargetInput } from '../src/modules/governance/store.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const skos = 'http://www.w3.org/2004/02/skos/core#';

function graph(kind: string, selectors: Record<string, string> = {}) {
  const resource = native(), head = native();
  const definitions = { scheme: native(), concept: resource, path: native(), expression: native(), sense: native() };
  const target: DecisionTargetInput = { owner: 'graph', resource, component: 'record', locator: null,
    scopeKind: 'component', revision: null, expectedHead: head, effect: 'disclosure' };
  const state = { head, selectors, kinds: [kind], loseResponse: false, stale: false,
    status: 'committed' as 'committed' | 'invalid', digest: '', becomeRealm: false, bindingRows: 1 };
  const receipts = new Map<string, { digest: string; head: string }>();
  const commands: CommandEnvelope[] = [];
  const reads: string[] = [];
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() }, fuseki: {
    query: async (sql: string) => {
      reads.push(sql);
      if (sql.includes('SELECT ?digest ?target ?head')) {
        const saved = [...receipts.entries()].find(([id]) => sql.includes(`<${id}>`))?.[1];
        return { results: { bindings: saved ? [{ digest: literal(state.digest || saved.digest),
          target: uri(resource), head: uri(saved.head) }] : [] } };
      }
      if (sql.includes('# registry-binding:')) {
        const profile = sql.match(/# registry-binding:([^\s]+)/)![1]!;
        const binding = manifest.profiles.find(entry => entry.id === profile)!.binding!;
        const selected = selectCommandProfile(manifest, state.kinds,
          path => state.selectors[path] ? [state.selectors[path]!] : []);
        const shape = selected!.shape;
        const read = commandBindingRead(profile, binding, shape, ['urn:rezics:graph:current']);
        const role = shape.split('/').at(-1)!.replace(/-shape$/, '');
        return { results: { bindings: Array.from({ length: state.bindingRows }, () => Object.fromEntries(
          read.keys.map(key => [read.variables[key]!, binding.roles.includes(key)
            ? uri(key === role ? resource : native()) : literal(`reviewed-${key}`)]))) } };
      }
      if (sql.includes('ASK')) {
        if (state.becomeRealm) state.kinds = [`${RV}Realm`];
        return { boolean: state.kinds.includes(`${RV}ZoneHomeDocument`) };
      }
      if (sql.includes('SELECT ?head')) return { results: { bindings: state.head ? [{ head: uri(state.head) }] : [] } };
      if (sql.includes('SELECT DISTINCT ?kind ?head')) return { results: { bindings: state.kinds.flatMap(current => {
        const terms = Object.entries(state.selectors).map(([path, value]) => ({ selector: uri(path), value: uri(value) }));
        return (sql.includes('?selector') && terms.length ? terms : [{}]).map(term => ({ kind: uri(current), ...term }));
      }) } };
      throw new Error(`Unexpected graph query: ${sql}`);
    },
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([id, definition]) => [id, definition.sha256])) }),
    commandWithReceipt: async (command: CommandEnvelope) => {
      commands.push(command);
      for (const profile of new Set(command.validations.map(entry => entry.profile))) {
        const entries = command.validations.filter(entry => entry.profile === profile);
        const required = manifest.profiles.find(entry => entry.id === profile)?.binding;
        if (!required) { expect(entries.every(entry => !entry.binding)).toBe(true); continue; }
        const args = entries[0]!.binding;
        expect(args, `${profile} needs its native bindings`).toBeDefined();
        expect(Object.keys(args!).sort()).toEqual(expect.arrayContaining(required.required));
        expect(Object.keys(args!).every(key => [...required.required, ...required.optional].includes(key))).toBe(true);
        const roles = entries.map(entry => entry.shape.split('/').at(-1)!.replace(/-shape$/, ''));
        expect(roles.sort()).toEqual([...required.roles].sort());
        for (const entry of entries) {
          expect(entry.binding).toEqual(args);
          expect(entry.focus).toHaveLength(1);
          const role = entry.shape.split('/').at(-1)!.replace(/-shape$/, '');
          if (args![role]) expect(entry.focus).toEqual([args![role]]);
        }
      }
      if (state.stale || state.head !== head) return { status: 'guard-unmatched' };
      if (state.status === 'invalid') return { status: 'invalid' };
      receipts.set(command.receipt, { digest: command.digest, head });
      if (state.loseResponse) throw new Error('Lost response after commit');
      return { status: 'committed' };
    },
  } } as unknown as WorkActivationEnvironment;
  return { target, state, commands, reads, receipts, effects: ownerModerationEffects({} as ContentModeration, env) };
}

for (const [kind, selectors, profile, shape, component, predicate] of [
  ['https://schema.org/CreativeWork', {}, 'work-metadata-v1', 'work', 'record', 'head'],
  [`${RV}MainVersion`, {}, 'work-metadata-v1', 'main-version', 'body', 'head'],
  [`${RV}Structure`, {}, 'structure-composition-v1', 'structure', 'structure', 'structureHead'],
  [`${skos}Concept`, {}, 'classification-proposition-v1', 'concept', 'record', 'head'],
  [`${skos}Concept`, { [`${RV}definitionProfile`]: 'https://rezics.com/definition/classification-proposition-v2' },
    'classification-proposition-v2', 'concept', 'record', 'head'],
  [`${RV}Agent`, {}, 'agent-provision-v1', 'agent', 'record', 'head'],
  [`${RV}Agent`, { [`${RV}profileNameFormat`]: `${RV}LocalizedNameV2` }, 'agent-profile-v2', 'profile', 'record', 'head'],
  [`${RV}Agent`, { [`${RV}profileNameFormat`]: `${RV}PlainNameAddressV1` },
    'agent-profile-address-v1', 'profile', 'record', 'head'],
  [`${RV}Agent`, { [`${RV}profileNameFormat`]: `${RV}LocalizedNameAddressV1` },
    'agent-profile-address-v1', 'localized-profile', 'record', 'head'],
  [`${RV}Space`, {}, 'space-realm-v1', 'space', 'record', 'head'],
  ...['space-realm-v2', 'space-realm-v3', 'space-zone-v1'].map(profile =>
    [`${RV}Space`, { [`${RV}definitionProfile`]: `https://rezics.com/definition/${profile}` },
      profile, 'space', 'record', 'head'] as const),
] as const) {
  test(`${kind} uses ${profile}/${shape} and its owner head`, async () => {
    const f = graph(kind, selectors);
    const selected = { ...f.target, component };
    const result = await f.effects.apply(randomUUID(), 1, selected);
    expect(result).toHaveProperty('receipt');
    const command = f.commands[0]!;
    expect(command.validations).toContainEqual(expect.objectContaining({ profile,
      shape: `https://rezics.com/definition/${profile}/${shape}-shape`, focus: [selected.resource] }));
    if (kind === `${skos}Concept`) {
      expect(command.validations).toHaveLength(5);
      expect(command.validations?.every(validation => validation.binding?.concept === selected.resource)).toBe(true);
      expect(command.update).toContain('<https://rezics.com/vocab/terminalConcept>');
    }
    expect(command.update).toContain(`<${selected.resource}> rv:${predicate} <${selected.expectedHead}>`);
    expect(command.update).toContain(`<${selected.resource}> a <${kind}>`);
    for (const [path, value] of Object.entries(selectors)) {
      expect(command.update).toContain(`<${selected.resource}> <${path}> <${value}>`);
    }
  });
}

for (const outcome of ['restrict', 'restore', 'reverse'] as const) {
  for (const scopeKind of ['component', 'exact_revision'] as const) {
    test(`native home ${outcome} at ${scopeKind} scope keeps P/H CAS and receipt identity`, async () => {
      const f = graph(`${RV}ZoneHomeDocument`);
      const target = { ...f.target, scopeKind, revision: scopeKind === 'exact_revision' ? f.target.expectedHead : null };
      const result = await f.effects.apply(randomUUID(), 1, target, { outcome });
      expect(result).toHaveProperty('receipt');
      const command = f.commands[0]!;
      expect(command.validations).toMatchObject([{ profile: 'zone-capability-v1',
        shape: 'https://rezics.com/definition/zone-capability-v1/home-document-shape', focus: [target.resource] }]);
      expect(command.update).toContain(`<${target.resource}> rv:homeDocumentHead <${target.expectedHead}>`);
      expect(command.update).toContain(`rv:moderationTarget <${target.resource}> ; rv:expectedHead <${target.expectedHead}>`);
      expect(f.reads.some(sql => /rv:(?:disclosure|profileDisclosure|visibility)\b/.test(sql))).toBe(false);
    });
  }
}

for (const kind of [`${skos}Concept`, `${RV}Agent`, `${RV}Space`, `${RV}ZoneHomeDocument`]) {
  test(`${kind} rejects a stale owner head without a receipt`, async () => {
    const f = graph(kind);
    f.state.head = native();
    await expect(f.effects.apply(randomUUID(), 1, f.target)).rejects.toBeInstanceOf(GovernanceStale);
    expect(f.receipts.size).toBe(0);
  });
  test(`${kind} reconciles lost acknowledgement and rejects a receipt with another binding`, async () => {
    const f = graph(kind), operation = randomUUID();
    f.state.loseResponse = true;
    const result = await f.effects.apply(operation, 1, f.target);
    expect(await f.effects.apply(operation, 1, f.target)).toEqual(result);
    expect(f.commands).toHaveLength(1);
    f.state.digest = 'different';
    await expect(f.effects.apply(operation, 1, f.target)).rejects.toBeInstanceOf(GovernanceConflict);
  });
}

for (const kind of [`${RV}Character`, 'https://example.org/UnreviewedOwner',
  `${RV}OperationReceipt`]) {
  test(`${kind} without a profile uses Access-only disclosure even without rv:head`, async () => {
    const f = graph(kind), operation = randomUUID();
    expect(await f.effects.apply(operation, 1, { ...f.target, expectedHead: null }))
      .toEqual({ receipt: `access:governance-enforcement:${operation}:1` });
    expect(f.commands).toHaveLength(0);
  });
}

for (const kind of semanticOwnerTypes) {
  test(`PRIMARY ${kind} has its authored profile/shape row or an explicit Access-only row`, async () => {
    const routes = manifest.canonical.find(entry => entry.type === kind)?.routes ?? [];
    expect(routes).toEqual(manifest.canonical.find(entry => entry.type === kind)?.routes ?? []);

    for (const route of routes!) {
      const pinned = profileRegistry[route.profile as keyof typeof profileRegistry];
      expect(pinned.shapes as readonly string[]).toContain(route.shape);
    }
    if (kind === `${RV}Realm`) return; // The reciprocal Realm fixture covers all authored revisions.
    const first = selectCommandProfile(manifest, [kind], path =>
      routes[0]?.when.filter(condition => condition.path === path).map(condition => condition.value) ?? []);
    const f = graph(kind, Object.fromEntries(first?.when.map(condition => [condition.path, condition.value]) ?? []));
    if (!first) f.target.expectedHead = null;
    const operation = randomUUID();
    const result = await f.effects.apply(operation, 1, f.target);
    if (first) expect(f.commands[0]?.validations).toContainEqual(expect.objectContaining({ profile: first.profile, shape: first.shape }));
    else {
      expect(result).toEqual({ receipt: `access:governance-enforcement:${operation}:1` });
      expect(f.commands).toHaveLength(0);
    }
  });
}

test('a new PRIMARY kind without a table row remains eligible for Access-only disclosure', async () => {
  const kind = 'https://example.org/NewPrimaryOwner';
  (CANONICAL_TYPES as Set<string>).add(kind);
  (semanticOwnerTypes as Set<string>).add(kind);
  try {
    const f = graph(kind), operation = randomUUID();
    expect(selectCommandProfile(manifest, [kind], () => [])).toBeNull();
    expect(await f.effects.apply(operation, 1, { ...f.target, expectedHead: null }))
      .toEqual({ receipt: `access:governance-enforcement:${operation}:1` });
    expect(f.commands).toHaveLength(0);
  } finally { (CANONICAL_TYPES as Set<string>).delete(kind); (semanticOwnerTypes as Set<string>).delete(kind); }
});

test('a non-Realm record becoming a Realm between classification and profile selection is stale', async () => {
  const f = graph(`${RV}Agent`);
  f.state.becomeRealm = true;
  await expect(f.effects.apply(randomUUID(), 1, f.target, { realm: null })).rejects.toBeInstanceOf(GovernanceStale);
  expect(f.commands).toHaveLength(0);
});

for (const bindingRows of [0, 2]) {
  test(`a Concept with ${bindingRows ? 'ambiguous' : 'missing'} owner bindings cannot confirm a receipt`, async () => {
    const f = graph(`${skos}Concept`);
    f.state.bindingRows = bindingRows;
    await expect(f.effects.apply(randomUUID(), 1, f.target)).rejects.toThrow('Graph owner binding is unavailable or ambiguous');
    expect(f.commands).toHaveLength(0);
    expect(f.receipts.size).toBe(0);
  });
}

for (const effect of ['disclosure', 'search'] as const) {
  test(`a reviewed Work losing its type and head refuses an Access-only ${effect} receipt`, async () => {
    const f = graph('https://schema.org/CreativeWork');
    f.state.kinds = [];
    f.state.head = '';
    await expect(f.effects.apply(randomUUID(), 1, { ...f.target, component: 'title', effect }))
      .rejects.toBeInstanceOf(GovernanceStale);
    expect(f.commands).toHaveLength(0);
    expect(f.receipts.size).toBe(0);
  });
}

for (const profile of manifest.profiles.filter(entry => entry.binding)) {
  for (const role of profile.binding!.roles) {
    test(`bound registry profile ${profile.id}/${role} constructs every declared role and argument`, async () => {
      const kind = `https://example.org/BindingProbe-${profile.id}-${role}`;
      const canonical = { type: kind, routes: [{ profile: profile.id,
        shape: `https://rezics.com/definition/${profile.id}/${role}-shape`, when: [] }] };
      manifest.canonical.push(canonical);
      (CANONICAL_TYPES as Set<string>).add(kind);
      (semanticOwnerTypes as Set<string>).add(kind);
      try {
        const f = graph(kind);
        await f.effects.apply(randomUUID(), 1, f.target);
        expect(f.commands).toHaveLength(1);
        expect(f.commands[0]!.validations).toHaveLength(profile.binding!.roles.length);
      } finally {
        manifest.canonical.splice(manifest.canonical.indexOf(canonical), 1);
        (CANONICAL_TYPES as Set<string>).delete(kind);
        (semanticOwnerTypes as Set<string>).delete(kind);
      }
    });
  }
}
