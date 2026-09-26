import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { ContextCommandUnavailable, InvalidContextCommand, checkedCommandReceipt, commitCommand,
  readCommandReceipt, sealCommandTerminal, term, type ContextCommandReceipt } from './command.ts';
import { CONTEXT_AUTHORITY, CONTEXT_PROFILE, CONTEXT_SELECTION_PROFILE, CONTEXT_SELECTION_SCOPE_PROFILE,
  GLOBAL_SEMANTIC_CONTEXT, canonicalContextEntries, checkContextSelectionScope, contextEntryIri,
  contextSelectionKey, nextInheritanceDepth, type ContextDisclosure, type ContextEntryRecord,
  type ContextSelectionScope } from './schema.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const SCOPE_TERMS = { default: 'DefaultScope', domain: 'DomainScope', object: 'ObjectScope',
  'object-relation': 'ObjectRelationScope' } as const;
const ENTRY_TERMS = { defined: 'Defined', unresolved: 'Unresolved', disabled: 'Disabled' } as const;

export const CONTEXT_FAMILIES = {
  create: 'context-create-v1', revise: 'context-revise-v1', realmSelect: 'context-realm-selection-v1',
} as const;

export interface CreateContextInput {
  role: 'global' | 'shared';
  disclosure: ContextDisclosure;
  base: string | null;
  entries: ContextEntryRecord[];
  actingSubject: string;
}
export interface ReviseContextInput {
  context: string;
  expectedSemanticHead: string;
  base: string | null;
  entries: ContextEntryRecord[];
  actingSubject: string;
}
export interface SelectRealmContextInput {
  realm: string;
  scope: ContextSelectionScope;
  /** null clears the scope explicitly; the next precedence level then applies. */
  selection: { context: string; semanticRevision: string } | null;
  expectedHead: string | null;
  actingSubject: string;
}

function checkActor(actingSubject: string) {
  if (!nativeId.test(actingSubject)) throw new InvalidContextCommand('invalid acting subject');
}

export function createContextRequest(input: CreateContextInput) {
  checkActor(input.actingSubject);
  if (!['global', 'shared'].includes(input.role) || !['public', 'private'].includes(input.disclosure)
    || (input.role === 'global' && (input.disclosure !== 'public' || input.base !== null))
    || (input.base !== null && !nativeId.test(input.base))) {
    throw new InvalidContextCommand('invalid Context creation');
  }
  const entries = canonicalContextEntries(input.entries);
  const authority = input.role === 'global'
    ? { action: 'context.create', scope: 'context:create:global' } : CONTEXT_AUTHORITY.create;
  return { ...authority, entries, digest: hash(JSON.stringify([CONTEXT_FAMILIES.create, input.role,
    input.disclosure, input.base, entries, input.actingSubject])) };
}

export function reviseContextRequest(input: ReviseContextInput) {
  checkActor(input.actingSubject);
  if ((input.context !== GLOBAL_SEMANTIC_CONTEXT && !nativeId.test(input.context))
    || !nativeId.test(input.expectedSemanticHead) || (input.base !== null && !nativeId.test(input.base))) {
    throw new InvalidContextCommand('invalid Context revision');
  }
  const entries = canonicalContextEntries(input.entries);
  return { ...CONTEXT_AUTHORITY.change(input.context), entries, digest: hash(JSON.stringify([
    CONTEXT_FAMILIES.revise, input.context, input.expectedSemanticHead, input.base, entries,
    input.actingSubject])) };
}

export function selectRealmContextRequest(input: SelectRealmContextInput) {
  checkActor(input.actingSubject);
  checkContextSelectionScope(input.scope);
  if (!nativeId.test(input.realm) || (input.expectedHead !== null && !nativeId.test(input.expectedHead))
    || (input.selection && ((input.selection.context !== GLOBAL_SEMANTIC_CONTEXT
      && !nativeId.test(input.selection.context)) || !nativeId.test(input.selection.semanticRevision)))) {
    throw new InvalidContextCommand('invalid Realm Context selection');
  }
  return { ...CONTEXT_AUTHORITY.realmSelection(input.realm), key: contextSelectionKey(input.realm, 'speaker', input.scope),
    digest: hash(JSON.stringify([CONTEXT_FAMILIES.realmSelect, input.realm, input.scope, input.selection,
      input.expectedHead, input.actingSubject])) };
}

function entryTriples(entries: readonly ContextEntryRecord[]): { iris: string[]; triples: string } {
  const iris = entries.map(contextEntryIri);
  return { iris, triples: entries.map((entry, index) => `${iri(iris[index]!)} a rv:ContextEntry ;
      rv:entryTarget ${term(entry.target)} ; rv:entryState rv:${ENTRY_TERMS[entry.state]}
      ${entry.relation ? `; rv:entryRelation ${term(entry.relation)}` : ''}
      ${entry.definition ? `; rv:interpretationDefinition ${term(entry.definition)}` : ''}
      ${entry.applicability.map(value => `; rv:applicability ${term(value)}`).join(' ')} .`).join('\n') };
}

/** The pinned base must be an existing semantic revision of an Active Context this one may inherit. */
async function baseDepth(env: WorkActivationEnvironment, base: string | null,
  disclosure: ContextDisclosure, self: string): Promise<{ depth: number; guard: string }> {
  if (base === null) return { depth: 0, guard: '' };
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?depth ?disclosure WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(base)} a rv:ContextSemanticRevision ; rv:component ?context ;
      rv:inheritanceDepth ?depth . }
    GRAPH ${iri(GRAPHS.current)} { ?context a rv:SemanticContext ; rv:contextState rv:Active ;
      rv:disclosure ?disclosure . }
  }`)).results?.bindings ?? [];
  const row = rows[0];
  // A public Context cannot rest on a hidden base; a private one may specialize either.
  if (rows.length !== 1 || !row?.context || !row.depth || row.context.value === self
    || (disclosure === 'public' && row.disclosure?.value !== `${RV}Public`)) {
    throw new ContextCommandUnavailable('Context base revision is unavailable');
  }
  const depth = nextInheritanceDepth(Number(row.depth.value));
  return { depth, guard: `GRAPH ${iri(GRAPHS.revisions)} { ${iri(base)} a rv:ContextSemanticRevision ;
      rv:component ${iri(row.context.value)} ; rv:inheritanceDepth ${depth - 1} . }
    GRAPH ${iri(GRAPHS.current)} { ${iri(row.context.value)} a rv:SemanticContext ; rv:contextState rv:Active ;
      rv:disclosure ${term(row.disclosure!.value)} . }` };
}

async function semanticRevisionPlan(env: WorkActivationEnvironment, context: string, revision: string,
  predecessor: string | null, base: string | null, depth: number, entries: ContextEntryRecord[],
  actingSubject: string, operation: string) {
  const { iris, triples } = entryTriples(entries);
  const manifest = prepareComponent(env.objectDirectory, context, { revision, predecessor, base,
    inheritanceDepth: depth, entries, authoredBy: actingSubject }, CONTEXT_PROFILE);
  const validations = await profileValidations(env.fuseki, 'context-v1', [
    { shape: `${CONTEXT_PROFILE}/${context === GLOBAL_SEMANTIC_CONTEXT ? 'global' : 'context'}-shape`,
      focus: [context], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${CONTEXT_PROFILE}/semantic-revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    ...(iris.length ? [{ shape: `${CONTEXT_PROFILE}/entry-shape`, focus: iris, graphs: [GRAPHS.revisions] }] : []),
  ]);
  const insert = `GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a rv:ContextSemanticRevision, rv:RevisionAnchor ; rv:component ${iri(context)} ;
        ${predecessor ? `rv:predecessor ${iri(predecessor)} ;` : ''}
        ${base ? `rv:baseRevision ${iri(base)} ;` : ''}
        rv:inheritanceDepth ${depth} ; rv:entryCount ${entries.length} ;
        ${iris.map(entry => `rv:entry ${iri(entry)} ;`).join(' ')}
        rv:authoredBy ${iri(actingSubject)} ; rv:operation ${iri(operation)} ;
        rv:modelRevision ${iri(CONTEXT_PROFILE)} ; rv:shapeRevision ${iri(CONTEXT_PROFILE)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      ${triples}
    }`;
  return { validations, insert };
}

/** Create a Realm-free shared Context (or the Global baseline) with its first semantic revision. */
export async function createContext(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: CreateContextInput): Promise<ContextCommandReceipt> {
  const request = createContextRequest(input);
  const existing = await readCommandReceipt(env, admission.id, CONTEXT_FAMILIES.create);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const context = input.role === 'global' ? GLOBAL_SEMANTIC_CONTEXT : ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const base = await baseDepth(env, input.base, input.disclosure, context);
  const plan = await semanticRevisionPlan(env, context, revision, null, input.base, base.depth,
    request.entries, input.actingSubject, operation);
  const committed = await commitCommand(env, admission, { family: CONTEXT_FAMILIES.create,
    digest: request.digest, validations: plan.validations, operation, component: context, revision,
    expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:SemanticContext ;
        rv:contextRole rv:${input.role === 'global' ? 'GlobalInterpretation' : 'SharedInterpretation'} ;
        rv:contextState rv:Active ; rv:disclosure rv:${input.disclosure === 'public' ? 'Public' : 'Private'} ;
        rv:semanticHead ${iri(revision)} . }
      ${plan.insert}`,
    where: `${base.guard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  throw new ContextCommandUnavailable('Context or its base changed during creation');
}

/** Publish a successor semantic revision under the Context's own expected head. */
export async function reviseContext(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: ReviseContextInput): Promise<ContextCommandReceipt> {
  const request = reviseContextRequest(input);
  const existing = await readCommandReceipt(env, admission.id, CONTEXT_FAMILIES.revise);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const header = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?disclosure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ; rv:contextState rv:Active ;
      rv:semanticHead ?head ; rv:disclosure ?disclosure . } }`)).results?.bindings ?? [];
  if (header.length !== 1 || !header[0]?.head) throw new ContextCommandUnavailable('Context is unavailable');
  const stale = `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ; rv:semanticHead ?other .
      FILTER(?other != ${iri(input.expectedSemanticHead)}) }`;
  if (header[0].head.value !== input.expectedSemanticHead) {
    return checkedCommandReceipt((await sealCommandTerminal(env, admission, CONTEXT_FAMILIES.revise,
      'stale-head', stale))!, admission, request.digest);
  }
  const disclosure: ContextDisclosure = header[0].disclosure?.value === `${RV}Public` ? 'public' : 'private';
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const base = await baseDepth(env, input.base, disclosure, input.context);
  const plan = await semanticRevisionPlan(env, input.context, revision, input.expectedSemanticHead,
    input.base, base.depth, request.entries, input.actingSubject, operation);
  const committed = await commitCommand(env, admission, { family: CONTEXT_FAMILIES.revise,
    digest: request.digest, validations: plan.validations, operation, component: input.context, revision,
    expectedHead: input.expectedSemanticHead,
    remove: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} rv:semanticHead ${iri(input.expectedSemanticHead)} }`,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} rv:semanticHead ${iri(revision)} }
      ${plan.insert}`,
    where: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ; rv:contextState rv:Active ;
        rv:semanticHead ${iri(input.expectedSemanticHead)} . }
      ${base.guard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const sealed = await sealCommandTerminal(env, admission, CONTEXT_FAMILIES.revise, 'stale-head', stale);
  if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  throw new ContextCommandUnavailable('Context changed during revision');
}

const realmGuard = (realm: string) => `?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .`;

/**
 * Set or clear a public Realm speaker selection. It adopts only a published revision of an
 * Active public Context and grants no authority over that Context.
 */
export async function selectRealmContext(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: SelectRealmContextInput): Promise<ContextCommandReceipt> {
  const request = selectRealmContextRequest(input);
  const family = CONTEXT_FAMILIES.realmSelect;
  const existing = await readCommandReceipt(env, admission.id, family);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const read = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realmOk ?selection ?head WHERE {
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${realmGuard(input.realm)} } BIND(true AS ?realmOk) }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?selection a rv:ContextSelection ;
      rv:selectionKey ${iri(request.key)} ; rv:contextSelectionHead ?head . } }
  }`)).results?.bindings ?? [];
  if (read.length !== 1 || !read[0]?.realmOk) throw new ContextCommandUnavailable('Realm is unavailable');
  const current = read[0].head?.value ?? null;
  const headGuard = input.expectedHead
    ? `GRAPH ${iri(GRAPHS.current)} { ?selection rv:selectionKey ${iri(request.key)} ;
        rv:contextSelectionHead ${iri(input.expectedHead)} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?occupied rv:selectionKey ${iri(request.key)} } }`;
  const stale = input.expectedHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?s rv:selectionKey ${iri(request.key)} ;
        rv:contextSelectionHead ${iri(input.expectedHead)} . } }`
    : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ?s rv:selectionKey ${iri(request.key)} } }`;
  if (current !== input.expectedHead) {
    return checkedCommandReceipt((await sealCommandTerminal(env, admission, family, 'stale-head', stale))!,
      admission, request.digest);
  }
  if (input.selection) {
    const ok = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.selection.context)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:disclosure rv:Public . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.selection.semanticRevision)} a rv:ContextSemanticRevision ;
        rv:component ${iri(input.selection.context)} . } }`);
    if (ok.boolean !== true) throw new ContextCommandUnavailable('selected Context revision is unavailable');
  }
  const selection = read[0].selection?.value ?? ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const scope = input.scope;
  const manifest = prepareComponent(env.objectDirectory, selection, { revision, predecessor: input.expectedHead,
    consumer: input.realm, role: 'speaker', scope, selection: input.selection, selectedBy: input.actingSubject },
  CONTEXT_SELECTION_PROFILE);
  const validations = await profileValidations(env.fuseki, 'context-selection-v1', [
    { shape: `${CONTEXT_SELECTION_PROFILE}/selection-shape`, focus: [selection], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${CONTEXT_SELECTION_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const dependency = input.selection ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.selection.context)}
      a rv:SemanticContext ; rv:contextState rv:Active ; rv:disclosure rv:Public . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.selection.semanticRevision)} a rv:ContextSemanticRevision ;
      rv:component ${iri(input.selection.context)} . }` : '';
  const header = input.expectedHead ? '' : `${iri(selection)} a rv:ContextSelection ; rv:consumer ${iri(input.realm)} ;
        rv:selectionRole rv:SpeakerSelection ; rv:scopeProfile ${iri(CONTEXT_SELECTION_SCOPE_PROFILE)} ;
        rv:scopeKind rv:${SCOPE_TERMS[scope.kind]} ; rv:selectionKey ${iri(request.key)}
        ${'object' in scope ? `; rv:scopeObject ${iri(scope.object)}` : ''}
        ${scope.kind === 'object-relation' ? `; rv:scopeRelation ${term(scope.relation)}` : ''}
        ${scope.kind === 'domain' ? `; rv:scopeDomain ${iri(scope.domain)}` : ''} .`;
  const committed = await commitCommand(env, admission, { family, digest: request.digest, validations, operation,
    component: selection, revision, expectedHead: input.expectedHead,
    remove: input.expectedHead ? `GRAPH ${iri(GRAPHS.current)} { ${iri(selection)} rv:contextSelectionHead ${iri(input.expectedHead)} }` : '',
    insert: `GRAPH ${iri(GRAPHS.current)} { ${header} ${iri(selection)} rv:contextSelectionHead ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ContextSelectionRevision, rv:RevisionAnchor ;
        rv:component ${iri(selection)} ; ${input.expectedHead ? `rv:predecessor ${iri(input.expectedHead)} ;` : ''}
        rv:selectionState rv:${input.selection ? 'Selected' : 'Cleared'} ;
        ${input.selection ? `rv:context ${iri(input.selection.context)} ;
          rv:semanticRevision ${iri(input.selection.semanticRevision)} ;` : ''}
        rv:selectedBy ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
        rv:modelRevision ${iri(CONTEXT_SELECTION_PROFILE)} ; rv:shapeRevision ${iri(CONTEXT_SELECTION_PROFILE)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `GRAPH ${iri(GRAPHS.current)} { ${realmGuard(input.realm)} }
      ${headGuard} ${dependency}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const sealed = await sealCommandTerminal(env, admission, family, 'stale-head', stale);
  if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  throw new ContextCommandUnavailable('Realm selection dependencies changed');
}
