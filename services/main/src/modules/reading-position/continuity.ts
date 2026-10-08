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

type EnclosingMembership =
  | { kind: 'none' }
  | { kind: 'one'; member: EnclosingMember }
  | { kind: 'ambiguous'; structures: string[] };

/** Active part placements of one Work. Two rows mean the Work has no single
 * series. A structure filter asks only whether one series is among them. */
async function activePartPlacements(env: WorkActivationEnvironment, work: string, structure?: string) {
  const only = structure ? `FILTER(?structure = ${iri(structure)})` : '';
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
        ${only}
      }
    } LIMIT 2`);
  return result.results?.bindings ?? [];
}

/** The single active part placement, or nothing. Two placements (a volume in a
 * series and an omnibus) are ambiguous: there is no one series to anchor, and
 * the reader's progress write still stands. */
async function enclosingMembership(env: WorkActivationEnvironment, work: string): Promise<EnclosingMembership> {
  const rows = await activePartPlacements(env, work);
  if (rows.length > 1) {
    return { kind: 'ambiguous', structures: rows.flatMap(row => row.structure?.value ? [row.structure.value] : []) };
  }
  const row = rows[0];
  if (!row?.work?.value || !row.structure?.value || !row.occurrence?.value) return { kind: 'none' };
  return { kind: 'one', member: { work: row.work.value, structure: row.structure.value, occurrence: row.occurrence.value } };
}

/** True when this Work belongs to more than one composition and this series is
 * one of them. The two-row sample can omit the series, so a miss is checked
 * against that series alone. */
export async function memberSeriesIsAmbiguous(env: WorkActivationEnvironment, work: string, seriesStructure: string):
  Promise<boolean> {
  const membership = await enclosingMembership(env, work);
  if (membership.kind !== 'ambiguous') return false;
  if (membership.structures.includes(seriesStructure)) return true;
  const placed = await activePartPlacements(env, work, seriesStructure);
  return placed.some(row => row.structure?.value === seriesStructure);
}

/** The one Structure that holds this Work as a member, with its current head.
 * Nothing when the Work is not a member, or when more than one placement is
 * active: ambiguous membership has no single place to index. */
export async function enclosingStructure(env: WorkActivationEnvironment, work: string):
  Promise<CompositionHeader | undefined> {
  const parent = await enclosingMembership(env, work);
  if (parent.kind !== 'one') return undefined;
  return await readCompositionHeader(env, parent.member.structure) ?? undefined;
}

function keyFits(key: string) {
  return key.length <= 1088 && key.split('\u0001').length <= CONTINUITY_KEY_PARTS
    && key.split('\u0001').every(part => /^[0-9a-z]{1,32}\u0002[0-9a-z]{1,32}$/.test(part));
}

/** One bounded ancestor walk. Each hop is the part that contains this Work,
 * that part's entry in its prepared order, and the order already accumulated
 * inside the member. Sibling volumes are never listed. Ambiguous membership
 * records no series anchor; a chain past the hop bound is left for the resume
 * read to refuse, and does not fail the progress write. */
export async function continuityAnchors(env: WorkActivationEnvironment, header: CompositionHeader,
  occurrence: string, local: ProgressOrder | undefined): Promise<ContinuityAnchor[]> {
  let work = header.work, key = local?.key ?? '', eligible = local?.eligible ?? false;
  const anchors: ContinuityAnchor[] = [];
  for (let hop = 0; hop < CONTINUITY_INDEX_HOPS; hop++) {
    const parent = await enclosingMembership(env, work);
    // This hop has no single series. Anchors already taken from a unique
    // parent stay; the chapter write still records nothing for this one.
    if (parent.kind !== 'one') return anchors;
    const parentHeader = await readCompositionHeader(env, parent.member.structure);
    if (!parentHeader) return anchors;
    const member = local ? await readProgressOrder(env, parentHeader, parent.member.occurrence) : undefined;
    if (local && !member) return anchors;
    if (member) {
      const next = `${member.key}\u0001${key}`;
      // A key past the bound is not stored. Resume refuses that chain when it
      // can see it; the write of the chapter itself still succeeds.
      if (!keyFits(next)) return anchors;
      key = next;
      eligible = eligible && member.eligible;
    }
    anchors.push({ structure: parentHeader.structure, order: member
      ? { revision: parentHeader.head, key, eligible } : null });
    work = parentHeader.work;
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
    const parent = await enclosingMembership(env, work);
    // Ambiguous or missing membership cannot rebuild one series order.
    if (parent.kind !== 'one') return undefined;
    const parentHeader = await readCompositionHeader(env, parent.member.structure);
    if (!parentHeader) return undefined;
    const member = await readProgressOrder(env, parentHeader, parent.member.occurrence);
    if (!member) return undefined;
    key = `${member.key}\u0001${key}`;
    eligible = eligible && member.eligible;
    work = parentHeader.work;
  }
  return undefined;
}
