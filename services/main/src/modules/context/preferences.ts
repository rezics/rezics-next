import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { ContextCommandUnavailable, InvalidContextCommand, checkedCommandReceipt, commitCommand,
  readCommandReceipt, sealCommandTerminal, term, type ContextCommandReceipt } from './command.ts';
import { ContextNotFound, readContextRevision } from './read.ts';
import { CONTEXT_LIMITS, CONTEXT_PROFILE, GLOBAL_SEMANTIC_CONTEXT } from './schema.ts';

export const CONTEXT_PREFERENCE_FAMILY = 'context-preference-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

export interface ContextLabelPreference { target: string; language: string; label: string }
export interface SetContextPreferencesInput {
  context: string;
  expectedPreferenceHead: string | null;
  labels: ContextLabelPreference[];
  actingSubject: string;
}

function checkedLabels(labels: readonly ContextLabelPreference[]): ContextLabelPreference[] {
  if (labels.length > CONTEXT_LIMITS.preferences) throw new InvalidContextCommand('too many Context labels');
  const normalized = labels.map(item => {
    term(item.target);
    if (!language.test(item.language) || item.label.length < 1 || item.label.length > 256
      || item.label.trim() !== item.label || /[\u0000-\u001f\u007f]/.test(item.label)) {
      throw new InvalidContextCommand('invalid Context label');
    }
    return { target: item.target, language: item.language.toLowerCase(), label: item.label };
  }).sort((a, b) => a.target.localeCompare(b.target) || a.language.localeCompare(b.language));
  if (new Set(normalized.map(item => `${item.target}\n${item.language}`)).size !== normalized.length) {
    throw new InvalidContextCommand('duplicate preferred label language');
  }
  return normalized;
}

export function contextPreferencesRequest(input: SetContextPreferencesInput) {
  if ((input.context !== GLOBAL_SEMANTIC_CONTEXT && !native.test(input.context)) || !native.test(input.actingSubject)
    || (input.expectedPreferenceHead !== null && !native.test(input.expectedPreferenceHead))) {
    throw new InvalidContextCommand('invalid Context preference target');
  }
  const labels = checkedLabels(input.labels);
  return { action: 'context.preference', scope: `context:change:${input.context}`, labels,
    digest: hash(JSON.stringify([CONTEXT_PREFERENCE_FAMILY, input.context,
      input.expectedPreferenceHead, labels, input.actingSubject])) };
}

/** Independent preference CAS: label edits cannot advance the semantic head. */
export async function setContextPreferences(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: SetContextPreferencesInput): Promise<ContextCommandReceipt> {
  const request = contextPreferencesRequest(input);
  const existing = await readCommandReceipt(env, admission.id, CONTEXT_PREFERENCE_FAMILY);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?semantic WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ;
      rv:contextState rv:Active ; rv:semanticHead ?semantic .
      OPTIONAL { ${iri(input.context)} rv:preferenceHead ?head } }
  }`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.semantic) throw new ContextCommandUnavailable('Context is unavailable');
  const current = rows[0].head?.value ?? null;
  const stale = input.expectedPreferenceHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.context)} rv:preferenceHead ${iri(input.expectedPreferenceHead)} . } }`
    : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.context)} rv:preferenceHead ?other . } }`;
  if (current !== input.expectedPreferenceHead) {
    const sealed = await sealCommandTerminal(env, admission, CONTEXT_PREFERENCE_FAMILY, 'stale-head', stale);
    if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
    throw new ContextCommandUnavailable('Context preference head changed');
  }
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const manifest = prepareComponent(env.objectDirectory, input.context, { revision, predecessor: current,
    labels: request.labels, authoredBy: input.actingSubject }, CONTEXT_PROFILE);
  const validations = await profileValidations(env.fuseki, 'context-v1', [
    { shape: `${CONTEXT_PROFILE}/${input.context === GLOBAL_SEMANTIC_CONTEXT ? 'global' : 'context'}-shape`,
      focus: [input.context],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${CONTEXT_PROFILE}/preference-revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const targetGuard = [...new Set(request.labels.map(label => label.target))].map((target, index) =>
    `GRAPH ${iri(GRAPHS.revisions)} { ${iri(rows[0]!.semantic!.value)} rv:baseRevision* ?labelRevision${index} .
      ?labelRevision${index} rv:entry ?labelEntry${index} .
      ?labelEntry${index} rv:entryTarget ${term(target)} ; rv:entryState rv:Defined . }`).join('\n');
  const guard = input.expectedPreferenceHead
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:semanticHead ${iri(rows[0].semantic.value)} ;
        rv:preferenceHead ${iri(input.expectedPreferenceHead)} . }`
    : `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:semanticHead ${iri(rows[0].semantic.value)} . }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} rv:preferenceHead ?any } }`;
  const committed = await commitCommand(env, admission, { family: CONTEXT_PREFERENCE_FAMILY,
    digest: request.digest, validations, operation, component: input.context, revision,
    expectedHead: input.expectedPreferenceHead,
    remove: current ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} rv:preferenceHead ${iri(current)} }` : '',
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} rv:preferenceHead ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ContextPreferenceRevision, rv:RevisionAnchor ;
        rv:component ${iri(input.context)} ; ${current ? `rv:predecessor ${iri(current)} ;` : ''}
        rv:preferenceCount ${request.labels.length} ; rv:authoredBy ${iri(input.actingSubject)} ;
        rv:operation ${iri(operation)} ; rv:modelRevision ${iri(CONTEXT_PROFILE)} ;
        rv:shapeRevision ${iri(CONTEXT_PROFILE)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `${guard}
      ${targetGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const sealed = await sealCommandTerminal(env, admission, CONTEXT_PREFERENCE_FAMILY, 'stale-head', stale);
  if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  throw new ContextCommandUnavailable('Context preferences changed');
}

export async function readContextPreferences(env: WorkActivationEnvironment, context: string,
  revision: string | null, canReadPrivate: (context: string) => Promise<boolean>) {
  await readContextRevision(env, context, null, canReadPrivate);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?revision ?manifest ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
    GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:SemanticContext ; rv:preferenceHead ?head . }
    ${revision ? `BIND(${iri(revision)} AS ?revision)` : 'BIND(?head AS ?revision)'}
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ContextPreferenceRevision ;
      rv:component ${iri(context)} ; rv:manifest ?manifest . }
  }`)).results?.bindings ?? [];
  if (!rows.length) throw new ContextNotFound('Context preferences are unavailable');
  if (rows.length !== 1 || !rows[0]?.head || !rows[0]?.revision || !rows[0]?.manifest) {
    throw new ContextCommandUnavailable('Context preference read is incomplete');
  }
  const payload = readComponentState(env.objectDirectory, rows[0].manifest.value, context, CONTEXT_PROFILE);
  if (payload.revision !== rows[0].revision.value || !Array.isArray(payload.labels)) {
    throw new ContextCommandUnavailable('Context preference manifest differs from graph');
  }
  const labels = checkedLabels(payload.labels as ContextLabelPreference[]);
  return { profile: 'context-preference-v1' as const, context, head: rows[0].head.value,
    revision: rows[0].revision.value, predecessor: (payload.predecessor as string | null) ?? null,
    labels, sourcePosition: { datasetId: 'product' as const,
      dataEpoch: rows[0].epoch!.value, sequence: rows[0].sequence!.value } };
}

/** Scoped concept IRIs avoid publishing local labels on the unqualified target. */
export async function contextSkos(env: WorkActivationEnvironment, context: string,
  semanticRevision: string | null, preferenceRevision: string | null,
  canReadPrivate: (context: string) => Promise<boolean>) {
  const semantic = await readContextRevision(env, context, semanticRevision, canReadPrivate);
  const preferences = await readContextPreferences(env, context, preferenceRevision, canReadPrivate);
  const targets = new Set<string>();
  if (preferences.labels.length) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?target ?relation ?state ?depth ?owner ?disclosure WHERE {
      VALUES ?target { ${[...new Set(preferences.labels.map(label => label.target))].map(term).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(semantic.revision)} rv:baseRevision* ?entryRevision .
        ?entryRevision a rv:ContextSemanticRevision ; rv:component ?owner ;
          rv:inheritanceDepth ?depth ; rv:entry ?entry .
        ?entry rv:entryTarget ?target ; rv:entryState ?state .
        OPTIONAL { ?entry rv:entryRelation ?relation } }
      GRAPH ${iri(GRAPHS.current)} { ?owner rv:disclosure ?disclosure . }
    } LIMIT ${CONTEXT_LIMITS.preferences * (CONTEXT_LIMITS.inheritanceDepth + 1) + 1}`)).results?.bindings ?? [];
    if (rows.length > CONTEXT_LIMITS.preferences * (CONTEXT_LIMITS.inheritanceDepth + 1)) {
      throw new ContextCommandUnavailable('Context SKOS dependency read exceeds its bound');
    }
    const selected = new Map<string, { target: string; depth: number; state: string }>();
    for (const row of rows) {
      if (!row.target || !row.owner || !row.disclosure || !row.depth || !row.state
        || (row.disclosure.value !== `${RV}Public` && (row.disclosure.value !== `${RV}Private`
          || !await canReadPrivate(row.owner.value)))) {
        throw new ContextCommandUnavailable('Context SKOS dependency is unavailable');
      }
      const key = `${row.target.value}\n${row.relation?.value ?? ''}`;
      const depth = Number(row.depth.value);
      if (!Number.isInteger(depth) || depth < 0 || depth > CONTEXT_LIMITS.inheritanceDepth) {
        throw new ContextCommandUnavailable('Context SKOS dependency depth is invalid');
      }
      const previous = selected.get(key);
      if (previous?.depth === depth) throw new ContextCommandUnavailable('Context SKOS entry is ambiguous');
      if (!previous || depth > previous.depth) selected.set(key, { target: row.target.value,
        depth, state: row.state.value });
    }
    for (const entry of selected.values()) if (entry.state === `${RV}Defined`) targets.add(entry.target);
  }
  const graph = preferences.labels.filter(label => targets.has(label.target)).map(label => ({
    '@id': `urn:rezics:context-concept:${hash(JSON.stringify([context, semantic.revision, label.target]))}`,
    '@type': 'skos:Concept', 'rv:interprets': { '@id': label.target },
    'rv:semanticRevision': { '@id': semantic.revision },
    'rv:preferenceRevision': { '@id': preferences.revision },
    'skos:prefLabel': { '@value': label.label, '@language': label.language },
  }));
  return { '@context': { skos: 'http://www.w3.org/2004/02/skos/core#', rv: RV,
    context: { '@id': 'rv:context', '@type': '@id' },
    semanticRevision: { '@id': 'rv:semanticRevision', '@type': '@id' },
    preferenceRevision: { '@id': 'rv:preferenceRevision', '@type': '@id' } },
    '@graph': graph, context, semanticRevision: semantic.revision, preferenceRevision: preferences.revision };
}
