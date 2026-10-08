import { STRUCTURE_LIMITS } from '../structure/format.ts';
import { readCompositionHeader, type CompositionHeader } from '../structure/graph.ts';
import { readIndexedProgressOrder, readProgressOrder, type ProgressOrder } from '../progress/order.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import type { MemberAnchor, MemberAnchoring } from '../progress/anchors.ts';
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

/** A member keeps anchors on at most this many active enclosing compositions
 * (a series and an omnibus are two). Any further composition holds the member
 * without an anchor, and resume there is unavailable rather than unread. */
export const MAX_ENCLOSING_PLACEMENTS = 4;

/** One composition that holds the member, directly or through another one. */
export interface EnclosingComposition {
  header: CompositionHeader;
  /** The Structure whose Work this composition holds as a part. */
  through: string;
  /** That part's placement in this composition. */
  occurrence: string;
}
export interface MemberEnclosure { compositions: EnclosingComposition[]; overflow: boolean }

/** Active part placements of one Work, in Structure order. A Structure filter
 * asks only whether that composition is among them. */
async function partPlacements(env: WorkActivationEnvironment, work: string, limit: number, structure?: string) {
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
    } ORDER BY ?structure LIMIT ${limit}`);
  return (result.results?.bindings ?? []).flatMap(row => row.structure?.value && row.occurrence?.value
    ? [{ structure: row.structure.value, occurrence: row.occurrence.value }] : []);
}

/** The compositions that hold this member Structure's Work, nearest first:
 * every direct one, then the ones that hold those. At most
 * MAX_ENCLOSING_PLACEMENTS in total, each found by one bounded placement
 * read, so a volume in a thousand omnibuses costs the same as one in two. */
export async function memberEnclosure(env: WorkActivationEnvironment, member: CompositionHeader): Promise<MemberEnclosure> {
  const compositions: EnclosingComposition[] = [];
  const seen = new Set([member.structure]);
  let overflow = false, level = [{ structure: member.structure, work: member.work }];
  for (let hop = 0; hop < CONTINUITY_INDEX_HOPS && level.length; hop++) {
    const next: typeof level = [];
    for (const from of level) {
      const full = compositions.length >= MAX_ENCLOSING_PLACEMENTS;
      const found = await partPlacements(env, from.work, full ? 1 : MAX_ENCLOSING_PLACEMENTS + 1);
      for (const placement of found) {
        if (seen.has(placement.structure)) continue;
        if (compositions.length >= MAX_ENCLOSING_PLACEMENTS) { overflow = true; break; }
        const header = await readCompositionHeader(env, placement.structure);
        if (!header) continue;
        seen.add(header.structure);
        compositions.push({ header, through: from.structure, occurrence: placement.occurrence });
        next.push({ structure: header.structure, work: header.work });
      }
    }
    level = next;
  }
  return { compositions, overflow };
}

/** True when this composition holds the member as a direct part but is past
 * the placements the member keeps anchors for. */
export async function holdsWithoutAnchor(env: WorkActivationEnvironment, member: CompositionHeader,
  composition: string): Promise<boolean> {
  const placed = await partPlacements(env, member.work, MAX_ENCLOSING_PLACEMENTS + 1);
  if (placed.length <= MAX_ENCLOSING_PLACEMENTS || placed.slice(0, MAX_ENCLOSING_PLACEMENTS)
    .some(placement => placement.structure === composition)) return false;
  return (await partPlacements(env, member.work, 1, composition)).length > 0;
}

function keyFits(key: string) {
  return key.length <= 1088 && key.split('\u0001').length <= CONTINUITY_KEY_PARTS
    && key.split('\u0001').every(part => /^[0-9a-z]{1,32}\u0002[0-9a-z]{1,32}$/.test(part));
}

/** The occurrence indexed on each enclosing composition, under that
 * composition's own continuity key: the member's place there, then the order
 * already accumulated inside the member. Each composition reads one point
 * lookup of its own; sibling volumes are never listed. A composition that no
 * longer places the occurrence, or whose key is past the bound, gets a null
 * order, which withdraws any anchor there. */
export async function memberAnchors(env: WorkActivationEnvironment, member: CompositionHeader,
  enclosure: MemberEnclosure, local: ProgressOrder | undefined): Promise<MemberAnchor[]> {
  const below = new Map<string, { key: string; eligible: boolean } | null>([
    [member.structure, local ? { key: local.key, eligible: local.eligible } : null]]);
  const anchors: MemberAnchor[] = [];
  for (const composition of enclosure.compositions) {
    const inner = below.get(composition.through);
    const place = inner ? await readProgressOrder(env, composition.header, composition.occurrence) : undefined;
    const key = inner && place ? `${place.key}\u0001${inner.key}` : undefined;
    const fits = key !== undefined && keyFits(key);
    below.set(composition.header.structure, fits ? { key, eligible: inner!.eligible && place!.eligible } : null);
    anchors.push({ structure: composition.header.structure, through: composition.through, order: fits
      ? { revision: composition.header.head, key, eligible: inner!.eligible && place!.eligible } : null });
  }
  return anchors;
}

/** The anchoring a progress write carries. Anchoring never fails the write:
 * a derivation that cannot finish (a chain too deep to store, a graph read
 * that is down) is reported as unknown, which leaves the member's anchors
 * unprepared for the background pass instead of vouching for them. */
export async function memberAnchoring(env: WorkActivationEnvironment, member: CompositionHeader,
  local: ProgressOrder | undefined): Promise<MemberAnchoring> {
  try {
    const enclosure = await memberEnclosure(env, member);
    return { anchors: await memberAnchors(env, member, enclosure, local), overflow: enclosure.overflow };
  } catch { return { unknown: true }; }
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

/** Rebuild an enclosing composition's anchor from the chapter's own order plus
 * each enclosing member's prepared order, stopping at this Structure. */
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
  const anchors = await memberAnchors(env, homeHeader, await memberEnclosure(env, homeHeader), local);
  const order = anchors.find(anchor => anchor.structure === header.structure)?.order;
  return order ? { revision: order.revision, key: order.key, eligible: order.eligible ?? true } : undefined;
}
