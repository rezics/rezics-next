import { createHash } from 'node:crypto';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { readSemanticRevision } from '../semantic/read.ts';
import type { SemanticValue } from '../semantic/value.ts';
import { CompositionUnavailable } from '../structure/graph.ts';
import { readCompositionSeal } from '../structure/seal-read.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readFixedRelease } from '../work/fixed-release.ts';
import { unverifiedWorks } from '../catalogue-intake/store.ts';
import { readAssessment, readClaimRevisions } from '../verification/graph.ts';
import type { VerificationStore } from '../verification/store.ts';
import type { SourceRunStore } from '../source/acquisition-run.ts';
import { readVndbConceptRun, VndbConceptRunInvalid, VndbConceptRunUnavailable } from '../source/vndb-concept-run.ts';
import { attachRightsIdentities, canonicalExport, InvalidExportPlan, planExport,
  type ExportLoss, type ExportPlan, type ExportRightsIdentity, type LicenseScopeHook,
  type PortableValue, type VerifiedExportMember } from './planner.ts';
import { planVndbSourceExport } from './vndb-source.ts';
import { readWikiExport } from './wiki.ts';
import type { WikiRevisionSet } from '../wiki/delta.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { discloseInventory, type DisclosureTarget } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import type { Viewer } from '../suitability/policy.ts';

export class ExportStale extends Error {}
export class ExportSourceNotFound extends Error {}
export class ExportSourceUnavailable extends Error {}

const sha = (value: unknown) => createHash('sha256').update(canonicalExport(value)).digest('hex');
const unknownRights: LicenseScopeHook = async (members, useScope) => [{ basisKind: 'unprotected_fact',
  basisRef: null, licenseExpression: null, notice: null, obligations: [], useScope,
  result: 'undetermined', memberOrdinals: members.map((_, index) => index + 1) }];

type OwnerPosition = { dataEpoch: string; sequence: string };
export type ExportSelection =
  | { kind: 'wiki-revision-set'; reference: string; revisions: WikiRevisionSet; expectedPosition: OwnerPosition;
    scope?: import('../wiki/history-read.ts').WikiHistoryScope }
  | { kind: 'fixed-release' | 'assessment'; reference: string; expectedPosition: OwnerPosition }
  | { kind: 'composition-seal'; reference: string; structure: string; expectedPosition: OwnerPosition }
  | { kind: 'semantic-revision'; reference: string; resource: string; expectedPosition: OwnerPosition }
  | { kind: 'vndb-concept-run'; reference: string; expectedPosition: OwnerPosition };

export interface ExportReaderDependencies {
  wiki?: MainWorkDependencies;
  env: WorkActivationEnvironment;
  canReadWork: (principal: VerifiedPrincipal, actingSubject: string, work: string) => Promise<boolean>;
  canReadSemantic?: (principal: VerifiedPrincipal, actingSubject: string, resource: string, revision?: string) => Promise<boolean>;
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

const observationId = (value: string | undefined): string | null => {
  const match = value?.match(/^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  return match?.[1] ?? null;
};

function rightsIdentityFor(member: VerifiedExportMember): ExportRightsIdentity {
  const data = member.data ?? {};
  const component = member.sourceGrain === 'main_version' ? 'publication'
    : member.sourceGrain === 'structure_revision' || member.sourceGrain === 'occurrence' ? 'structure'
      : member.sourceOwner === 'object' ? 'cover'
      : 'record';
  const targetResource = member.sourceOwner === 'source'
    ? (typeof data.observation === 'string' ? data.observation
      : typeof data.run === 'string' ? data.run : member.exactRef)
    : (typeof data.resource === 'string' ? data.resource
      : typeof data.structure === 'string' ? data.structure
        : typeof data.mainVersion === 'string' ? data.mainVersion
          : typeof data.claim === 'string' ? data.claim
            : typeof data.assessment === 'string' ? data.assessment : member.exactRef);
  const exactRevision = member.contentRevisionId ?? member.exactRef;
  const material = member.sourceOwner === 'source'
    ? { scopeKind: 'source_record' as const, provider: null, namespace: null,
      sourceRecordId: observationId(typeof data.observation === 'string' ? data.observation
        : typeof data.run === 'string' ? data.run : member.exactRef),
      contentVariantId: null, mediaAsset: null, component }
    : member.sourceOwner === 'object'
      ? { scopeKind: 'media_asset' as const, provider: null, namespace: null,
        sourceRecordId: null, contentVariantId: null, mediaAsset: member.exactRef, component }
    : { scopeKind: 'content_variant' as const, provider: null, namespace: null,
      sourceRecordId: null, contentVariantId: exactRevision, mediaAsset: null, component };
  if (material.scopeKind === 'source_record' && material.sourceRecordId === null) {
    throw new InvalidExportPlan('source member lacks an exact rights record identity');
  }
  return { material, target: { owner: member.sourceOwner === 'object' ? 'media' : member.sourceOwner,
    resource: targetResource,
    component, revision: exactRevision } };
}

async function planFromOwner(input: { targetProfile: string; useScope: ExportPlan['useScope'];
  members: readonly VerifiedExportMember[]; residuals: readonly ExportLoss[] }, rights?: LicenseScopeHook) {
  const identities = input.members.map(rightsIdentityFor);
  const members = await attachRightsIdentities(input.members, identities);
  return planExport({ ...input, members }, rights ?? unknownRights);
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
async function readExportPlanUnchecked(deps: ExportReaderDependencies, principal: VerifiedPrincipal,
  actingSubject: string, selection: ExportSelection, useScope: ExportPlan['useScope']): Promise<ExportPlan> {
  if (selection.kind === 'wiki-revision-set') {
    if (!deps.wiki) throw new ExportSourceUnavailable('Wiki owner is unavailable');
    if (selection.expectedPosition.dataEpoch !== deps.env.lineage.dataEpoch) throw new ExportStale('Wiki epoch changed');
    return readWikiExport(deps.wiki, principal, actingSubject, selection.reference, selection.revisions,
      selection.expectedPosition, useScope, deps.rights, selection.scope);
  }
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
    if ((await unverifiedWorks(deps.env, [release.work])).size) throw new ExportSourceNotFound('Work awaits catalogue verification');
    pinned(release.sourcePosition, selection.expectedPosition, deps.env.lineage.dataEpoch, 'fixed release');
    const { body: _body, externalReleases: links, ...metadata } = release;
    const exportedMetadata = { ...metadata, externalReleaseCount: links.length,
      exportActor: actingSubject };
    const member: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
      sourceGrain: 'main_version', exactRef: release.mainRevision, contentRevisionId: null,
      refDigest: sha(exportedMetadata), ownerDataEpoch: release.sourcePosition.dataEpoch,
      ownerSequence: release.sourcePosition.sequence, sourcePosition: release.selection,
      targetGrain: 'MainVersion', mapping: 'exact', data: exportedMetadata };
    const members: VerifiedExportMember[] = [member];
    const residuals: ExportLoss[] = [{ memberOrdinal: 1, kind: 'rights_excluded', path: '/body',
      detail: { reason: 'Exact body was checked but this export has no body-use assessment' } }];
    if (!links.length) residuals.push({ memberOrdinal: null, kind: 'missing_member',
      path: '/externalReleases', detail: { reason: 'No external release was sealed with this fixed release' } });
    const snapshots = new Map<string, Awaited<ReturnType<typeof readVndbConceptRun>>>();
    for (const [index, link] of links.entries()) {
      if (!deps.sourceRuns) throw new ExportSourceUnavailable('source-run owner is unavailable');
      let snapshot = snapshots.get(link.run);
      if (!snapshot) {
        try { snapshot = await readVndbConceptRun(deps.sourceRuns, link.sourcePrincipalId,
          link.run.split('/').at(-1)!); }
        catch (error) {
          if (error instanceof VndbConceptRunInvalid || error instanceof VndbConceptRunUnavailable) {
            throw new ExportSourceUnavailable('linked external release evidence is unavailable');
          }
          throw error;
        }
        snapshots.set(link.run, snapshot);
      }
      const claim = snapshot.projection.claims.find(item => item.key === link.sourceClaim
        && item.kind === 'appearance' && item.release === link.release);
      const capture = snapshot.captures.find(item => item.surface === 'character');
      if (snapshot.run !== link.run || snapshot.position.dataEpoch !== link.expectedPosition.dataEpoch
        || snapshot.position.sequence !== link.expectedPosition.sequence || !claim || !capture
        || capture.observation !== link.observation || capture.digest !== link.captureDigest
        || claim.captureDigest !== capture.digest) {
        throw new ExportSourceUnavailable('linked external release differs from sealed evidence');
      }
      const data = { provider: snapshot.provider, run: snapshot.run, release: link.release,
        sourceClaim: link.sourceClaim, observation: link.observation,
        captureDigest: link.captureDigest, sourcePosition: snapshot.position,
        fixedRelease: release.release, exportActor: actingSubject };
      members.push({ sourceOwner: 'source', sourceNamespace: snapshot.provider,
        sourceGrain: 'external_release', exactRef: link.release, contentRevisionId: null,
        refDigest: sha(data), ownerDataEpoch: snapshot.position.dataEpoch,
        ownerSequence: snapshot.position.sequence, sourcePosition: link.sourceClaim,
        targetGrain: 'PublicationIssue', mapping: 'exact', data });
      // The source occurrence proves an external release ID, not an edition parent.
      residuals.push({ memberOrdinal: index + 2, kind: 'qualified_claim', path: '/edition',
        detail: { reason: 'Source occurrence does not identify an edition parent' } });
    }
    return planFromOwner({ targetProfile: 'rezics-main-version-v1', useScope, members,
      residuals }, deps.rights);
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
    if ((await unverifiedWorks(deps.env, [work])).size) throw new ExportSourceNotFound('Work awaits catalogue verification');
    const pins: Awaited<ReturnType<typeof readCompositionSeal>>['pins'] = [];
    let cursor: string | undefined;
    let coverage: 'complete' | 'partial' | undefined;
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
      if (coverage !== undefined && (coverage !== page.coverage || revision !== page.structureRevision)) {
        throw new ExportStale('composition seal pages differ');
      }
      coverage = page.coverage;
      revision = page.structureRevision;
      pins.push(...page.pins);
      if (pins.length > 255) throw new InvalidExportPlan('composition seal exceeds export member limit');
      cursor = page.next ?? undefined;
    } while (cursor);
    const rootData = { structure: selection.structure, seal: selection.reference,
      structureRevision: revision!, coverage: coverage!,
      exportActor: actingSubject };
    const position = selection.expectedPosition;
    for (let offset = 0; offset < pins.length; offset += 128) {
      const targets = pins.slice(offset, offset + 128).flatMap(pin => pin.target ? [pin.target] : []);
      if ((await unverifiedWorks(deps.env, targets)).size) throw new ExportSourceNotFound('Composition includes a Work awaiting catalogue verification');
    }
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
      kind: 'unavailable', path: '/coverage', detail: { coverage } });
    return planFromOwner({ targetProfile: 'rezics-composition-v1', useScope, members,
      residuals }, deps.rights);
  }
  if (selection.kind === 'semantic-revision') {
    if (!deps.canReadSemantic || !await deps.canReadSemantic(principal, actingSubject, selection.resource, selection.reference)) {
      throw new ExportSourceNotFound('semantic resource is unavailable');
    }
    // Establish exact-history authority before probing current catalogue state
    // or hydrating bytes. Denied and absent sources share the same 404 even if
    // a later disclosure/verification owner is unavailable.
    if ((await unverifiedWorks(deps.env, [selection.resource])).size) throw new ExportSourceNotFound('Work awaits catalogue verification');
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
    return planFromOwner({ targetProfile: 'rezics-semantic-values-v1', useScope, members,
      residuals }, deps.rights);
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
  return planFromOwner({ targetProfile: 'rezics-verification-v1', useScope,
    members: [claimMember, assessmentMember], residuals }, deps.rights);
}

/** Retain an explicit, payload-free omission at each denied member ordinal.
 * License notices covering a denied member cannot survive via the manifest. */
export async function discloseExportPlan(env: WorkActivationEnvironment, plan: ExportPlan, viewer: Viewer): Promise<ExportPlan> {
  const native = (value: unknown) => typeof value === 'string'
    ? /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}/.exec(value)?.[0] ?? null : null;
  const root = native(plan.members[0]?.data?.resource) ?? native(plan.members[0]?.data?.work);
  const targets: DisclosureTarget[] = [], ranges: number[][] = [];
  for (const member of plan.members) {
    const identity = rightsIdentityFor(member);
    const resource = native(identity.target.resource) ?? root;
    const work = native(member.data?.work) ?? root;
    const selected: DisclosureTarget[] = resource ? [{ owner: identity.target.owner, resource,
      component: member.sourceOwner === 'content' ? 'body' : identity.target.component as DisclosureTarget['component'],
      revision: identity.target.revision, work },
    { owner: 'graph', resource: work ?? resource, component: 'name' }] : [];
    ranges.push(selected.map((_, index) => targets.length + index));
    targets.push(...selected);
  }
  const decisions = await discloseInventory(env, targets, viewer, 'export');
  const denied = new Set(plan.members.filter((_, index) => !ranges[index]!.length
    || ranges[index]!.some(ordinal => decisions[ordinal] !== 'visible')).map(member => member.ordinal));
  if (!denied.size) return plan;
  const members = plan.members.map(member => {
    if (!denied.has(member.ordinal)) return member;
    const { data: _data, value: _value, ...identity } = member;
    return { ...identity, mapping: 'unmapped' as const, targetGrain: null,
      refDigest: sha({ omitted: 'disclosure_restricted' }), data: { omitted: 'disclosure_restricted' } };
  });
  const residuals: ExportLoss[] = [...plan.residuals.filter(loss => loss.memberOrdinal === null
    || !denied.has(loss.memberOrdinal)), ...[...denied].flatMap(memberOrdinal => [
      { memberOrdinal, kind: 'private_dependency' as const, path: null, detail: { reason: 'disclosure_restricted' } },
      { memberOrdinal, kind: 'unmapped_grain' as const, path: null, detail: { reason: 'omitted' } },
    ])];
  return planExport({ targetProfile: plan.targetProfile, useScope: plan.useScope, members, residuals },
    async () => plan.bases.filter(basis => !basis.memberOrdinals.some(ordinal => denied.has(ordinal))));
}

export async function readExportPlan(deps: ExportReaderDependencies, principal: VerifiedPrincipal,
  actingSubject: string, selection: ExportSelection, useScope: ExportPlan['useScope']): Promise<ExportPlan> {
  return discloseExportPlan(deps.env, await readExportPlanUnchecked(deps, principal, actingSubject, selection, useScope),
    disclosureViewer(principal));
}
