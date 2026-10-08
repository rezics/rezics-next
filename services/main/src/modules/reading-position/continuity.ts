import { STRUCTURE_LIMITS } from '../structure/format.ts';
import { readCompositionHeader, type CompositionHeader } from '../structure/graph.ts';
import { readIndexedProgressOrder, readProgressOrder, type ProgressOrder } from '../progress/order.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { READING_POSITION_COST } from './contract.ts';
import { ReadingContinuityUnsupported } from './errors.ts';
import type { ReadingLocation } from './traversal.ts';

/** A series may contain volumes. A volume's own parts are inside that one
 * member. Another composed Work inside the volume is past this bound. */
export const CONTINUITY_MEMBER_BOUND = 1;
/** Index the supported member and one further ancestor, so a too-deep position
 * is found and refused instead of disappearing as an empty resume. */
export const CONTINUITY_INDEX_HOPS = CONTINUITY_MEMBER_BOUND + 1;
/** Each Structure contributes at most maxDepth ancestor steps. */
export const CONTINUITY_KEY_PARTS = STRUCTURE_LIMITS.maxDepth * (CONTINUITY_INDEX_HOPS + 1);

export interface ContinuityAnchor {
  structure: string;
  /** Null withdraws a previous anchor when this occurrence no longer has an order. */
  order: ProgressOrder | null;
}

/** Series order, then order within the enclosing member. The same string is
 * the progress order key, the resume seek, and the disclosure comparison. */
export function continuityKey(location: ReadingLocation): string {
  if (!location.frames.length || location.frames.some(frame => !frame.after)) {
    throw new ReadingContinuityUnsupported('A reading position has no place in this continuity');
  }
  let seen = '', members = 0;
  for (const frame of location.frames) {
    if (frame.work === seen) continue;
    if (seen) members += 1;
    seen = frame.work;
  }
  if (members > CONTINUITY_MEMBER_BOUND) {
    throw new ReadingContinuityUnsupported('A reading position is nested deeper than this continuity can resolve');
  }
  return location.frames.map(frame => `${frame.after!.segmentKey}\u0002${frame.after!.orderKey}`).join('\u0001');
}

interface EnclosingMember { work: string; structure: string; occurrence: string }

async function enclosingMembers(env: WorkActivationEnvironment, work: string): Promise<EnclosingMember[]> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    # reading-position:enclosing-member
    SELECT ?work ?structure ?occurrence WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?occurrence ;
          rv:occurrenceRole rv:PartRole ; schema:item ${iri(work)} .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:WorkComposition ;
          rv:selectedGeneration ?generation .
        ?generation rv:generationState rv:Active .
        ?work rv:mainVersion ?main .
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) {
    throw new ReadingContinuityUnsupported('A reading position belongs to more than one continuity');
  }
  const row = rows[0];
  if (!row?.work?.value || !row.structure?.value || !row.occurrence?.value) return [];
  return [{ work: row.work.value, structure: row.structure.value, occurrence: row.occurrence.value }];
}

function acceptKey(key: string) {
  if (key.length > 1088 || key.split('\u0001').length > CONTINUITY_KEY_PARTS
    || !key.split('\u0001').every(part => /^[0-9a-z]{1,32}\u0002[0-9a-z]{1,32}$/.test(part))) {
    throw new ReadingContinuityUnsupported('A reading position is nested deeper than this continuity can resolve');
  }
}

/** One bounded ancestor walk. Each hop is the part that contains this Work,
 * that part's entry in its prepared order, and the order already accumulated
 * inside the member. Sibling volumes are never listed. */
export async function continuityAnchors(env: WorkActivationEnvironment, header: CompositionHeader,
  occurrence: string, local: ProgressOrder | undefined): Promise<ContinuityAnchor[]> {
  let work = header.work, key = local?.key ?? '', eligible = local?.eligible ?? false;
  const anchors: ContinuityAnchor[] = [];
  for (let hop = 0; hop < CONTINUITY_INDEX_HOPS; hop++) {
    const [parent] = await enclosingMembers(env, work);
    if (!parent) return anchors;
    const parentHeader = await readCompositionHeader(env, parent.structure);
    if (!parentHeader) return anchors;
    const member = local ? await readProgressOrder(env, parentHeader, parent.occurrence) : undefined;
    if (local && !member) return anchors;
    if (member) {
      key = `${member.key}\u0001${key}`;
      eligible = eligible && member.eligible;
      acceptKey(key);
    }
    anchors.push({ structure: parentHeader.structure, order: member
      ? { revision: parentHeader.head, key, eligible } : null });
    work = parentHeader.work;
  }
  // A further ancestor would not be indexed, and a later read would look like
  // the reader had not started. Refuse while the order is still being saved.
  if (local && (await enclosingMembers(env, work)).length) {
    throw new ReadingContinuityUnsupported('A reading position is nested deeper than this continuity can resolve');
  }
  return anchors;
}

async function occurrenceHome(env: WorkActivationEnvironment, occurrence: string):
  Promise<{ structure: string; work: string } | undefined> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    # reading-position:occurrence-home
    SELECT ?structure ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(occurrence)} rv:structure ?structure .
        ?work rv:mainVersion ?main .
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile ?profile ;
          rv:structureHead ?head ; rv:selectedGeneration ?generation .
        ?generation rv:generationState rv:Active .
        FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.structure?.value || !row.work?.value) return undefined;
  return { structure: row.structure.value, work: row.work.value };
}

/** Rebuild a series anchor from the chapter's own order plus each enclosing
 * member's prepared order, stopping at this Structure. */
export async function readResumeOrder(env: WorkActivationEnvironment, header: CompositionHeader,
  occurrence: string): Promise<ProgressOrder | undefined> {
  const indexed = await readIndexedProgressOrder(env, header, occurrence);
  if (indexed !== null) return indexed;
  const home = await occurrenceHome(env, occurrence);
  if (!home || home.structure === header.structure) return undefined;
  const homeHeader = await readCompositionHeader(env, home.structure);
  if (!homeHeader) return undefined;
  const local = await readIndexedProgressOrder(env, homeHeader, occurrence);
  if (!local) return undefined;
  let work = homeHeader.work, key = local.key, eligible = local.eligible;
  for (let hop = 0; hop < READING_POSITION_COST.workDepth; hop++) {
    if (work === header.work) return { revision: header.head, key, eligible };
    let parents: EnclosingMember[];
    try { parents = await enclosingMembers(env, work); }
    catch (error) {
      if (error instanceof ReadingContinuityUnsupported) return undefined;
      throw error;
    }
    if (parents.length !== 1) return undefined;
    const parent = parents[0]!;
    const parentHeader = await readCompositionHeader(env, parent.structure);
    if (!parentHeader) return undefined;
    const member = await readProgressOrder(env, parentHeader, parent.occurrence);
    if (!member) return undefined;
    key = `${member.key}\u0001${key}`;
    eligible = eligible && member.eligible;
    work = parentHeader.work;
  }
  return undefined;
}
