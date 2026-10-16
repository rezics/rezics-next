import { checkExactInstructionSelection } from '../structure/selection.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { canReadContentTarget, resolveContentTarget } from '../content-publication/draft.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { ExactInstructionSelector } from '../structure/selection.ts';
import { readCompositionHeader, roleIri } from '../structure/graph.ts';
import { structureProfileFor, type StructureProfileRegistration } from '../structure/profiles.ts';
import { PublicationUnavailable, StalePublicationHead } from '../contribution/publish.ts';
import { GRAPHS, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { readPublicationAttribution } from './sourced-structure-publication.ts';
import { readPublishedStructuredWorkSources, admittedPublicWorks } from './public-patterns.ts';
import type { Viewer } from '../suitability/policy.ts';
import type { DisclosureChannel } from '../disclosure/read.ts';

export interface InstructionAdoption {
  occurrence: string; target: string; selector: ExactInstructionSelector; mediaUse?: string;
}

/** An immutable publication retains the exact dependency cut, independently of later drafts. */
export function instructionAdoptionTriples(source: string, adoptions: readonly InstructionAdoption[],
  profile?: StructureProfileRegistration): string {
  return adoptions.map(adoption => {
    const node = `urn:rezics:instruction-adoption:${hash(`${source}\0${adoption.occurrence}`)}`;
    return `${iri(source)} <https://rezics.com/vocab/publicationDependency> ${iri(node)} .
      ${profile?.projectPublicationDependency?.(source, node) ?? ''}
      ${iri(node)} a <http://www.w3.org/ns/oa#SpecificResource> ;
        <http://www.w3.org/ns/oa#hasSource> ${iri(adoption.target)} ;
        <http://www.w3.org/ns/oa#hasState> ${iri(`${node}:state`)} ;
        <https://schema.org/identifier> ${iri(adoption.occurrence)} ;
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> ${lit(JSON.stringify(adoption.selector))}
        ${adoption.mediaUse ? `; <https://schema.org/associatedMedia> ${iri(`https://rezics.com/id/${adoption.mediaUse}`)}` : ''} .
      ${iri(`${node}:state`)} a <http://www.w3.org/ns/oa#TimeState> ;
        <http://www.w3.org/ns/oa#cachedSource> ${iri(`urn:rezics:content:revision:${adoption.selector.revision}`)} .`;
  }).join('\n');
}

interface InstructionAdoptionSelection {
  work?: string; revision?: string; contentRevision?: string; target?: string;
  mediaRevision?: string; mediaUse?: string; mediaUses?: readonly string[];
  occurrences?: readonly string[];
}

/** Manifest identity only. Callers must disclose the exact Use before returning any selection. */
export async function readInstructionAdoptionCandidates(env: WorkActivationEnvironment,
  selection: InstructionAdoptionSelection): Promise<(InstructionAdoption & { work: string })[]> {
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?work ?occurrence ?target ?selector ?use WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${selection.work ? iri(selection.work) : '?work'} rv:workStructurePublicationHead ?decision .
        ${selection.work ? `BIND(${iri(selection.work)} AS ?work)` : ''} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?decision a rv:WorkStructurePublicationDecision ; rv:publicationOutcome rv:Published ; rv:publicSource ?source .
        ?source rv:work ?work ; rv:structureRevision ${selection.revision ? iri(selection.revision) : '?structureRevision'} ;
          <https://rezics.com/vocab/publicationDependency> ?adoption .
        ?adoption <http://www.w3.org/ns/oa#hasSource> ?target ; <https://schema.org/identifier> ?occurrence ;
          <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> ?selector .
        OPTIONAL { ?adoption <https://schema.org/associatedMedia> ?use }
        ${selection.mediaUse ? `FILTER(?use = ${iri(`https://rezics.com/id/${selection.mediaUse}`)})` : ''}
        ${selection.target ? `FILTER(?target = ${iri(selection.target)})` : ''}
        ${selection.occurrences ? `VALUES ?occurrence { ${selection.occurrences.map(iri).join(' ')} }` : ''}
        ${selection.mediaRevision ? `?adoption (<http://www.w3.org/ns/oa#hasState>|<http://www.w3.org/ns/oa#hasState>/<http://www.w3.org/ns/oa#cachedSource>) ?selectedRevision .
          VALUES ?selectedRevision { ${iri(`urn:rezics:media:revision:${selection.mediaRevision}`)} ${iri(`urn:rezics:content:revision:${selection.mediaRevision}`)} }` : ''}
        ${selection.mediaUses ? `FILTER(?use IN (${selection.mediaUses.map(use => iri(`https://rezics.com/id/${use}`)).join(',')}))` : ''}
        ${selection.contentRevision ? `?adoption (<http://www.w3.org/ns/oa#hasState>|<http://www.w3.org/ns/oa#hasState>/<http://www.w3.org/ns/oa#cachedSource>) ${iri(`urn:rezics:content:revision:${selection.contentRevision}`)} .` : ''}
      }
    } LIMIT 4097`, 2 * 1024 * 1024)).results?.bindings ?? [];
  if (rows.length > 4096) throw new PublicationUnavailable('Instruction adoption inventory exceeds its bound');
  return rows.flatMap(row => {
    if (!row.work || !row.occurrence || !row.target || !row.selector) return [];
    const selector = JSON.parse(row.selector.value) as ExactInstructionSelector;
    if (selection.contentRevision && (selector.grain !== 'content' || selector.revision !== selection.contentRevision)) return [];
    return [{ work: row.work.value, occurrence: row.occurrence.value, target: row.target.value, selector,
      ...(row.use ? { mediaUse: row.use.value.slice('https://rezics.com/id/'.length) } : {}) }];
  });
}

/** Only a current public Work adoption grants public delivery; history is not authority. */
export async function readPublicInstructionAdoptions(env: WorkActivationEnvironment,
  selection: InstructionAdoptionSelection, viewer?: Viewer,
  admittedWorks?: ReadonlySet<string>, channel: DisclosureChannel = 'read'): Promise<InstructionAdoption[]> {
  const candidates = await readInstructionAdoptionCandidates(env, selection);
  const allowed = admittedWorks ?? await admittedPublicWorks(env,
    [...new Set(candidates.map(item => item.work))], viewer, undefined, channel);
  const selected = candidates.filter(item => allowed.has(item.work));
  const sources = await readPublishedStructuredWorkSources(env, [...new Set(selected.map(item => item.work))]);
  const sourceAllowed = new Set<string>();
  for (const source of sources.values()) {
    if (!source.sourceObservation) { sourceAllowed.add(source.work); continue; }
    const attribution = await readPublicationAttribution(env, source.source, source.sourceObservation);
    if ((await discloseInventory(env, [{ owner: 'source', resource: attribution.record, component: 'record',
      revision: attribution.observation }], viewer ?? ANONYMOUS_VIEWER, channel))[0] === 'visible'
      && (await env.structuredPublicationRights?.(source.work, attribution.record))?.allowed) sourceAllowed.add(source.work);
  }
  return selected.flatMap(({ work, ...adoption }) => sourceAllowed.has(work) ? [adoption] : []);
}

/** Runs after Work publish admission. Custody and original authorship are separate proofs. */
export async function prepareInstructionAdoptions(work: MainWorkDependencies,
  input: { work: string; structure: string; expectedStructureHead: string; actingSubject: string },
  admissionId: string, principal: VerifiedPrincipal): Promise<InstructionAdoption[]> {
  const header = await readCompositionHeader(work.environment, input.structure);
  if (!header) throw new PublicationUnavailable('Instruction Structure is unavailable');
  const profile = structureProfileFor(header.profile);
  if (!profile.selectionSelectorRoles?.length) return [];
  if (header.head !== input.expectedStructureHead) throw new StalePublicationHead('Structure head changed');
  // Only adopted dependencies count against this bounded inventory. An unrelated
  // ingredient inventory does not acquire the export operation's 4,096-use limit.
  const rows = (await work.environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?occurrence ?target ?selector WHERE { GRAPH ${iri(GRAPHS.current)} {
      VALUES ?role { ${profile.selectionSelectorRoles.map(role => `<${roleIri(role)}>`).join(' ')} }
      ?placement rv:generation ${iri(header.generation)} ; rv:occurrenceRole ?role ;
        rv:occurrence ?occurrence ; <https://schema.org/item> ?target ; rv:selectionSelector ?selector .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
    } } LIMIT 4097`, 2 * 1024 * 1024)).results?.bindings ?? [];
  if (rows.length > 4096) throw new PublicationUnavailable('Instruction publication exceeds 4096 adopted dependencies');
  const adoptions: InstructionAdoption[] = rows.map(row => {
    if (!row.occurrence || !row.target || !row.selector) throw new PublicationUnavailable('Instruction selection is incomplete');
    const selector = JSON.parse(row.selector.value) as ExactInstructionSelector;
    checkExactInstructionSelection(row.target.value, selector.revision, selector);
    return { occurrence: row.occurrence.value, target: row.target.value, selector };
  });
  for (const adoption of adoptions) {
    const selector = adoption.selector;
    const exact = (await work.content?.readExactBatch([selector.revision], async ids => new Set(ids)))?.[0];
    if (exact?.status !== 'available') throw new PublicationUnavailable('Instruction dependency is unavailable');
    if (selector.grain === 'content') {
      if (!await canReadContentTarget(work.environment, work.access, principal, input.actingSubject, adoption.target,
        await resolveContentTarget(work.environment, adoption.target))) throw new PublicationUnavailable('Instruction custody is unavailable');
      if (exact.reference.resourceId !== adoption.target || exact.reference.variantId !== selector.variantId
        || exact.reference.provenance.kind !== 'admitted-original-contribution-v1'
        || exact.reference.provenance.author !== input.actingSubject) {
        throw new PublicationUnavailable('Instruction authorship or custody is unavailable');
      }
    } else {
      const asset = adoption.target.slice('urn:rezics:media:asset:'.length);
      const state = await work.media?.store.readAsset(asset);
      if (!state || state.owner !== input.actingSubject || state.lifecycle !== 'active'
        || state.moderation !== 'none' || exact.reference.resourceId !== `https://rezics.com/id/${asset}`
        || !(exact.body.representations as { id: string }[] | undefined)?.some(item => item.id === selector.representation)) {
        throw new PublicationUnavailable('Instruction recording custody is unavailable');
      }
      adoption.mediaUse = await work.media!.store.createStructureInstructionUse(admissionId, input.actingSubject,
        input.work, adoption.occurrence, asset, selector.revision, selector.representation);
    }
  }
  return adoptions;
}
