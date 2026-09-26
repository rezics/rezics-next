import { createHash } from 'node:crypto';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { readSemanticRevision } from '../semantic/read.ts';
import type { SemanticValue } from '../semantic/value.ts';
import { CompositionUnavailable } from '../structure/graph.ts';
import { readCompositionSeal } from '../structure/seal-read.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readFixedRelease } from '../work/fixed-release.ts';
import { readAssessment, readClaimRevisions } from '../verification/graph.ts';
import type { VerificationStore } from '../verification/store.ts';
import type { SourceRunStore } from '../source/acquisition-run.ts';
import { readVndbConceptRun, VndbConceptRunInvalid, VndbConceptRunUnavailable } from '../source/vndb-concept-run.ts';
import { canonicalExport, InvalidExportPlan, planExport, type ExportLoss, type ExportPlan,
  type LicenseScopeHook, type PortableValue, type VerifiedExportMember } from './planner.ts';
import { planVndbSourceExport } from './vndb-source.ts';

export class ExportStale extends Error {}
export class ExportSourceNotFound extends Error {}
export class ExportSourceUnavailable extends Error {}

const sha = (value: unknown) => createHash('sha256').update(canonicalExport(value)).digest('hex');
const unknownRights: LicenseScopeHook = async (members, useScope) => [{ basisKind: 'unprotected_fact',
  basisRef: null, licenseExpression: null, notice: null, obligations: [], useScope,
  result: 'undetermined', memberOrdinals: members.map((_, index) => index + 1) }];

type OwnerPosition = { dataEpoch: string; sequence: string };
export type ExportSelection =
  | { kind: 'fixed-release' | 'assessment'; reference: string; expectedPosition: OwnerPosition }
  | { kind: 'composition-seal'; reference: string; structure: string; expectedPosition: OwnerPosition }
  | { kind: 'semantic-revision'; reference: string; resource: string; expectedPosition: OwnerPosition }
  | { kind: 'vndb-concept-run'; reference: string; expectedPosition: OwnerPosition };

export interface ExportReaderDependencies {
  env: WorkActivationEnvironment;
  canReadWork: (principal: VerifiedPrincipal, actingSubject: string, work: string) => Promise<boolean>;
  canReadSemantic?: (principal: VerifiedPrincipal, actingSubject: string, resource: string) => Promise<boolean>;
  principalIdOf?: (principal: VerifiedPrincipal) => Promise<string | null>;
  sourceRuns?: Pick<SourceRunStore, 'read' | 'frozen'>;
  structureObjects?: ImmutableObjects;
  verification?: Pick<VerificationStore, 'readEvidenceFor'>;
  rights?: LicenseScopeHook;
}

function pinned(actual: OwnerPosition, expected: OwnerPosition, epoch: string, label: string): void {
  if (actual.dataEpoch !== expected.dataEpoch || actual.sequence !== expected.sequence
    || actual.dataEpoch !== epoch) throw new ExportStale(`${label} position differs from requested selection`);
}

/** Keep the original owner value in `data` even where the portable scalar is narrower. */
function portable(value: SemanticValue | { kind: 'unavailable-reference' }): PortableValue | undefined {
  switch (value.kind) {
    case 'unknown': return { kind: 'unknown' };
    case 'no-value': return { kind: 'no-value' };
    case 'boolean': return { kind: 'boolean', value: value.lexical === 'true' };
    case 'integer': case 'decimal': return { kind: value.kind, lexical: value.lexical };
    case 'string': return { kind: 'text', lexical: value.lexical, language: null };
    case 'language-string': return { kind: 'text', lexical: value.lexical, language: value.language };
    case 'temporal': return { kind: 'time', lexical: value.lexical,
      precision: value.precision, calendar: value.calendar, timezone: value.timeZone ?? null,
      before: null, after: null };
    case 'quantity': return { kind: 'quantity', lexical: value.lexical, unit: value.unit,
      lower: null, upper: null };
    default: return undefined;
  }
}

/** Exact readers decide the member payload. No caller-provided member or basis is trusted. */
export async function readExportPlan(deps: ExportReaderDependencies, principal: VerifiedPrincipal,
  actingSubject: string, selection: ExportSelection, useScope: ExportPlan['useScope']): Promise<ExportPlan> {
  if (selection.kind === 'vndb-concept-run') {
    const runId = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(selection.reference)?.[1];
    const principalId = await deps.principalIdOf?.(principal);
    if (!runId || !principalId || !deps.sourceRuns) {
      throw new ExportSourceUnavailable('source run owner is unavailable');
    }
    let snapshot;
    try { snapshot = await readVndbConceptRun(deps.sourceRuns, principalId, runId); }
    catch (error) {
      if (error instanceof VndbConceptRunInvalid || error instanceof VndbConceptRunUnavailable) {
        throw new ExportSourceUnavailable('exact VNDB source-run evidence is unavailable');
      }
      throw error;
    }
    pinned(snapshot.position, selection.expectedPosition, snapshot.position.dataEpoch, 'VNDB source run');
    return planVndbSourceExport(snapshot, actingSubject, useScope, deps.rights ?? unknownRights);
  }
  if (selection.kind === 'fixed-release') {
    const release = await readFixedRelease(deps.env, selection.reference,
      work => deps.canReadWork(principal, actingSubject, work));
    pinned(release.sourcePosition, selection.expectedPosition, deps.env.lineage.dataEpoch, 'fixed release');
    const { body: _body, ...metadata } = release;
    const exportedMetadata = { ...metadata, exportActor: actingSubject };
    const member: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
      sourceGrain: 'main_version', exactRef: release.mainRevision, contentRevisionId: null,
      refDigest: sha(exportedMetadata), ownerDataEpoch: release.sourcePosition.dataEpoch,
      ownerSequence: release.sourcePosition.sequence, sourcePosition: release.selection,
      targetGrain: 'MainVersion', mapping: 'exact', data: exportedMetadata };
    return planExport({ targetProfile: 'rezics-main-version-v1', useScope, members: [member],
      residuals: [
        { memberOrdinal: null, kind: 'missing_member', path: '/externalReleases',
          detail: { reason: 'No verified external release reader is installed' } },
        { memberOrdinal: 1, kind: 'rights_excluded', path: '/body',
          detail: { reason: 'Exact body was checked but this export has no body-use assessment' } },
      ] }, deps.rights ?? unknownRights);
  }
  if (selection.kind === 'composition-seal') {
    const owners = (await deps.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(selection.structure)} a rv:Structure ; rv:structureOf ?main .
        ?work rv:mainVersion ?main . }
    } LIMIT 2`)).results?.bindings ?? [];
    const work = owners[0]?.work?.value;
    if (owners.length !== 1 || !work
      || !await deps.canReadWork(principal, actingSubject, work)) {
      throw new ExportSourceNotFound('composition authority is unavailable');
    }
    const env = deps.structureObjects
      ? { ...deps.env, structureObjects: deps.structureObjects } : deps.env;
    const pins: Awaited<ReturnType<typeof readCompositionSeal>>['pins'] = [];
    let cursor: string | undefined;
    let coverage: 'complete' | 'partial' | undefined;
    let unavailableCount: number | undefined;
    let revision: string | undefined;
    do {
      let page: Awaited<ReturnType<typeof readCompositionSeal>>;
      try { page = await readCompositionSeal(env, { structure: selection.structure,
        seal: selection.reference, ...(cursor ? { after: cursor } : {}), limit: 100,
        canReadTarget: target => deps.canReadWork(principal, actingSubject, target) }); }
      catch (error) {
        if (error instanceof CompositionUnavailable) throw new ExportSourceNotFound(error.message);
        throw error;
      }
      pinned(page.sourcePosition, selection.expectedPosition, deps.env.lineage.dataEpoch, 'composition seal');
      if (coverage !== undefined && (coverage !== page.coverage
        || unavailableCount !== page.unavailableCount || revision !== page.structureRevision)) {
        throw new ExportStale('composition seal pages differ');
      }
      coverage = page.coverage;
      unavailableCount = page.unavailableCount;
      revision = page.structureRevision;
      pins.push(...page.pins);
      if (pins.length > 255) throw new InvalidExportPlan('composition seal exceeds export member limit');
      cursor = page.next ?? undefined;
    } while (cursor);
    const rootData = { structure: selection.structure, seal: selection.reference,
      structureRevision: revision!, coverage: coverage!, unavailableCount: unavailableCount!,
      exportActor: actingSubject };
    const position = selection.expectedPosition;
    const root: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
      sourceGrain: 'structure_revision', exactRef: revision!, contentRevisionId: null,
      refDigest: sha(rootData), ownerDataEpoch: position.dataEpoch, ownerSequence: position.sequence,
      sourcePosition: null, targetGrain: 'StructureSeal', mapping: 'exact', data: rootData };
    const members: VerifiedExportMember[] = [root, ...pins.map(pin => ({
      sourceOwner: 'graph' as const, sourceNamespace: 'product', sourceGrain: 'occurrence' as const,
      exactRef: pin.occurrence, contentRevisionId: null, refDigest: sha(pin),
      ownerDataEpoch: position.dataEpoch, ownerSequence: position.sequence,
      sourcePosition: pin.variant ? `${pin.occurrence}/${pin.variant}` : pin.occurrence,
      targetGrain: 'OccurrenceUse', mapping: 'exact' as const, data: { ...pin },
    }))];
    const residuals: ExportLoss[] = pins.flatMap((pin, index) => pin.unavailable
      ? [{ memberOrdinal: index + 2, kind: pin.unavailable === 'undisclosed'
        ? 'private_dependency' as const : 'unavailable' as const, path: '/target',
        detail: { availability: pin.unavailable } }] : []);
    if (coverage === 'partial' && !residuals.length) residuals.push({ memberOrdinal: 1,
      kind: 'unavailable', path: '/coverage', detail: { unavailableCount } });
    return planExport({ targetProfile: 'rezics-composition-v1', useScope, members,
      residuals }, deps.rights ?? unknownRights);
  }
  if (selection.kind === 'semantic-revision') {
    if (!deps.canReadSemantic || !await deps.canReadSemantic(principal, actingSubject, selection.resource)) {
      throw new ExportSourceNotFound('semantic resource is unavailable');
    }
    const exact = await readSemanticRevision(deps.env, selection.resource, selection.reference,
      resource => deps.canReadSemantic!(principal, actingSubject, resource));
    if (!exact || exact.state.component !== 'resource') {
      throw new ExportSourceNotFound('semantic revision is unavailable');
    }
    pinned(exact.sourcePosition, selection.expectedPosition, deps.env.lineage.dataEpoch, 'semantic revision');
    const rootData = { resource: exact.component, revision: exact.revision,
      types: exact.state.types, lifecycle: exact.state.lifecycle, exportActor: actingSubject };
    const root: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
      sourceGrain: 'value', exactRef: exact.revision, contentRevisionId: null,
      refDigest: sha(rootData), ownerDataEpoch: exact.sourcePosition.dataEpoch,
      ownerSequence: exact.sourcePosition.sequence, sourcePosition: null,
      targetGrain: 'SemanticResource', mapping: 'exact', data: rootData };
    const members: VerifiedExportMember[] = [root, ...exact.state.properties.map((property, index) => {
      const data = { predicate: property.predicate, semanticValue: property.value,
        ...(property.node ? { node: property.node } : {}) };
      return { sourceOwner: 'graph' as const, sourceNamespace: 'product', sourceGrain: 'value' as const,
        exactRef: `${exact.revision}#property-${index + 1}`, contentRevisionId: null,
        refDigest: sha(data), ownerDataEpoch: exact.sourcePosition.dataEpoch,
        ownerSequence: exact.sourcePosition.sequence, sourcePosition: String(index + 1),
        targetGrain: 'SemanticProperty', mapping: 'exact' as const,
        ...(portable(property.value) ? { value: portable(property.value) } : {}), data };
    })];
    const residuals: ExportLoss[] = exact.state.properties.flatMap((property, index) =>
      property.value.kind === 'unavailable-reference'
        ? [{ memberOrdinal: index + 2, kind: 'private_dependency' as const, path: '/value',
          detail: { reason: 'Referenced resource is not readable' } }] : []);
    return planExport({ targetProfile: 'rezics-semantic-values-v1', useScope, members,
      residuals }, deps.rights ?? unknownRights);
  }
  if (!deps.verification) throw new ExportSourceUnavailable('verification owner is unavailable');
  const assessment = await readAssessment(deps.env, selection.reference);
  if (!assessment) throw new ExportSourceUnavailable('assessment is unavailable');
  pinned(assessment, selection.expectedPosition, deps.env.lineage.dataEpoch, 'assessment');
  const claim = (await readClaimRevisions(deps.env, [assessment.claimRevision])).get(assessment.claimRevision);
  if (!claim || claim.claim !== assessment.claim) throw new ExportSourceUnavailable('claim revision is unavailable');
  const principalId = await deps.principalIdOf?.(principal);
  if (!principalId) throw new ExportSourceUnavailable('verification principal is unavailable');
  const evidence = await deps.verification.readEvidenceFor(
    assessment.evidenceSetRevision.split('/').at(-1)!, principalId);
  const evidenceItems = evidence?.items.map(item => ({ ordinal: item.ordinal,
    stance: item.stance, recordedAvailability: item.availability,
    currentAvailability: item.currentAvailability })) ?? [];
  const claimMember: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
    sourceGrain: 'claim', exactRef: assessment.claimRevision, contentRevisionId: null,
    refDigest: sha(claim), ownerDataEpoch: claim.dataEpoch, ownerSequence: claim.sequence,
    sourcePosition: null, targetGrain: 'Claim', mapping: 'exact', data: { ...claim } };
  const assessmentData = { ...assessment, exportActor: actingSubject,
    scoreKind: assessment.scorePerMillion === null
    ? null : 'method-output', evidence: evidence ? {
      revision: evidence.revision, manifestDigest: evidence.manifestDigest,
      itemCount: evidence.itemCount, items: evidenceItems } : null };
  const assessmentMember: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
    sourceGrain: 'assessment', exactRef: assessment.assessment, contentRevisionId: null,
    refDigest: sha(assessmentData), ownerDataEpoch: assessment.dataEpoch,
    ownerSequence: assessment.sequence, sourcePosition: assessment.evaluationContext,
    targetGrain: 'Assessment', mapping: 'exact', data: assessmentData };
  const residuals: ExportLoss[] = evidence ? evidence.items.map(item => ({ memberOrdinal: 2,
    kind: 'private_dependency' as const, path: `/evidence/items/${item.ordinal}/anchor`,
    detail: { reason: 'The cited anchor has no export disclosure proof' } }))
    : [{ memberOrdinal: 2, kind: 'private_dependency' as const, path: '/evidence',
      detail: { reason: 'Evidence is not disclosed to this principal' } }];
  residuals.push({ memberOrdinal: 2, kind: 'unavailable', path: '/methodCalibration',
    detail: { reason: 'No representative labelled calibration record was verified for this method' } });
  return planExport({ targetProfile: 'rezics-verification-v1', useScope,
    members: [claimMember, assessmentMember], residuals }, deps.rights ?? unknownRights);
}
