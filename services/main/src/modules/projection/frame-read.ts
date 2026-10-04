import { t } from 'elysia';
import { readId } from '../work/read-contract.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { resolveTargets } from '../target/resolve.ts';
import { visibleResourceReferences } from '../entity-page/read.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import { STRUCTURE_LIMITS } from '../structure/format.ts';
import { coordinateOf, coordinateTypes, FrameRefused, frameWork, normalizeFrame, structuralCoordinateTypes,
  type Coordinate } from './dimension.ts';

export const frameQuery = t.Optional(t.Array(readId, { minItems: 1, maxItems: 8, uniqueItems: true }));
export const frameMatch = t.Object({ dimensions: t.Integer({ minimum: 0, maximum: 8 }),
  exact: t.Integer({ minimum: 0, maximum: 8 }), score: t.Integer({ minimum: 0, maximum: 136 }) },
{ additionalProperties: false });
/** A frame lies in at most one Work (`normalizeFrame`). Its disclosed in-continuity memberships are read in keyset
 * batches, hidden and unrevealed ones skipped before anything is counted: `membershipRows` bounds the visible ones,
 * `membershipScans` batches the scan. A position's Structure ancestors take one query per level of the Structure. */
export const FRAME_READ_COST = { coordinates: 8, membershipBatch: 64, membershipScans: 8, membershipRows: 64,
  ancestorQueries: STRUCTURE_LIMITS.maxDepth } as const;

export function matchFromScore(score: number) {
  if (!Number.isInteger(score) || score < 0 || score > 136) throw new WorkReadInvalid('Frame specificity is invalid');
  return { dimensions: Math.floor(score / 16), exact: score % 16, score };
}

/** The continuities of a Work that the reader may rely on: active in-continuity memberships whose occurrence is
 * disclosed and revealed at the reading position and whose continuity is readable. The pattern starts from the Work's
 * own participation, so its cost follows that Work's memberships, never every relation occurrence. */
async function readContinuities(session: WorkReadSession, work: string): Promise<string[]> {
  const boundary = readingBoundary(session);
  const continuities = new Set<string>();
  let visible = 0;
  let after: { occurrence: string; continuity: string } | null = null;
  for (let scan = 0; scan < FRAME_READ_COST.membershipScans; scan++) {
    const rows = await session.query(`SELECT DISTINCT ?work ?continuity ?occurrence WHERE {
      VALUES ?work { ${iri(work)} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?workPart rv:participant ?work ; rv:role ?workRole .
        ?head rv:participation ?workPart, ?continuityPart ; rv:lifecycle rv:Active ; rv:relationDefinition ?meaning .
        ?continuityPart rv:role ?continuityRole ; rv:participant ?continuity .
        ?meaning rv:component ?definition . }
      GRAPH ${iri(GRAPHS.current)} {
        ?key a rv:DefinitionKey ; rv:keyDefinition ?definition ; <http://www.w3.org/2004/02/skos/core#notation> "in-continuity" .
        ?occurrence a rv:RelationOccurrence ; rv:occurrenceHead ?head . }
      FILTER(STR(?workRole) = CONCAT(STR(?definition), "/role/work"))
      FILTER(STR(?continuityRole) = CONCAT(STR(?definition), "/role/continuity"))
      ${after === null ? '' : `FILTER(STR(?occurrence) > ${lit(after.occurrence)}
        || STR(?occurrence) = ${lit(after.occurrence)} && STR(?continuity) > ${lit(after.continuity)})`}
    } ORDER BY STR(?occurrence) STR(?continuity) LIMIT ${FRAME_READ_COST.membershipBatch}`, FRAME_READ_COST.membershipBatch);
    const occurrences = [...new Set(rows.map(row => row.occurrence!.value))];
    const disclosed = await session.disclosure(occurrences.map(resource => ({ owner: 'graph', resource, component: 'record' })));
    const visibleOccurrences = await boundary.visible(occurrences.filter((_, index) => disclosed[index] === 'visible'));
    const visibleContinuities = await visibleResourceReferences(session, rows.map(row => row.continuity!.value));
    for (const row of rows) {
      if (!visibleOccurrences.has(row.occurrence!.value) || !visibleContinuities.has(row.continuity!.value)) continue;
      if (++visible > FRAME_READ_COST.membershipRows) throw new WorkReadLimit('Work continuity membership exceeds the frame read budget');
      continuities.add(row.continuity!.value);
    }
    if (rows.length < FRAME_READ_COST.membershipBatch) return [...continuities];
    after = { occurrence: rows.at(-1)!.occurrence!.value, continuity: rows.at(-1)!.continuity!.value };
  }
  throw new WorkReadLimit('Work continuity membership scan exceeds the frame read budget');
}

/** The Structure groups a position lies in, nearest first, through its placement in the selected generation. */
async function readAncestors(session: WorkReadSession, position: string): Promise<string[]> {
  const ancestors: string[] = [];
  let current = position;
  for (let level = 0; level < FRAME_READ_COST.ancestorQueries; level++) {
    const rows = await session.query(`SELECT ?parent ?inner WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(current)} rv:structure ?structure . ?structure rv:selectedGeneration ?generation .
      ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ${iri(current)} ; rv:orderSegment ?segment .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
      ?segment rv:parent ?parent .
      BIND(EXISTS { ?parent a <https://schema.org/ListItem> } AS ?inner) } } LIMIT 2`, 1);
    if (rows.length !== 1) throw new WorkReadUnavailable('Position ancestry is unavailable');
    // The root of a chain is the Structure itself, not a group.
    if (rows[0]!.inner?.value !== 'true') return ancestors;
    current = rows[0]!.parent!.value;
    ancestors.push(current);
  }
  throw new WorkReadUnavailable('Position ancestry exceeds the Structure depth');
}

/** One target batch, one membership scan and one ancestor walk. No transitive inference or catalogue scan.
 * Hidden, retired and unrevealed membership occurrences cannot establish coverage. */
export async function readFrames(session: WorkReadSession, references: readonly string[]): Promise<Coordinate[]> {
  if (!references.length || references.length > FRAME_READ_COST.coordinates || new Set(references).size !== references.length) {
    throw new WorkReadInvalid('A frame needs one to eight distinct coordinates');
  }
  const targets = await resolveTargets(session, references, 'report');
  const coordinates = targets.map(target => {
    const coordinate = coordinateOf(target);
    if (!coordinate) throw new WorkReadInvalid('A frame must have a coordinate dimension');
    return coordinate;
  });
  let frames: Coordinate[];
  try { frames = normalizeFrame(coordinates); }
  catch (error) { throw error instanceof FrameRefused ? new WorkReadInvalid(error.message) : error; }
  const boundary = readingBoundary(session);
  const revealed = await boundary.visible(references);
  if (revealed.size !== references.length) throw new WorkReadInvalid('A frame is unavailable at the reading position');
  const work = frameWork(frames);
  if (!work) return frames;
  const continuities = await readContinuities(session, work);
  const position = frames.find(frame => frame.dimension === 'position');
  const ancestors = position ? await readAncestors(session, position.iri) : [];
  for (const frame of frames) {
    if (frame.dimension !== 'work' && !frame.work) continue;
    frame.continuities = continuities;
    if (frame === position) frame.ancestors = ancestors;
  }
  return frames;
}

const typePattern = (coordinate: string, types: readonly string[]) => `{
  { GRAPH ${iri(GRAPHS.current)} { ${coordinate} a ?coordinateType } }
  UNION { GRAPH ${iri(GRAPHS.revisions)} { ${coordinate} a rv:FixedRelease } BIND(rv:FixedRelease AS ?coordinateType) }
  FILTER(?coordinateType IN (${types.map(type => `<${type}>`).join(', ')})) }`;

/** The one implementation of coverage, applied before keyset pagination. Whether applicability holds throughout a
 * frame: values in one dimension combine with OR (true in Canon or in Legends) and dimensions with AND (in
 * continuity C and in chapter 3). A dimension the applicability does not name leaves the frame unconstrained, so empty
 * applicability covers every frame; a dimension it names needs the frame to hold a coordinate there, or one that
 * contains the frame: the Work of a position, release or realization, a Structure group above a position, and a
 * continuity the frame's Work belongs to, unless the frame names a continuity itself. Containment goes one way: a
 * Work frame is not inside one of its chapters. The score ranks constrained dimensions first, then exact coordinates
 * before inherited coverage; alternatives in one dimension never inflate it.
 * Correlated EXISTS keeps each dimension's OR alternatives together: https://www.w3.org/TR/sparql11-query/#neg-exists */
export function framePattern(frames: readonly Coordinate[], owner: string, graph: string) {
  const groups = new Map<string, string[]>();
  for (const [type, dimension] of coordinateTypes) groups.set(dimension, [...groups.get(dimension) ?? [], type]);
  const filters: string[] = [];
  const scores: string[] = [];
  const structural = structuralCoordinateTypes.map(([type]) => type);
  const allTypes = coordinateTypes.map(([type]) => type);
  filters.push(`FILTER NOT EXISTS { GRAPH ${iri(graph)} { ${owner} rv:applicability ?untypedCoordinate }
    FILTER NOT EXISTS ${typePattern('?untypedCoordinate', allTypes)} }`);
  for (const [dimension, types] of groups) {
    const exact = frames.filter(frame => frame.dimension === dimension).map(frame => frame.iri);
    const allowed = [...new Set([...exact,
      ...dimension === 'work' ? frames.filter(frame => frame.dimension !== 'work' && frame.work).map(frame => frame.work!) : [],
      ...dimension === 'position' ? frames.flatMap(frame => frame.ancestors ?? []) : [],
      ...dimension === 'continuity' && !exact.length ? frames.flatMap(frame => frame.continuities ?? []) : [],
    ])];
    const coordinate = `?coordinate_${dimension}`;
    const named = `GRAPH ${iri(graph)} { ${owner} rv:applicability ${coordinate} }
      ${typePattern(coordinate, types)} ${['work','realization','release','position'].includes(dimension) ? ''
        : `FILTER NOT EXISTS ${typePattern(coordinate, structural)}`}`;
    const matches = allowed.length ? `EXISTS { GRAPH ${iri(graph)} { ${owner} rv:applicability ${coordinate} }
      FILTER(${coordinate} IN (${allowed.map(iri).join(', ')})) }` : 'false';
    filters.push(`FILTER(!EXISTS { ${named} } || ${matches})`);
    scores.push(`IF(EXISTS { ${named} }, 16, 0)`);
    if (exact.length) scores.push(`IF(EXISTS { GRAPH ${iri(graph)} { ${owner} rv:applicability ${iri(exact[0]!)} } }, 1, 0)`);
  }
  return { filter: filters.join('\n'), score: scores.join(' + ') || '0' };
}
