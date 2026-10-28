import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { PARTITIONS, routeOf } from '../route/route.ts';
import { SearchUnavailableError } from './opensearch.ts';
import {
  normalizePublicRatingFigure,
  type PublicRatingFigure,
  type PublicRatingSnapshot,
  type PublicRatingSource,
} from './rating-source.ts';
import { subjectPartition, type IndexedSubject, type SubjectSnapshot, type SubjectSource } from './source.ts';

const BATCH_SIZE = 256;
const MAX_ATTEMPTS = 3;

/**
 * Enrich semantic state only when every bounded read observes the same authoritative partition position.
 * The binding is stable standard-question/Global metadata from the native adapter at startup.
 */
export function withPublicRatings(
  source: SubjectSource,
  ratings: PublicRatingSource,
  binding: { questionId: string; populationId: string },
): SubjectSource {
  const { questionId, populationId } = binding;
  if (routeOf(questionId) === null || populationId !== GLOBAL_CONTEXT.id)
    throw new TypeError('Public ratings require a routable standard question and the Global population');

  return {
    async read(partition, ids) {
      if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
        throw new RangeError('Partition must be an integer from 0 to 4095');
      const requested = [...new Set(ids)];
      for (const id of requested) {
        if (subjectPartition(id) !== partition)
          throw new RangeError(`Subject ${id} is outside requested partition ${partition}`);
      }
      const batches: string[][] = [];
      for (let offset = 0; offset < requested.length; offset += BATCH_SIZE)
        batches.push(requested.slice(offset, offset + BATCH_SIZE));
      // Even an empty request needs a proven partition position.
      if (batches.length === 0) batches.push([]);

      let mismatch = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const semantic: SubjectSnapshot[] = [];
        const figures: PublicRatingSnapshot[] = [];
        for (const batch of batches) {
          semantic.push(await source.read(partition, batch));
          figures.push(await ratings.read(partition, batch));
        }
        const position = semantic[0]!.position;
        mismatch = '';
        for (const [kind, snapshots] of [
          ['semantic', semantic],
          ['ratings', figures],
        ] as const) {
          for (const [index, snapshot] of snapshots.entries()) {
            if (
              snapshot.partition !== partition ||
              typeof snapshot.position !== 'bigint' ||
              snapshot.position < 0n ||
              snapshot.position !== position
            ) {
              mismatch = `${kind} batch ${index + 1} partition=${snapshot.partition} position=${snapshot.position}; expected partition=${partition} semantic position=${position}`;
              break;
            }
          }
          if (mismatch) break;
        }
        // A command between any two reads invalidates the whole collection, including earlier batches.
        if (mismatch) continue;

        const subjects: IndexedSubject[] = [];
        for (const [index, batch] of batches.entries()) {
          const allowed = new Set(batch);
          const normalized = new Map<string, PublicRatingFigure>();
          for (const [id, figure] of figures[index]!.figures) {
            if (!allowed.has(id)) throw new TypeError(`Unexpected public rating subject ${id}`);
            normalized.set(id, normalizePublicRatingFigure(figure, { questionId, populationId, subjectId: id }));
          }
          const seen = new Set<string>();
          for (const subject of semantic[index]!.subjects) {
            if (!allowed.has(subject.id) || seen.has(subject.id))
              throw new TypeError(`Unexpected or duplicate semantic subject ${subject.id}`);
            seen.add(subject.id);
            const { publicRating: _stale, ...body } = subject;
            const publicRating = normalized.get(subject.id);
            subjects.push(publicRating === undefined ? body : { ...body, publicRating });
          }
        }
        return { partition, position, subjects };
      }
      throw new SearchUnavailableError(`Public rating snapshot mismatch after ${MAX_ATTEMPTS} attempts: ${mismatch}`);
    },
    count: source.count.bind(source),
    ...(source.matchRelationFacets ? { matchRelationFacets: source.matchRelationFacets.bind(source) } : {}),
  };
}
