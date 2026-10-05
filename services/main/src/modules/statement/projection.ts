import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { ContextCommandUnavailable, InvalidContextCommand } from '../context/command.ts';
import { coordinateOf, dimensionOfTypes, frameWork, slotOf, type Coordinate, type FrameSlot } from '../projection/dimension.ts';
import type { ResolvedTarget } from '../target/contract.ts';
import { MAX_FRAMES } from '../projection/schema.ts';
import { STATEMENT_LIMITS } from './schema.ts';

type StatementApplicabilityRefusal = 'statement_applicability_too_large' | 'statement_applicability_unknown'
  | 'statement_applicability_projection' | 'statement_applicability_not_coordinate'
  | 'statement_applicability_slot_occupied' | 'statement_applicability_work_mismatch';

/** A public writer resolves all coordinates with its own disclosure and read authority. */
export type StatementTargetReader = (references: readonly string[]) => Promise<ResolvedTarget[]>;

/** Applicability a Statement cannot carry, with the reason a caller can act on. */
export class StatementApplicabilityRefused extends InvalidContextCommand {
  constructor(readonly code: StatementApplicabilityRefusal, message: string) { super(message); }
}

const tooLarge = () => new StatementApplicabilityRefused('statement_applicability_too_large',
  'The subject projection and Statement applicability together exceed eight coordinates');

/** A Statement on a projection is a Statement on its subject whose applicability holds the projection's frames, so
 * "X in F" has one home. A caller coordinate in a slot the frames already fill must be that coordinate: another one
 * would widen or move the Statement away from the frame it was written for, as OR within a dimension. */
export function projectionStatementMeaning(subject: string, frames: readonly Coordinate[], applicability: readonly Coordinate[]) {
  const filled = new Map<FrameSlot, Set<string>>();
  for (const frame of frames) filled.set(slotOf(frame.dimension), (filled.get(slotOf(frame.dimension)) ?? new Set()).add(frame.iri));
  for (const coordinate of applicability) {
    if (filled.get(slotOf(coordinate.dimension))?.has(coordinate.iri) === false) {
      throw new StatementApplicabilityRefused('statement_applicability_slot_occupied',
        'The projection already fills this slot; name its frame coordinate or write on the subject');
    }
  }
  const works = new Set([...frames, ...applicability].flatMap(coordinate => frameWork([coordinate]) ?? []));
  if (works.size > 1) {
    throw new StatementApplicabilityRefused('statement_applicability_work_mismatch',
      'A projection Statement cannot name coordinates from more than one Work');
  }
  const union = [...new Set([...frames, ...applicability].map(coordinate => coordinate.iri))].sort();
  if (union.length > STATEMENT_LIMITS.applicability) throw tooLarge();
  return { subject, applicability: union };
}

/** Parts of a projection, then the types of its frames and of the caller's applicability: two bounded queries. */
export const STATEMENT_PROJECTION_COST = { subjectQueries: 1, partRows: 9, subjectSummaryReads: 1, coordinateTargetReads: 1,
  typeQueries: 1, typeRows: STATEMENT_LIMITS.applicability + MAX_FRAMES } as const;

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Every applicability IRI belongs to one dimension (decision 51), so a write names only existing Resources whose
 * types give one: never a projection, a Realm, an Agent or an IRI the graph does not hold. One query for all. */
async function readCoordinates(env: WorkActivationEnvironment, references: readonly string[], readTargets?: StatementTargetReader): Promise<Coordinate[]> {
  const unique = [...new Set(references)];
  const native = unique.filter(reference => nativeId.test(reference));
  if (readTargets) {
    const targets = new Map((native.length ? await readTargets(native) : []).map(target => [target.resource, target]));
    // Check availability for the whole batch before disclosing any type-specific refusal.
    if (unique.some(reference => !targets.has(reference))) throw unknownCoordinate();
    return unique.map(reference => {
      const target = targets.get(reference)!;
      if (target.base === 'projection') throw projectionCoordinate();
      const coordinate = coordinateOf(target);
      if (!coordinate) throw notCoordinate();
      return coordinate;
    });
  }
  const typed = new Map<string, string[]>();
  const works = new Map<string, string>();
  if (native.length) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?coordinate (GROUP_CONCAT(DISTINCT STR(?type); separator="|") AS ?types)
        (GROUP_CONCAT(DISTINCT STR(?work); separator="|") AS ?works) WHERE {
        VALUES ?coordinate { ${native.map(iri).join(' ')} }
        OPTIONAL { { GRAPH ${iri(GRAPHS.current)} { ?coordinate a ?type } }
          UNION { GRAPH ${iri(GRAPHS.revisions)} { ?coordinate a rv:FixedRelease } BIND(rv:FixedRelease AS ?type) } }
        OPTIONAL { { GRAPH ${iri(GRAPHS.current)} { ?coordinate rv:work ?work } }
          UNION { GRAPH ${iri(GRAPHS.revisions)} { ?coordinate a rv:FixedRelease ; rv:work ?work } }
          UNION { GRAPH ${iri(GRAPHS.current)} { ?coordinate rv:structure ?structure .
            ?structure rv:structureOf ?component .
            { ?component a rv:MainVersion ; rv:work ?work }
            UNION { ?component a <https://schema.org/CreativeWork> . BIND(?component AS ?work) } } } }
      } GROUP BY ?coordinate LIMIT ${STATEMENT_PROJECTION_COST.typeRows + 1}`)).results?.bindings ?? [];
    for (const row of rows) {
      typed.set(row.coordinate!.value, row.types?.value ? row.types.value.split('|') : []);
      if (row.works?.value) {
        if (row.works.value.includes('|')) throw new ContextCommandUnavailable('Coordinate ownership is ambiguous');
        works.set(row.coordinate!.value, row.works.value);
      }
    }
  }
  return unique.map(reference => {
    const types = typed.get(reference) ?? [];
    if (!types.length) {
      throw unknownCoordinate();
    }
    if (types.includes(`${RV}Projection`)) {
      throw projectionCoordinate();
    }
    const dimension = dimensionOfTypes(types);
    if (!dimension) {
      throw notCoordinate();
    }
    return { iri: reference, dimension, work: dimension === 'work' ? reference : works.get(reference) ?? null };
  });
}

const unknownCoordinate = () => new StatementApplicabilityRefused('statement_applicability_unknown',
  'Statement applicability must name an existing Resource of this platform');
const projectionCoordinate = () => new StatementApplicabilityRefused('statement_applicability_projection',
  'A projection is not applicability; name its frame coordinates');
const notCoordinate = () => new StatementApplicabilityRefused('statement_applicability_not_coordinate',
  'Statement applicability must be a Work, position, release, realization, continuity or event');

/** The request digest retains the supplied subject; only the stored meaning is normalized.
 * Projection parts are immutable, so admission retries always resolve to the same meaning. */
export async function normalizeStatementSubject(env: WorkActivationEnvironment,
  input: { subject: string; applicability: string[] }, canReadSubject?: (subject: string) => Promise<boolean>,
  readTargets?: StatementTargetReader) {
  if (canReadSubject && !await canReadSubject(input.subject)) {
    throw new ContextCommandUnavailable('Statement subject is unavailable');
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?subject ?frame WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.subject)} a rv:Projection .
      OPTIONAL { ${iri(input.subject)} rv:projectionOf ?subject }
      OPTIONAL { ${iri(input.subject)} rv:frame ?frame }
    } } LIMIT ${STATEMENT_PROJECTION_COST.partRows}`)).results?.bindings ?? [];
  if (!rows.length) {
    await readCoordinates(env, input.applicability, readTargets);
    return { subject: input.subject, applicability: input.applicability };
  }
  if (rows.length > 8 || rows.some(row => !row.subject || !row.frame)
    || new Set(rows.map(row => row.subject!.value)).size !== 1) {
    throw new ContextCommandUnavailable('Statement projection parts are unavailable');
  }
  const frames = rows.map(row => row.frame!.value);
  if (new Set([...frames, ...input.applicability]).size > STATEMENT_LIMITS.applicability) throw tooLarge();
  const coordinates = await readCoordinates(env, [...frames, ...input.applicability], readTargets);
  const byIri = new Map(coordinates.map(coordinate => [coordinate.iri, coordinate]));
  return projectionStatementMeaning(rows[0]!.subject!.value, frames.map(frame => byIri.get(frame)!),
    input.applicability.map(reference => byIri.get(reference)!));
}
