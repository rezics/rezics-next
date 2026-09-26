import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, IdempotencyConflict, PendingActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { InvalidStructureObject, STRUCTURE_LIMITS, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT,
  STRUCTURE_SEAL_FORMAT, checkOccurrenceRecord, checkStructureManifest, checkStructureSealManifest,
  type OccurrenceRecord,
  type OccurrenceRole, type OrderEntry, type PinEntry, type StructureManifest,
  type StructureProfile } from './format.ts';
import { COMPOSITION_PROFILE, CompositionCorrupt, CompositionUnavailable, NATIVE_ID, ROLE_IRI,
  derivedId, orderTreeKey, placementIri, placementRecord, readCompositionHeader,
  readPlacements, readPublishedVariants, readSegments, recordTreeKey, structureIri,
  type CompositionHeader, type Label, type PlacementState, type SegmentState, type Selection }
  from './graph.ts';
import { isCatalogTarget, structureProfileFor, structureProfileForAction,
  type StructureProfileRegistration } from './profiles.ts';
import { evenKeys, keyBetween, withinBudget } from './order-key.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, StructureTree, newCost,
  type TreeCost } from './tree.ts';

export const MAX_OPERATIONS = 16;
/** A seal reads the whole revision; larger compositions need a staged seal job. */
export const SEAL_PLACEMENT_LIMIT = 4096;
const PROFILE_ID = 'structure-composition-v1';
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export class InvalidCompositionChange extends Error {}
export class StaleCompositionHead extends Error {}
export class CompositionConflict extends Error {}
export class CompositionExists extends Error {}
export class CompositionTooLarge extends Error {}
export class CompositionCancelled extends Error {}

export type Position = 'first' | 'last' | { after: string };
export type CompositionOperation =
  | { op: 'insert'; parent: string; position: Position; role: OccurrenceRole; target?: string;
    selection?: Selection; label?: Label; sourceKey?: string;
    qualifier?: OccurrenceRecord['qualifier'] }
  | { op: 'move'; occurrence: string; parent: string; position: Position }
  | { op: 'remove'; occurrence: string };

/** Measured local work of one change; rebalanced counts rewritten sibling keys. */
export interface CompositionCost extends TreeCost {
  placementsWritten: number;
  segmentsWritten: number;
  rebalanced: number;
}

export interface CompositionTerminal {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head' | 'topology-conflict' | 'composition-exists' | 'too-large' | 'invalid-profile';
  action?: string;
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  structure?: string;
  mainVersion?: string;
  revision?: string;
  expectedHead?: string;
  seal?: string;
  owner?: string;
  component?: string;
}

type Admission = Pick<RegisteredAdmission, 'id' | 'scope' | 'action' | 'requestDigest'
  | 'authorityEpoch' | 'expiresAt'>;

export function structureObjects(env: WorkActivationEnvironment): ImmutableObjects {
  const objects = (env as WorkActivationEnvironment & { structureObjects?: ImmutableObjects }).structureObjects;
  if (!objects) throw new ObjectUnavailable('Structure immutable object store is unavailable');
  return objects;
}

function native(value: unknown, name: string): string {
  if (typeof value !== 'string' || !NATIVE_ID.test(value)) {
    throw new InvalidCompositionChange(`${name} is not a native identity`);
  }
  return value;
}

function checkedPosition(position: unknown): Position {
  if (position === 'first' || position === 'last') return position;
  if (position && typeof position === 'object' && Object.keys(position).length === 1) {
    return { after: native((position as { after?: unknown }).after, 'position.after') };
  }
  throw new InvalidCompositionChange('position is invalid');
}

/** Canonical, bounded operation list; every change in one request has the same kind. */
export function checkedOperations(operations: readonly CompositionOperation[],
  profile?: StructureProfile | StructureProfileRegistration): CompositionOperation[] {
  const registration = typeof profile === 'string' ? structureProfileFor(profile) : profile;
  if (!operations.length || operations.length > MAX_OPERATIONS
    || new Set(operations.map(operation => operation.op)).size !== 1) {
    throw new InvalidCompositionChange('a change carries 1-16 operations of one kind');
  }
  return operations.map(operation => {
    if (operation.op === 'remove') return { op: 'remove', occurrence: native(operation.occurrence, 'occurrence') };
    if (operation.op === 'move') {
      return { op: 'move', occurrence: native(operation.occurrence, 'occurrence'),
        parent: native(operation.parent, 'parent'), position: checkedPosition(operation.position) };
    }
    if (operation.op !== 'insert' || !(operation.role in ROLE_IRI)
      || registration && !registration.roles.includes(operation.role)) {
      throw new InvalidCompositionChange('operation role is not admitted by this Structure profile');
    }
    const target = operation.target === undefined ? undefined
      : registration && isCatalogTarget(registration, operation.target)
        ? operation.target : native(operation.target, 'target');
    if (registration && (registration.targetRoles.includes(operation.role) && target === undefined
      || target !== undefined && !registration.targetRoles.includes(operation.role)
        && !registration.optionalTargetRoles?.includes(operation.role))) {
      throw new InvalidCompositionChange('operation target cardinality differs from its Structure profile');
    }
    let selection: Selection | undefined;
    const catalogTarget = target !== undefined && registration
      && isCatalogTarget(registration, target);
    const needsSelection = Boolean(target) && !catalogTarget && (!registration
      || (registration.selectionRequiredRoles ?? registration.targetRoles).includes(operation.role));
    if (target && !needsSelection && operation.selection !== undefined) {
      throw new InvalidCompositionChange('this Structure target role has no content selection');
    }
    if (target && needsSelection) {
      const requested = operation.selection ?? { mode: 'follow-context' };
      if (requested.mode === 'fixed-revision') {
        if (!/^urn:rezics:content:revision:[0-9a-f-]{36}$/.test(requested.revision)) {
          throw new InvalidCompositionChange('a fixed chapter pins an exact Content revision');
        }
        selection = { mode: 'fixed-revision', revision: requested.revision };
      } else if (requested.mode === 'follow-context') selection = { mode: 'follow-context' };
      else throw new InvalidCompositionChange('selection mode is not admitted');
    } else if (!target && operation.selection !== undefined) {
      throw new InvalidCompositionChange('a group has no selection');
    }
    const label = operation.label;
    if (label !== undefined && (typeof label.value !== 'string' || !label.value.length
      || label.value.length > STRUCTURE_LIMITS.labelChars || /[\u0000-\u001f\u007f]/u.test(label.value)
      || !LANGUAGE.test(label.language))) {
      throw new InvalidCompositionChange('occurrence label is invalid');
    }
    if (operation.sourceKey !== undefined && (!operation.sourceKey.length || operation.sourceKey.length > 200
      || /[\u0000-\u001f\u007f]/u.test(operation.sourceKey))) {
      throw new InvalidCompositionChange('source key is invalid');
    }
    return { op: 'insert', parent: native(operation.parent, 'parent'),
      position: checkedPosition(operation.position), role: operation.role,
      ...(target ? { target, ...(selection ? { selection } : {}) } : {}),
      ...(label ? { label: { value: label.value, language: label.language } } : {}),
      ...(operation.sourceKey ? { sourceKey: operation.sourceKey } : {}),
      ...(operation.qualifier ? { qualifier: operation.qualifier } : {}) };
  });
}

export function compositionCreateDigest(mainVersion: string, profile: StructureProfile = 'book-composition'): string {
  structureProfileFor(profile);
  return hash(JSON.stringify({ family: 'composition-create-v1', profile,
    mainVersion: native(mainVersion, 'mainVersion') }));
}

export function structureCreateDigest(owner: string, component: string,
  profile: StructureProfile): string {
  const registration = structureProfileFor(profile);
  const identity = registration.componentPredicate
    ? native(component, 'component') : native(owner, 'owner');
  native(owner, 'owner');
  return profile === 'book-composition'
    ? compositionCreateDigest(identity, profile)
    : hash(JSON.stringify({ family: 'structure-create-v1', profile, owner, component: identity }));
}

export function compositionChangeDigest(structure: string, expectedHead: string,
  operations: readonly CompositionOperation[], profile: StructureProfile = 'book-composition'): string {
  return hash(JSON.stringify({ family: 'composition-change-v1', structure: native(structure, 'composition'),
    expectedHead: native(expectedHead, 'expectedHead'), operations: checkedOperations(operations, profile) }));
}

export function compositionSealDigest(structure: string, expectedHead: string): string {
  return hash(JSON.stringify({ family: 'composition-seal-v1', structure: native(structure, 'composition'),
    expectedHead: native(expectedHead, 'expectedHead') }));
}

export function compositionRestoreDigest(structure: string, expectedHead: string,
  restoredFrom: string): string {
  return hash(JSON.stringify({ family: 'composition-restore-v1',
    structure: native(structure, 'composition'), expectedHead: native(expectedHead, 'expectedHead'),
    restoredFrom: native(restoredFrom, 'restoredFrom') }));
}

export function compositionStageDigest(structure: string, expectedHead: string,
  stageId: string, manifestDigest: string): string {
  if (!/^[0-9a-f-]{36}$/.test(stageId) || !/^[0-9a-f]{64}$/.test(manifestDigest)) {
    throw new InvalidCompositionChange('staged Structure identity is invalid');
  }
  return hash(JSON.stringify({ family: 'composition-stage-activate-v1',
    structure: native(structure, 'composition'), expectedHead: native(expectedHead, 'expectedHead'),
    stageId, manifestDigest }));
}

/** Structure owner actions select their registered Access receipt family. */
export function compositionReceiptIri(admissionId: string, action = 'work.edit'): string {
  const profile = structureProfileForAction(action);
  return `urn:rezics:receipt:${hash(`${admissionId}\0${profile.receiptFamily}`)}`;
}

const REASONS: Record<string, CompositionTerminal['reason']> = {
  [`${RV}StaleHead`]: 'stale-head', [`${RV}TopologyConflict`]: 'topology-conflict',
  [`${RV}CompositionExists`]: 'composition-exists', [`${RV}CompositionTooLarge`]: 'too-large',
};

export async function readCompositionReceipt(env: WorkActivationEnvironment,
  admissionId: string, action = 'work.edit'): Promise<CompositionTerminal | null> {
  const receipt = compositionReceiptIri(admissionId, action);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?reason ?kind ?action ?digest ?admission ?epoch ?scope ?dataEpoch ?sequence
      ?structure ?main ?owner ?component ?revision ?expected ?seal WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:admissionId ?admission ;
        rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:rejectionKind ?kind }
      OPTIONAL { ${iri(receipt)} rv:action ?action }
      OPTIONAL { ${iri(receipt)} rv:structure ?structure }
      OPTIONAL { ${iri(receipt)} rv:mainVersion ?main }
      OPTIONAL { ${iri(receipt)} rv:structureOwner ?owner }
      OPTIONAL { ${iri(receipt)} rv:structureComponent ?component }
      OPTIONAL { ${iri(receipt)} rv:structureRevision ?revision }
      OPTIONAL { ${iri(receipt)} rv:expectedHead ?expected }
      OPTIONAL { ${iri(receipt)} rv:structureSeal ?seal }
    } }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new CompositionCorrupt('composition receipt cardinality violation');
  const row = rows[0]!;
  const get = (key: string) => row[key]?.value;
  const outcome = get('outcome') === `${RV}Succeeded` ? 'succeeded'
    : get('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome || !/^[0-9]+$/.test(get('sequence') ?? '')) throw new CompositionCorrupt('composition receipt is incomplete');
  const reason = get('kind') === `${RV}InvalidProfile` ? 'invalid-profile' : REASONS[get('reason') ?? ''];
  if (get('reason') && !reason) throw new CompositionCorrupt('composition receipt reason is unknown');
  return { outcome, ...(reason ? { reason } : {}), ...(get('action') ? { action: get('action') } : {}),
    receipt, admissionId: get('admission')!, requestDigest: get('digest')!, authorityEpoch: get('epoch')!,
    scope: get('scope')!, dataEpoch: get('dataEpoch')!, sequence: get('sequence')!,
    ...(get('structure') ? { structure: get('structure') } : {}),
    ...(get('main') ? { mainVersion: get('main') } : {}),
    ...((get('owner') ?? get('work')) ? { owner: get('owner') ?? get('work') } : {}),
    ...((get('component') ?? get('main')) ? { component: get('component') ?? get('main') } : {}),
    ...(get('revision') ? { revision: get('revision') } : {}),
    ...(get('expected') ? { expectedHead: get('expected') } : {}),
    ...(get('seal') ? { seal: get('seal') } : {}) };
}

/** Resolve a denied non-Book Structure admission with the same owner receipt family. */
export async function sealStructureAdmissionCancellation(env: WorkActivationEnvironment,
  admission: Admission): Promise<CompositionTerminal> {
  const receipt = compositionReceiptIri(admission.id, admission.action);
  const prior = await readCompositionReceipt(env, admission.id, admission.action);
  if (prior) return prior;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, admission, receipt, 'Cancelled',
        `rv:action ${lit(admission.action)} ;`)} }
      GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt)} }
    }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    update, validations: [], deadlineMs: 10_000 }); }
  catch { /* the graph receipt is authoritative after an ambiguous response */ }
  const terminal = await readCompositionReceipt(env, admission.id, admission.action);
  if (!terminal) throw new PendingActivation('Structure cancellation outcome is unknown');
  return terminal;
}

/** Terminal typed outcomes carry their exact error; a success is returned unchanged. */
export function terminalResult(terminal: CompositionTerminal, admission: Pick<Admission, 'id'
  | 'requestDigest' | 'authorityEpoch' | 'scope'>): CompositionTerminal {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== admission.requestDigest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new IdempotencyConflict('composition receipt differs from admission');
  }
  if (terminal.outcome === 'succeeded') return terminal;
  switch (terminal.reason) {
    case 'stale-head': throw new StaleCompositionHead('expected composition head is stale');
    case 'topology-conflict': throw new CompositionConflict('composition change conflicts with its topology');
    case 'composition-exists': throw new CompositionExists('Main Version already has a composition');
    case 'too-large': throw new CompositionTooLarge('composition exceeds the bounded seal');
    case 'invalid-profile': throw new CommandRejected({ status: 'invalid' });
    default: throw new CompositionCancelled('composition command was cancelled');
  }
}

const controlGuard = (env: WorkActivationEnvironment) => `
  GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`;

function receiptTriples(env: WorkActivationEnvironment, admission: Admission, receipt: string,
  outcome: 'Succeeded' | 'Cancelled', fields: string): string {
  return `${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
    rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
    rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:${outcome} ; ${fields}
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`;
}

/** One ordered event makes the graph change visible to the shared relay. */
function outboxTriples(env: WorkActivationEnvironment, receipt: string): string {
  const event = `urn:rezics:event:${hash(`${receipt}\0structure`)}`;
  return `${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
    rv:event ${iri(event)} .
    ${iri(event)} a rv:StructureCommandEvent ; rv:ordinal 0 ; rv:action "structure.command" ;
    rv:receipt ${iri(receipt)} .`;
}

/** A typed terminal rejection decided against an exact guarded state. */
async function sealRejection(env: WorkActivationEnvironment, admission: Admission, action: string,
  reason: 'StaleHead' | 'TopologyConflict' | 'CompositionExists' | 'CompositionTooLarge',
  guard: string, stageCleanup?: { generation: string }): Promise<void> {
  const receipt = compositionReceiptIri(admission.id, admission.action);
  const cleanupDelete = stageCleanup
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(stageCleanup.generation)} rv:generationState rv:Staging . }` : '';
  const cleanupInsert = stageCleanup
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(stageCleanup.generation)} rv:generationState rv:Cancelled . }` : '';
  const cleanupGuard = stageCleanup
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(stageCleanup.generation)} rv:generationState rv:Staging . }` : '';
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${cleanupDelete} }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      ${cleanupInsert}
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, admission, receipt, 'Cancelled',
        `rv:action ${lit(action)} ; rv:reason rv:${reason} ;`)} }
      GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt)} }
    }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${guard}
      ${cleanupGuard}
      BIND(?n + 1 AS ?next) }`;
  try {
    await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, update,
      validations: stageCleanup ? await validations(env, [['generation', stageCleanup.generation]]) : [],
      deadlineMs: 10_000 });
  } catch { /* the receipt read decides after an ambiguous response */ }
}

async function dispatch(env: WorkActivationEnvironment, admission: Admission, update: string,
  validations: CommandValidation[]): Promise<boolean> {
  const receipt = compositionReceiptIri(admission.id, admission.action);
  try {
    const result = await validatedCommand(env, { receipt, digest: admission.requestDigest, update,
      validations, deadlineMs: 10_000 }, admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
    return result.status === 'committed';
  } catch (error) {
    if (error instanceof CommandRejected) throw error;
    return false;
  }
}

function checkAdmission(admission: Admission, digest: string, profile: StructureProfileRegistration): void {
  if (admission.action !== profile.editAction || digest !== admission.requestDigest
    || !/^[0-9a-f-]{36}$/.test(admission.id) || !/^[0-9]+$/.test(admission.authorityEpoch)) {
    throw new IdempotencyConflict('composition admission differs from intent');
  }
}

async function existing(env: WorkActivationEnvironment, admission: Admission): Promise<CompositionTerminal | null> {
  await assertNotInvalidProfileReceipt(env.fuseki,
    compositionReceiptIri(admission.id, admission.action));
  const terminal = await readCompositionReceipt(env, admission.id, admission.action);
  if (terminal) return terminalResult(terminal, admission);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('composition admission expired');
  return null;
}

async function settled(env: WorkActivationEnvironment, admission: Admission): Promise<CompositionTerminal> {
  const terminal = await readCompositionReceipt(env, admission.id, admission.action);
  if (!terminal) throw new PendingActivation('composition outcome is unknown');
  return terminalResult(terminal, admission);
}

function manifestIri(digest: string): string { return `urn:rezics:sha256:${digest}`; }

async function readManifest(objects: ImmutableObjects, header: CompositionHeader,
  cost: TreeCost): Promise<StructureManifest> {
  let bytes: Uint8Array;
  try { bytes = await objects.get(header.manifest.slice(-64)); }
  catch (error) {
    if (error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    throw error;
  }
  cost.pagesRead++;
  let manifest: StructureManifest;
  try { manifest = checkStructureManifest(bytes); }
  catch (error) {
    if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
    throw error;
  }
  if (manifest.structure !== header.structure || manifest.generation !== header.generation
    || manifest.structureOf !== header.component || manifest.profile !== header.profile) {
    throw new StructureObjectCorrupt('manifest does not belong to this composition head');
  }
  return manifest;
}

async function writeManifest(objects: ImmutableObjects, manifest: StructureManifest,
  cost: TreeCost): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  checkStructureManifest(bytes);
  cost.pagesWritten++;
  return objects.put(bytes);
}

export const recordTree = (objects: ImmutableObjects) =>
  new StructureTree<OccurrenceRecord>(objects, 'record', recordTreeKey);
export const orderTree = (objects: ImmutableObjects) =>
  new StructureTree<OrderEntry>(objects, 'order', orderTreeKey);
export const pinTree = (objects: ImmutableObjects) =>
  new StructureTree<PinEntry>(objects, 'pin', entry => `${entry.occurrence}\u0001${entry.variant ?? ''}`);

async function validations(env: WorkActivationEnvironment, entries: readonly [string, string][]) {
  const both = [GRAPHS.current, GRAPHS.revisions];
  return profileValidations(env.fuseki, PROFILE_ID, entries.map(([shape, focus]) => ({
    shape: `${COMPOSITION_PROFILE}/${shape}-shape`, focus: [focus], graphs: both })));
}

/** Include the owner when creation changes its current-graph Structure link. */
export async function structureCreationValidations(env: WorkActivationEnvironment,
  profile: StructureProfileRegistration, owner: string, structure: string,
  generation: string, revision: string): Promise<CommandValidation[]> {
  const common = await validations(env, [
    ['structure', structure], ['generation', generation], ['revision', revision]]);
  if (!profile.structurePredicate || !profile.ownerValidation) return common;
  return [...common, ...await profileValidations(env.fuseki, profile.ownerValidation.profile,
    [{ shape: profile.ownerValidation.shape, focus: [owner], graphs: [GRAPHS.current] }])];
}

async function projectStageBatch(env: WorkActivationEnvironment, admission: Admission,
  input: { stageId: string; structure: string; generation: string; expectedHead: string;
    previousGeneration: string; ordinal: number; generationTriples: string;
    projection: readonly string[]; revisionTriples: string; focus: readonly [string, string][] }): Promise<void> {
  const receipt = `urn:rezics:receipt:structure-projection:${hash(`${input.stageId}\0${input.ordinal}`)}`;
  const digest = hash(JSON.stringify({ family: 'structure-projection-batch-v1',
    stage: input.stageId, ordinal: input.ordinal, projection: input.projection }));
  const receiptTriples = `${iri(receipt)} a rv:OperationReceipt ;
    rv:commandFamily "structure-projection-batch" ; rv:requestDigest ${lit(digest)} ;
    rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
    rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
    rv:action "structure.project" ; rv:stageId ${lit(input.stageId)} ;
    rv:structure ${iri(input.structure)} ; rv:generation ${iri(input.generation)} ;
    rv:projectionBatch ${input.ordinal} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`;
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${input.generationTriples} ${input.projection.join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${input.revisionTriples} }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples} }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
        rv:event ${iri(event)} .
        ${iri(event)} a rv:StructureProjectionEvent ; rv:ordinal 0 ;
          rv:action \"structure.project\" ; rv:receipt ${iri(receipt)} ;
          rv:stageId ${lit(input.stageId)} ; rv:structure ${iri(input.structure)} ;
          rv:generation ${iri(input.generation)} ; rv:projectionBatch ${input.ordinal} . }
    }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.structure)} rv:structureHead ${iri(input.expectedHead)} ;
          rv:selectedGeneration ${iri(input.previousGeneration)} .
        ${iri(input.previousGeneration)} rv:generationState rv:Active . }
      ${input.ordinal === 0
        ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.generation)} ?p ?o } }`
        : `GRAPH ${iri(GRAPHS.current)} { ${iri(input.generation)} rv:structure ${iri(input.structure)} ;
            rv:generationState rv:Staging . }`}
      BIND(?n + 1 AS ?next) }`;
  const checks = await validations(env, input.focus);
  const result = await env.fuseki.commandWithReceipt({ receipt, digest, update,
    validations: checks, deadlineMs: 10_000 });
  if (result.status === 'invalid' || result.status === 'unknown-profile') {
    throw new CommandRejected(result);
  }
  if (result.status === 'conflict') throw new IdempotencyConflict('Structure projection receipt differs');
  if (result.status !== 'committed') throw new CompositionConflict('staged projection basis changed');
}

function revisionTriples(env: WorkActivationEnvironment, input: { revision: string; structure: string;
  predecessor?: string; operation: string; kind: string; generation: string; manifest: string;
  count: number; restoredFrom?: string }): string {
  return `${iri(input.revision)} a rv:StructureRevision, rv:RevisionAnchor ;
    rv:component ${iri(input.structure)} ;
    ${input.predecessor ? `rv:predecessor ${iri(input.predecessor)} ;` : ''}
    ${input.restoredFrom ? `rv:restoredFrom ${iri(input.restoredFrom)} ;` : ''}
    rv:operation ${iri(input.operation)} ; rv:structureOperation rv:${input.kind} ;
    rv:generation ${iri(input.generation)} ; rv:manifest ${iri(manifestIri(input.manifest))} ;
    rv:placementCount ${input.count} ; rv:modelRevision ${iri(COMPOSITION_PROFILE)} ;
    rv:shapeRevision ${iri(COMPOSITION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`;
}

export interface CreateCompositionIntent {
  admission: Admission;
  owner?: string;
  component?: string;
  /** Book compatibility inputs. New owner profiles use owner/component. */
  work?: string;
  mainVersion?: string;
  profile?: StructureProfile;
}

/** Allocate an empty Structure for a profile owner; the owner selects its identity grain. */
export async function createComposition(env: WorkActivationEnvironment,
  intent: CreateCompositionIntent): Promise<{ terminal: CompositionTerminal; committed: boolean }> {
  const profile = structureProfileFor(intent.profile ?? 'book-composition');
  const owner = native(intent.owner ?? intent.work, 'owner');
  const component = profile.componentPredicate
    ? native(intent.component ?? intent.mainVersion, 'component') : owner;
  const digest = profile.id === 'book-composition'
    ? compositionCreateDigest(component, profile.id)
    : structureCreateDigest(owner, component, profile.id);
  checkAdmission(intent.admission, digest, profile);
  if (intent.admission.scope !== `${profile.editScopePrefix}${owner}`) {
    throw new IdempotencyConflict('Structure admission targets another owner');
  }
  const prior = await existing(env, intent.admission);
  if (prior) return { terminal: prior, committed: false };
  const ownerPattern = profile.componentPredicate
    ? `${iri(owner)} a <${profile.ownerType}> ; <${profile.componentPredicate}> ${iri(component)} .
      ${iri(component)} a <${profile.componentType}> .`
    : `${iri(owner)} a <${profile.ownerType}> .`;
  const ownerState = await env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} { ${ownerPattern} } }`);
  if (ownerState.boolean !== true) throw new CompositionUnavailable('Structure owner is unavailable');
  const seed = `${intent.admission.id}\0composition`;
  const structure = derivedId(`${seed}\0structure`);
  const generation = derivedId(`${seed}\0generation`);
  const revision = derivedId(`${seed}\0revision`);
  const operation = derivedId(`${seed}\0operation`);
  const objects = structureObjects(env);
  const cost = newCost();
  const manifest = await writeManifest(objects, { format: STRUCTURE_MANIFEST_FORMAT, structure,
    structureOf: component, profile: profile.id, generation,
    pageFormat: STRUCTURE_PAGE_FORMAT, records: await recordTree(objects).empty(cost),
    order: await orderTree(objects).empty(cost), placementCount: 0, measures: [],
    model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE }, cost);
  const receipt = compositionReceiptIri(intent.admission.id, intent.admission.action);
  const occupied = `GRAPH ${iri(GRAPHS.current)} { ?existing rv:structureOf ${iri(component)} ;
    rv:structureProfile <${profile.graphProfile}> . }`;
  const structureLink = profile.structurePredicate
    ? `${iri(owner)} <${profile.structurePredicate}> ${iri(structure)} .` : '';
  const noPriorStructure = profile.structurePredicate
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(owner)}
        <${profile.structurePredicate}> ?existingOwnerStructure . } }` : '';
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(structure)} a rv:Structure ; rv:structureOf ${iri(component)} ;
          rv:structureProfile <${profile.graphProfile}> ; rv:structureHead ${iri(revision)} ;
          rv:selectedGeneration ${iri(generation)} .
        ${structureLink}
        ${iri(generation)} a rv:StructureGeneration ; rv:structure ${iri(structure)} ;
          rv:generationState rv:Active ; rv:stagedBy ${iri(operation)} ; rv:placementCount 0 .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ${revisionTriples(env, { revision, structure, operation,
        kind: 'StructureCreate', generation, manifest, count: 0 })} }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, intent.admission, receipt, 'Succeeded',
        `rv:operation ${iri(operation)} ; rv:action "composition.create" ; rv:structure ${iri(structure)} ;
        rv:structureOwner ${iri(owner)} ; rv:structureComponent ${iri(component)} ;
        ${profile.id === 'book-composition'
          ? `rv:work ${iri(owner)} ; rv:mainVersion ${iri(component)} ;` : ''}
        rv:structureRevision ${iri(revision)} ;`)} }
      GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt)} }
    }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      GRAPH ${iri(GRAPHS.current)} { ${ownerPattern} }
      FILTER NOT EXISTS { ${occupied} }
      ${noPriorStructure}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(structure)} ?sp ?so } }
      BIND(?n + 1 AS ?next) }`;
  const committed = await dispatch(env, intent.admission, update,
    await structureCreationValidations(env, profile, owner, structure, generation, revision));
  if (!committed && !await readCompositionReceipt(env, intent.admission.id, intent.admission.action)) {
    await sealRejection(env, intent.admission, 'composition.create', 'CompositionExists', occupied);
  }
  return { terminal: await settled(env, intent.admission), committed };
}

/** In-memory working state over lazily loaded placements and order segments. */
class Working {
  readonly placements = new Map<string, PlacementState>();
  readonly original = new Map<string, string | null>();
  readonly segments = new Map<string, SegmentState>();
  readonly originalSegments = new Map<string, string | null>();
  private readonly parentSegments = new Map<string, string[]>();
  private readonly members = new Map<string, string[]>();
  private allocated = 0;
  activeDelta = 0;
  rebalanced = 0;

  constructor(private readonly env: WorkActivationEnvironment, readonly header: CompositionHeader,
    private readonly seed: string, readonly revision: string) {}

  private remember(state: PlacementState): void {
    if (!this.placements.has(state.occurrence)) {
      this.placements.set(state.occurrence, state);
      this.original.set(state.occurrence, JSON.stringify(state));
    }
  }

  private async hydrate(state: PlacementState): Promise<void> {
    const load = structureProfileFor(this.header.profile).hydrateQualifier;
    if (load) {
      const qualifier = await load(this.env, state);
      if (qualifier) state.qualifier = qualifier;
    }
    this.remember(state);
  }

  private rememberSegment(segment: SegmentState): void {
    if (!this.segments.has(segment.segment)) {
      this.segments.set(segment.segment, segment);
      this.originalSegments.set(segment.segment, JSON.stringify(segment));
    }
  }

  async get(occurrence: string): Promise<PlacementState | undefined> {
    if (!this.placements.has(occurrence)) {
      for (const state of await readPlacements(this.env, this.header.generation,
        { occurrences: [occurrence] }, this.header.profile)) {
        await this.hydrate(state);
      }
    }
    return this.placements.get(occurrence);
  }

  add(state: PlacementState): void {
    if (this.placements.has(state.occurrence)) throw new CompositionCorrupt('occurrence identity repeats');
    this.placements.set(state.occurrence, state);
    this.original.set(state.occurrence, null);
  }

  allocate(kind: string): string { return derivedId(`${this.seed}\0${kind}\0${this.allocated++}`); }

  async segmentsOf(parent: string): Promise<string[]> {
    let ids = this.parentSegments.get(parent);
    if (!ids) {
      const loaded = await readSegments(this.env, this.header.generation, [parent]);
      for (const segment of loaded) this.rememberSegment(segment);
      ids = loaded.map(segment => segment.segment);
      this.parentSegments.set(parent, ids);
    }
    return ids;
  }

  segment(id: string): SegmentState {
    const segment = this.segments.get(id);
    if (!segment) throw new CompositionCorrupt('order segment is not loaded');
    return segment;
  }

  async membersOf(id: string): Promise<string[]> {
    let list = this.members.get(id);
    if (!list) {
      const loaded = await readPlacements(this.env, this.header.generation, { segment: id }, this.header.profile);
      for (const state of loaded) await this.hydrate(state);
      list = loaded.map(state => this.placements.get(state.occurrence)!)
        .filter(state => state.active && state.segment === id)
        .sort((a, b) => a.orderKey! < b.orderKey! ? -1 : 1).map(state => state.occurrence);
      if (list.length !== this.segment(id).count) throw new CompositionCorrupt('order segment count differs');
      this.members.set(id, list);
    }
    return list;
  }

  newSegment(parent: string, key: string, after?: string): SegmentState {
    const segment = { segment: this.allocate('segment'), parent, key, count: 0 };
    this.segments.set(segment.segment, segment);
    this.originalSegments.set(segment.segment, null);
    this.members.set(segment.segment, []);
    const ids = this.parentSegments.get(parent)!;
    ids.splice(after === undefined ? ids.length : ids.indexOf(after) + 1, 0, segment.segment);
    return segment;
  }
}

async function rebalanceSegmentKeys(w: Working, parent: string): Promise<void> {
  const ids = await w.segmentsOf(parent);
  const keys = evenKeys(ids.length);
  for (const [index, id] of ids.entries()) {
    const segment = w.segment(id);
    segment.key = keys[index]!;
    for (const occurrence of await w.membersOf(id)) (await w.get(occurrence))!.segmentKey = segment.key;
  }
}

/** Move the upper half of a full segment into a new neighbour; at most 256 uses change. */
async function split(w: Working, segment: SegmentState): Promise<void> {
  const members = await w.membersOf(segment.segment);
  const ids = await w.segmentsOf(segment.parent);
  const next = ids[ids.indexOf(segment.segment) + 1];
  let key = keyBetween(segment.key, next ? w.segment(next).key : null);
  if (!withinBudget(key)) {
    await rebalanceSegmentKeys(w, segment.parent);
    key = keyBetween(segment.key, next ? w.segment(next).key : null);
  }
  const created = w.newSegment(segment.parent, key, segment.segment);
  const upper = members.splice(Math.floor(members.length / 2));
  for (const occurrence of upper) {
    const state = (await w.get(occurrence))!;
    state.segment = created.segment;
    state.segmentKey = created.key;
  }
  (await w.membersOf(created.segment)).push(...upper);
  segment.count -= upper.length;
  created.count = upper.length;
  w.rebalanced += upper.length;
}

async function locate(w: Working, parent: string, position: Position): Promise<{ segment: SegmentState; index: number }> {
  const ids = await w.segmentsOf(parent);
  if (typeof position === 'object') {
    const sibling = await w.get(position.after);
    if (!sibling?.active || sibling.parent !== parent) {
      throw new CompositionConflict('position sibling is not an active child of the parent');
    }
    await w.segmentsOf(parent);
    const segment = w.segment(sibling.segment!);
    return { segment, index: (await w.membersOf(segment.segment)).indexOf(sibling.occurrence) + 1 };
  }
  if (!ids.length) return { segment: w.newSegment(parent, keyBetween(null, null)), index: 0 };
  const segment = w.segment(position === 'first' ? ids[0]! : ids.at(-1)!);
  return { segment, index: position === 'first' ? 0 : (await w.membersOf(segment.segment)).length };
}

async function place(w: Working, state: PlacementState, parent: string, position: Position): Promise<void> {
  let at = await locate(w, parent, position);
  if (at.segment.count >= STRUCTURE_LIMITS.segmentMembers) {
    await split(w, at.segment);
    at = await locate(w, parent, position);
  }
  const members = await w.membersOf(at.segment.segment);
  const key = async (index: number) => index >= 0 && index < members.length
    ? (await w.get(members[index]!))!.orderKey! : null;
  const candidate = keyBetween(await key(at.index - 1), await key(at.index));
  members.splice(at.index, 0, state.occurrence);
  at.segment.count++;
  Object.assign(state, { active: true, parent, segment: at.segment.segment,
    segmentKey: at.segment.key, orderKey: candidate });
  delete state.removedBy;
  if (!withinBudget(candidate)) {
    // Bounded local rebalance: only this segment's keys are rewritten.
    const keys = evenKeys(members.length);
    for (const [index, occurrence] of members.entries()) (await w.get(occurrence))!.orderKey = keys[index]!;
    w.rebalanced += members.length;
  }
}

async function unplace(w: Working, state: PlacementState): Promise<void> {
  await w.segmentsOf(state.parent);
  const segment = w.segment(state.segment!);
  const members = await w.membersOf(segment.segment);
  members.splice(members.indexOf(state.occurrence), 1);
  segment.count--;
}

/** Ancestors of a prospective parent, bounded by the depth limit; parents must be active groups. */
async function ancestry(w: Working, parent: string): Promise<string[]> {
  const chain: string[] = [];
  let current = parent;
  while (current !== w.header.structure) {
    const state = await w.get(current);
    if (!state?.active || state.role !== 'group') {
      throw new CompositionConflict('parent is not an active group of this composition');
    }
    chain.push(current);
    if (chain.length >= STRUCTURE_LIMITS.maxDepth) throw new CompositionConflict('composition depth exceeded');
    current = state.parent;
  }
  return chain;
}

/** Levels of descendants below an occurrence; only groups own children. */
async function height(w: Working, occurrence: string): Promise<number> {
  let frontier = [occurrence];
  let levels = 0;
  while (frontier.length && levels <= STRUCTURE_LIMITS.maxDepth) {
    const next: string[] = [];
    let found = false;
    for (const parent of frontier) {
      for (const id of await w.segmentsOf(parent)) {
        for (const child of await w.membersOf(id)) {
          found = true;
          if ((await w.get(child))!.role === 'group') next.push(child);
        }
      }
    }
    if (!found) break;
    levels++;
    frontier = next;
  }
  return levels;
}

async function apply(w: Working, operation: CompositionOperation, index: number): Promise<void> {
  if (operation.op === 'insert') {
    const chain = await ancestry(w, operation.parent);
    if (chain.length + 1 > STRUCTURE_LIMITS.maxDepth) throw new CompositionConflict('composition depth exceeded');
    const occurrence = derivedId(`${w.revision}\0occurrence\0${index}`);
    const state: PlacementState = { occurrence, placement: placementIri(w.header.generation, occurrence),
      active: true, parent: operation.parent, role: operation.role, introducedBy: w.revision,
      ...(operation.label ? { label: operation.label } : {}),
      ...(operation.target ? { target: operation.target,
        ...(operation.selection ? { selection: operation.selection } : {}) } : {}),
      ...(operation.qualifier ? { qualifier: operation.qualifier } : {}),
      ...(operation.sourceKey ? { sourceKey: operation.sourceKey } : {}) };
    w.add(state);
    if (w.header.placementCount + w.activeDelta + 1 > STRUCTURE_LIMITS.maxPlacements) {
      throw new CompositionConflict('composition placement limit exceeded');
    }
    await place(w, state, operation.parent, operation.position);
    w.activeDelta++;
    return;
  }
  const state = await w.get(operation.occurrence);
  if (!state?.active) throw new CompositionConflict('occurrence is not active in this composition');
  if (operation.op === 'remove') {
    for (const id of await w.segmentsOf(state.occurrence)) {
      if (w.segment(id).count > 0) throw new CompositionConflict('a group with children cannot be removed');
    }
    await unplace(w, state);
    state.active = false;
    state.tombstone = true;
    state.removedBy = w.revision;
    w.activeDelta--;
    return;
  }
  if (operation.parent === state.occurrence) throw new CompositionConflict('an occurrence cannot contain itself');
  const chain = await ancestry(w, operation.parent);
  if (chain.includes(state.occurrence)) throw new CompositionConflict('move would create a cycle');
  if (typeof operation.position === 'object' && operation.position.after === state.occurrence) {
    throw new CompositionConflict('an occurrence cannot be placed after itself');
  }
  if (state.role === 'group' && chain.length + 1 + await height(w, state.occurrence) > STRUCTURE_LIMITS.maxDepth) {
    throw new CompositionConflict('composition depth exceeded');
  }
  await unplace(w, state);
  await place(w, state, operation.parent, operation.position);
}

/** A fixed Content pin must be an actual publication of that same chapter target. */
async function checkFixedSelections(env: WorkActivationEnvironment,
  selections: readonly (CompositionOperation | OccurrenceRecord)[]): Promise<void> {
  const requested = selections.flatMap(operation => (!('op' in operation) || operation.op === 'insert')
    && operation.target
    && operation.selection?.mode === 'fixed-revision'
    ? [{ target: operation.target, revision: operation.selection.revision }] : []);
  if (!requested.length) return;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?target ?revision WHERE {
    VALUES (?target ?revision) { ${requested.map(row => `(${iri(row.target)} ${iri(row.revision)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:ContentPublicationDecision ;
      rv:resource ?target ; rv:contentRevision ?revision . }
  }`, 128 * 1024);
  const found = new Set((result.results?.bindings ?? []).map(row =>
    `${row.target?.value}\u0000${row.revision?.value}`));
  if (requested.some(row => !found.has(`${row.target}\u0000${row.revision}`))) {
    throw new CompositionConflict('fixed chapter revision is not a publication of its target');
  }
}

function placementTriples(state: PlacementState, generation: string,
  profile?: StructureProfile): string[] {
  const subject = iri(state.placement);
  const triples = [`${subject} a ${state.active || state.tombstone
    ? 'rv:OccurrencePlacement' : 'rv:RemovedPlacement'} .`];
  const add = (predicate: string, object: string) => triples.push(`${subject} rv:${predicate} ${object} .`);
  add('occurrence', iri(state.occurrence));
  add('generation', iri(generation));
  add('occurrenceRole', `<${ROLE_IRI[state.role]}>`);
  if (state.active || state.tombstone) {
    add('orderSegment', iri(state.segment!));
    add('orderKey', lit(state.orderKey!));
  }
  if (!state.active) {
    add('lastParent', iri(state.parent));
    add('removedBy', iri(state.removedBy!));
  }
  if (state.label) add('occurrenceLabel', `${lit(state.label.value)}@${state.label.language}`);
  if (state.target) add('target', profile && isCatalogTarget(profile, state.target)
    ? structureIri(state.target) : iri(state.target));
  if (state.selection?.mode === 'follow-context') add('selectionMode', 'rv:FollowContext');
  if (state.selection?.mode === 'fixed-revision') {
    add('selectionMode', 'rv:FixedRevision');
    add('pinnedRevision', iri(state.selection.revision));
  }
  if (state.sourceKey) add('sourceKey', lit(state.sourceKey));
  const qualifier = profile && structureProfileFor(profile).projectQualifier?.(state, generation);
  if (qualifier) {
    add('qualifier', iri(qualifier.iri));
    triples.push(...qualifier.triples);
  }
  return triples;
}

function segmentTriples(segment: SegmentState, generation: string): string[] {
  const subject = iri(segment.segment);
  return [`${subject} a rv:OrderSegment .`, `${subject} rv:generation ${iri(generation)} .`,
    `${subject} rv:parent ${iri(segment.parent)} .`, `${subject} rv:segmentKey ${lit(segment.key)} .`,
    `${subject} rv:memberCount ${segment.count} .`];
}

function diff(before: readonly string[], after: readonly string[]): { removed: string[]; added: string[] } {
  const old = new Set(before);
  const next = new Set(after);
  return { removed: before.filter(triple => !next.has(triple)), added: after.filter(triple => !old.has(triple)) };
}

const OPERATION_KIND = { insert: 'OccurrenceInsert', move: 'OccurrenceMove', remove: 'OccurrenceRemove' } as const;

export interface ChangeCompositionIntent {
  admission: Admission;
  structure: string;
  expectedHead: string;
  operations: readonly CompositionOperation[];
}

export interface CompositionChangeResult {
  terminal: CompositionTerminal;
  committed: boolean;
  occurrences: string[];
  cost?: CompositionCost;
}

/** Apply one bounded change batch against the exact expected head and seal a new revision. */
export async function changeComposition(env: WorkActivationEnvironment,
  intent: ChangeCompositionIntent): Promise<CompositionChangeResult> {
  const registration = structureProfileForAction(intent.admission.action);
  const operations = checkedOperations(intent.operations, registration);
  const digest = compositionChangeDigest(intent.structure, intent.expectedHead, operations, registration.id);
  checkAdmission(intent.admission, digest, registration);
  const revision = derivedId(`${intent.admission.id}\0composition\0revision`);
  const occurrences = operations.flatMap((operation, index) => operation.op === 'insert'
    ? [derivedId(`${revision}\0occurrence\0${index}`)] : []);
  const prior = await existing(env, intent.admission);
  if (prior) return { terminal: prior, committed: false, occurrences };
  const header = await readCompositionHeader(env, intent.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  if (header.profile !== registration.id) throw new IdempotencyConflict('Structure action targets another profile');
  const targets = [...new Set(operations.flatMap(operation => operation.op === 'insert'
    && operation.target ? [operation.target] : []))];
  const resourceTargets = targets.filter(target => !isCatalogTarget(registration, target));
  if (resourceTargets.length) {
    const found = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?target WHERE {
      VALUES ?target { ${resourceTargets.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?target ?targetPredicate ?targetObject . }
    }`);
    const available = new Set((found.results?.bindings ?? []).map(row => row.target?.value));
    if (resourceTargets.some(target => !available.has(target))) {
      throw new CompositionUnavailable('chapter target is unavailable');
    }
  }
  if (intent.admission.scope !== `${registration.editScopePrefix}${header.owner}`) {
    throw new IdempotencyConflict('Structure admission targets another owner');
  }
  const headGuard = `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.structure)} rv:structureHead ${iri(intent.expectedHead)} }`;
  if (header.head !== intent.expectedHead) {
    await sealRejection(env, intent.admission, 'composition.change', 'StaleHead',
      `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.structure)} rv:structureHead ?head }
      FILTER(?head != ${iri(intent.expectedHead)})`);
    return { terminal: await settled(env, intent.admission), committed: false, occurrences };
  }
  const w = new Working(env, header, `${intent.admission.id}\0composition`, revision);
  const profile = structureProfileFor(header.profile);
  try {
    await checkFixedSelections(env, operations);
    for (const [index, operation] of operations.entries()) await apply(w, operation, index);
  } catch (error) {
    if (!(error instanceof CompositionConflict)) throw error;
    await sealRejection(env, intent.admission, 'composition.change', 'TopologyConflict', headGuard);
    return { terminal: await settled(env, intent.admission), committed: false, occurrences };
  }
  const objects = structureObjects(env);
  const cost: CompositionCost = { ...newCost(), placementsWritten: 0, segmentsWritten: 0,
    rebalanced: w.rebalanced };
  const manifest = await readManifest(objects, header, cost);
  const records = new Map<string, OccurrenceRecord | null>();
  const order = new Map<string, OrderEntry | null>();
  const deletes: string[] = [];
  const inserts: string[] = [];
  const changedExisting: PlacementState[] = [];
  for (const [occurrence, state] of w.placements) {
    const before = w.original.get(occurrence);
    const old = before ? JSON.parse(before) as PlacementState : undefined;
    const change = diff(old ? placementTriples(old, header.generation, header.profile) : [],
      placementTriples(state, header.generation, header.profile));
    if (old && !change.removed.length && !change.added.length) continue;
    const record = placementRecord(state);
    checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
      profile.selectionRequiredRoles ?? profile.targetRoles);
    records.set(occurrence, record);
    if (old) {
      changedExisting.push(old);
      if (old.active) order.set(orderTreeKey(old as Required<PlacementState>), null);
    } else {
      inserts.push(`${iri(occurrence)} a rv:StructureOccurrence ; rv:structure ${iri(header.structure)} ;
        rv:introducedBy ${iri(revision)} .`);
    }
    deletes.push(...change.removed);
    inserts.push(...change.added);
    cost.placementsWritten++;
  }
  for (const occurrence of records.keys()) {
    const state = w.placements.get(occurrence)!;
    if (state.active) {
      order.set(orderTreeKey(state as Required<PlacementState>), { parent: state.parent,
        segmentKey: state.segmentKey!, orderKey: state.orderKey!, occurrence: state.occurrence });
    }
  }
  for (const [id, segment] of w.segments) {
    const before = w.originalSegments.get(id);
    if (before === JSON.stringify(segment)) continue;
    const change = diff(before ? segmentTriples(JSON.parse(before) as SegmentState, header.generation) : [],
      segmentTriples(segment, header.generation));
    deletes.push(...change.removed);
    inserts.push(...change.added);
    cost.segmentsWritten++;
  }
  // The graph projection must still match the retained head before it is extended.
  const retained = await recordTree(objects).lookup(manifest.records,
    changedExisting.map(state => state.occurrence), cost);
  for (const old of changedExisting) {
    if (JSON.stringify(retained.get(old.occurrence)) !== JSON.stringify(placementRecord(old))) {
      throw new StructureObjectCorrupt('composition graph differs from its retained head');
    }
  }
  const count = header.placementCount + w.activeDelta;
  const next = await writeManifest(objects, { ...manifest,
    records: await recordTree(objects).apply(manifest.records, records, cost),
    order: await orderTree(objects).apply(manifest.order, order, cost), placementCount: count }, cost);
  const operation = derivedId(`${intent.admission.id}\0composition\0operation`);
  const receipt = compositionReceiptIri(intent.admission.id, intent.admission.action);
  const update = `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(header.structure)} rv:structureHead ${iri(intent.expectedHead)} .
        ${iri(header.generation)} rv:placementCount ${header.placementCount} .
        ${deletes.join('\n')}
      }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(header.structure)} rv:structureHead ${iri(revision)} .
        ${iri(header.generation)} rv:placementCount ${count} .
        ${inserts.join('\n')}
      }
      GRAPH ${iri(GRAPHS.revisions)} { ${revisionTriples(env, { revision, structure: header.structure,
        predecessor: intent.expectedHead, operation, kind: OPERATION_KIND[operations[0]!.op],
        generation: header.generation, manifest: next, count })} }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, intent.admission, receipt, 'Succeeded',
        `rv:operation ${iri(operation)} ; rv:action "composition.change" ;
        rv:structure ${iri(header.structure)} ; rv:structureRevision ${iri(revision)} ;
        rv:expectedHead ${iri(intent.expectedHead)} ;`)} }
      GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt)} }
    }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(header.structure)} rv:structureHead ${iri(intent.expectedHead)} ;
        rv:selectedGeneration ${iri(header.generation)} .
        ${iri(header.generation)} rv:placementCount ${header.placementCount} . }
      ${resourceTargets.length
        ? `GRAPH ${iri(GRAPHS.current)} { ${resourceTargets.map((target, index) => `${iri(target)} ?targetPredicate${index} ?targetObject${index} .`).join(' ')} }`
        : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?rp ?ro } }
      BIND(?n + 1 AS ?next) }`;
  if (Date.parse(intent.admission.expiresAt) <= Date.now()) throw new PendingActivation('composition admission expired');
  const focus: [string, string][] = [['structure', header.structure],
    ['generation', header.generation], ['revision', revision]];
  for (const occurrence of records.keys()) {
    const state = w.placements.get(occurrence)!;
    focus.push([state.active || state.tombstone ? 'placement' : 'removed-placement', state.placement]);
    if (w.original.get(occurrence) === null) focus.push(['occurrence', occurrence]);
  }
  for (const [id, segment] of w.segments) {
    if (w.originalSegments.get(id) !== JSON.stringify(segment)) focus.push(['segment', id]);
  }
  if (focus.length > 100) {
    await sealRejection(env, intent.admission, 'composition.change', 'CompositionTooLarge', headGuard);
    return { terminal: await settled(env, intent.admission), committed: false, occurrences };
  }
  const committed = await dispatch(env, intent.admission, update, [
    ...await validations(env, focus),
    ...(await profile.qualifierValidations?.(env,
      [...records.keys()].map(id => w.placements.get(id)!)) ?? []),
  ]);
  if (!committed && !await readCompositionReceipt(env, intent.admission.id, intent.admission.action)) {
    await sealRejection(env, intent.admission, 'composition.change', 'StaleHead',
      `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.structure)} rv:structureHead ?head }
      FILTER(?head != ${iri(intent.expectedHead)})`);
  }
  return { terminal: await settled(env, intent.admission), committed, occurrences,
    ...(committed ? { cost } : {}) };
}

export interface SealCompositionIntent { admission: Admission; structure: string; expectedHead: string;
  canReadTarget: (target: string) => Promise<boolean> }

/**
 * Seal a fixed manifest: every targeted use of the exact head revision pins the
 * Content revision it currently follows, or records why it is unavailable.
 */
export async function sealComposition(env: WorkActivationEnvironment,
  intent: SealCompositionIntent): Promise<{ terminal: CompositionTerminal; committed: boolean }> {
  const registration = structureProfileForAction(intent.admission.action);
  const digest = compositionSealDigest(intent.structure, intent.expectedHead);
  checkAdmission(intent.admission, digest, registration);
  const prior = await existing(env, intent.admission);
  if (prior) return { terminal: prior, committed: false };
  const header = await readCompositionHeader(env, intent.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  if (header.profile !== registration.id
    || intent.admission.scope !== `${registration.editScopePrefix}${header.owner}`) {
    throw new IdempotencyConflict('Structure admission targets another owner');
  }
  const headGuard = `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.structure)} rv:structureHead ${iri(intent.expectedHead)} }`;
  if (header.head !== intent.expectedHead) {
    await sealRejection(env, intent.admission, 'composition.seal', 'StaleHead',
      `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.structure)} rv:structureHead ?head }
      FILTER(?head != ${iri(intent.expectedHead)})`);
    return { terminal: await settled(env, intent.admission), committed: false };
  }
  if (header.placementCount > SEAL_PLACEMENT_LIMIT) {
    await sealRejection(env, intent.admission, 'composition.seal', 'CompositionTooLarge', headGuard);
    return { terminal: await settled(env, intent.admission), committed: false };
  }
  const objects = structureObjects(env);
  const cost = newCost();
  const manifest = await readManifest(objects, header, cost);
  const order = await orderTree(objects).range(manifest.order, '', '￿', SEAL_PLACEMENT_LIMIT, cost);
  const records = await recordTree(objects).lookup(manifest.records, order.map(entry => entry.occurrence), cost);
  if (order.length !== header.placementCount || order.some(entry => !records.has(entry.occurrence))) {
    throw new StructureObjectCorrupt('composition order and record trees differ');
  }
  const profile = structureProfileFor(header.profile);
  const resourceTargets = order.map(entry => records.get(entry.occurrence)!).filter(record => record.target
    && !isCatalogTarget(profile, record.target));
  for (const target of new Set(resourceTargets.map(record => record.target!))) {
    if (!await intent.canReadTarget(target)) {
      throw new CompositionUnavailable('chapter target is unavailable for sealing');
    }
  }
  const targeted = resourceTargets.filter(record => record.selection);
  const published = await readPublishedVariants(env, targeted
    .filter(record => record.selection?.mode === 'follow-context').map(record => record.target!));
  const pins = new Map<string, PinEntry | null>();
  let unavailable = 0;
  for (const record of targeted) {
    if (record.selection?.mode === 'fixed-revision') {
      pins.set(`${record.occurrence}\u0001`, { occurrence: record.occurrence, target: record.target!,
        revision: record.selection.revision });
      continue;
    }
    const variants = published.filter(entry => entry.target === record.target);
    if (!variants.length) {
      unavailable++;
      pins.set(`${record.occurrence}\u0001`, { occurrence: record.occurrence, target: record.target!,
        unavailable: 'missing' });
    }
    for (const variant of variants) {
      pins.set(`${record.occurrence}\u0001${variant.variant}`, { occurrence: record.occurrence,
        target: record.target!, variant: variant.variant, revision: variant.revision });
    }
  }
  const tree = pinTree(objects);
  const root = await tree.apply(await tree.empty(cost), pins, cost);
  const sealBytes = new TextEncoder().encode(JSON.stringify({ format: STRUCTURE_SEAL_FORMAT,
    structure: header.structure, structureRevision: header.head,
    structureManifest: `sha256:${header.manifest.slice(-64)}`, pins: root,
    coverage: unavailable ? 'partial' : 'complete', unavailableCount: unavailable,
    model: COMPOSITION_PROFILE }));
  checkStructureSealManifest(sealBytes);
  const sealManifest = await objects.put(sealBytes);
  const seal = derivedId(`${intent.admission.id}\0composition\0seal`);
  const operation = derivedId(`${intent.admission.id}\0composition\0operation`);
  const receipt = compositionReceiptIri(intent.admission.id, intent.admission.action);
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(seal)} a rv:StructureSeal ; rv:structure ${iri(header.structure)} ;
          rv:structureRevision ${iri(header.head)} ; rv:manifest ${iri(manifestIri(sealManifest))} ;
          rv:sealedBy ${iri(operation)} ; rv:sealCoverage rv:${unavailable ? 'Partial' : 'Complete'} ;
          rv:unavailableCount ${unavailable} ; rv:modelRevision ${iri(COMPOSITION_PROFILE)} ;
          rv:shapeRevision ${iri(COMPOSITION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, intent.admission, receipt, 'Succeeded',
        `rv:operation ${iri(operation)} ; rv:action "composition.seal" ;
        rv:structure ${iri(header.structure)} ; rv:structureRevision ${iri(header.head)} ;
        rv:expectedHead ${iri(intent.expectedHead)} ; rv:structureSeal ${iri(seal)} ;`)} }
      GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt)} }
    }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${headGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(seal)} ?sp ?so } }
      BIND(?n + 1 AS ?next) }`;
  const committed = await dispatch(env, intent.admission, update,
    await validations(env, [['seal', seal]]));
  if (!committed && !await readCompositionReceipt(env, intent.admission.id, intent.admission.action)) {
    await sealRejection(env, intent.admission, 'composition.seal', 'StaleHead',
      `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.structure)} rv:structureHead ?head }
      FILTER(?head != ${iri(intent.expectedHead)})`);
  }
  return { terminal: await settled(env, intent.admission), committed };
}

export async function cancelCompositionStage(env: WorkActivationEnvironment,
  stage: { id: string; structure: string; generation: string; baseHead: string;
    placementCount: number | null }): Promise<{ receipt: string; dataEpoch: string; sequence: string }> {
  const receipt = `urn:rezics:receipt:structure-stage-cancel:${hash(stage.id)}`;
  const digest = hash(JSON.stringify({ family: 'structure-stage-cancel-v1', id: stage.id,
    structure: stage.structure, generation: stage.generation, baseHead: stage.baseHead }));
  const operation = derivedId(`${stage.id}\0composition\0operation`);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(stage.generation)} rv:generationState rv:Staging . } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(stage.generation)} a rv:StructureGeneration ;
        rv:structure ${iri(stage.structure)} ; rv:generationState rv:Cancelled ;
        rv:stagedBy ${iri(operation)} ; rv:baseRevision ${iri(stage.baseHead)} ;
        rv:placementCount ${stage.placementCount ?? 0} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:commandFamily \"structure-stage-cancel\" ; rv:requestDigest ${lit(digest)} ;
        rv:outcome rv:Cancelled ; rv:action \"structure.stage-cancel\" ;
        rv:stageId ${lit(stage.id)} ; rv:structure ${iri(stage.structure)} ;
        rv:generation ${iri(stage.generation)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
        rv:event ${iri(event)} .
        ${iri(event)} a rv:StructureStageCancelledEvent ; rv:ordinal 0 ;
          rv:action "structure.stage-cancel" ; rv:receipt ${iri(receipt)} ;
          rv:stageId ${lit(stage.id)} ; rv:structure ${iri(stage.structure)} ;
          rv:generation ${iri(stage.generation)} . }
    }
    WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(stage.structure)}
        rv:selectedGeneration ${iri(stage.generation)} }
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(stage.generation)} rv:generationState ?state . FILTER(?state != rv:Staging) } }
      BIND(?n + 1 AS ?next) }`;
  const result = await env.fuseki.commandWithReceipt({ receipt, digest, update,
    validations: await validations(env, [['generation', stage.generation]]), deadlineMs: 10_000 });
  if (result.status === 'conflict') throw new IdempotencyConflict('stage cancellation receipt differs');
  if (result.status !== 'committed') throw new CompositionConflict('stage is no longer cancellable');
  return { receipt, dataEpoch: result.position.dataEpoch, sequence: result.position.sequence };
}

export interface RestoreCompositionIntent {
  admission: Admission;
  structure: string;
  expectedHead: string;
  restoredFrom: string;
  /** Rechecked for every active target just before the guarded activation. */
  canReadTarget: (target: string) => Promise<boolean>;
  stage?: { id: string; generation: string; revision: string; manifestDigest: string;
    onGraphStart: () => Promise<number>;
    onProjectionBatch: (previous: number) => Promise<number> };
}

/** A bounded restore selects retained bytes as a new revision; target resources are never rewound. */
export async function restoreComposition(env: WorkActivationEnvironment, intent: RestoreCompositionIntent):
  Promise<{ terminal: CompositionTerminal; committed: boolean; cost?: CompositionCost }> {
  const registration = structureProfileForAction(intent.admission.action);
  const digest = intent.stage
    ? compositionStageDigest(intent.structure, intent.expectedHead,
      intent.stage.id, intent.stage.manifestDigest)
    : compositionRestoreDigest(intent.structure, intent.expectedHead, intent.restoredFrom);
  checkAdmission(intent.admission, digest, registration);
  const prior = await existing(env, intent.admission);
  if (prior) return { terminal: prior, committed: false };
  const header = await readCompositionHeader(env, intent.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  if (header.profile !== registration.id
    || intent.admission.scope !== `${registration.editScopePrefix}${header.owner}`) {
    throw new IdempotencyConflict('restore admission targets another Structure owner');
  }
  const headGuard = `GRAPH ${iri(GRAPHS.current)} {
    ${iri(header.structure)} rv:structureHead ${iri(intent.expectedHead)} }`;
  if (header.head !== intent.expectedHead) {
    if (intent.stage) throw new StaleCompositionHead('stage basis is stale');
    await sealRejection(env, intent.admission, 'composition.restore', 'StaleHead',
      `GRAPH ${iri(GRAPHS.current)} { ${iri(header.structure)} rv:structureHead ?head }
      FILTER(?head != ${iri(intent.expectedHead)})`);
    return { terminal: await settled(env, intent.admission), committed: false };
  }
  const source = intent.stage ? null : await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(intent.restoredFrom)} a rv:StructureRevision ;
      rv:component ${iri(header.structure)} ; rv:manifest ?manifest . } } LIMIT 2`);
  const sourceRows = source?.results?.bindings ?? [];
  if (!intent.stage && !sourceRows.length) throw new CompositionUnavailable('retained revision is unavailable');
  const sourceManifestRef = intent.stage
    ? manifestIri(intent.stage.manifestDigest) : sourceRows[0]?.manifest?.value;
  if ((!intent.stage && sourceRows.length !== 1)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(sourceManifestRef ?? '')) {
    throw new CompositionCorrupt('retained revision anchor is ambiguous');
  }
  const objects = structureObjects(env);
  let sourceManifest: StructureManifest;
  try { sourceManifest = checkStructureManifest(await objects.get(sourceManifestRef!.slice(-64))); }
  catch (error) {
    if (error instanceof ObjectIntegrityError || error instanceof InvalidStructureObject) {
      throw new StructureObjectCorrupt(error.message);
    }
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    throw error;
  }
  const materializationLimit = intent.stage ? STRUCTURE_LIMITS.stageRecords : STRUCTURE_LIMITS.segmentMembers;
  if (sourceManifest.structure !== header.structure || sourceManifest.structureOf !== header.component
    || sourceManifest.profile !== header.profile
    || sourceManifest.records.count > materializationLimit
    || sourceManifest.placementCount > materializationLimit) {
    throw new CompositionTooLarge(intent.stage
      ? 'staged generation needs batched graph projection'
      : 'restore requires the staged generation path');
  }
  const cost: CompositionCost = { ...newCost(), placementsWritten: 0, segmentsWritten: 0,
    rebalanced: 0 };
  cost.pagesRead++;
  const records = await recordTree(objects).range(sourceManifest.records, '', '\uffff',
    materializationLimit + 1, cost);
  const ordered = await orderTree(objects).range(sourceManifest.order, '', '\uffff',
    materializationLimit + 1, cost);
  if (records.length !== sourceManifest.records.count
    || ordered.length !== sourceManifest.placementCount) {
    throw new StructureObjectCorrupt('retained Structure tree count differs');
  }
  const byOccurrence = new Map(records.map(record => [record.occurrence, record]));
  const orderKeys = new Set(ordered.map(orderTreeKey));
  for (const record of records) {
    try { checkOccurrenceRecord(record, header.profile, registration.catalogTargetTypes,
      registration.selectionRequiredRoles ?? registration.targetRoles); }
    catch (error) {
      if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    if (record.labels.length > 1 || record.selection?.mode === 'fixed-realm'
      || record.state === 'active'
      && (!orderKeys.has(orderTreeKey(record as OrderEntry))
        || record.parent !== header.structure
          && (byOccurrence.get(record.parent)?.role !== 'group'
            || byOccurrence.get(record.parent)?.state !== 'active'))
      || record.target && !isCatalogTarget(registration, record.target)
        && record.state === 'active' && !await intent.canReadTarget(record.target)) {
      throw new CompositionConflict('restored Structure has an unavailable or undisclosed dependency');
    }
  }
  const active = records.filter(record => record.state === 'active');
  if (intent.stage) await checkFixedSelections(env, active);
  if (active.length !== ordered.length || new Set(records.map(record => record.occurrence)).size !== records.length) {
    throw new StructureObjectCorrupt('retained Structure records and order differ');
  }
  for (const record of active) {
    const seen = new Set([record.occurrence]);
    let parent = record.parent;
    while (parent !== header.structure) {
      if (seen.has(parent) || seen.size > STRUCTURE_LIMITS.maxDepth) {
        throw new StructureObjectCorrupt('retained Structure parent chain cycles or exceeds depth');
      }
      seen.add(parent);
      const owner = byOccurrence.get(parent);
      if (!owner || owner.state !== 'active' || owner.role !== 'group') {
        throw new StructureObjectCorrupt('retained Structure parent is unavailable');
      }
      parent = owner.parent;
    }
  }
  const targets = [...new Set(active.flatMap(record => record.target
    && !isCatalogTarget(registration, record.target) ? [record.target] : []))];
  if (targets.length) {
    const available = new Set<string>();
    for (let offset = 0; offset < targets.length; offset += 100) {
      const page = targets.slice(offset, offset + 100);
      const found = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?target WHERE {
        VALUES ?target { ${page.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?target ?targetPredicate ?targetObject . } }`);
      for (const row of found.results?.bindings ?? []) {
        if (row.target?.value) available.add(row.target.value);
      }
    }
    if (targets.some(target => !available.has(target))) {
      throw new CompositionConflict('restored target resource is unavailable');
    }
  }
  const generation = intent.stage?.generation
    ?? derivedId(`${intent.admission.id}\0composition\0generation`);
  const revision = intent.stage
    ? derivedId(`${intent.stage.id}\0composition\0revision`)
    : derivedId(`${intent.admission.id}\0composition\0revision`);
  const operation = derivedId(`${intent.stage?.id ?? intent.admission.id}\0composition\0operation`);
  const next = await writeManifest(objects, { ...sourceManifest, generation,
    ...(intent.stage ? {} : { restoredFrom: intent.restoredFrom }) }, cost);
  const segments = new Map<string, SegmentState & { firstIndex: number }>();
  const projectionByRecord = records.map(() => [] as string[]);
  const focusByRecord = records.map(() => [] as [string, string][]);
  for (const [index, record] of records.entries()) {
    if (record.state !== 'active') continue;
    const segment = derivedId(`${generation}\0${record.parent}\0${record.segmentKey}`);
    const existingSegment = segments.get(segment);
    if (existingSegment) existingSegment.count++;
    else segments.set(segment, { segment, parent: record.parent,
      key: record.segmentKey!, count: 1, firstIndex: index });
  }
  const segmentEntries = [...segments.values()];
  for (const [index, record] of records.entries()) {
    const segment = record.state === 'active'
      ? derivedId(`${generation}\0${record.parent}\0${record.segmentKey}`) : undefined;
    const state: PlacementState = { occurrence: record.occurrence,
      placement: placementIri(generation, record.occurrence), active: record.state === 'active',
      parent: record.parent, role: record.role, introducedBy: record.introducedBy,
      ...(segment ? { segment, segmentKey: record.segmentKey, orderKey: record.orderKey } : {
        removedBy: record.removedBy }),
      ...(record.labels[0] ? { label: record.labels[0] } : {}),
      ...(record.target ? { target: record.target,
        ...(record.selection ? { selection: record.selection as Selection } : {}) } : {}),
      ...(record.sourceKey ? { sourceKey: record.sourceKey } : {}) };
    projectionByRecord[index]!.push(...placementTriples(state, generation, header.profile));
    if (intent.stage && record.introducedBy === revision) {
      projectionByRecord[index]!.push(`${iri(record.occurrence)} a rv:StructureOccurrence ;
        rv:structure ${iri(header.structure)} ; rv:introducedBy ${iri(revision)} .`);
    }
    if (intent.stage && record.introducedBy === revision) {
      focusByRecord[index]!.push(['occurrence', record.occurrence]);
    }
    focusByRecord[index]!.push([state.active ? 'placement' : 'removed-placement', state.placement]);
    cost.placementsWritten++;
  }
  for (const segment of segmentEntries) {
    const index = segment.firstIndex;
    projectionByRecord[index]!.push(...segmentTriples(segment, generation));
    focusByRecord[index]!.push(['segment', segment.segment]);
    cost.segmentsWritten++;
  }
  const commonFocus: [string, string][] = [['structure', header.structure],
    ['generation', generation], ['generation', header.generation], ['revision', revision]];
  const projection = projectionByRecord.flat();
  const focus = [...commonFocus, ...focusByRecord.flat()];
  if (!intent.stage && focus.length > 100) {
    throw new CompositionTooLarge('restore requires the staged generation path');
  }
  if (intent.stage) {
    const generationTriples = `${iri(generation)} a rv:StructureGeneration ;
      rv:structure ${iri(header.structure)} ; rv:generationState rv:Staging ;
      rv:stagedBy ${iri(operation)} ; rv:baseRevision ${iri(intent.expectedHead)} ;
      rv:placementCount ${active.length} .`;
    const candidateRevisionTriples = revisionTriples(env, { revision, structure: header.structure,
      predecessor: intent.expectedHead, operation, kind: 'StructureReplace', generation,
      manifest: next, count: active.length });
    const totalBatches = Math.max(1, Math.ceil(records.length / STRUCTURE_LIMITS.projectionBatchRecords));
    let checkpoint = await intent.stage.onGraphStart();
    if (checkpoint > totalBatches) throw new CompositionCorrupt('stage projection checkpoint exceeds its manifest');
    while (checkpoint < totalBatches) {
      const ordinal = checkpoint;
      const first = ordinal * STRUCTURE_LIMITS.projectionBatchRecords;
      const last = Math.min(records.length, first + STRUCTURE_LIMITS.projectionBatchRecords);
      const batchProjection = projectionByRecord.slice(first, last).flat();
      const batchFocus: [string, string][] = ordinal === 0
        ? [['generation', generation], ['revision', revision]] : [];
      batchFocus.push(...focusByRecord.slice(first, last).flat());
      await projectStageBatch(env, intent.admission, { stageId: intent.stage.id,
        structure: header.structure, generation, expectedHead: intent.expectedHead,
        previousGeneration: header.generation, ordinal,
        generationTriples: ordinal === 0 ? generationTriples : '',
        revisionTriples: ordinal === 0 ? candidateRevisionTriples : '',
        projection: batchProjection, focus: batchFocus });
      checkpoint = await intent.stage.onProjectionBatch(ordinal);
    }
  }
  const receipt = compositionReceiptIri(intent.admission.id, intent.admission.action);
  const generationInsert = intent.stage
    ? `${iri(generation)} rv:generationState rv:Active .`
    : `${iri(generation)} a rv:StructureGeneration ; rv:structure ${iri(header.structure)} ;
        rv:generationState rv:Active ; rv:stagedBy ${iri(operation)} ;
        rv:placementCount ${active.length} . ${projection.join('\n')}`;
  const stagingDelete = intent.stage
    ? `${iri(generation)} rv:generationState rv:Staging .` : '';
  const stageGuard = intent.stage
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(generation)} rv:structure ${iri(header.structure)} ;
        rv:generationState rv:Staging ; rv:placementCount ${active.length} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(generation)} ?gp ?go } }`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(header.structure)} rv:structureHead ${iri(intent.expectedHead)} ;
          rv:selectedGeneration ${iri(header.generation)} .
        ${iri(header.generation)} rv:generationState rv:Active . ${stagingDelete} } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(header.structure)} rv:structureHead ${iri(revision)} ;
          rv:selectedGeneration ${iri(generation)} .
        ${iri(header.generation)} rv:generationState rv:Retired . ${generationInsert}
      }
      ${intent.stage ? '' : `GRAPH ${iri(GRAPHS.revisions)} { ${revisionTriples(env, { revision,
        structure: header.structure, predecessor: intent.expectedHead,
        restoredFrom: intent.restoredFrom, operation, kind: 'StructureRestore',
        generation, manifest: next, count: active.length })} }`}
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, intent.admission, receipt, 'Succeeded',
        `rv:operation ${iri(operation)} ; rv:action "${intent.stage ? 'composition.stage-activate' : 'composition.restore'}" ;
        rv:structure ${iri(header.structure)} ; rv:structureRevision ${iri(revision)} ;
        rv:expectedHead ${iri(intent.expectedHead)} ;`)} }
      GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt)} }
    } WHERE { ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${headGuard}
      GRAPH ${iri(GRAPHS.current)} { ${iri(header.structure)} rv:selectedGeneration ${iri(header.generation)} .
        ${iri(header.generation)} rv:generationState rv:Active .
        ${targets.map((target, index) => `${iri(target)} rv:mainVersion ?main${index} .`).join('\n')} }
      ${stageGuard}
      ${intent.stage ? `GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StructureRevision ;
        rv:component ${iri(header.structure)} ; rv:generation ${iri(generation)} ;
        rv:manifest ${iri(manifestIri(next))} . }`
        : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?rp ?ro } }`}
      BIND(?n + 1 AS ?next) }`;
  const finalFocus: [string, string][] = [['structure', header.structure],
    ['generation', generation], ['generation', header.generation], ['revision', revision]];
  const checks = await validations(env, intent.stage ? finalFocus : focus);
  const committed = await dispatch(env, intent.admission, update, checks);
  if (!committed && !await readCompositionReceipt(env, intent.admission.id, intent.admission.action)) {
    await sealRejection(env, intent.admission, 'composition.restore', 'StaleHead',
      `GRAPH ${iri(GRAPHS.current)} { ${iri(header.structure)} rv:structureHead ?head }
      FILTER(?head != ${iri(intent.expectedHead)})`, intent.stage
        ? { generation } : undefined);
  }
  return { terminal: await settled(env, intent.admission), committed,
    ...(committed ? { cost } : {}) };
}
