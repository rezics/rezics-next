import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

const INPUT_A = 'https://rezics.com/example/has-feature';
const INPUT_B = 'https://rezics.com/example/verified-feature';
const OUTPUT = 'https://rezics.com/derived/has-feature';
type RuleWrite = { slot: string; revision: string; generation: string; replayed: boolean };

const rule = (input: string, rounds = 3) => ({ profile: 'finite-positive-rule-v1' as const,
  inputPredicates: [input], outputPredicate: OUTPUT,
  body: [{ subject: '?resource', predicate: input, object: '?feature' }],
  head: { subject: '?resource', object: '?feature' },
  budget: { rounds, inferences: 128, inspections: 2000 } });

test('CTX06: selected Realm rule conflict rejects before derivation and exact Context closure retains provenance', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const definition = nativeId();
    const source = nativeId();
    const realmA = await f.realm('Rule A');
    const realmB = await f.realm('Rule B');
    await f.grant('context:create:root', 'context.create');
    const context = await f.json<{ context: string; semanticRevision: string }>(await f.call('POST',
      '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public',
        base: null, entries: [{ target: object, relation: null, state: 'defined',
          definition, applicability: [] }], actingSubject: f.actorA }), 201);
    const write = (realm: string, input: string, expectedHead: string | null,
      key = randomUUID(), rounds = 3) => f.call('POST', '/v1/context-rules', {
        profile: 'context-rule-v1', context: context.context,
        semanticRevision: context.semanticRevision, realm, expectedHead,
        rule: rule(input, rounds), actingSubject: f.actorA }, key);
    await f.revoke(await f.grant(`context:rule:${context.context}:${realmA.realm}`, 'context.rule.change'));
    const denied = await write(realmA.realm, INPUT_A, null);
    expect(denied.status).toBe(403);
    await f.grant(`context:rule:${context.context}:${realmA.realm}`, 'context.rule.change');
    await f.grant(`context:rule:${context.context}:${realmB.realm}`, 'context.rule.change');
    const key = randomUUID();
    const first = await f.json<RuleWrite>(await write(realmA.realm, INPUT_A, null, key), 201);
    expect(await f.json<RuleWrite>(await write(realmA.realm, INPUT_A, null, key), 200))
      .toMatchObject({ slot: first.slot, revision: first.revision, generation: first.generation,
        replayed: true });
    const second = await f.json<RuleWrite>(await write(realmB.realm, INPUT_B, null), 201);
    expect(first.slot).not.toBe(second.slot);
    const read = await f.json<{ rule: { inputPredicates: string[] }; currentHead: string }>(await f.call('GET',
      `/v1/context-rules?slot=${encodeURIComponent(first.slot)}&actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(read).toMatchObject({ rule: { inputPredicates: [INPUT_A] }, currentHead: first.revision });
    const unsafe = await f.call('POST', '/v1/context-rules', {
      profile: 'context-rule-v1', context: context.context,
      semanticRevision: context.semanticRevision, realm: realmA.realm, expectedHead: first.revision,
      rule: { ...rule(INPUT_A), outputPredicate: 'https://rezics.com/derived/acceptance' },
      actingSubject: f.actorA });
    expect(unsafe.status).toBe(422);
    expect((await f.call('POST', '/v1/context-rules', {
      profile: 'context-rule-v1', context: context.context,
      semanticRevision: context.semanticRevision, realm: realmA.realm, expectedHead: first.revision,
      rule: { ...rule(INPUT_A), inputPredicates: ['http://www.w3.org/2002/07/owl#sameAs'],
        body: [{ subject: '?resource', predicate: 'http://www.w3.org/2002/07/owl#sameAs',
          object: '?feature' }] }, actingSubject: f.actorA })).status).toBe(422);
    const selection = (realm: string, written: RuleWrite) => ({ slot: written.slot,
      revision: written.revision, context: context.context,
      semanticRevision: context.semanticRevision, realm });
    const fact = (realm: string, predicate: string) => ({ id: randomUUID(),
      subject: source, predicate, object, definition, context: context.context,
      contextRevision: context.semanticRevision, realm });
    const plan = (selections: object[], facts: object[]) => f.call('POST', '/v1/context-rule-plans', {
      profile: 'context-rule-plan-v1', selections, facts, actingSubject: f.actorA });
    const conflict = await f.json<{ state: string; reason: string; inferences: unknown[];
      conflictingRevisions: string[] }>(await plan([
        selection(realmA.realm, first), selection(realmB.realm, second)],
      [fact(realmA.realm, INPUT_A), fact(realmB.realm, INPUT_B)]), 200);
    expect(conflict).toMatchObject({ state: 'rejected', reason: 'conflicting-rules',
      inferences: [], conflictingRevisions: [first.revision, second.revision].sort() });
    const input = fact(realmA.realm, INPUT_A);
    const complete = await f.json<{ state: string; exactCount: number; accepted: boolean;
      projectionKey: string;
      authorizes: boolean; inferences: { subject: string; object: string; context: string;
        contextRevision: string; realm: string; ruleRevision: string;
        inputIds: string[]; definitions: string[] }[] }>(await plan([
          selection(realmA.realm, first)], [input]), 200);
    expect(complete).toMatchObject({ state: 'complete', exactCount: 1, accepted: false,
      authorizes: false, inferences: [{ subject: source, object, context: context.context,
        contextRevision: context.semanticRevision, realm: realmA.realm,
        ruleRevision: first.revision, inputIds: [input.id], definitions: [definition] }] });
    const secondInput = { ...input, id: randomUUID() };
    const recomputed = await f.json<{ projectionKey: string }>(await plan([
      selection(realmA.realm, first)], [secondInput]), 200);
    expect(recomputed.projectionKey).not.toBe(complete.projectionKey);
    expect((await plan([selection(realmA.realm, first)],
      [{ ...input, object: nativeId() }])).status).toBe(400);
    const inherited = await f.json<{ context: string; semanticRevision: string }>(await f.call('POST',
      '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public',
        base: context.semanticRevision, entries: [], actingSubject: f.actorA }), 201);
    await f.grant(`context:rule:${inherited.context}:${realmA.realm}`, 'context.rule.change');
    const inheritedRule = await f.json<RuleWrite>(await f.call('POST', '/v1/context-rules', {
      profile: 'context-rule-v1', context: inherited.context,
      semanticRevision: inherited.semanticRevision, realm: realmA.realm,
      expectedHead: null, rule: rule(INPUT_A), actingSubject: f.actorA }), 201);
    const inheritedFact = { ...input, context: inherited.context,
      contextRevision: inherited.semanticRevision, id: randomUUID() };
    const inheritedPlan = await f.json<{ state: string; inferences: { definitions: string[] }[] }>(
      await plan([{ slot: inheritedRule.slot, revision: inheritedRule.revision,
        context: inherited.context, semanticRevision: inherited.semanticRevision,
        realm: realmA.realm }], [inheritedFact]), 200);
    expect(inheritedPlan).toMatchObject({ state: 'complete',
      inferences: [{ definitions: [definition] }] });
    const hidden = await f.json<{ context: string; semanticRevision: string }>(await f.call('POST',
      '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'private',
        base: null, entries: [{ target: object, relation: null, state: 'defined',
          definition, applicability: [] }], actingSubject: f.actorA }), 201);
    await f.grant(`context:rule:${hidden.context}:${realmA.realm}`, 'context.rule.change');
    const hiddenRule = await f.json<RuleWrite>(await f.call('POST', '/v1/context-rules', {
      profile: 'context-rule-v1', context: hidden.context,
      semanticRevision: hidden.semanticRevision, realm: realmA.realm,
      expectedHead: null, rule: rule(INPUT_A), actingSubject: f.actorA }), 201);
    expect((await f.call('GET', `/v1/context-rules?slot=${encodeURIComponent(hiddenRule.slot)}`
      + `&actingSubject=${encodeURIComponent(f.actorB)}`, undefined, randomUUID(),
    f.account.tokenB)).status).toBe(404);
    expect((await f.call('POST', '/v1/context-rule-plans', {
      profile: 'context-rule-plan-v1', selections: [{ slot: hiddenRule.slot,
        revision: hiddenRule.revision, context: hidden.context,
        semanticRevision: hidden.semanticRevision, realm: realmA.realm }],
      facts: [{ ...input, context: hidden.context, contextRevision: hidden.semanticRevision }],
      actingSubject: f.actorB }, randomUUID(), f.account.tokenB)).status).toBe(404);
    const partial = await f.json<RuleWrite>(await write(realmA.realm, INPUT_A, first.revision,
      randomUUID(), 1), 201);
    const incomplete = await f.json<{ state: string; exactCount: null; accepted: boolean }>(
      await plan([selection(realmA.realm, partial)], [input]), 200);
    expect(incomplete).toMatchObject({ state: 'partial', exactCount: null, accepted: false });
    expect((await plan([selection(realmA.realm, first)], [input])).status).toBe(409);
    expect((await write(realmA.realm, INPUT_A, first.revision)).status).toBe(409);
    const competing = await Promise.all([
      write(realmA.realm, INPUT_A, partial.revision, randomUUID(), 2),
      write(realmA.realm, INPUT_A, partial.revision, randomUUID(), 4),
    ]);
    expect(competing.map(response => response.status).sort()).toEqual([201, 409]);
    expect((await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(source)} <${OUTPUT}> ${iri(object)} } }`)).boolean).toBe(false);
  } finally { await f.close(); }
}, 120_000);

test('CTX10: one rule revision switches a many-target dependent generation with bounded pages', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const definition = nativeId();
    const realm = await f.realm('Dependent rule');
    await f.grant('context:create:root', 'context.create');
    const context = await f.json<{ context: string; semanticRevision: string }>(await f.call('POST',
      '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public',
        base: null, entries: [{ target: object, relation: null, state: 'defined',
          definition, applicability: [] }], actingSubject: f.actorA }), 201);
    await f.grant(`context:rule:${context.context}:${realm.realm}`, 'context.rule.change');
    const write = (expectedHead: string | null, predicate: string) => f.call('POST', '/v1/context-rules', {
      profile: 'context-rule-v1', context: context.context,
      semanticRevision: context.semanticRevision, realm: realm.realm,
      expectedHead, rule: rule(predicate), actingSubject: f.actorA });
    const before = await f.json<RuleWrite>(await write(null, INPUT_A), 201);
    await f.grant(`context:rule-depend:${before.slot}`, 'context.rule.depend');
    const targets = Array.from({ length: 100 }, nativeId);
    const register = (generation: string, values: string[], key = randomUUID()) =>
      f.call('POST', '/v1/context-rule-dependencies', {
        profile: 'context-rule-dependency-v1', slot: before.slot, expectedGeneration: generation,
        targets: values, actingSubject: f.actorA }, key);
    const key = randomUUID();
    const registered = await f.json<{ revision: string; generation: string; replayed: boolean }>(
      await register(before.generation, targets.slice(0, 60), key), 201);
    expect(await f.json<{ revision: string; replayed: boolean }>(await register(before.generation,
      targets.slice(0, 60), key), 200)).toMatchObject({ revision: registered.revision, replayed: true });
    await f.json(await register(before.generation, targets.slice(60)), 201);
    const count = async () => (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(?node) AS ?n) WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?node a rv:RuleDependency ; rv:ruleSlot ${iri(before.slot)} } }`))
      .results?.bindings?.[0]?.n?.value;
    expect(await count()).toBe('100');
    f.resetQueries();
    f.loseNextResponse('rv:FiniteRuleRevision');
    const after = await f.json<RuleWrite>(await write(before.revision, INPUT_B), 201);
    expect(f.queries()).toBeLessThanOrEqual(16);
    expect(after.generation).not.toBe(before.generation);
    expect(await count()).toBe('100');
    const retained = await f.json<{ revision: string; generation: string; currentHead: string }>(
      await f.call('GET', `/v1/context-rules?slot=${encodeURIComponent(before.slot)}`
        + `&revision=${encodeURIComponent(before.revision)}`
        + `&actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(retained).toMatchObject({ revision: before.revision, generation: before.generation,
      currentHead: after.revision });
    expect((await register(before.generation, [nativeId()])).status).toBe(409);
    const page = (cursor: string | null) => f.call('GET',
      `/v1/context-rule-dependencies?slot=${encodeURIComponent(before.slot)}`
      + `&expectedGeneration=${encodeURIComponent(after.generation)}`
      + `&actingSubject=${encodeURIComponent(f.actorA)}&limit=17`
      + (cursor ? `&after=${encodeURIComponent(cursor)}` : ''));
    expect((await f.call('GET', `/v1/context-rule-dependencies?slot=${encodeURIComponent(before.slot)}`
      + `&expectedGeneration=${encodeURIComponent(before.generation)}`
      + `&actingSubject=${encodeURIComponent(f.actorA)}`)).status).toBe(409);
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const result = await f.json<{ currentGeneration: string; items: { target: string;
        previousGeneration: string }[]; next: string | null }>(await page(cursor), 200);
      expect(result.currentGeneration).toBe(after.generation);
      expect(result.items.length).toBeLessThanOrEqual(17);
      for (const item of result.items) {
        expect(item.previousGeneration).toBe(before.generation);
        expect(seen.has(item.target)).toBe(false);
        seen.add(item.target);
      }
      cursor = result.next;
    } while (cursor);
    expect(seen).toEqual(new Set(targets));
    expect(await count()).toBe('100');
  } finally { await f.close(); }
}, 120_000);
