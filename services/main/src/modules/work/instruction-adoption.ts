import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { ExactInstructionSelector } from '../structure/selection.ts';
import { readCompositionPage } from '../structure/read.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import { isContainerRole, structureProfileFor } from '../structure/profiles.ts';
import { PublicationUnavailable } from '../contribution/publish.ts';
import { GRAPHS, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { admittedPublicWorks } from './public-patterns.ts';
import type { Viewer } from '../suitability/policy.ts';

export interface InstructionAdoption {
  occurrence: string; target: string; selector: ExactInstructionSelector; mediaUse?: string;
}

/** An immutable publication retains the exact dependency cut, independently of later drafts. */
export function instructionAdoptionTriples(source: string, adoptions: readonly InstructionAdoption[]): string {
  return adoptions.map(adoption => {
    const node = `urn:rezics:instruction-adoption:${hash(`${source}\0${adoption.occurrence}`)}`;
    return `${iri(source)} <https://schema.org/recipeInstructions> ${iri(node)} .
      ${iri(node)} a <http://www.w3.org/ns/oa#SpecificResource> ;
        <http://www.w3.org/ns/oa#hasSource> ${iri(adoption.target)} ;
        <http://www.w3.org/ns/oa#hasState> ${iri(`urn:rezics:${adoption.selector.grain === 'content' ? 'content' : 'media'}:revision:${adoption.selector.revision}`)} ;
        <https://schema.org/identifier> ${iri(adoption.occurrence)} ;
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> ${lit(JSON.stringify(adoption.selector))}
        ${adoption.mediaUse ? `; <https://schema.org/associatedMedia> ${iri(`https://rezics.com/id/${adoption.mediaUse}`)}` : ''} .`;
  }).join('\n');
}

/** Only a current public Work adoption grants public delivery; history is not authority. */
export async function readPublicInstructionAdoptions(env: WorkActivationEnvironment,
  selection: { work?: string; revision?: string; contentRevision?: string; mediaUse?: string; mediaUses?: readonly string[] }, viewer?: Viewer):
  Promise<InstructionAdoption[]> {
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?work ?occurrence ?target ?selector ?use WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${selection.work ? iri(selection.work) : '?work'} rv:workStructurePublicationHead ?decision .
        ${selection.work ? `BIND(${iri(selection.work)} AS ?work)` : ''} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?decision a rv:WorkStructurePublicationDecision ; rv:publicationOutcome rv:Published ; rv:publicSource ?source .
        ?source rv:work ?work ; rv:structureRevision ${selection.revision ? iri(selection.revision) : '?structureRevision'} ;
          <https://schema.org/recipeInstructions> ?adoption .
        ?adoption <http://www.w3.org/ns/oa#hasSource> ?target ; <https://schema.org/identifier> ?occurrence ;
          <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> ?selector .
        OPTIONAL { ?adoption <https://schema.org/associatedMedia> ?use }
        ${selection.mediaUse ? `FILTER(?use = ${iri(`https://rezics.com/id/${selection.mediaUse}`)})` : ''}
        ${selection.mediaUses ? `FILTER(?use IN (${selection.mediaUses.map(use => iri(`https://rezics.com/id/${use}`)).join(',')}))` : ''}
        ${selection.contentRevision ? `?adoption <http://www.w3.org/ns/oa#hasState> ${iri(`urn:rezics:content:revision:${selection.contentRevision}`)} .` : ''}
      }
    } LIMIT 4097`, 2 * 1024 * 1024)).results?.bindings ?? [];
  if (rows.length > 4096) throw new PublicationUnavailable('Instruction adoption inventory exceeds its bound');
  const works = [...new Set(rows.flatMap(row => row.work?.value ? [row.work.value] : []))];
  const allowed = await admittedPublicWorks(env, works, viewer);
  return rows.flatMap(row => {
    if (!allowed.has(row.work?.value ?? '') || !row.occurrence || !row.target || !row.selector) return [];
    const selector = JSON.parse(row.selector.value) as ExactInstructionSelector;
    if (selection.contentRevision && (selector.grain !== 'content' || selector.revision !== selection.contentRevision)) return [];
    return [{ occurrence: row.occurrence.value, target: row.target.value, selector,
      ...(row.use ? { mediaUse: row.use.value.slice('https://rezics.com/id/'.length) } : {}) }];
  });
}

/** Runs after Work publish admission. Custody and original authorship are separate proofs. */
export async function prepareInstructionAdoptions(work: MainWorkDependencies,
  input: { work: string; structure: string; expectedStructureHead: string; actingSubject: string },
  admissionId: string): Promise<InstructionAdoption[]> {
  const header = await readCompositionHeader(work.environment, input.structure);
  if (!header) throw new PublicationUnavailable('Instruction Structure is unavailable');
  const profile = structureProfileFor(header.profile);
  if (!profile.selectionSelectorRoles?.length) return [];
  const adoptions: InstructionAdoption[] = [];
  const parents = [input.structure];
  let visited = 0;
  for (const parent of parents) {
    let after: string | undefined;
    do {
      const page = await readCompositionPage(work.environment, { structure: input.structure,
        revision: input.expectedStructureHead, parent, limit: 100, ...(after ? { after } : {}),
        canReadTarget: async () => true });
      visited += page.occurrences.length;
      if (visited > 4096) throw new PublicationUnavailable('Instruction publication exceeds 4096 occurrences');
      for (const record of page.occurrences) {
        if (isContainerRole(profile, record.role)) parents.push(record.occurrence);
        if (!profile.selectionSelectorRoles.includes(record.role) || !record.target || record.selection?.mode !== 'fixed-revision'
          || !record.selection.selector) continue;
        adoptions.push({ occurrence: record.occurrence, target: record.target, selector: record.selection.selector });
      }
      after = page.next ?? undefined;
    } while (after);
  }
  for (const adoption of adoptions) {
    const selector = adoption.selector;
    const exact = (await work.content?.readExactBatch([selector.revision], async ids => new Set(ids)))?.[0];
    if (exact?.status !== 'available') throw new PublicationUnavailable('Instruction dependency is unavailable');
    if (selector.grain === 'content') {
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
