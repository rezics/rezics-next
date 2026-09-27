import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { ensureModelGeneration } from '../semantic/command.ts';
import { modelGenerationHeadGuard, readActiveModelGeneration } from '../semantic/generation-guard.ts';
import { checkedFiniteRule, planFiniteRules, type FinitePositiveRule, type FiniteRuleFact,
  type FiniteRulePlan, type SelectedFiniteRule } from '../semantic/finite-rule.ts';
import { ContextCommandUnavailable, InvalidContextCommand, StaleContextCommand,
  checkedCommandReceipt, commitCommand,
  readCommandReceipt, sealCommandTerminal, term, type ContextCommandReceipt } from './command.ts';
import { ContextNotFound, readContextRevision } from './read.ts';
import { CONTEXT_LIMITS, GLOBAL_SEMANTIC_CONTEXT, type ContextEntryRecord } from './schema.ts';

export const CONTEXT_RULE_FAMILY = 'context-rule-v1';
export const CONTEXT_RULE_DEPENDENCY_FAMILY = 'context-rule-dependency-v1';
export const CONTEXT_RULE_PROFILE = 'https://rezics.com/definition/semantic-rule-v1';
export const CONTEXT_RULE_COST = {
  write: { graphQueriesAtMost: 8, manifestWrites: 1, targetRewrites: 0 },
  plan: { selectedRules: 16, facts: 10_000, graphQueriesBase: 4,
    graphQueriesPerRuleAtMost: 29, pinnedBaseDepth: 8, closureInspections: 50_000 },
  dependencyRegistration: { targets: 64, graphCommands: 1 },
  invalidationPage: { limit: 64, graphQueries: 7, targetRewrites: 0 },
} as const;

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const slotPattern = /^urn:rezics:context-rule:[0-9a-f]{64}$/;
const generationPattern = /^urn:rezics:derived-generation:[0-9a-f]{64}$/;
const contextId = (value: string) => value === GLOBAL_SEMANTIC_CONTEXT || native.test(value);

export interface RuleWriteInput {
  context: string; semanticRevision: string; realm: string; expectedHead: string | null;
  rule: FinitePositiveRule; actingSubject: string;
}
export interface ContextRuleRevision {
  slot: string; revision: string; predecessor: string | null; context: string;
  semanticRevision: string; realm: string; generation: string; modelGeneration: string;
  rule: FinitePositiveRule;
}

export function contextRuleSlot(context: string, realm: string, outputPredicate: string): string {
  if (!contextId(context) || !native.test(realm)) throw new InvalidContextCommand('rule scope is invalid');
  term(outputPredicate);
  return `urn:rezics:context-rule:${hash(JSON.stringify([context, realm, outputPredicate]))}`;
}

export function ruleGeneration(slot: string, revision: string, contextRevision: string,
  modelGeneration: string): string {
  if (!slotPattern.test(slot) || !native.test(revision) || !native.test(contextRevision)
    || !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(modelGeneration)) {
    throw new InvalidContextCommand('rule generation basis is invalid');
  }
  return `urn:rezics:derived-generation:${hash(JSON.stringify([
    slot, revision, contextRevision, modelGeneration]))}`;
}

export function contextRuleRequest(input: RuleWriteInput) {
  if (!contextId(input.context) || !native.test(input.semanticRevision) || !native.test(input.realm)
    || !native.test(input.actingSubject) || (input.expectedHead !== null && !native.test(input.expectedHead))) {
    throw new InvalidContextCommand('rule revision references are invalid');
  }
  const rule = checkedFiniteRule(input.rule);
  const slot = contextRuleSlot(input.context, input.realm, rule.outputPredicate);
  return { slot, rule, action: 'context.rule.change',
    scope: `context:rule:${input.context}:${input.realm}`,
    digest: hash(JSON.stringify([CONTEXT_RULE_FAMILY, slot, input.semanticRevision,
      input.expectedHead, rule, input.actingSubject])) };
}

async function currentRuleHead(env: WorkActivationEnvironment, slot: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?generation WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} a rv:ContextRule ; rv:ruleHead ?head ;
      rv:derivedGenerationHead ?generation }
  } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length > 1 || rows.length === 1 && (!rows[0]?.head || !rows[0]?.generation)) {
    throw new ContextCommandUnavailable('rule head is ambiguous');
  }
  return rows[0] ? { head: rows[0].head!.value, generation: rows[0].generation!.value } : null;
}

/** Read only the public rule-to-Context pointer; callers must check Context disclosure next. */
export async function ruleContextBasis(env: WorkActivationEnvironment, slot: string) {
  if (!slotPattern.test(slot)) throw new InvalidContextCommand('rule slot is invalid');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} a rv:ContextRule ; rv:context ?context ; rv:ruleHead ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:FiniteRuleRevision ;
      rv:component ${iri(slot)} ; rv:contextSemanticRevision ?revision }
  } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.context || !rows[0].revision) {
    throw new ContextNotFound('rule is unavailable');
  }
  return { context: rows[0].context.value, semanticRevision: rows[0].revision.value };
}

/** One guarded CAS switches the rule and dependent generation without touching target records. */
export async function changeContextRule(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: RuleWriteInput): Promise<ContextCommandReceipt> {
  const request = contextRuleRequest(input);
  const existing = await readCommandReceipt(env, admission.id, CONTEXT_RULE_FAMILY);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const current = await currentRuleHead(env, request.slot);
  if ((current?.head ?? null) !== input.expectedHead) {
    const terminal = await sealCommandTerminal(env, admission, CONTEXT_RULE_FAMILY, 'stale-head',
      input.expectedHead ? `GRAPH ${iri(GRAPHS.current)} { ${iri(request.slot)} rv:ruleHead ?actual }
        FILTER(?actual != ${iri(input.expectedHead)})`
        : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(request.slot)} rv:ruleHead ?actual } }`);
    if (terminal) return checkedCommandReceipt(terminal, admission, request.digest);
    throw new ContextCommandUnavailable('rule head changed before stale outcome');
  }
  const modelGeneration = await ensureModelGeneration(env);
  const revision = `${ID}${Bun.randomUUIDv7()}`;
  const operation = `${ID}${Bun.randomUUIDv7()}`;
  const generation = ruleGeneration(request.slot, revision, input.semanticRevision, modelGeneration);
  const manifest = prepareComponent(env.objectDirectory, request.slot, {
    slot: request.slot, revision, predecessor: input.expectedHead, context: input.context,
    semanticRevision: input.semanticRevision, realm: input.realm, generation, modelGeneration,
    rule: request.rule }, CONTEXT_RULE_PROFILE);
  const validations = await profileValidations(env.fuseki, 'semantic-rule-v1', [
    { shape: `${CONTEXT_RULE_PROFILE}/slot-shape`, focus: [request.slot],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${CONTEXT_RULE_PROFILE}/revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const committed = await commitCommand(env, admission, {
    family: CONTEXT_RULE_FAMILY, digest: request.digest, validations, operation,
    component: request.slot, revision, expectedHead: input.expectedHead,
    ...(current ? { remove: `GRAPH ${iri(GRAPHS.current)} {
      ${iri(request.slot)} rv:ruleHead ${iri(current.head)} ;
        rv:derivedGenerationHead ${iri(current.generation)} . }` } : {}),
    insert: `GRAPH ${iri(GRAPHS.current)} {
      ${iri(request.slot)} ${current ? '' : `a rv:ContextRule ; rv:context ${iri(input.context)} ;
        rv:realm ${iri(input.realm)} ; rv:outputPredicate ${term(request.rule.outputPredicate)} ;`}
        rv:ruleHead ${iri(revision)} ; rv:derivedGenerationHead ${iri(generation)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:FiniteRuleRevision, rv:RevisionAnchor ;
        rv:component ${iri(request.slot)} ; rv:context ${iri(input.context)} ;
        rv:contextSemanticRevision ${iri(input.semanticRevision)} ; rv:realm ${iri(input.realm)} ;
        rv:outputPredicate ${term(request.rule.outputPredicate)} ; rv:derivedGeneration ${iri(generation)} ;
        rv:modelGeneration ${iri(modelGeneration)} ;
        ${input.expectedHead ? `rv:predecessor ${iri(input.expectedHead)} ;` : ''}
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:operation ${iri(operation)} ;
        rv:modelRevision ${iri(CONTEXT_RULE_PROFILE)} ; rv:shapeRevision ${iri(CONTEXT_RULE_PROFILE)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `${modelGenerationHeadGuard(modelGeneration)}
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:semanticHead ${iri(input.semanticRevision)} .
        ${iri(input.realm)} a rv:Realm . }
      ${current ? `GRAPH ${iri(GRAPHS.current)} { ${iri(request.slot)} a rv:ContextRule ;
        rv:context ${iri(input.context)} ; rv:realm ${iri(input.realm)} ;
        rv:outputPredicate ${term(request.rule.outputPredicate)} ; rv:ruleHead ${iri(current.head)} ;
        rv:derivedGenerationHead ${iri(current.generation)} . }`
        : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(request.slot)} ?p ?o } }`}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }`,
  });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const now = await currentRuleHead(env, request.slot);
  if (now && now.head !== input.expectedHead) {
    const terminal = await sealCommandTerminal(env, admission, CONTEXT_RULE_FAMILY, 'stale-head',
      `GRAPH ${iri(GRAPHS.current)} { ${iri(request.slot)} rv:ruleHead ?actual }
       FILTER(?actual != ${iri(input.expectedHead ?? revision)})`);
    if (terminal) return checkedCommandReceipt(terminal, admission, request.digest);
  }
  throw new ContextCommandUnavailable('rule revision guard did not match');
}

/** Exact immutable rule read; the current slot remains a separate CAS head. */
export async function readContextRule(env: WorkActivationEnvironment, slot: string,
  revision: string | null = null): Promise<ContextRuleRevision & { currentHead: string }> {
  if (!slotPattern.test(slot) || revision !== null && !native.test(revision)) {
    throw new InvalidContextCommand('rule reference is invalid');
  }
  const head = await currentRuleHead(env, slot);
  if (!head) throw new ContextCommandUnavailable('rule is unavailable');
  const exact = revision ?? head.head;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?context ?contextRevision ?realm
    ?output ?generation ?modelGeneration ?predecessor WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(exact)} a rv:FiniteRuleRevision, rv:RevisionAnchor ;
      rv:component ${iri(slot)} ; rv:context ?context ; rv:contextSemanticRevision ?contextRevision ;
      rv:realm ?realm ; rv:outputPredicate ?output ; rv:derivedGeneration ?generation ;
      rv:modelGeneration ?modelGeneration ; rv:manifest ?manifest ;
      rv:modelRevision ${iri(CONTEXT_RULE_PROFILE)} ; rv:shapeRevision ${iri(CONTEXT_RULE_PROFILE)} .
      OPTIONAL { ${iri(exact)} rv:predecessor ?predecessor } }
  } LIMIT 2`)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.manifest || !row.context || !row.contextRevision || !row.realm
    || !row.output || !row.generation || !row.modelGeneration || !generationPattern.test(row.generation.value)) {
    throw new ContextCommandUnavailable('rule revision is unavailable');
  }
  const state = readComponentState(env.objectDirectory, row.manifest.value, slot, CONTEXT_RULE_PROFILE) as
    Partial<ContextRuleRevision>;
  const rule = checkedFiniteRule(state.rule);
  if (state.slot !== slot || state.revision !== exact || state.context !== row.context.value
    || state.semanticRevision !== row.contextRevision.value || state.realm !== row.realm.value
    || state.generation !== row.generation.value || state.modelGeneration !== row.modelGeneration.value
    || state.predecessor !== (row.predecessor?.value ?? null)
    || rule.outputPredicate !== row.output.value
    || contextRuleSlot(row.context.value, row.realm.value, row.output.value) !== slot
    || ruleGeneration(slot, exact, row.contextRevision.value, row.modelGeneration.value) !== row.generation.value
    || exact === head.head && head.generation !== row.generation.value) {
    throw new ContextCommandUnavailable('rule manifest differs from exact revision');
  }
  return { slot, revision: exact, predecessor: row.predecessor?.value ?? null,
    context: row.context.value, semanticRevision: row.contextRevision.value, realm: row.realm.value,
    generation: row.generation.value, modelGeneration: row.modelGeneration.value, rule,
    currentHead: head.head };
}

export interface RuleSelection { slot: string; revision: string; context: string;
  semanticRevision: string; realm: string }

async function exactContextDefinitions(env: WorkActivationEnvironment, context: string,
  revision: string, canReadPrivate: (context: string) => Promise<boolean>) {
  const chain: Map<string, ContextEntryRecord>[] = [];
  const seen = new Set<string>();
  let currentContext = context;
  let currentRevision = revision;
  let head: Awaited<ReturnType<typeof readContextRevision>> | null = null;
  for (let depth = 0; depth <= CONTEXT_LIMITS.inheritanceDepth; depth++) {
    if (seen.has(currentRevision)) throw new ContextCommandUnavailable('Context base cycle is unavailable');
    seen.add(currentRevision);
    const current = await readContextRevision(env, currentContext, currentRevision, canReadPrivate);
    if (!head) head = current;
    chain.push(new Map(current.entries.map(entry => [JSON.stringify([entry.target, entry.relation]), entry])));
    if (!current.base) return { head, chain };
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(current.base)} a rv:ContextSemanticRevision ;
        rv:component ?context }
    } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.context) {
      throw new ContextCommandUnavailable('pinned Context base is unavailable');
    }
    currentContext = rows[0].context.value;
    currentRevision = current.base;
  }
  throw new ContextCommandUnavailable('Context base exceeds inheritance budget');
}

/** Resolve each selected rule and Context independently, then reject conflicts before closure. */
export async function planContextRules(env: WorkActivationEnvironment,
  selections: readonly RuleSelection[], facts: readonly FiniteRuleFact[],
  canReadPrivate: (context: string) => Promise<boolean>, disclosureDomain: string):
Promise<FiniteRulePlan & { generations?: string[]; projectionKey?: string }> {
  if (!selections.length || selections.length > 16 || new Set(selections.map(item => item.slot)).size !== selections.length
    || !disclosureDomain || disclosureDomain.length > 512) {
    throw new InvalidContextCommand('rule selection exceeds bound');
  }
  const active = await readActiveModelGeneration(env.fuseki);
  const selected: SelectedFiniteRule[] = [];
  const generations: string[] = [];
  for (const choice of selections) {
    if (!slotPattern.test(choice.slot) || !native.test(choice.revision) || !contextId(choice.context)
      || !native.test(choice.semanticRevision) || !native.test(choice.realm)) {
      throw new InvalidContextCommand('rule selection is invalid');
    }
    const { head: context, chain } = await exactContextDefinitions(env, choice.context,
      choice.semanticRevision, canReadPrivate);
    const rule = await readContextRule(env, choice.slot, choice.revision);
    if (rule.context !== choice.context) throw new ContextNotFound('rule is unavailable');
    if (rule.currentHead !== choice.revision
      || rule.semanticRevision !== choice.semanticRevision || rule.realm !== choice.realm
      || rule.modelGeneration !== active.generation) throw new StaleContextCommand('selected rule is stale');
    if (context.state !== 'active' || context.semanticHead !== choice.semanticRevision) {
      throw new StaleContextCommand('selected Context is stale');
    }
    const selectedDefinition = (fact: FiniteRuleFact) => {
      for (const entries of chain) {
        const entry = entries.get(JSON.stringify([fact.object, fact.predicate]))
          ?? entries.get(JSON.stringify([fact.object, null]));
        if (entry) return entry.state === 'defined' ? entry.definition : null;
      }
      return null;
    };
    if (facts.filter(fact => fact.context === choice.context && fact.contextRevision === choice.semanticRevision
      && fact.realm === choice.realm).some(fact => selectedDefinition(fact) !== fact.definition)) {
      throw new InvalidContextCommand('fact DefinitionRef differs from selected Context meaning');
    }
    selected.push({ context: choice.context, contextRevision: choice.semanticRevision,
      realm: choice.realm, revision: choice.revision, rule: rule.rule });
    generations.push(rule.generation);
  }
  const planned = planFiniteRules(selected, facts, active);
  // A rule head changed while closure ran: never issue a false-current projection.
  for (const choice of selections) {
    if ((await currentRuleHead(env, choice.slot))?.head !== choice.revision) {
      throw new StaleContextCommand('rule changed during planning');
    }
  }
  if ((await readActiveModelGeneration(env.fuseki)).generation !== active.generation) {
    throw new ContextCommandUnavailable('model generation changed during planning');
  }
  return planned.state === 'rejected' ? planned : { ...planned, generations,
    projectionKey: `urn:rezics:projection-key:${hash(JSON.stringify([
      active.generation, [...generations].sort(), [...facts].sort((a, b) => a.id.localeCompare(b.id)),
      disclosureDomain]))}` };
}

export interface DependencyInput { slot: string; expectedGeneration: string; targets: string[];
  actingSubject: string }

export function dependencyRequest(input: DependencyInput) {
  if (!slotPattern.test(input.slot) || !generationPattern.test(input.expectedGeneration)
    || !native.test(input.actingSubject) || !Array.isArray(input.targets) || !input.targets.length
    || input.targets.length > CONTEXT_RULE_COST.dependencyRegistration.targets
    || input.targets.some(target => !native.test(target))
    || new Set(input.targets).size !== input.targets.length) {
    throw new InvalidContextCommand('rule dependencies are invalid');
  }
  const targets = [...input.targets].sort();
  return { action: 'context.rule.depend', scope: `context:rule-depend:${input.slot}`,
    digest: hash(JSON.stringify([CONTEXT_RULE_DEPENDENCY_FAMILY, input.slot,
      input.expectedGeneration, targets, input.actingSubject])), targets };
}

/** Register one bounded page; a subsequent rule switch invalidates it by one head change. */
export async function registerRuleDependencies(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: DependencyInput): Promise<ContextCommandReceipt> {
  const request = dependencyRequest(input);
  const existing = await readCommandReceipt(env, admission.id, CONTEXT_RULE_DEPENDENCY_FAMILY);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const head = await currentRuleHead(env, input.slot);
  if (!head || head.generation !== input.expectedGeneration) {
    throw new ContextCommandUnavailable('dependent generation changed');
  }
  const rule = await readContextRule(env, input.slot);
  if (rule.modelGeneration !== (await readActiveModelGeneration(env.fuseki)).generation) {
    throw new StaleContextCommand('model generation changed before dependency registration');
  }
  const revision = `${ID}${Bun.randomUUIDv7()}`;
  const operation = `${ID}${Bun.randomUUIDv7()}`;
  const manifest = prepareComponent(env.objectDirectory, input.slot, { slot: input.slot,
    generation: input.expectedGeneration, targets: request.targets }, CONTEXT_RULE_PROFILE);
  const dependency = (target: string) => `urn:rezics:rule-dependent:${hash(JSON.stringify([input.slot, target]))}`;
  const prior = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?node ?generation WHERE {
    VALUES ?node { ${request.targets.map(target => iri(dependency(target))).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?node a rv:RuleDependency ; rv:ruleSlot ${iri(input.slot)} ;
      rv:dependencyGeneration ?generation }
  } LIMIT ${request.targets.length + 1}`)).results?.bindings ?? [];
  if (prior.length > request.targets.length) throw new ContextCommandUnavailable('dependency state is ambiguous');
  const priorGeneration = new Map(prior.map(row => [row.node!.value, row.generation!.value]));
  const validations = await profileValidations(env.fuseki, 'semantic-rule-v1', [
    { shape: `${CONTEXT_RULE_PROFILE}/dependency-shape`,
      focus: request.targets.map(dependency), graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${CONTEXT_RULE_PROFILE}/dependency-page-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const committed = await commitCommand(env, admission, { family: CONTEXT_RULE_DEPENDENCY_FAMILY,
    digest: request.digest, validations, operation, component: input.slot, revision, expectedHead: null,
    remove: prior.length ? `GRAPH ${iri(GRAPHS.current)} { ${prior.map(row =>
      `${iri(row.node!.value)} rv:dependencyGeneration ${iri(row.generation!.value)} .`).join('\n')} }` : '',
    insert: `GRAPH ${iri(GRAPHS.current)} { ${request.targets.map(target => {
      const node = dependency(target);
      return `${iri(node)} ${priorGeneration.has(node) ? '' : `a rv:RuleDependency ;
        rv:ruleSlot ${iri(input.slot)} ; rv:target ${iri(target)} ;`}
        rv:dependencyGeneration ${iri(input.expectedGeneration)} .`;
    }).join('\n')} }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RuleDependencyPage, rv:RevisionAnchor ;
      rv:component ${iri(input.slot)} ; rv:derivedGeneration ${iri(input.expectedGeneration)} ;
      rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:operation ${iri(operation)} ;
      rv:modelRevision ${iri(CONTEXT_RULE_PROFILE)} ; rv:shapeRevision ${iri(CONTEXT_RULE_PROFILE)} ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `${modelGenerationHeadGuard(rule.modelGeneration)}
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.slot)} a rv:ContextRule ;
      rv:derivedGenerationHead ${iri(input.expectedGeneration)} . }
      ${request.targets.map(target => {
        const node = dependency(target);
        const generation = priorGeneration.get(node);
        return generation ? `GRAPH ${iri(GRAPHS.current)} { ${iri(node)} rv:dependencyGeneration ${iri(generation)} }`
          : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(node)} ?p ?o } }`;
      }).join('\n')}` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  throw new ContextCommandUnavailable('dependency registration guard did not match');
}

/** Cursor pages stale target identities under one slot; no target is edited here. */
export async function staleRuleDependencies(env: WorkActivationEnvironment, slot: string,
  expectedGeneration: string, after: string | null, limit: number) {
  if (!slotPattern.test(slot) || after !== null && !/^urn:rezics:rule-dependent:[0-9a-f]{64}$/.test(after)
    || !generationPattern.test(expectedGeneration) || !Number.isInteger(limit) || limit < 1
    || limit > CONTEXT_RULE_COST.invalidationPage.limit) {
    throw new InvalidContextCommand('invalidation cursor is invalid');
  }
  const head = await currentRuleHead(env, slot);
  if (!head) throw new ContextCommandUnavailable('rule is unavailable');
  if (head.generation !== expectedGeneration) throw new StaleContextCommand('invalidation generation changed');
  const rule = await readContextRule(env, slot);
  if (rule.modelGeneration !== (await readActiveModelGeneration(env.fuseki)).generation) {
    throw new StaleContextCommand('model generation changed before invalidation page');
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?node ?target ?generation WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:derivedGenerationHead ${iri(expectedGeneration)} . }
    GRAPH ${iri(GRAPHS.current)} { ?node a rv:RuleDependency ; rv:ruleSlot ${iri(slot)} ;
      rv:target ?target ; rv:dependencyGeneration ?generation . }
    FILTER(?generation != ${iri(head.generation)})
    ${after ? `FILTER(STR(?node) > ${lit(after)})` : ''}
  } ORDER BY ?node LIMIT ${limit + 1}`)).results?.bindings ?? [];
  if ((await currentRuleHead(env, slot))?.generation !== expectedGeneration) {
    throw new StaleContextCommand('invalidation generation changed during page');
  }
  const items = rows.slice(0, limit).map(row => ({ dependency: row.node!.value,
    target: row.target!.value, previousGeneration: row.generation!.value }));
  return { profile: 'context-rule-invalidation-v1' as const, slot, currentGeneration: head.generation,
    items, next: rows.length > limit ? items.at(-1)!.dependency : null };
}
