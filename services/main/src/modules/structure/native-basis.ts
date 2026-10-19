import { isDeepStrictEqual } from 'node:util';
import { canReadCompositionWork, compositionTargetBatchReader } from '../composition/disclosure-read.ts';
import { discloseInventory, type DisclosureTarget } from '../disclosure/read.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { compositionReceiptIri, orderTree, readCompositionReceipt, recordTree,
  type CompositionTerminal } from './change.ts';
import { checkOccurrenceRecord, STRUCTURE_LIMITS, type OccurrenceRecord } from './format.ts';
import { COMPOSITION_PROFILE, NATIVE_ID, orderTreeKey, readCompositionHeader } from './graph.ts';
import { isContainerRole, structureProfileFor } from './profiles.ts';
import { readCompositionSnapshot } from './read.ts';

/** An acknowledged command selects one exact use, never every use of its target. */
export interface AcknowledgedStructureOccurrence {
  kind: 'structure-occurrence'; owner: 'structure';
  target: string; component: string; structure: string; profile: string;
  revision: string; receipt: string; occurrence: string;
}

export interface VerifiedStructureOccurrence {
  native: AcknowledgedStructureOccurrence;
  record: OccurrenceRecord;
  /** Root-to-parent occurrence path at the same immutable revision. */
  path: OccurrenceRecord[];
  commandReceipt: CompositionTerminal & { outcome: 'succeeded'; structure: string; revision: string };
  operation: string; manifest: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  headGuarantee: 'verified-before-commit';
}

export class StructureNativeBasisProblem extends Error {
  constructor(readonly status: 403 | 409 | 422 | 503,
    readonly code: 'structure_basis_denied' | 'structure_basis_unavailable'
      | 'structure_target_mismatch' | 'structure_receipt_mismatch'
      | 'structure_head_mismatch' | 'structure_occurrence_retired',
    message: string, options?: ErrorOptions) { super(message, options); }
}

function refuse(code: StructureNativeBasisProblem['code'], message: string): never {
  const status = code === 'structure_basis_denied' ? 403
    : code === 'structure_head_mismatch' || code === 'structure_occurrence_retired' ? 409
    : code === 'structure_basis_unavailable' ? 503 : 422;
  throw new StructureNativeBasisProblem(status, code, message);
}

async function readAcknowledgedOccurrence(session: WorkReadSession,
  basis: AcknowledgedStructureOccurrence): Promise<VerifiedStructureOccurrence> {
  if (!basis || basis.kind !== 'structure-occurrence' || basis.owner !== 'structure'
    || ![basis.target, basis.component, basis.structure, basis.revision, basis.occurrence]
      .every(value => typeof value === 'string' && NATIVE_ID.test(value))
    || typeof basis.profile !== 'string' || basis.profile.length > 64
    || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(basis.profile)) {
    return refuse('structure_target_mismatch', 'An exact native Structure and occurrence are required');
  }
  if (!/^urn:rezics:receipt:[0-9a-f]{64}$/.test(basis.receipt)) {
    return refuse('structure_receipt_mismatch', 'An actual Structure command receipt is required');
  }
  if (!session.fencesSelectedUnits) {
    return refuse('structure_basis_unavailable', 'Acknowledged owner reads require a fenced exact selection');
  }
  basis = structuredClone(basis);
  const principal = session.principal, actor = session.options.actingSubject;
  if (!principal || !actor || !await session.deps.access.activePrincipalId(principal)) {
    return refuse('structure_basis_denied', 'A current verified principal and acting subject are required');
  }
  const canReadOwner = () => canReadCompositionWork(session, basis.target);
  if (!await canReadOwner()) return refuse('structure_basis_denied', 'The Structure owner is unavailable to this principal');
  const env = session.deps.environment;
  const readHead = () => readCompositionHeader(env, basis.structure);
  const header = await readHead();
  if (!header) return refuse('structure_basis_unavailable', 'The native Structure owner is unavailable');
  if (header.owner !== basis.target || header.component !== basis.component || header.profile !== basis.profile) {
    return refuse('structure_target_mismatch', 'The Structure belongs to another exact owner, component or profile');
  }
  const profile = structureProfileFor(header.profile);
  // Work custody is not Collection/Zone authority. Those owners need their own
  // acknowledged-read entry point rather than inheriting this Work admission.
  if (profile.componentType !== `${RV}MainVersion` || profile.componentPredicate !== `${RV}mainVersion`
    || profile.structurePredicate) return refuse('structure_basis_unavailable', 'This Structure owner is not supported by the Work admission');
  if (header.head !== basis.revision) return refuse('structure_head_mismatch', 'The native Structure head changed');
  const disclosureTargets: DisclosureTarget[] = [{ owner: 'graph', resource: basis.structure,
    component: 'structure', revision: basis.revision, work: basis.target }];
  const readDisclosure = () => discloseInventory(env, disclosureTargets, session.viewer, 'read');
  const disclosed = async () => {
    session.checkDeadline();
    const decisions = await readDisclosure();
    // Classify a current denial before recording a changed selection. Keep the
    // same owner read in the final fence so a later withdrawal still refuses.
    if (decisions.length !== 1 || decisions[0] !== 'visible') return false;
    session.observeDependency(`structure-acknowledgement-disclosure:${basis.structure}:${basis.revision}`,
      decisions, readDisclosure);
    return true;
  };
  if (!await disclosed()) return refuse('structure_basis_denied', 'The exact Structure revision is not disclosed');

  const anchors = await session.query(`SELECT ?admission ?operation WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(basis.receipt)} a rv:OperationReceipt ; rv:admissionId ?admission .
      OPTIONAL { ${iri(basis.receipt)} rv:operation ?operation } }
  } LIMIT 2`, 2);
  if (anchors.length !== 1 || !anchors[0]?.admission?.value) {
    return refuse('structure_basis_unavailable', 'The actual Structure command receipt is unavailable');
  }
  const receipt = await readCompositionReceipt(env, anchors[0].admission.value, profile.editAction);
  if (!receipt) return refuse('structure_basis_unavailable', 'The terminal Structure command receipt is unavailable');
  if (receipt.receipt !== basis.receipt
    || receipt.admissionId !== anchors[0].admission.value
    || compositionReceiptIri(receipt.admissionId, profile.editAction) !== basis.receipt
    || receipt.outcome !== 'succeeded' || receipt.structure !== basis.structure || receipt.revision !== basis.revision
    || receipt.scope !== `${profile.editScopePrefix}${header.owner}`) {
    return refuse('structure_receipt_mismatch', 'The command did not acknowledge this exact Structure revision');
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.requestDigest) || !/^\d+$/.test(receipt.authorityEpoch)
    || !receipt.dataEpoch || receipt.owner && receipt.owner !== header.owner
    || receipt.component && receipt.component !== header.component) {
    return refuse('structure_receipt_mismatch', 'The command receipt has no exact native owner binding');
  }
  const operation = anchors[0].operation?.value;
  if (!operation || !NATIVE_ID.test(operation)) {
    return refuse('structure_basis_unavailable', 'The actual Structure command operation is unavailable');
  }
  const revisions = await session.query(`SELECT ?model ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(basis.revision)} a rv:StructureRevision ;
      rv:component ${iri(basis.structure)} ; rv:manifest ${iri(header.manifest)} ;
      rv:generation ${iri(header.generation)} ; rv:operation ${iri(operation)} ;
      rv:modelRevision ?model ; rv:dataEpoch ?epoch ; rv:sequence ?sequence }
  } LIMIT 2`, 2);
  if (revisions.length !== 1 || revisions[0]?.model?.value !== COMPOSITION_PROFILE
    || revisions[0].epoch?.value !== receipt.dataEpoch || revisions[0].sequence?.value !== receipt.sequence) {
    return refuse('structure_basis_unavailable', 'The command and exact Structure revision do not share an owner anchor');
  }

  const snapshot = await readCompositionSnapshot(env, { structure: basis.structure, header, revision: basis.revision });
  if (snapshot.sourcePosition.dataEpoch !== receipt.dataEpoch || snapshot.sourcePosition.sequence !== receipt.sequence) {
    return refuse('structure_basis_unavailable', 'The immutable Structure revision differs from its acknowledgement');
  }
  const records = recordTree(snapshot.objects), order = orderTree(snapshot.objects);
  const readRecord = async (id: string): Promise<OccurrenceRecord> => {
    session.checkDeadline();
    const record = (await records.lookup(snapshot.manifest.records, [id], snapshot.cost)).get(id);
    if (!record) return refuse('structure_basis_unavailable', 'The exact native occurrence is unavailable');
    checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
      profile.selectionRequiredRoles ?? profile.targetRoles, profile.selectionOptionalRoles);
    if (record.state !== 'active') return refuse('structure_occurrence_retired', 'The exact native occurrence was retired');
    const entry = (await order.lookup(snapshot.manifest.order, [orderTreeKey(record as Required<Pick<OccurrenceRecord,
      'parent' | 'segmentKey' | 'orderKey'>>)], snapshot.cost)).values().next().value;
    if (!entry || entry.occurrence !== id || entry.parent !== record.parent
      || entry.segmentKey !== record.segmentKey || entry.orderKey !== record.orderKey) {
      return refuse('structure_basis_unavailable', 'The native occurrence has no exact active order entry');
    }
    return record;
  };
  const record = await readRecord(basis.occurrence), path: OccurrenceRecord[] = [];
  const visited = new Set([basis.occurrence]);
  let parent = record.parent;
  while (parent !== header.structure) {
    if (visited.has(parent) || path.length + 1 >= (profile.maxDepth ?? STRUCTURE_LIMITS.maxDepth)) {
      return refuse('structure_basis_unavailable', 'The exact occurrence ancestry exceeds its native bound');
    }
    visited.add(parent);
    const ancestor = await readRecord(parent);
    if (!isContainerRole(profile, ancestor.role)) return refuse('structure_basis_unavailable', 'The native occurrence parent is not a container');
    path.unshift(ancestor);
    parent = ancestor.parent;
  }
  const targets = [...new Set([record, ...path].flatMap(item => item.target ? [item.target] : []))];
  const readTargets = compositionTargetBatchReader(session, profile);
  const targetsReadable = async () => {
    const readable = await readTargets(targets);
    return targets.every(target => readable.has(target));
  };
  if (!await targetsReadable()) return refuse('structure_basis_denied', 'The exact occurrence target is unavailable to this principal');
  const current = await readHead();
  if (!isDeepStrictEqual(header, current)) return refuse('structure_head_mismatch', 'The native Structure changed during acknowledgement verification');
  if (!await canReadOwner() || !await disclosed() || !await targetsReadable()
    || !await session.deps.access.activePrincipalId(principal)) {
    return refuse('structure_basis_denied', 'Native owner or target authority changed during verification');
  }
  session.observeDependency(`structure-acknowledgement:${basis.structure}`, header, readHead);
  session.observeDependency(`structure-acknowledgement-owner:${basis.target}`, true, canReadOwner);
  session.observeDependency(`structure-acknowledgement-targets:${basis.structure}:${basis.occurrence}`, true, targetsReadable);
  session.checkDeadline();
  return structuredClone({ native: basis, record, path,
    commandReceipt: receipt as VerifiedStructureOccurrence['commandReceipt'], operation, manifest: header.manifest,
    sourcePosition: snapshot.sourcePosition, headGuarantee: 'verified-before-commit' });
}

/** Private native-owner evidence for Source correspondence. This reads an actual
 * terminal command and immutable child; it grants no Source adoption, support,
 * publication or write authority. The caller keeps the same session through its
 * final emission/settlement fence. An old receipt never creates a replacement use.
 */
export async function readAcknowledgedStructureOccurrence(session: WorkReadSession,
  basis: AcknowledgedStructureOccurrence): Promise<VerifiedStructureOccurrence> {
  try { return await readAcknowledgedOccurrence(session, basis); }
  catch (error) {
    if (error instanceof StructureNativeBasisProblem) throw error;
    throw new StructureNativeBasisProblem(503, 'structure_basis_unavailable',
      'Exact native Structure owner evidence is unavailable', { cause: error });
  }
}
