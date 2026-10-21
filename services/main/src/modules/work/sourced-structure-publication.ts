import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionUnavailable, type VerifiedPrincipal } from '../access/admission.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { PublicationUnavailable, StalePublicationHead } from '../contribution/publish.ts';
import { workPublicationProfileFor } from '../structure/profiles.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import type { WorkStructurePublicationInput } from './structured-publication.ts';
import { GRAPHS, iri, type WorkActivationEnvironment } from './activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from './read-session.ts';
import { WorkStructurePublicationRightsDenied } from './structured-publication.ts';

export interface PublicationAttribution {
  record: string; observation: string; provider: string; externalId: string; url: string;
  license: string | null; author: string | null; transcriber: string;
}

export interface ManualPublicationCitation {
  url: string; license: string | null; author: string | null;
}

export interface ManualPublicationAttribution extends ManualPublicationCitation {
  kind: 'manual-citation'; rightsAssessmentId: string; transcriber: string;
}

export type VerifiedPublicationAttribution = (PublicationAttribution | ManualPublicationAttribution)
  & { structure: string; structureRevision: string };

const assessmentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
function citationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

export function validManualPublicationCitation(value: ManualPublicationCitation): boolean {
  return !!value && citationUrl(value.url) && (value.license === null || citationUrl(value.license))
    && (value.author === null || typeof value.author === 'string' && value.author.length > 0
      && value.author.length <= 200);
}

/** Citation describes the authored source; only the current Rights owner grants the basis. */
export async function verifyManualPublicationRights(deps: Pick<MainWorkDependencies, 'rights'>,
  work: string, id: string): Promise<void> {
  if (!deps.rights || !assessmentId.test(id)) throw new AdmissionUnavailable('Publication rights are unavailable');
  let current: boolean;
  try { current = await deps.rights.store.currentPublicDomainAssessment(work, id); }
  catch (cause) { throw new AdmissionUnavailable('Publication rights are unavailable', { cause }); }
  if (!current)
    throw new WorkStructurePublicationRightsDenied('A current public-domain Work assessment is required');
}

/** Private bytes are inspected only after the exact Work publish admission. */
export async function prepareSourcedStructurePublication(deps: MainWorkDependencies,
  input: Extract<WorkStructurePublicationInput, { operation: 'publish' }>, principal: VerifiedPrincipal)
  : Promise<VerifiedPublicationAttribution> {
  const refuse = (reason = 'source-incomplete') =>
    new PublicationUnavailable(`The exact public-domain source is unavailable: ${reason}`);
  if (input.rightsBasis === 'public-domain' && input.sourceObservation === undefined) {
    if (!validManualPublicationCitation(input.citation)) throw refuse('citation');
    await verifyManualPublicationRights(deps, input.work, input.rightsAssessmentId);
    const header = await readCompositionHeader(deps.environment, input.structure);
    if (!header || header.owner !== input.work || header.component !== input.expectedMainVersion)
      throw refuse('structure-owner');
    if (header.head !== input.expectedStructureHead) throw new StalePublicationHead('Structure head changed');
    return { kind: 'manual-citation', ...input.citation, rightsAssessmentId: input.rightsAssessmentId,
      transcriber: input.actingSubject, structure: header.structure, structureRevision: header.head };
  }
  const principalId = await deps.access.activePrincipalId?.(principal);
  if (input.rightsBasis !== 'public-domain' || !principalId || !deps.sourceIntake) throw refuse('source-owner');
  const observation = await deps.sourceIntake.read(principalId, input.sourceObservation.slice(-36));
  if (!observation || observation.observation !== input.sourceObservation
    || observation.rightsEvidence.basis !== 'public-domain' || observation.retention !== 'retained'
    || !observation.rawBytesBase64 || !observation.coverage.complete
    || observation.coverage.omittedFields.length) throw refuse('source-evidence');
  const header = await readCompositionHeader(deps.environment, input.structure);
  if (!header || header.owner !== input.work || header.component !== input.expectedMainVersion)
    throw refuse('structure-owner');
  if (header.head !== input.expectedStructureHead) throw new StalePublicationHead('Structure head changed');
  let profile;
  try { profile = workPublicationProfileFor(header.profile); }
  catch { throw refuse('structure-profile'); }
  if (!profile.verifySourceCorrespondence) throw refuse('source-profile');
  const evidence = await profile.verifySourceCorrespondence({ environment: deps.environment, observation, header });
  if (evidence.observation !== observation.observation || evidence.structure !== input.structure
    || evidence.revision !== input.expectedStructureHead) throw refuse('source-correspondence');
  const { url, author, license } = evidence.attribution;
  if (!/^https?:\/\//.test(url) || author !== null && (typeof author !== 'string' || !author || author.length > 200)
    || license !== null && !/^https?:\/\//.test(license)) throw refuse('source-attribution');
  if ((await discloseInventory(deps.environment, [{ owner: 'source', resource: observation.record,
    component: 'record', revision: observation.observation }], ANONYMOUS_VIEWER, 'read'))[0] !== 'visible') throw refuse('source-disclosure');
  if (!deps.rights || !(await deps.rights.store.structuredPublicationRights(input.work, observation.record)).allowed)
    throw refuse();
  return { record: observation.record, observation: observation.observation, provider: observation.provider,
    externalId: observation.externalId, url, author, license, transcriber: input.actingSubject,
    structure: evidence.structure, structureRevision: evidence.revision };
}

/** The publication snapshot carries public attribution, never retained Source bytes. */
export async function readPublicationAttribution(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  source: string, observation: string): Promise<PublicationAttribution>;
export async function readPublicationAttribution(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  source: string, observation: undefined): Promise<ManualPublicationAttribution>;
export async function readPublicationAttribution(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  source: string, observation: string | undefined): Promise<PublicationAttribution | ManualPublicationAttribution> {
  const rows = (await env.fuseki.query(`SELECT ?citation WHERE { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(source)} <https://schema.org/citation> ?citation . } } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.citation) throw new WorkReadUnavailable('Publication attribution is unavailable');
  let value: PublicationAttribution | ManualPublicationAttribution;
  try { value = JSON.parse(rows[0].citation.value); }
  catch { throw new WorkReadUnavailable('Publication attribution is invalid'); }
  if (observation === undefined) {
    if (!value || !('kind' in value) || value.kind !== 'manual-citation'
      || !assessmentId.test(value.rightsAssessmentId) || !nativeId.test(value.transcriber)
      || !validManualPublicationCitation(value)
      || ['record', 'observation', 'provider', 'externalId'].some(key => key in value))
      throw new WorkReadUnavailable('Manual publication attribution is incomplete');
    return value;
  }
  if (!value || !('record' in value)) throw new WorkReadUnavailable('Publication attribution is incomplete');
  if (value.observation !== observation || !value.record || value.author !== null && (typeof value.author !== 'string' || !value.author) || !value.transcriber
    || !value.provider || !value.externalId || !/^https?:\/\//.test(value.url))
    throw new WorkReadUnavailable('Publication attribution is incomplete');
  return value;
}

export async function selectedPublicationAttribution(session: WorkReadSession,
  source: { source: string; sourceObservation?: string; rightsAssessmentId?: string; work: string } | null) {
  if (!source) return null;
  if (!source.sourceObservation) {
    if (!source.rightsAssessmentId) return null;
    const attribution = await session.retained(`publication-attribution:${source.source}`,
      () => readPublicationAttribution(session.deps.environment, source.source, undefined));
    if (attribution.rightsAssessmentId !== source.rightsAssessmentId)
      throw new WorkReadUnavailable('Publication assessment does not match its citation');
    const store = session.deps.rights?.store;
    if (!store) throw new WorkReadUnavailable('Publication rights are unavailable');
    const read = async () => {
      try { return await store.currentPublicDomainAssessment(source.work, attribution.rightsAssessmentId); }
      catch (cause) { throw new WorkReadUnavailable('Publication rights are unavailable', { cause }); }
    };
    const current = await read();
    if (!current) throw new WorkReadMissing('Publication rights do not permit delivery');
    session.observeDependency(`structured-publication-rights:${source.source}`, current, read);
    return attribution;
  }
  const attribution = await session.retained(`publication-attribution:${source.source}`,
    () => readPublicationAttribution(session.deps.environment, source.source, source.sourceObservation!));
  if ((await session.disclosure([{ owner: 'source', resource: attribution.record, component: 'record',
    revision: attribution.observation }]))[0] !== 'visible')
    throw new WorkReadUnavailable('Publication source is unavailable');
  const store = session.deps.rights?.store;
  if (!store) throw new WorkReadUnavailable('Publication rights are unavailable');
  const read = () => store.structuredPublicationRights(source.work, attribution.record);
  const rights = await read();
  if (!rights.allowed) throw new WorkReadMissing('Publication rights do not permit delivery');
  session.observeDependency(`structured-publication-rights:${source.source}`, rights, read);
  return attribution;
}
