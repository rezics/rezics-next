import { isDeepStrictEqual } from 'node:util';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { PublicationUnavailable, StalePublicationHead } from '../contribution/publish.ts';
import { importRecipe } from '../recipe/importer.ts';
import { GUTENBERG_LICENSE } from '../rights/import-policy.ts';
import { readCompositionPage, readCompositionSnapshot } from '../structure/read.ts';
import type { OccurrenceRecord } from '../structure/format.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import type { WorkStructurePublicationInput } from './structured-publication.ts';
import { GRAPHS, iri, type WorkActivationEnvironment } from './activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from './read-session.ts';

export interface PublicationAttribution {
  record: string; observation: string; provider: string; externalId: string; url: string;
  license: string | null; author: string; transcriber: string;
}

/** Private bytes are inspected only after the exact Work publish admission. */
export async function prepareSourcedStructurePublication(deps: MainWorkDependencies,
  input: Extract<WorkStructurePublicationInput, { operation: 'publish' }>, principal: VerifiedPrincipal)
  : Promise<PublicationAttribution> {
  const refuse = (reason = 'source-incomplete') =>
    new PublicationUnavailable(`The exact public-domain Recipe source is unavailable: ${reason}`);
  const principalId = await deps.access.activePrincipalId?.(principal);
  if (input.rightsBasis !== 'public-domain' || !principalId || !deps.sourceIntake) throw refuse('source-owner');
  const observation = await deps.sourceIntake.read(principalId, input.sourceObservation.slice(-36));
  if (!observation || observation.observation !== input.sourceObservation
    || observation.rightsEvidence.basis !== 'public-domain' || observation.retention !== 'retained'
    || !observation.rawBytesBase64 || !observation.coverage.complete
    || observation.coverage.scope !== 'complete-recipe' || observation.coverage.omittedFields.length
    || !/^application\/(?:json|ld\+json)(?:;|$)/i.test(observation.mediaType)) throw refuse('source-evidence');
  let document: { url?: unknown; author?: { name?: unknown }; license?: unknown };
  try { document = JSON.parse(Buffer.from(observation.rawBytesBase64, 'base64').toString('utf8')); }
  catch { throw refuse(); }
  const url = typeof document.url === 'string' ? document.url : '';
  if (!/^https?:\/\//.test(url) || typeof document.author?.name !== 'string'
    || !document.author.name || document.author.name.length > 200) throw refuse();
  const parsed = importRecipe(document, observation.observation);
  const expected = new Map<string, { role: string; parent: string | null; text?: unknown; labels?: unknown }>([
    ...parsed.ingredients.map(item => [item.sourceKey, { role: 'ingredient', parent: null,
      text: { ...item.qualifier, ...(item.qualifier.parseStatus !== 'parsed'
        ? { residual: `sha256:${parsed.residual}` } : {}) } }] as const),
    ...parsed.steps.map(item => [item.sourceKey, { role: 'step', parent: parsed.sections[item.section]?.sourceKey ?? null,
      text: { value: item.text, language: item.language } }] as const),
    ...parsed.sections.map(item => [item.sourceKey, { role: 'group', parent: parsed.sections[item.parent]?.sourceKey ?? null,
      labels: [{ value: item.label, language: item.language }] }] as const),
  ]);
  const header = await readCompositionHeader(deps.environment, input.structure);
  if (!header || header.profile !== 'recipe-composition' || header.owner !== input.work
    || header.component !== input.expectedMainVersion
    || header.placementCount !== expected.size || !expected.size) throw refuse('structure-owner');
  if (header.head !== input.expectedStructureHead) throw new StalePublicationHead('Recipe Structure head changed');
  const records: OccurrenceRecord[] = [];
  const snapshot = await readCompositionSnapshot(deps.environment, { structure: input.structure, header,
    revision: input.expectedStructureHead });
  const visit = async (parent: string) => {
    let after: string | undefined;
    do {
      const page = await readCompositionPage(deps.environment, { structure: input.structure, header, snapshot,
        revision: input.expectedStructureHead, parent, limit: 100, after, canReadTarget: async () => false });
      for (const record of page.occurrences) {
        records.push(record);
        if (records.length > expected.size) throw refuse();
        if (record.role === 'group') await visit(record.occurrence);
      }
      after = page.next ?? undefined;
    } while (after);
  };
  await visit(input.structure);
  if (!isDeepStrictEqual(records.filter(item => item.role === 'ingredient').map(item => item.sourceKey),
    parsed.ingredients.map(item => item.sourceKey))
    || !isDeepStrictEqual(records.filter(item => item.role === 'step').map(item => item.sourceKey),
      parsed.steps.map(item => item.sourceKey))
    || !isDeepStrictEqual(records.filter(item => item.role === 'group').map(item => item.sourceKey),
      parsed.sections.map(item => item.sourceKey))) throw refuse('source-order');
  const keys = new Map(records.map(record => [record.occurrence, record.sourceKey]));
  if (records.length !== expected.size || new Set(records.map(record => record.sourceKey)).size !== expected.size)
    throw refuse();
  for (const record of records) {
    const wanted = record.sourceKey ? expected.get(record.sourceKey) : undefined;
    const qualifier = record.qualifier;
    if (!wanted || record.role !== wanted.role || record.target && record.target !== record.occurrence
      || (record.parent === input.structure ? null : keys.get(record.parent)) !== wanted.parent
      || wanted.role === 'ingredient' && !isDeepStrictEqual(qualifier, wanted.text)
      || wanted.role === 'step' && (!qualifier || qualifier.type !== 'recipe-step'
        || qualifier.media.length > 0 || qualifier.usesIngredient.length > 0
        || !isDeepStrictEqual(qualifier.instructionText, wanted.text))
      || wanted.role === 'group' && !isDeepStrictEqual(record.labels, wanted.labels)) {
      throw refuse('source-text');
    }
  }
  if ((await discloseInventory(deps.environment, [{ owner: 'source', resource: observation.record,
    component: 'record', revision: observation.observation }], ANONYMOUS_VIEWER, 'read'))[0] !== 'visible') throw refuse('source-disclosure');
  if (!deps.rights || !(await deps.rights.store.structuredPublicationRights(input.work, observation.record)).allowed)
    throw refuse();
  return { record: observation.record, observation: observation.observation, provider: observation.provider,
    externalId: observation.externalId, url, author: document.author.name, transcriber: input.actingSubject,
    license: observation.provider === 'gutenberg' || observation.provider === 'project-gutenberg'
      ? GUTENBERG_LICENSE : typeof document.license === 'string' && /^https?:\/\//.test(document.license)
        ? document.license : null };
}

/** The publication snapshot carries public attribution, never retained Source bytes. */
export async function readPublicationAttribution(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  source: string, observation: string): Promise<PublicationAttribution> {
  const rows = (await env.fuseki.query(`SELECT ?citation WHERE { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(source)} <https://schema.org/citation> ?citation . } } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.citation) throw new WorkReadUnavailable('Publication attribution is unavailable');
  let value: PublicationAttribution;
  try { value = JSON.parse(rows[0].citation.value); }
  catch { throw new WorkReadUnavailable('Publication attribution is invalid'); }
  if (value.observation !== observation || !value.record || !value.author || !value.transcriber
    || !value.provider || !value.externalId || !/^https?:\/\//.test(value.url))
    throw new WorkReadUnavailable('Publication attribution is incomplete');
  return value;
}

export async function selectedPublicationAttribution(session: WorkReadSession,
  source: { source: string; sourceObservation?: string; work: string } | null) {
  if (!source?.sourceObservation) return null;
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
