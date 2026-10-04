import { t } from 'elysia';
import { readId } from '../work/read-contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadInvalid, WorkReadLimit, type WorkReadSession } from '../work/read-session.ts';
import { resolveTargets } from '../target/resolve.ts';
import { visibleResourceReferences } from '../entity-page/read.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import { coordinateOf, coordinateTypes, type Coordinate } from './dimension.ts';

export const frameQuery = t.Optional(t.Array(readId, { minItems: 1, maxItems: 8, uniqueItems: true }));
export const frameMatch = t.Object({ dimensions: t.Integer({ minimum: 0, maximum: 8 }),
  exact: t.Integer({ minimum: 0, maximum: 8 }), score: t.Integer({ minimum: 0, maximum: 136 }) },
{ additionalProperties: false });
export const FRAME_READ_COST = { coordinates: 8, membershipQueries: 1, membershipRows: 64 } as const;

export function matchFromScore(score: number) {
  if (!Number.isInteger(score) || score < 0 || score > 136) throw new WorkReadInvalid('Frame specificity is invalid');
  return { dimensions: Math.floor(score / 16), exact: score % 16, score };
}

/** One target batch and one bounded incidence read. No transitive inference or catalogue scan.
 * Hidden, retired and unrevealed membership occurrences cannot establish coverage. */
export async function readFrames(session: WorkReadSession, references: readonly string[]): Promise<Coordinate[]> {
  if (!references.length || references.length > FRAME_READ_COST.coordinates || new Set(references).size !== references.length) {
    throw new WorkReadInvalid('A frame needs one to eight distinct coordinates');
  }
  const targets = await resolveTargets(session, references, 'report');
  const frames = targets.map(target => {
    const coordinate = coordinateOf(target);
    if (!coordinate) throw new WorkReadInvalid('A frame must have a coordinate dimension');
    return coordinate;
  });
  if (new Set(frames.map(frame => frame.dimension)).size !== frames.length) {
    throw new WorkReadInvalid('A frame has at most one coordinate per dimension');
  }
  const boundary = readingBoundary(session);
  const revealed = await boundary.visible(references);
  if (revealed.size !== references.length) throw new WorkReadInvalid('A frame is unavailable at the reading position');
  const works = [...new Set(frames.flatMap(frame => frame.dimension === 'work' ? [frame.iri]
    : frame.dimension === 'position' && frame.work ? [frame.work] : []))];
  if (!works.length) return frames;
  const rows = await session.query(`SELECT DISTINCT ?work ?continuity ?occurrence WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} {
      ?key a rv:DefinitionKey ; rv:keyDefinition ?definition ; <http://www.w3.org/2004/02/skos/core#notation> "in-continuity" .
      ?occurrence a rv:RelationOccurrence ; rv:occurrenceHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?head rv:lifecycle rv:Active ; rv:relationDefinition ?meaning ; rv:participation ?workPart, ?continuityPart .
      ?meaning rv:component ?definition .
      ?workPart rv:role ?workRole ; rv:participant ?work .
      ?continuityPart rv:role ?continuityRole ; rv:participant ?continuity . }
    FILTER(STR(?workRole) = CONCAT(STR(?definition), "/role/work"))
    FILTER(STR(?continuityRole) = CONCAT(STR(?definition), "/role/continuity"))
  } LIMIT ${FRAME_READ_COST.membershipRows + 1}`, FRAME_READ_COST.membershipRows + 1);
  if (rows.length > FRAME_READ_COST.membershipRows) throw new WorkReadLimit('Work continuity membership exceeds the frame read budget');
  const occurrences = [...new Set(rows.map(row => row.occurrence!.value))];
  const disclosed = await session.disclosure(occurrences.map(resource => ({ owner: 'graph', resource, component: 'record' })));
  const visibleOccurrences = await boundary.visible(occurrences.filter((_, index) => disclosed[index] === 'visible'));
  const visibleContinuities = await visibleResourceReferences(session, rows.map(row => row.continuity!.value));
  for (const frame of frames) {
    const work = frame.dimension === 'work' ? frame.iri : frame.dimension === 'position' ? frame.work : null;
    if (work) frame.continuities = [...new Set(rows.filter(row => row.work!.value === work
      && visibleOccurrences.has(row.occurrence!.value) && visibleContinuities.has(row.continuity!.value))
      .map(row => row.continuity!.value))];
  }
  return frames;
}

const typePattern = (coordinate: string, types: readonly string[]) => `{
  { GRAPH ${iri(GRAPHS.current)} { ${coordinate} a ?coordinateType } }
  UNION { GRAPH ${iri(GRAPHS.revisions)} { ${coordinate} a rv:FixedRelease } BIND(rv:FixedRelease AS ?coordinateType) }
  FILTER(?coordinateType IN (${types.map(type => `<${type}>`).join(', ')})) }`;

/** SPARQL equivalent of covers, applied before keyset pagination. Correlated EXISTS
 * keeps each dimension's OR alternatives together: https://www.w3.org/TR/sparql11-query/#neg-exists */
export function framePattern(frames: readonly Coordinate[], owner: string, graph: string) {
  const groups = new Map<string, string[]>();
  for (const [type, dimension] of coordinateTypes) groups.set(dimension, [...groups.get(dimension) ?? [], type]);
  const filters: string[] = [];
  const scores: string[] = [];
  const structural = coordinateTypes.slice(0, 6).map(([type]) => type);
  const allTypes = coordinateTypes.map(([type]) => type);
  filters.push(`FILTER NOT EXISTS { GRAPH ${iri(graph)} { ${owner} rv:applicability ?untypedCoordinate }
    FILTER NOT EXISTS ${typePattern('?untypedCoordinate', allTypes)} }`);
  for (const [dimension, types] of groups) {
    const exact = frames.filter(frame => frame.dimension === dimension).map(frame => frame.iri);
    const allowed = [...new Set([...exact,
      ...dimension === 'work' ? frames.filter(frame => frame.dimension === 'position' && frame.work).map(frame => frame.work!) : [],
      ...dimension === 'continuity' && !exact.length ? frames.filter(frame => ['work', 'position'].includes(frame.dimension))
        .flatMap(frame => frame.continuities ?? []) : [],
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
