import { GRAPHS, ID, IdempotencyConflict, PendingActivation, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import type { EditorRecording } from '../lexicon/editor-recording.ts';
import { KEY_NOTATION } from '../lexicon/definition-key.ts';
import { assertSemanticDispatchable, checkedSemanticTerminal, ensureModelGeneration, familyReceiptIri,
  readComponent, readSemanticTerminal, SemanticChangeRejected, SemanticTargetUnavailable, sealComponentState,
  sealSemanticRejection, sendSemanticWrite, StaleSemanticHead, validationsFor, type SemanticAdmission,
  type SemanticTerminal } from '../semantic/command.ts';
import { ModelGenerationChanged } from '../semantic/generation-guard.ts';
import { checkedStoredState, term, type RelationRole, type RelationStar } from '../semantic/change.ts';
import { checkedNativeIri, MODEL_COMPONENT, PROFILES, type Lifecycle } from '../semantic/schema.ts';
import { semanticValueRdf } from '../semantic/value.ts';
import { checkedApplicability, checkedParticipations, checkedRevealedAt, InvalidRelationOccurrence,
  RELATION_LIMITS, RELATION_TERMS, type Participation, type RelationRoleDefinition,
  type RevealedAt } from './schema.ts';
import { RevelationConflict, type ReadingPositionStore } from '../reading-position/store.ts';
import { targetRead, targetSummaries } from '../target/resolve.ts';
import { systemDisclosure, undisclosedReferences, type ReferenceDisclosure } from '../target/disclosed-references.ts';
import { normalizeStatementSubject, StatementApplicabilityRefused } from '../statement/projection.ts';
import { readingWorkScope } from '../reading-position/work-scope.ts';

export const RELATION_CHANGE_FAMILY = 'relation-change';

export interface RelationInput {
  /** Exact relation DefinitionRef: a `semantic-definition-v1` revision. */
  definition: string;
  participations: { role: string; participant: unknown; position?: number;
    creditedName?: { lexical: string; language: string } }[];
  applicability?: string[];
  lifecycle?: Lifecycle;
  evidence?: string;
  /** Where in a Work's reading order the occurrence is first revealed; absent keeps it always visible. */
  revealedAt?: RevealedAt;
}

export interface RelationChangeIntent {
  admission: SemanticAdmission;
  occurrence?: string;
  expectedHead: string | null;
  input: RelationInput;
  /** Server-only validation and successful-receipt publication hook. */
  beforeCommit?: RelationPublication;
  /** The caller's read authority; a star refusal names only links this reader may see. */
  canRead?: (resource: string) => Promise<boolean>;
}

/** Validate and register publication before the graph write, then settle it: `complete` on a successful
 * receipt, `abandon` on a sealed refusal. An interrupted write settles on replay of the same admission. */
export interface RelationPublication {
  (component: string, receipt: string): Promise<void>;
  complete?: (component: string, receipt: string) => Promise<void>;
  abandon?: (receipt: string) => Promise<void>;
  guard?: string;
}

/** Stored occurrence revision state; participation and value node identities are exact. */
export interface OccurrenceState {
  definition: string;
  lifecycle: Lifecycle;
  applicability: string[];
  evidence?: string;
  participations: (Participation & { iri: string; node?: string })[];
}

/** Canonical command state: the stored occurrence plus the revelation it publishes beside the graph write. */
export type CanonicalRelation = OccurrenceState & { revealedAt?: RevealedAt };

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
  disclose: ReferenceDisclosure, canRead?: (definition: string) => Promise<boolean>): Promise<ExactDefinition | null> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new SemanticChangeRejected('invalid', 'invalid definition key');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?definition ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?key a rv:DefinitionKey ; rv:keyDefinition ?definition ;
      <${KEY_NOTATION}> ${lit(key)} . ?definition a rv:SemanticDefinition ; rv:definitionHead ?head }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RevisionCorrupt('definition key is ambiguous');
  if (canRead && !await canRead(rows[0]!.definition!.value)) return null;
  const definition = await readExactDefinition(env, rows[0]!.head!.value, disclose, canRead);
  if (!definition || definition.notation !== key) throw new RevisionCorrupt('definition key differs from retained state');
  return definition;
}

/** Resolve an exact relation DefinitionRef from its immutable revision, never the current head. The definition is a
 * semantic Resource: `canRead` gates it before its bytes load. `disclose` decides each role member, which may be a
 * Concept the semantic reader alone would hide. */
export async function readExactDefinition(env: WorkActivationEnvironment, revision: string,
  disclose: ReferenceDisclosure, canRead?: (definition: string) => Promise<boolean>): Promise<ExactDefinition | null> {
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
  // Role members are typed coordinates: one disclosure decision for all roles, never one per member.
  const readableMembers = await disclose(state.roles.flatMap(role => role.members ?? []));
  const roles = state.roles.map((role: RelationRole) => ({ role: roleIri(definition, role.key),
    minParticipants: role.minParticipants, maxParticipants: role.maxParticipants, ordered: role.ordered,
    ...(role.members ? { members: role.members.filter(ref => readableMembers.has(ref)) } : {}) }));
  return { revision, definition, lifecycle: state.lifecycle, ...(state.editorRecordable === undefined ? {} : { editorRecordable: state.editorRecordable }),
    ...(state.writePath === undefined ? {} : { writePath: state.writePath }),
    ...(state.notation ? { notation: state.notation } : {}),
    ...(state.workSubjectRole ? { workSubjectRole: state.workSubjectRole } : {}),
    ...(state.star ? { star: state.star } : {}),
    roles,
    roleKeys: Object.fromEntries(state.roles.map(role => [roleIri(definition, role.key), role.key])) };
}

export function canonicalRelation(definition: ExactDefinition, input: RelationInput): CanonicalRelation {
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
    return { ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.revealedAt === undefined ? {} : { revealedAt: checkedRevealedAt(input.revealedAt) }),
      definition: definition.revision, lifecycle: input.lifecycle ?? 'active',
      applicability: checkedApplicability(input.applicability ?? []),
      participations: participations.sort((a, b) => key(a).localeCompare(key(b))).map(item => ({ ...item, iri: '' })) };
  } catch (error) {
    if (error instanceof InvalidRelationOccurrence) throw new SemanticChangeRejected('invalid', error.message);
    throw error;
  }
}

export class ProjectionParticipantRefused extends SemanticChangeRejected {
  readonly problemCode = 'projection_participant_refused';
  constructor() { super('reserved-owner', 'A Projection is not an identity; name its subject as the participant and put its frames in applicability'); }
}

export const PARTICIPANT_IDENTITY_COST = { queries: 1, participants: 64, projectionSummaryBatch: 64 } as const;

/** Projections identify scoped judgments, never relation participants. Admission
 * checks this before the ordinary reference reader, which has no Projection owner.
 * Hidden projections retain the same unavailable-reference outcome as missing IDs. */
export async function assertIdentityParticipants(env: WorkActivationEnvironment, participations: readonly Participation[],
  authority?: Parameters<typeof targetRead>[1]) {
  const participants = [...new Set(participations.flatMap(item =>
    item.participant.kind === 'resource' ? [item.participant.ref] : []))];
  if (!participants.length) return;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?participant WHERE {
    VALUES ?participant { ${participants.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?participant a rv:Projection }
  } LIMIT ${PARTICIPANT_IDENTITY_COST.participants}`)).results?.bindings ?? [];
  if (!rows.length) return;
  if (authority) {
    const batch = await targetRead(env, authority, session => targetSummaries(session, rows.map(row => row.participant!.value)));
    if (batch.summaries.some(summary => summary.status !== 'available')) {
      throw new SemanticChangeRejected('unavailable-reference', 'a referenced resource is unavailable');
    }
  }
  throw new ProjectionParticipantRefused();
}

/** Preflight disclosure precedes admission. Visible owner references reach dispatch for a sealed refusal;
 * hidden references keep the same pre-admission outcome as missing ones. */
export async function relationReferences(env: WorkActivationEnvironment, definition: ExactDefinition,
  state: CanonicalRelation, authority: Parameters<typeof targetRead>[1]): Promise<string[]> {
  const participants = [...new Set(state.participations.flatMap(item =>
    item.participant.kind === 'resource' ? [item.participant.ref] : []))];
  const projections = new Set<string>();
  try { await assertIdentityParticipants(env, state.participations, authority); }
  catch (error) {
    if (!(error instanceof ProjectionParticipantRefused)) throw error;
    const batch = await targetRead(env, authority, session => targetSummaries(session, participants));
    for (const summary of batch.summaries) if (summary.status === 'available' && summary.type === 'projection') {
      projections.add(summary.reference);
    }
  }
  // Participants, role members and applicability name typed coordinates (Structure positions, releases, Concepts),
  // not only semantic Resources or Works: the target reader discloses them, the semantic and Work readers decide the rest.
  const members = definition.roles.flatMap(role => role.members ?? []);
  const undisclosed = await undisclosedReferences(env, authority,
    [...participants.filter(ref => !projections.has(ref)), ...members, ...state.applicability]);
  return [...new Set([definition.definition, ...undisclosed, ...(state.revealedAt ? [state.revealedAt.work] : [])])];
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
}

/**
 * Observed star conflict for a new active occurrence: another active occurrence of the same definition in
 * which a leaf already holds the leaf or hub role, or a hub already holds the leaf role. Retired occurrences
 * hold nothing. The same pattern guards the write and, restated, seals the typed refusal. It starts from the
 * participations of the written participants, so its graph work follows their own history, never the number
 * of occurrences in the graph.
 */
export function starConflict(definition: ExactDefinition, occurrence: string, state: OccurrenceState): string {
  const roles = starRoles(definition);
  const refs = (role: string) => state.participations.flatMap(item =>
    item.role === role && item.participant.kind === 'resource' ? [item.participant.ref] : []);
  const pairs = [...refs(roles.leaf).flatMap(ref => [[roles.leaf, ref], [roles.hub, ref]]),
    ...refs(roles.hub).map(ref => [roles.leaf, ref])];
  if (!pairs.length) return '';
  // One branch per written (role, participant): the participant leads each branch because it is the selective
  // term; a role alone matches every occurrence of the definition.
  return `{ ${pairs.map(([role, ref]) => `{ GRAPH ${iri(GRAPHS.revisions)} {
      ?otherParticipation rv:participant ${iri(ref!)} ; rv:role ${iri(role!)} ; rv:occurrence ?other } }`).join(' UNION ')}
    GRAPH ${iri(GRAPHS.revisions)} { ?otherHead rv:participation ?otherParticipation ; rv:lifecycle rv:Active ;
        rv:relationDefinition ?otherDefinition .
      ?otherDefinition rv:component ${iri(definition.definition)} }
    GRAPH ${iri(GRAPHS.current)} { ?other rv:occurrenceHead ?otherHead }
    FILTER(?other != ${iri(occurrence)}) }`;
}

export const RELATION_REFERENCE_COST = { applicability: 8, coordinateQueries: 2, coordinateSummaryReads: 1, roleMembers: 16 * 8,
  revelationQueries: 1, starConflictQueries: 1 } as const;

export const STAR_REFUSAL_COST = { conflicts: 32 } as const;
/** Refuse indistinctly if any conflicting occurrence or participant is hidden. An overflow is also
 * undisclosed; it cannot make a hidden conflict visible through a sampled public one. */
async function visibleStarConflict(env: WorkActivationEnvironment, conflict: string,
  canRead: (resource: string) => Promise<boolean>): Promise<boolean> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?other WHERE ${conflict}
    LIMIT ${STAR_REFUSAL_COST.conflicts + 1}`)).results?.bindings ?? [];
  if (!rows.length || rows.length > STAR_REFUSAL_COST.conflicts) return false;
  for (const row of rows) {
    if (!await canRead(row.other!.value)) return false;
    const current = await readCurrentOccurrence(env, row.other!.value);
    if (!current) return false;
    for (const ref of [...current.state.applicability, ...current.state.participations.flatMap(item =>
      item.participant.kind === 'resource' ? [item.participant.ref] : [])]) {
      if (!await canRead(ref)) return false;
    }
  }
  return true;
}

export function relationChangeDigest(occurrence: string | undefined, expectedHead: string | null,
  state: CanonicalRelation): string {
  return hash(JSON.stringify({ family: 'relation-change-v1', occurrence: occurrence ?? null, expectedHead,
    ...(state.evidence === undefined ? {} : { evidence: state.evidence }),
    ...(state.revealedAt ? { revealedAt: state.revealedAt } : {}), definition: state.definition, lifecycle: state.lifecycle, applicability: state.applicability,
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
  try { return await writeRelationOccurrence(env, intent); }
  catch (error) {
    // A sealed refusal is final, so its registration goes; an unknown outcome keeps it, failing closed.
    if (error instanceof SemanticChangeRejected || error instanceof StaleSemanticHead
      || error instanceof ModelGenerationChanged) {
      await intent.beforeCommit?.abandon?.(familyReceiptIri(intent.admission.id, RELATION_CHANGE_FAMILY));
    }
    throw error;
  }
}

async function writeRelationOccurrence(env: WorkActivationEnvironment,
  intent: RelationChangeIntent): Promise<RelationChangeResult> {
  if (intent.occurrence !== undefined) checkedNativeIri(intent.occurrence);
  if ((intent.occurrence === undefined) !== (intent.expectedHead === null)) {
    throw new SemanticChangeRejected('invalid', 'a create has no head; an edit names one');
  }
  // System reader: the writer validates participants against the full member list; `undisclosedReferences` decides what the caller may name.
  const definition = await readExactDefinition(env, checkedNativeIri(intent.input.definition), systemDisclosure);
  if (!definition) throw new SemanticChangeRejected('unavailable-reference', 'relation definition is unavailable');
  const state = canonicalRelation(definition, intent.input);
  const digest = relationChangeDigest(intent.occurrence, intent.expectedHead, state);
  const receipt = familyReceiptIri(intent.admission.id, RELATION_CHANGE_FAMILY);
  const existing = await assertSemanticDispatchable(env, intent.admission, receipt, digest);
  if (existing) {
    const result = checkedResult(existing, intent, true);
    await intent.beforeCommit?.complete?.(result.occurrence, result.receipt);
    return result;
  }
  try { await assertIdentityParticipants(env, state.participations); }
  catch (error) {
    if (!(error instanceof ProjectionParticipantRefused)) throw error;
    const refused = await sealSemanticRejection(env, receipt, digest, intent.admission, 'reserved-owner',
      `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
        VALUES ?participant { ${state.participations.flatMap(item => item.participant.kind === 'resource'
          ? [iri(item.participant.ref)] : []).join(' ')} } ?participant a rv:Projection } }`);
    if (refused) return checkedResult(refused, intent, false);
    throw new PendingActivation('participant owner refusal is not sealed');
  }
  try { await normalizeStatementSubject(env, { subject: definition.definition, applicability: state.applicability }); }
  catch (error) {
    if (error instanceof StatementApplicabilityRefused) throw new SemanticChangeRejected('invalid', 'Relation applicability must name typed coordinates');
    throw error;
  }
  if (definition.star) {
    const roles = starRoles(definition);
    const hubs = new Set(state.participations.filter(item => item.role === roles.hub).map(item => JSON.stringify(item.participant)));
    if (state.participations.some(item => item.role === roles.leaf && hubs.has(JSON.stringify(item.participant)))) {
      const refused = await sealSemanticRejection(env, receipt, digest, intent.admission, 'star-violation', 'FILTER(true)');
      if (refused) return checkedResult(refused, intent, false);
      throw new PendingActivation('star refusal is not sealed');
    }
  }
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
  const { revealedAt: _revealedAt, ...retained } = state;
  const exact: OccurrenceState = { ...retained, participations: participations.map(({ object: _object, ...item }) => item) };
  const manifest = await sealComponentState(env, occurrence, PROFILES.relation, exact);
  const revision = `${ID}${Bun.randomUUIDv7()}`;
  const operation = `${ID}${Bun.randomUUIDv7()}`;
  const old = current ? occurrenceTriples(current.state, current.head) : [];
  const next = occurrenceTriples(exact, revision);
  const resources = [...new Set([...state.participations.flatMap(item =>
    item.participant.kind === 'resource' ? [item.participant.ref] : []), ...state.applicability,
    ...definition.roles.flatMap(role => role.members ?? [])])];
  const active = state.lifecycle === 'active';
  const conflict = active && definition.star ? starConflict(definition, occurrence, exact) : '';
  const validations = [
    ...await validationsFor(env, 'relation-occurrence-v1', [{ role: 'occurrence', focus: [occurrence] },
      { role: 'revision', focus: [revision] },
      { role: 'participation', focus: participations.map(item => item.iri) }]),
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
          rv:role ${iri(item.role)} ; rv:participant ${item.object}
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
      ${resources.map(ref => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(ref)} a rv:Projection } }`).join('\n')}
      ${conflict ? `FILTER NOT EXISTS ${conflict}` : ''}
      ${intent.beforeCommit?.guard ? `FILTER EXISTS ${intent.beforeCommit.guard}` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?revP ?revO } }`,
    receiptFields: `rv:operation ${iri(operation)} ; rv:component ${iri(occurrence)} ; rv:revision ${iri(revision)} ;
      ${state.revealedAt ? `rv:revelationWork ${iri(state.revealedAt.work)} ; rv:revelationOccurrence ${iri(state.revealedAt.occurrence)} ;` : ''}
      ${current ? `rv:expectedHead ${iri(current.head)} ;` : ''}`,
  });
  const committed = await readSemanticTerminal(env, receipt);
  if (committed) {
    const result = checkedResult(committed, intent, committed.revision !== revision);
    await intent.beforeCommit?.complete?.(result.occurrence, result.receipt);
    return result;
  }
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
    const visible = intent.canRead ? await visibleStarConflict(env, conflict, intent.canRead) : false;
    const refused = await sealSemanticRejection(env, receipt, digest, intent.admission,
      visible ? 'star-violation' : 'unavailable-reference', `FILTER EXISTS ${conflict}`);
    if (refused) return checkedResult(refused, intent, false);
  }
  if (intent.beforeCommit?.guard) {
    const refused = await sealSemanticRejection(env, receipt, digest, intent.admission, 'unavailable-reference',
      `FILTER NOT EXISTS ${intent.beforeCommit.guard}`);
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

/**
 * Check the selected composition and register the occurrence as pending before dispatch: readers treat a pending
 * record as position-required, so the graph write never exposes it unguarded and costs reads no graph query.
 * An accepted receipt publishes the position and settles the registration; a refused one abandons it. A crash
 * in between leaves the registration, which stays hidden until a replay of the same admission settles it.
 * An existing position never moves.
 */
export function relationRevelation(env: WorkActivationEnvironment,
  store: Pick<ReadingPositionStore, 'publish' | 'register' | 'abandon'> | undefined,
  revealedAt: RevealedAt): RelationPublication {
  const row = (component: string, receipt: string) => ({ record: component, recordKind: 'relation' as const,
    continuityWork: revealedAt.work, occurrence: revealedAt.occurrence, receipt });
  const guard = `{
      GRAPH ${iri(GRAPHS.current)} { ${iri(revealedAt.work)} a <https://schema.org/CreativeWork> .
        { ${readingWorkScope(revealedAt.work)} }
        ?work rv:mainVersion ?main . ?structure a rv:Structure ; rv:structureOf ?main ;
          rv:structureProfile ?profile ; rv:selectedGeneration ?generation .
        FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
        ?generation rv:generationState rv:Active .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ${iri(revealedAt.occurrence)} .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed } } }`;
  const prepare: RelationPublication = async (component, receipt) => {
    if (!store) throw new SemanticChangeRejected('unsupported', 'revelation positions are unavailable');
    const placed = await env.fuseki.query(`PREFIX rv: <${RV}> ASK ${guard}`);
    if (placed.boolean !== true) throw new SemanticChangeRejected('unavailable-reference', 'a referenced resource is unavailable');
    try {
      await store.register(row(component, receipt));
    } catch (error) {
      if (error instanceof RevelationConflict) {
        throw new SemanticChangeRejected('invalid', 'the occurrence already has a revelation position');
      }
      throw error;
    }
  };
  prepare.guard = guard;
  prepare.complete = async (component, receipt) => {
    if (!store) throw new SemanticChangeRejected('unsupported', 'revelation positions are unavailable');
    await store.publish(row(component, receipt));
  };
  prepare.abandon = async receipt => { await store?.abandon(receipt); };
  return prepare;
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
