import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { ContextCommandUnavailable, InvalidContextCommand, checkedCommandReceipt, commitCommand,
  readCommandReceipt, sealCommandTerminal, term, type ContextCommandReceipt } from './command.ts';

export const DEFINITION_STATE_PROFILE = 'https://rezics.com/definition/context-definition-state-v1';
export const DEFINITION_STATE_FAMILY = 'context-definition-state-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface SetDefinitionStateInput {
  definition: string;
  expectedHead: string | null;
  state: 'active' | 'retired';
  actingSubject: string;
}

/** One exact DefinitionRef has one lifecycle; no Context/member scan is involved. */
export function definitionLifecycleIri(definition: string): string {
  term(definition);
  return `urn:rezics:definition-lifecycle:${hash(definition)}`;
}

/** A selected revision and its bounded pinned bases cannot newly adopt retired DefinitionRefs. */
export function activeDefinitionDependenciesGuard(revision: string): string {
  return `FILTER NOT EXISTS {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} rv:baseRevision* ?usedRevision .
      ?usedRevision rv:entry ?usedEntry . ?usedEntry rv:interpretationDefinition ?usedDefinition . }
    GRAPH ${iri(GRAPHS.current)} { ?definitionControl a rv:DefinitionLifecycle ;
      rv:definitionRef ?usedDefinition ; rv:definitionState rv:Retired . }
  }`;
}

/** A bounded direct-entry anti-join for Context create/revise commands. */
export function activeDirectDefinitionsGuard(definitions: readonly string[]): string {
  if (!definitions.length) return '';
  return `FILTER NOT EXISTS { VALUES ?usedDefinition { ${definitions.map(term).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?definitionControl a rv:DefinitionLifecycle ;
      rv:definitionRef ?usedDefinition ; rv:definitionState rv:Retired . } }`;
}

export function definitionStateRequest(input: SetDefinitionStateInput) {
  const component = definitionLifecycleIri(input.definition);
  if ((input.expectedHead !== null && !nativeId.test(input.expectedHead))
    || !nativeId.test(input.actingSubject) || !['active', 'retired'].includes(input.state)
    || (input.expectedHead === null && input.state !== 'active')) {
    throw new InvalidContextCommand('invalid DefinitionRef state transition');
  }
  return { action: 'context.definition.state', scope: `context:definition:${hash(input.definition)}`,
    component, digest: hash(JSON.stringify([DEFINITION_STATE_FAMILY, input.definition,
      input.expectedHead, input.state, input.actingSubject])) };
}

export async function setDefinitionState(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: SetDefinitionStateInput): Promise<ContextCommandReceipt> {
  const request = definitionStateRequest(input);
  const existing = await readCommandReceipt(env, admission.id, DEFINITION_STATE_FAMILY);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?state WHERE {
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(request.component)} a rv:DefinitionLifecycle ;
      rv:definitionRef ${term(input.definition)} ; rv:definitionHead ?head ; rv:definitionState ?state . } }
  }`)).results?.bindings ?? [];
  if (rows.length !== 1) throw new ContextCommandUnavailable('DefinitionRef lifecycle is incomplete');
  const current = rows[0]?.head?.value ?? null;
  const stale = input.expectedHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(request.component)} rv:definitionHead ${iri(input.expectedHead)} . } }`
    : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(request.component)} rv:definitionHead ?other . } }`;
  if (current !== input.expectedHead) {
    const sealed = await sealCommandTerminal(env, admission, DEFINITION_STATE_FAMILY, 'stale-head', stale);
    if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
    throw new ContextCommandUnavailable('DefinitionRef head changed');
  }
  const oldState = rows[0]?.state?.value;
  const from = oldState === `${RV}Active` ? 'Active' : oldState === `${RV}Retired` ? 'Retired' : null;
  const to = input.state === 'active' ? 'Active' : 'Retired';
  if ((current && !from) || from === to) throw new ContextCommandUnavailable('DefinitionRef state is unavailable');
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const manifest = prepareComponent(env.objectDirectory, request.component, { revision,
    predecessor: current, definition: input.definition, state: input.state,
    authoredBy: input.actingSubject }, DEFINITION_STATE_PROFILE);
  const validations = await profileValidations(env.fuseki, 'context-definition-state-v1', [
    { shape: `${DEFINITION_STATE_PROFILE}/control-shape`, focus: [request.component],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${DEFINITION_STATE_PROFILE}/revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const guard = current
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(request.component)} a rv:DefinitionLifecycle ;
        rv:definitionRef ${term(input.definition)} ; rv:definitionHead ${iri(current)} ;
        rv:definitionState rv:${from} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(request.component)} ?p ?o } }`;
  const committed = await commitCommand(env, admission, { family: DEFINITION_STATE_FAMILY,
    digest: request.digest, validations, operation, component: request.component, revision,
    expectedHead: current,
    remove: current ? `GRAPH ${iri(GRAPHS.current)} { ${iri(request.component)}
      rv:definitionHead ${iri(current)} ; rv:definitionState rv:${from} . }` : '',
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(request.component)}
        ${current ? '' : `a rv:DefinitionLifecycle ; rv:definitionRef ${term(input.definition)} ;`}
        rv:definitionHead ${iri(revision)} ; rv:definitionState rv:${to} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:DefinitionLifecycleRevision, rv:RevisionAnchor ;
        rv:component ${iri(request.component)} ; ${current ? `rv:predecessor ${iri(current)} ;` : ''}
        rv:definitionRef ${term(input.definition)} ; rv:definitionState rv:${to} ;
        rv:authoredBy ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
        rv:modelRevision ${iri(DEFINITION_STATE_PROFILE)} ; rv:shapeRevision ${iri(DEFINITION_STATE_PROFILE)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `${guard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const sealed = await sealCommandTerminal(env, admission, DEFINITION_STATE_FAMILY, 'stale-head', stale);
  if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  throw new ContextCommandUnavailable('DefinitionRef state changed during transition');
}

/** Exact lifecycle state with retained manifest validation. A missing lifecycle is not a retirement. */
export async function readDefinitionState(env: WorkActivationEnvironment, definition: string,
  revision: string | null) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const component = definitionLifecycleIri(definition);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?state ?revision ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a rv:DefinitionLifecycle ;
      rv:definitionRef ${term(definition)} ; rv:definitionHead ?head ; rv:definitionState ?state . }
    ${revision ? `BIND(${iri(revision)} AS ?revision)` : 'BIND(?head AS ?revision)'}
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:DefinitionLifecycleRevision ;
      rv:component ${iri(component)} ; rv:definitionRef ${term(definition)} ; rv:manifest ?manifest . }
  }`)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.manifest || !rows[0]?.revision || !rows[0]?.head) {
    throw new ContextCommandUnavailable('DefinitionRef lifecycle read is incomplete');
  }
  const payload = readComponentState(env.objectDirectory, rows[0].manifest.value,
    component, DEFINITION_STATE_PROFILE);
  if (!rows[0].state || ![`${RV}Active`, `${RV}Retired`].includes(rows[0].state.value)
    || payload.revision !== rows[0].revision.value || payload.definition !== definition
    || !['active', 'retired'].includes(String(payload.state))
    || (rows[0].revision.value === rows[0].head.value
      && payload.state !== (rows[0].state?.value === `${RV}Retired` ? 'retired' : 'active'))) {
    throw new ContextCommandUnavailable('DefinitionRef lifecycle manifest differs from graph');
  }
  return { profile: 'context-definition-state-v1' as const, definition, component,
    state: rows[0].state!.value === `${RV}Retired` ? 'retired' as const : 'active' as const,
    head: rows[0].head.value, revision: rows[0].revision.value,
    revisionState: payload.state as 'active' | 'retired',
    predecessor: (payload.predecessor as string | null) ?? null };
}
