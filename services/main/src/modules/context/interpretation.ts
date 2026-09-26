import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { term } from './command.ts';
import type { PrivateSelectionCandidateRow } from './private-selection-schema.ts';
import { CONTEXT_LIMITS, GLOBAL_SEMANTIC_CONTEXT, contextSelectionCandidates, contextSelectionKey,
  contextSelectionScopeKey, type ContextSelectionScope } from './schema.ts';

// Declared selection order (docs/contracts/context.md, selection and statement
// meaning): explicit request, the speaker's object-relation / object / default
// selection, then the published Global head. Entry-point defaults and admitted
// domain candidates are not supplied by this first profile. Cost: at most one
// speaker selection read, one Global head read and one bounded chain read; a
// Private Context adds one Access proof per distinct Context in the chain.

export type InterpretationBasis = 'explicit' | 'speaker-object-relation' | 'speaker-object'
  | 'speaker-default' | 'global' | 'none';

export type Interpretation =
  | { state: 'resolved'; basis: InterpretationBasis; context: string | null; semanticRevision: string | null;
    definition: string | null; entryRevision: string | null; selectionRevision: string | null }
  | { state: 'unresolved' | 'disabled'; basis: InterpretationBasis; context: string; semanticRevision: string;
    entryRevision: string; selectionRevision: string | null }
  | { state: 'unavailable' };

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
  levels: ContextSelectionScope[][]): Promise<Selected | null | 'unavailable'> {
  const scopes = levels.flat();
  const found = new Map<string, { state: string; context: string | null; revision: string | null; head: string }>();
  if (request.speaker.kind === 'realm') {
    const realm = request.speaker.realm!;
    const keys = scopes.map(scope => [contextSelectionKey(realm, 'speaker', scope), contextSelectionScopeKey(scope)] as const);
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?key ?head ?state ?context ?revision WHERE {
      VALUES ?key { ${keys.map(([key]) => iri(key)).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?selection a rv:ContextSelection ; rv:selectionKey ?key ;
        rv:consumer ${iri(realm)} ; rv:selectionHead ?head . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head rv:selectionState ?state .
        OPTIONAL { ?head rv:context ?context ; rv:semanticRevision ?revision } } }
    }`)).results?.bindings ?? [];
    for (const row of rows) {
      const scope = keys.find(([key]) => key === row.key?.value)?.[1];
      if (!scope || !row.head || found.has(scope)) return 'unavailable';
      found.set(scope, { state: row.state?.value === `${RV}Selected` ? 'selected'
        : row.state?.value === `${RV}Cleared` ? 'cleared' : 'unreadable',
      context: row.context?.value ?? null, revision: row.revision?.value ?? null, head: row.head.value });
    }
  } else if (request.speaker.privateCandidates) {
    for (const row of await request.speaker.privateCandidates(scopes)) {
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
  const levels = contextSelectionCandidates(request.object, request.relation, []);
  let selected: Selected | null | 'unavailable' = request.explicit
    ? { basis: 'explicit', ...request.explicit, selectionRevision: null }
    : await speakerSelection(env, request, levels);
  if (selected === 'unavailable') return { state: 'unavailable' };
  if (!selected) {
    const global = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(GLOBAL_SEMANTIC_CONTEXT)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:semanticHead ?head . } }`)).results?.bindings ?? [];
    if (global.length > 1) return { state: 'unavailable' };
    if (!global[0]?.head) {
      return { state: 'resolved', basis: 'none', context: null, semanticRevision: null, definition: null,
        entryRevision: null, selectionRevision: null };
    }
    selected = { basis: 'global', context: GLOBAL_SEMANTIC_CONTEXT, semanticRevision: global[0].head.value,
      selectionRevision: null };
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?revision ?depth ?context ?disclosure ?entry ?state ?definition ?relation WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(selected.semanticRevision)} rv:baseRevision* ?revision .
        ?revision a rv:ContextSemanticRevision ; rv:component ?context ; rv:inheritanceDepth ?depth .
        OPTIONAL { ?revision rv:entry ?entry . ?entry rv:entryTarget ${term(request.object)} ; rv:entryState ?state .
          OPTIONAL { ?entry rv:interpretationDefinition ?definition }
          OPTIONAL { ?entry rv:entryRelation ?relation }
          FILTER(!BOUND(?relation)${request.relation ? ` || ?relation = ${term(request.relation)}` : ''}) } }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?context a rv:SemanticContext ; rv:disclosure ?disclosure } }
    } LIMIT ${(CONTEXT_LIMITS.inheritanceDepth + 1) * 3}`)).results?.bindings ?? [];
  // Entries are unique per target/relation, so a complete chain has at most two rows per revision.
  if (rows.length >= (CONTEXT_LIMITS.inheritanceDepth + 1) * 3) return { state: 'unavailable' };
  const chain = new Map<string, { depth: number; context: string; disclosure?: string;
    entries: { state: string; definition?: string; relation?: string }[] }>();
  for (const row of rows) {
    if (!row.revision || !row.context || !row.depth) return { state: 'unavailable' };
    const item = chain.get(row.revision.value) ?? { depth: Number(row.depth.value), context: row.context.value,
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
  for (const [revision, item] of ordered) {
    const entry = item.entries.find(value => value.relation) ?? item.entries.find(value => !value.relation);
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
  return { state: 'resolved', basis: selected.basis, context: selected.context,
    semanticRevision: selected.semanticRevision, definition: null, entryRevision: null,
    selectionRevision: selected.selectionRevision };
}
