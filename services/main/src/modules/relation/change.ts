import { GRAPHS, ID, IdempotencyConflict, PendingActivation, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import type { EditorRecording } from '../lexicon/editor-recording.ts';
import { KEY_NOTATION } from '../lexicon/definition-key.ts';
import { assertSemanticDispatchable, checkedSemanticTerminal, ensureModelGeneration, familyReceiptIri,
  readComponent, readSemanticTerminal, SemanticChangeRejected, SemanticTargetUnavailable, sealComponentState,
  sealSemanticRejection, sendSemanticWrite, validationsFor, type SemanticAdmission,
  type SemanticTerminal } from '../semantic/command.ts';
import { checkedStoredState, term, type RelationRole, type RelationStar } from '../semantic/change.ts';
import { checkedNativeIri, MODEL_COMPONENT, PROFILES, type Lifecycle } from '../semantic/schema.ts';
import { semanticValueRdf } from '../semantic/value.ts';
import { checkedApplicability, checkedParticipations, InvalidRelationOccurrence, PARTICIPATION_FORMAT_V2,
  RELATION_LIMITS, RELATION_TERMS, type Participation, type RelationRoleDefinition } from './schema.ts';

export const RELATION_CHANGE_FAMILY = 'relation-change';

export interface RelationInput {
  /** Exact relation DefinitionRef: a `semantic-definition-v1` revision. */
  definition: string;
  participations: { role: string; participant: unknown; position?: number;
    creditedName?: { lexical: string; language: string } }[];
  applicability?: string[];
  lifecycle?: Lifecycle;
  evidence?: string;
}

export interface RelationChangeIntent {
  admission: SemanticAdmission;
  occurrence?: string;
  expectedHead: string | null;
  input: RelationInput;
  /** Server-only publication hook; complete disclosure metadata before graph visibility. */
  beforeCommit?: (component: string, receipt: string) => Promise<void>;
}

/** Stored occurrence revision state; participation and value node identities are exact. */
export interface OccurrenceState {
  definition: string;
  lifecycle: Lifecycle;
  applicability: string[];
  evidence?: string;
  participations: (Participation & { iri: string; node?: string })[];
}

export interface ExactDefinition extends EditorRecording {
  revision: string;
  definition: string;
  lifecycle: Lifecycle;
  roles: RelationRoleDefinition[];
  roleKeys: Record<string, string>;
  notation?: string;
  workSubjectRole?: string;
  /** Role keys of the star constraint, when the definition declares one. */
  star?: RelationStar;
}

export const roleIri = (definition: string, key: string): string => `${definition}/role/${key}`;

/** Resolve the unique stored key through graph state, never a machine-local seed map.
 * SKOS notation is an identifier independent of a preferred language label:
 * https://www.w3.org/TR/skos-reference/#notations */
export async function readDefinitionByKey(env: WorkActivationEnvironment, key: string,
  canRead?: (definition: string) => Promise<boolean>): Promise<ExactDefinition | null> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new SemanticChangeRejected('invalid', 'invalid definition key');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?definition ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?key a rv:DefinitionKey ; rv:keyDefinition ?definition ;
      <${KEY_NOTATION}> ${lit(key)} . ?definition a rv:SemanticDefinition ; rv:definitionHead ?head }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RevisionCorrupt('definition key is ambiguous');
  if (canRead && !await canRead(rows[0]!.definition!.value)) return null;
  const definition = await readExactDefinition(env, rows[0]!.head!.value);
  if (!definition || definition.notation !== key) throw new RevisionCorrupt('definition key differs from retained state');
  return definition;
}

/** Resolve an exact relation DefinitionRef from its immutable revision, never the current head. */
export async function readExactDefinition(env: WorkActivationEnvironment, revision: string,
  canRead?: (definition: string) => Promise<boolean>): Promise<ExactDefinition | null> {
  checkedNativeIri(revision);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?definition ?manifest WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:DefinitionRevision ; rv:component ?definition ;
      rv:manifest ?manifest } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RevisionCorrupt('definition revision is ambiguous');
  const definition = rows[0]!.definition!.value;
  if (canRead && !await canRead(definition)) return null;
  const state = checkedStoredState(await readComponent(env, rows[0]!.manifest!.value, definition, PROFILES.definition));
  if (state.component !== 'definition') throw new RevisionCorrupt('definition revision names another component');
  if (state.kind !== 'relation') return null;
  return { revision, definition, lifecycle: state.lifecycle, ...(state.editorRecordable === undefined ? {} : { editorRecordable: state.editorRecordable }),
    ...(state.writePath === undefined ? {} : { writePath: state.writePath }),
    ...(state.notation ? { notation: state.notation } : {}),
    ...(state.workSubjectRole ? { workSubjectRole: state.workSubjectRole } : {}),
    ...(state.star ? { star: state.star } : {}),
    roles: state.roles.map((role: RelationRole) => ({ role: roleIri(definition, role.key),
      minParticipants: role.minParticipants, maxParticipants: role.maxParticipants, ordered: role.ordered })),
    roleKeys: Object.fromEntries(state.roles.map(role => [roleIri(definition, role.key), role.key])) };
}

export function canonicalRelation(definition: ExactDefinition, input: RelationInput): OccurrenceState {
  try {
    if (input.evidence !== undefined && !/^https:\/\/[^\s<>"{}|\\^`]{1,2040}$/.test(input.evidence)) {
      throw new InvalidRelationOccurrence('invalid relation evidence');
    }
    const participations = checkedParticipations(definition.roles, input.participations.map(item => ({
      ...item, role: typeof item.role === 'string' ? roleIri(definition.definition, item.role) : item.role })));
    const externals = participations.filter(item => item.participant.kind === 'external').length;
    if (participations.length + externals > RELATION_LIMITS.participants + 32) {
      throw new InvalidRelationOccurrence('occurrence footprint exceeds the command bound');
    }
    if (definition.star) checkedStarParticipants(definition, participations);
    const key = (item: Participation) => JSON.stringify([item.role, item.position ?? -1, item.participant]);
    return { ...(input.evidence === undefined ? {} : { evidence: input.evidence }), definition: definition.revision, lifecycle: input.lifecycle ?? 'active',
      applicability: checkedApplicability(input.applicability ?? []),
      participations: participations.sort((a, b) => key(a).localeCompare(key(b))).map(item => ({ ...item, iri: '' })) };
  } catch (error) {
    if (error instanceof InvalidRelationOccurrence) throw new SemanticChangeRejected('invalid', error.message);
    throw error;
  }
}

export class StarViolation extends SemanticChangeRejected {
  constructor(message: string) { super('star-violation', message); }
}

function starRoles(definition: ExactDefinition) {
  const star = definition.star!;
  return { leaf: roleIri(definition.definition, star.leaf), hub: roleIri(definition.definition, star.hub) };
}

/** Star members are identities: only native Resources can be compared across occurrences, and one
 * Resource cannot be leaf and hub of the same occurrence. */
function checkedStarParticipants(definition: ExactDefinition, participations: readonly Participation[]) {
  const roles = starRoles(definition);
  const members = (role: string) => participations.filter(item => item.role === role);
  const all = [...members(roles.leaf), ...members(roles.hub)];
  if (all.some(item => item.participant.kind !== 'resource')) {
    throw new InvalidRelationOccurrence('star roles take native resources');
  }
  const hubs = new Set(members(roles.hub).map(item => JSON.stringify(item.participant)));
  if (members(roles.leaf).some(item => hubs.has(JSON.stringify(item.participant)))) {
    throw new StarViolation('a participant cannot be both leaf and hub of one occurrence');
  }
}

/**
 * Observed star conflict for a new active occurrence: another active occurrence of the same definition in
 * which a leaf already holds the leaf or hub role, or a hub already holds the leaf role. Retired occurrences
 * hold nothing. The same pattern guards the write and, restated, seals the typed refusal.
 */
function starConflict(definition: ExactDefinition, occurrence: string, state: OccurrenceState): string {
  const roles = starRoles(definition);
  const refs = (role: string) => state.participations.flatMap(item =>
    item.role === role && item.participant.kind === 'resource' ? [item.participant.ref] : []);
  const pairs = [...refs(roles.leaf).flatMap(ref => [[roles.leaf, ref], [roles.hub, ref]]),
    ...refs(roles.hub).map(ref => [roles.leaf, ref])];
  if (!pairs.length) return '';
  return `{ VALUES (?conflictRole ?conflictParticipant) { ${pairs.map(([role, ref]) =>
      `(${iri(role!)} ${iri(ref!)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?other a rv:RelationOccurrence ; rv:occurrenceHead ?otherHead }
    GRAPH ${iri(GRAPHS.revisions)} { ?otherHead rv:lifecycle rv:Active ; rv:relationDefinition ?otherDefinition ;
      rv:participation ?otherParticipation .
      ?otherDefinition rv:component ${iri(definition.definition)} .
      ?otherParticipation rv:role ?conflictRole ; rv:participant ?conflictParticipant }
    FILTER(?other != ${iri(occurrence)}) }`;
}

export function relationChangeDigest(occurrence: string | undefined, expectedHead: string | null,
  state: OccurrenceState): string {
  return hash(JSON.stringify({ family: 'relation-change-v1', occurrence: occurrence ?? null, expectedHead,
    ...(state.evidence === undefined ? {} : { evidence: state.evidence }), definition: state.definition, lifecycle: state.lifecycle, applicability: state.applicability,
    participations: state.participations.map(({ role, participant, position, creditedName }) =>
      ({ role, participant, ...(position === undefined ? {} : { position }),
        ...(creditedName ? { creditedName } : {}) })) }));
}

function checkedOccurrenceState(state: Record<string, unknown>): OccurrenceState {
  const participations = state.participations as OccurrenceState['participations'] | undefined;
  if (typeof state.definition !== 'string' || (state.lifecycle !== 'active' && state.lifecycle !== 'retired')
    || !Array.isArray(state.applicability) || !Array.isArray(participations)
    || participations.some(item => typeof item.iri !== 'string' || typeof item.role !== 'string')) {
    throw new RevisionCorrupt('stored occurrence state is invalid');
  }
  return state as unknown as OccurrenceState;
}

function occurrenceTriples(state: OccurrenceState, head: string): string[] {
  return [`<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}RelationOccurrence>`,
    `<${RV}relationDefinition> <${state.definition}>`, `<${RV}occurrenceHead> <${head}>`,
    ...state.applicability.map(item => `<${RV}applicability> <${item}>`)];
}

export interface CurrentOccurrence { head: string; manifest: string; state: OccurrenceState }

export async function readCurrentOccurrence(env: WorkActivationEnvironment, occurrence: string):
Promise<CurrentOccurrence | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(occurrence)} a rv:RelationOccurrence ; rv:occurrenceHead ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head rv:component ${iri(occurrence)} ; rv:manifest ?manifest } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RevisionCorrupt('occurrence head is ambiguous');
  const head = rows[0]!.head!.value;
  const state = checkedOccurrenceState(await readComponent(env, rows[0]!.manifest!.value, occurrence, PROFILES.relation));
  const graph = await env.fuseki.query(`SELECT ?p ?o WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(occurrence)} ?p ?o } } LIMIT 12`);
  const actual = new Set((graph.results?.bindings ?? []).map(row => `<${row.p!.value}> ${term(row.o!)}`));
  const expected = new Set(occurrenceTriples(state, head));
  if (actual.size !== expected.size || [...expected].some(item => !actual.has(item))) {
    throw new RevisionCorrupt('occurrence projection differs from its retained head');
  }
  return { head, manifest: rows[0]!.manifest!.value, state };
}

export interface RelationChangeResult {
  occurrence: string;
  revision: string;
  predecessor: string | null;
  receipt: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

/**
 * Create or revise one identified relation occurrence. The update guards the
 * occurrence head, that the definition revision is its definition's current Active
 * head, the participants' presence and the pinned model generation.
 */
export async function changeRelationOccurrence(env: WorkActivationEnvironment,
  intent: RelationChangeIntent): Promise<RelationChangeResult> {
  if (intent.occurrence !== undefined) checkedNativeIri(intent.occurrence);
  if ((intent.occurrence === undefined) !== (intent.expectedHead === null)) {
    throw new SemanticChangeRejected('invalid', 'a create has no head; an edit names one');
  }
  const definition = await readExactDefinition(env, checkedNativeIri(intent.input.definition));
  if (!definition) throw new SemanticChangeRejected('unavailable-reference', 'relation definition is unavailable');
  const state = canonicalRelation(definition, intent.input);
  const digest = relationChangeDigest(intent.occurrence, intent.expectedHead, state);
  const receipt = familyReceiptIri(intent.admission.id, RELATION_CHANGE_FAMILY);
  const existing = await assertSemanticDispatchable(env, intent.admission, receipt, digest);
  if (existing) return checkedResult(existing, intent, true);
  const generation = await ensureModelGeneration(env);
  const occurrence = intent.occurrence ?? `${ID}${Bun.randomUUIDv7()}`;
  const current = intent.occurrence ? await readCurrentOccurrence(env, occurrence) : null;
  if (intent.occurrence && !current) throw new SemanticTargetUnavailable('relation occurrence is unavailable');
  if (current && current.head !== intent.expectedHead) return sealStale(env, intent, receipt, digest, occurrence);
  const nodes: string[][] = [];
  const participations = state.participations.map(item => {
    const participation = `${ID}${Bun.randomUUIDv7()}`;
    const rdf = semanticValueRdf(item.participant, () => `${ID}${Bun.randomUUIDv7()}`);
    if (rdf.node) nodes.push([rdf.node.iri, ...rdf.node.triples.map(triple => `${triple} .`)]);
    return { ...item, iri: participation, ...(rdf.node ? { node: rdf.node.iri } : {}), object: rdf.object };
  });
  const exact: OccurrenceState = { ...state, participations: participations.map(({ object: _object, ...item }) => item) };
  const manifest = await sealComponentState(env, occurrence, PROFILES.relation, exact);
  const revision = `${ID}${Bun.randomUUIDv7()}`;
  const operation = `${ID}${Bun.randomUUIDv7()}`;
  const old = current ? occurrenceTriples(current.state, current.head) : [];
  const next = occurrenceTriples(exact, revision);
  const resources = [...new Set(state.participations.flatMap(item =>
    item.participant.kind === 'resource' ? [item.participant.ref] : []))];
  const active = state.lifecycle === 'active';
  const conflict = active && definition.star ? starConflict(definition, occurrence, exact) : '';
  const validations = [
    ...await validationsFor(env, 'relation-occurrence-v1', [{ role: 'occurrence', focus: [occurrence] },
      { role: 'revision', focus: [revision] }]),
    ...await validationsFor(env, 'relation-occurrence-v2',
      [{ role: 'participation', focus: participations.map(item => item.iri) }]),
    ...nodes.length ? await validationsFor(env, 'value-exact-v1',
      [{ role: 'external-reference', focus: nodes.map(node => node[0]!) }]) : [],
  ];
  await intent.beforeCommit?.(occurrence,receipt);
  await sendSemanticWrite(env, {
    receipt, digest, admission: intent.admission, validations,
    deletes: old.length ? `GRAPH ${iri(GRAPHS.current)} { ${old.map(triple => `${iri(occurrence)} ${triple} .`).join('\n')} }` : '',
    inserts: `GRAPH ${iri(GRAPHS.current)} { ${next.map(triple => `${iri(occurrence)} ${triple} .`).join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RelationOccurrenceRevision, rv:RevisionAnchor ; rv:component ${iri(occurrence)} ;
          ${current ? `rv:predecessor ${iri(current.head)} ;` : ''} rv:relationDefinition ${iri(definition.revision)} ;
          rv:lifecycle rv:${active ? 'Active' : 'Retired'} ; rv:participantCount ${participations.length} ;
          ${participations.map(item => `rv:participation ${iri(item.iri)} ;`).join(' ')}
          rv:operation ${iri(operation)} ; rv:manifest ${iri(manifest)} ; rv:modelGeneration ${iri(generation)} ;
          rv:modelRevision ${iri(PROFILES.relation)} ; rv:shapeRevision ${iri(PROFILES.relation)} ;
          rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${participations.map(item => `${iri(item.iri)} a rv:RelationParticipation ; rv:occurrence ${iri(occurrence)} ;
          rv:role ${iri(item.role)} ; rv:participant ${item.object} ;
          <${RELATION_TERMS.format}> <${PARTICIPATION_FORMAT_V2}>
          ${item.position === undefined ? '' : `; <https://schema.org/position> ${item.position}`}
          ${item.creditedName ? `; <${RELATION_TERMS.creditedName}> ${semanticValueRdf({ kind: 'language-string',
            ...item.creditedName }, () => '').object}` : ''} .`).join('\n')}
        ${nodes.map(node => node.slice(1).join('\n')).join('\n')} }`,
    where: `GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} a rv:ModelGeneration }
      GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(generation)} }
      ${current ? `GRAPH ${iri(GRAPHS.current)} { ${old.map(triple => `${iri(occurrence)} ${triple} .`).join('\n')} }`
        : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(occurrence)} ?anyP ?anyO } }`}
      ${active ? `GRAPH ${iri(GRAPHS.current)} { ${iri(definition.definition)} rv:definitionHead ${iri(definition.revision)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(definition.revision)} rv:lifecycle rv:Active }` : ''}
      ${intent.admission.scope.startsWith('work:edit:') ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(intent.admission.scope.slice('work:edit:'.length))} a <https://schema.org/CreativeWork> }` : ''}
      ${resources.map(ref => `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(ref)} a ?refType } }`).join('\n')}
      ${conflict ? `FILTER NOT EXISTS ${conflict}` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?revP ?revO } }`,
    receiptFields: `rv:operation ${iri(operation)} ; rv:component ${iri(occurrence)} ; rv:revision ${iri(revision)} ;
      ${current ? `rv:expectedHead ${iri(current.head)} ;` : ''}`,
  });
  const committed = await readSemanticTerminal(env, receipt);
  if (committed) return checkedResult(committed, intent, committed.revision !== revision);
  if (current) {
    const now = await readCurrentOccurrence(env, occurrence).catch(() => null);
    if (now && now.head !== intent.expectedHead) return sealStale(env, intent, receipt, digest, occurrence);
  }
  if (active) {
    const retired = await sealSemanticRejection(env, receipt, digest, intent.admission, 'retired-definition',
      `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(definition.definition)} rv:definitionHead ${iri(definition.revision)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(definition.revision)} rv:lifecycle rv:Active } }`);
    if (retired) return checkedResult(retired, intent, false);
  }
  if (resources.length) {
    const missing = await sealSemanticRejection(env, receipt, digest, intent.admission, 'unavailable-reference',
      `FILTER (${resources.map(ref => `NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(ref)} a ?t } }`).join(' || ')})`);
    if (missing) return checkedResult(missing, intent, false);
  }
  if (conflict) {
    const refused = await sealSemanticRejection(env, receipt, digest, intent.admission, 'star-violation',
      `FILTER EXISTS ${conflict}`);
    if (refused) return checkedResult(refused, intent, false);
  }
  throw new PendingActivation('relation change guard did not match');
}

async function sealStale(env: WorkActivationEnvironment, intent: RelationChangeIntent, receipt: string,
  digest: string, occurrence: string): Promise<RelationChangeResult> {
  const terminal = await sealSemanticRejection(env, receipt, digest, intent.admission, 'stale-head',
    `GRAPH ${iri(GRAPHS.current)} { ${iri(occurrence)} rv:occurrenceHead ?currentHead }
     FILTER(?currentHead != ${iri(intent.expectedHead!)})`);
  if (!terminal) throw new PendingActivation('stale relation outcome is not sealed');
  return checkedResult(terminal, intent, false);
}

function checkedResult(terminal: SemanticTerminal, intent: RelationChangeIntent, replayed: boolean): RelationChangeResult {
  const checked = checkedSemanticTerminal(terminal, intent.admission, intent.admission.requestDigest);
  if ((intent.occurrence !== undefined && checked.component !== intent.occurrence)
    || (checked.expectedHead ?? null) !== intent.expectedHead) {
    throw new IdempotencyConflict('relation receipt targets another intent');
  }
  return { occurrence: checked.component!, revision: checked.revision!, predecessor: checked.expectedHead ?? null,
    receipt: checked.receipt, dataEpoch: checked.dataEpoch, sequence: checked.sequence, replayed };
}

export async function readRelationChangeTerminal(env: WorkActivationEnvironment, admissionId: string) {
  return readSemanticTerminal(env, familyReceiptIri(admissionId, RELATION_CHANGE_FAMILY));
}

/** Exact occurrence revision: its retained participations and pinned DefinitionRef. */
export async function readExactOccurrence(env: WorkActivationEnvironment, occurrence: string, revision: string) {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?predecessor ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RelationOccurrenceRevision ; rv:component ${iri(occurrence)} ;
      rv:manifest ?manifest ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor } } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const state = checkedOccurrenceState(await readComponent(env, row.manifest!.value, occurrence, PROFILES.relation));
  return { revision, occurrence, predecessor: row.predecessor?.value ?? null, state,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
}
