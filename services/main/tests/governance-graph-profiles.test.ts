import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import manifest from '../../../generated/model/manifest.json';
import type { ContentModeration } from '../../content/src/moderation.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { graphModerationProfiles, ownerModerationEffects } from '../src/modules/governance/effects.ts';
import { CANONICAL_TYPES, semanticOwnerTypes } from '../src/modules/semantic/change.ts';
import { GovernanceConflict, GovernanceStale, type DecisionTargetInput } from '../src/modules/governance/store.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const skos = 'http://www.w3.org/2004/02/skos/core#';

function graph(kind: string, selectors: Record<string, string> = {}) {
  const resource = native(), head = native();
  const target: DecisionTargetInput = { owner: 'graph', resource, component: 'record', locator: null,
    scopeKind: 'component', revision: null, expectedHead: head, effect: 'disclosure' };
  const state = { head, selectors, kinds: [kind], loseResponse: false, stale: false,
    status: 'committed' as 'committed' | 'invalid', digest: '', becomeRealm: false };
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
      if (sql.includes('ASK')) {
        if (state.becomeRealm) state.kinds = [`${RV}Realm`];
        return { boolean: state.kinds.includes(`${RV}ZoneHomeDocument`) };
      }
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
    expect(command.validations).toMatchObject([{ profile, shape: `https://rezics.com/definition/${profile}/${shape}-shape`,
      focus: [selected.resource] }]);
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
    const routes = graphModerationProfiles.get(kind);
    expect(routes).toEqual(manifest.canonical.find(entry => entry.type === kind)?.routes ?? []);
    expect(routes).toBeDefined();
    for (const route of routes!) {
      const pinned = profileRegistry[route.profile as keyof typeof profileRegistry];
      expect(pinned.shapes as readonly string[]).toContain(route.shape);
    }
    if (kind === `${RV}Realm`) return; // The reciprocal Realm fixture covers all authored revisions.
    const first = routes?.[0];
    const f = graph(kind, Object.fromEntries(first?.when.map(condition => [condition.path, condition.value]) ?? []));
    const operation = randomUUID();
    const result = await f.effects.apply(operation, 1, f.target);
    if (first) expect(f.commands[0]?.validations).toMatchObject([{ profile: first.profile, shape: first.shape }]);
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
    expect(graphModerationProfiles.has(kind)).toBe(false);
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
