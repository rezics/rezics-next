import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { term } from './command.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { readDependencyToken, readRowsToken, type ReadRow } from '../work/read-session.ts';
import { contextReadBudget } from './read.ts';
import type { PrivateSelectionCandidateRow } from './private-selection-schema.ts';
import { CONTEXT_LIMITS, GLOBAL_SEMANTIC_CONTEXT, contextSelectionCandidates, contextSelectionKey,
  contextSelectionScopeKey, type ContextSelectionScope } from './schema.ts';

// Declared selection order (docs/contracts/context.md, selection and statement
// meaning): explicit request, the speaker's object-relation / object / default
// selection, then the published Global head. Entry-point defaults and admitted
// domain candidates are not supplied by this first profile. Cost: at most one
// speaker selection read, one Global head read and at most nine indexed pinned
// revision reads per attempt. Repeat those dependencies once as a local fence; a
// Private Context adds one Access proof per distinct Context in the chain.

export type InterpretationBasis = 'explicit' | 'speaker-object-relation' | 'speaker-object'
  | 'speaker-default' | 'global' | 'none';

export type Interpretation = (
  | { state: 'resolved'; basis: InterpretationBasis; context: string | null; semanticRevision: string | null;
    definition: string | null; entryRevision: string | null; selectionRevision: string | null }
  | { state: 'unresolved' | 'disabled'; basis: InterpretationBasis; context: string; semanticRevision: string;
    entryRevision: string; selectionRevision: string | null }
  | { state: 'ambiguous'; basis: InterpretationBasis; context: string; semanticRevision: string;
    selectionRevision: string | null; candidates: { relation: string; definition: string; entryRevision: string }[] }
  | { state: 'unavailable' }) & { sourcePosition?: { datasetId: 'product'; dataEpoch: string; sequence: string;
    dependencyToken: string } };

export interface InterpretationSpeaker {
  kind: 'realm' | 'personal';
  realm?: string;
  /** Private personal selections, already read with the principal's own authority. */
  privateCandidates?: (scopes: ContextSelectionScope[]) => Promise<PrivateSelectionCandidateRow[]>;
  /** Access proof for a Private Context; Realm speech never adopts one. */
  canReadPrivate?: (context: string) => Promise<boolean>;
}

export interface InterpretationRequest {
  object: string;
  relation: string | null;
  explicit: { context: string; semanticRevision: string } | null;
  speaker: InterpretationSpeaker;
}

const BASIS: Record<ContextSelectionScope['kind'], InterpretationBasis> = {
  'object-relation': 'speaker-object-relation', object: 'speaker-object', domain: 'speaker-object',
  default: 'speaker-default',
};

interface Selected { basis: InterpretationBasis; context: string; semanticRevision: string; selectionRevision: string | null }

async function speakerSelection(env: WorkActivationEnvironment, request: InterpretationRequest,
  levels: ContextSelectionScope[][], query: FusekiClient['query']): Promise<Selected | null | 'unavailable'> {
  const scopes = levels.flat();
  const found = new Map<string, { state: string; context: string | null; revision: string | null; head: string }>();
  if (request.speaker.kind === 'realm') {
    const realm = request.speaker.realm!;
    const keys = scopes.map(scope => [contextSelectionKey(realm, 'speaker', scope), contextSelectionScopeKey(scope)] as const);
    const rows = (await query(`PREFIX rv: <${RV}> SELECT ?key ?head ?state ?context ?revision WHERE {
      VALUES ?key { ${keys.map(([key]) => iri(key)).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?selection a rv:ContextSelection ; rv:selectionKey ?key ;
        rv:consumer ${iri(realm)} ; rv:contextSelectionHead ?head . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head rv:selectionState ?state .
        OPTIONAL { ?head rv:context ?context ; rv:semanticRevision ?revision } } }
    } LIMIT ${scopes.length + 1}`, 16 * 1024)).results?.bindings ?? [];
    if (rows.length > scopes.length) return 'unavailable';
    for (const row of rows) {
      const scope = keys.find(([key]) => key === row.key?.value)?.[1];
      if (!scope || !row.head || found.has(scope)) return 'unavailable';
      found.set(scope, { state: row.state?.value === `${RV}Selected` ? 'selected'
        : row.state?.value === `${RV}Cleared` ? 'cleared' : 'unreadable',
      context: row.context?.value ?? null, revision: row.revision?.value ?? null, head: row.head.value });
    }
  } else if (request.speaker.privateCandidates) {
    for (const row of await request.speaker.privateCandidates(scopes)) {
      if (found.has(row.scope_key)) return 'unavailable';
      found.set(row.scope_key, { state: row.state, context: row.context, revision: row.semantic_revision,
        head: row.head_revision });
    }
  }
  for (const level of levels) {
    const hits = level.map(scope => found.get(contextSelectionScopeKey(scope))).filter(hit => hit !== undefined);
    const selected = hits.filter(hit => hit.state !== 'cleared');
    if (selected.some(hit => hit.state === 'unreadable' || !hit.context || !hit.revision)) return 'unavailable';
    // Equal-priority selectors that disagree are an explicit conflict, never insertion order.
    if (new Set(selected.map(hit => hit.revision)).size > 1) return 'unavailable';
    if (selected[0]) {
      return { basis: BASIS[level[0]!.kind], context: selected[0].context!, semanticRevision: selected[0].revision!,
        selectionRevision: selected[0].head };
    }
  }
  return null;
}

/** Resolve one interpretation slot and walk only the pinned base chain of the chosen revision. */
export async function resolveInterpretation(env: WorkActivationEnvironment,
  request: InterpretationRequest): Promise<Interpretation> {
  return contextReadBudget(() => resolveInterpretationAtBasis(env, request));
}

async function resolveInterpretationAtBasis(env: WorkActivationEnvironment,
  request: InterpretationRequest): Promise<Interpretation> {
  // Include absent selector slots and the fallback lookup, not just the winner.
  // Separate HTTP operations are transactions; one request-local dependency
  // pass followed by the same bounded pass detects relevant intervening writes.
  const pass = async () => {
    const dependencies: unknown[] = [];
    const query: FusekiClient['query'] = async (text, maximumBytes) => {
      const result = await env.fuseki.query(text, maximumBytes ?? 64 * 1024);
      dependencies.push(readRowsToken((result.results?.bindings ?? [])
        .map(({ sequence: _sequence, ...row }) => row)));
      return result;
    };
    const position = await interpretationGraphPosition(env, query);
    const health = await env.fuseki.commandHealth();
    const profiles = ['context-v1', ...(!request.explicit && request.speaker.kind === 'realm'
      ? ['context-selection-v1'] : [])].map(profile => [profile, health.profiles[profile]]);
    if (!position || profiles.some(([, digest]) => !digest)) {
      return { interpretation: { state: 'unavailable' } as Interpretation, token: '', position };
    }
    dependencies.push(profiles);
    const speaker: InterpretationSpeaker = { ...request.speaker,
      ...(request.speaker.privateCandidates ? { privateCandidates: async (scopes: ContextSelectionScope[]) => {
        const rows = await request.speaker.privateCandidates!(scopes);
        if (rows.length > scopes.length) throw new Error('Private Context selectors exceed their bounded slots');
        dependencies.push(rows.map(row => JSON.stringify(row)).sort());
        return rows;
      } } : {}),
      ...(request.speaker.canReadPrivate ? { canReadPrivate: async (context: string) => {
        const allowed = await request.speaker.canReadPrivate!(context);
        dependencies.push([context, allowed]); return allowed;
      } } : {}) };
    const interpretation = await resolveInterpretationAtPosition(env, { ...request, speaker }, query);
    return { interpretation, token: readDependencyToken(dependencies), position };
  };
  const before = await pass();
  if (before.interpretation.state === 'unavailable') return before.interpretation;
  const after = await pass();
  if (!before.position || after.interpretation.state === 'unavailable' || before.token !== after.token) {
    return { state: 'unavailable' };
  }
  return { ...before.interpretation, sourcePosition: { ...before.position, dependencyToken: before.token } };
}

async function interpretationGraphPosition(env: WorkActivationEnvironment, query: FusekiClient['query']) {
  const rows = (await query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      ${iri(DATASET)} rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
  } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.epoch?.value !== env.lineage.dataEpoch
    || !/^(0|[1-9][0-9]*)$/u.test(rows[0].sequence?.value ?? '')) return null;
  return { datasetId: 'product' as const, dataEpoch: rows[0].epoch.value,
    sequence: rows[0].sequence!.value };
}

async function resolveInterpretationAtPosition(env: WorkActivationEnvironment,
  request: InterpretationRequest, query: FusekiClient['query']): Promise<Interpretation> {
  const levels = contextSelectionCandidates(request.object, request.relation, []);
  let selected: Selected | null | 'unavailable' = request.explicit
    ? { basis: 'explicit', ...request.explicit, selectionRevision: null }
    : await speakerSelection(env, request, levels, query);
  if (selected === 'unavailable') return { state: 'unavailable' };
  if (!selected) {
    const global = (await query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(GLOBAL_SEMANTIC_CONTEXT)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:semanticHead ?head . } } LIMIT 2`)).results?.bindings ?? [];
    if (global.length > 1) return { state: 'unavailable' };
    if (!global[0]?.head) {
      return { state: 'resolved', basis: 'none', context: null, semanticRevision: null, definition: null,
        entryRevision: null, selectionRevision: null };
    }
    selected = { basis: 'global', context: GLOBAL_SEMANTIC_CONTEXT, semanticRevision: global[0].head.value,
      selectionRevision: null };
  }
  const rows: ReadRow[] = [];
  const seen = new Set<string>();
  let pinned: string | null = selected.semanticRevision;
  for (let hop = 0; pinned !== null; hop++) {
    if (hop > CONTEXT_LIMITS.inheritanceDepth || seen.has(pinned)) return { state: 'unavailable' };
    seen.add(pinned);
    const page: ReadRow[] = (await query(`PREFIX rv: <${RV}>
    SELECT ?revision ?base ?depth ?context ?disclosure ?contextHead ?entry ?state ?definition ?relation WHERE {
      BIND(${iri(pinned)} AS ?revision)
      GRAPH ${iri(GRAPHS.revisions)} {
        ?revision a rv:ContextSemanticRevision ; rv:component ?context ; rv:inheritanceDepth ?depth .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision }
        OPTIONAL { ?revision rv:baseRevision ?base }
        OPTIONAL { ?revision rv:entry ?entry . ?entry rv:entryTarget ${term(request.object)} ; rv:entryState ?state .
          OPTIONAL { ?entry rv:interpretationDefinition ?definition }
          OPTIONAL { ?entry rv:entryRelation ?relation }
          ${request.relation ? `FILTER(!BOUND(?relation) || ?relation = ${term(request.relation)})` : ''} } }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?context a rv:SemanticContext ;
        rv:semanticHead ?contextHead ; rv:disclosure ?disclosure .
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?contextHead a rv:ErasedRevision } } } }
    } LIMIT ${(CONTEXT_LIMITS.inheritanceDepth + 1) * 3}`, 64 * 1024)).results?.bindings ?? [];
    if (!page.length || page.some(row => row.revision?.value !== pinned)
      || ['base', 'depth', 'context', 'disclosure', 'contextHead'].some(field =>
        new Set(page.map(row => row[field]?.value)).size !== 1)) return { state: 'unavailable' };
    rows.push(...page);
    pinned = page[0]!.base?.value ?? null;
  }
  // A relationless lookup may see several qualified candidates; overflow is unavailable.
  if (rows.length >= (CONTEXT_LIMITS.inheritanceDepth + 1) * 3) return { state: 'unavailable' };
  const chain = new Map<string, { depth: number; context: string; disclosure?: string;
    entries: { state: string; definition?: string; relation?: string }[] }>();
  for (const row of rows) {
    if (!row.revision || !row.context || !row.depth) return { state: 'unavailable' };
    const item: NonNullable<ReturnType<typeof chain.get>> = chain.get(row.revision.value) ?? { depth: Number(row.depth.value), context: row.context.value,
      disclosure: row.disclosure?.value, entries: [] };
    if (row.entry && row.state) {
      item.entries.push({ state: row.state.value, definition: row.definition?.value, relation: row.relation?.value });
    }
    chain.set(row.revision.value, item);
  }
  const ordered = [...chain.entries()].sort(([, a], [, b]) => b.depth - a.depth);
  const head = chain.get(selected.semanticRevision);
  // A missing retained revision or a gap in the pinned chain is unavailable, never absence.
  if (!head || head.context !== selected.context || ordered.length !== head.depth + 1
    || ordered.some(([, item], index) => item.depth !== head.depth - index)) return { state: 'unavailable' };
  for (const context of new Set(ordered.map(([, item]) => item.context))) {
    const item = ordered.find(([, entry]) => entry.context === context)![1];
    if (item.disclosure === `${RV}Public`) continue;
    if (item.disclosure !== `${RV}Private` || !request.speaker.canReadPrivate
      || !await request.speaker.canReadPrivate(context)) return { state: 'unavailable' };
  }
  const candidates = new Map<string, { relation: string; definition: string; entryRevision: string }>();
  for (const [revision, item] of ordered) {
    if (request.relation === null) {
      for (const value of item.entries.filter(entry => entry.relation)) {
        if (candidates.has(value.relation!)) continue;
        if (value.state !== `${RV}Defined` || !value.definition) return { state: 'unavailable' };
        candidates.set(value.relation!, { relation: value.relation!, definition: value.definition,
          entryRevision: revision });
      }
    }
    const entry = request.relation === null ? item.entries.find(value => !value.relation)
      : item.entries.find(value => value.relation) ?? item.entries.find(value => !value.relation);
    if (!entry) continue;
    if (entry.state === `${RV}Defined` && entry.definition) {
      return { state: 'resolved', basis: selected.basis, context: selected.context,
        semanticRevision: selected.semanticRevision, definition: entry.definition, entryRevision: revision,
        selectionRevision: selected.selectionRevision };
    }
    if (entry.state === `${RV}Unresolved` || entry.state === `${RV}Disabled`) {
      return { state: entry.state === `${RV}Unresolved` ? 'unresolved' : 'disabled', basis: selected.basis,
        context: selected.context, semanticRevision: selected.semanticRevision, entryRevision: revision,
        selectionRevision: selected.selectionRevision };
    }
    return { state: 'unavailable' };
  }
  if (request.relation === null && candidates.size) {
    return { state: 'ambiguous', basis: selected.basis, context: selected.context,
      semanticRevision: selected.semanticRevision, selectionRevision: selected.selectionRevision,
      candidates: [...candidates.values()].sort((a, b) => a.relation.localeCompare(b.relation)) };
  }
  return { state: 'resolved', basis: selected.basis, context: selected.context,
    semanticRevision: selected.semanticRevision, definition: null, entryRevision: null,
    selectionRevision: selected.selectionRevision };
}
