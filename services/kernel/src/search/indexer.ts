import type { Pool } from 'pg';
import { projectBatch, type Envelope } from '../events/log.ts';
import { lookupEventType } from '../events/catalogue.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import type { Relay } from '../events/relays.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { documentActions } from './document.ts';
import type { OpenSearch } from './opensearch.ts';
import { normalizePublicRatingFigure } from './rating-source.ts';
import {
  subjectPartition,
  type IndexedSubject,
  type SubjectListingSource,
  type SubjectSnapshot,
  type SubjectSource,
} from './source.ts';
import { writeIndexActions } from './write-actions.ts';

export { IndexWriteError } from './write-actions.ts';

/** Internal composition only: admission must reject or await the same real apply exactly once. */
export type SubjectApplyGuard = (
  partition: number,
  envelopes: readonly Envelope[],
  apply: () => Promise<void>,
) => Promise<void>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function languageValues(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => record(item) && typeof item.language === 'string' && typeof item.value === 'string')
  );
}

/** Validate all returned evidence, including records that will produce deletes, before any projection I/O. */
function validateObservation(
  snapshot: SubjectSnapshot,
  partition: number,
  ids: readonly string[],
  obligation: bigint,
): Map<string, IndexedSubject> {
  if (!record(snapshot) || snapshot.partition !== partition)
    throw new TypeError('Source snapshot does not observe the requested partition');
  if (
    typeof snapshot.position !== 'bigint' ||
    snapshot.position < obligation ||
    snapshot.position < 0n ||
    snapshot.position > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new TypeError('Source snapshot position must be a valid bigint version covering the captured batch');
  if (!Array.isArray(snapshot.subjects) || snapshot.subjects.length > ids.length)
    throw new TypeError('Source snapshot must contain unique requested records');
  const requested = new Set(ids);
  const subjects = new Map<string, IndexedSubject>();
  for (const subject of snapshot.subjects) {
    if (
      !record(subject) ||
      typeof subject.id !== 'string' ||
      subjectPartition(subject.id) !== partition ||
      !requested.has(subject.id) ||
      subjects.has(subject.id)
    )
      throw new TypeError('Source snapshot contains a duplicate or unrequested subject');
    if (
      typeof subject.type !== 'string' ||
      !['visible', 'hidden', 'taken_down'].includes(subject.visibility) ||
      (subject.redirect !== null && (typeof subject.redirect !== 'string' || !subject.redirect)) ||
      !Number.isSafeInteger(subject.securityRevision) ||
      subject.securityRevision < 0 ||
      !languageValues(subject.labels) ||
      !languageValues(subject.aliases) ||
      !languageValues(subject.descriptions) ||
      !Array.isArray(subject.statements) ||
      (subject.relationFacetOverflow !== undefined &&
        (!Array.isArray(subject.relationFacetOverflow) ||
          !subject.relationFacetOverflow.every((property) => typeof property === 'string')))
    )
      throw new TypeError('Source snapshot contains invalid subject state');
    if (subject.redirect !== null) subjectPartition(subject.redirect);
    for (const statement of subject.statements) {
      if (
        !record(statement) ||
        typeof statement.property !== 'string' ||
        typeof statement.value !== 'string' ||
        (statement.qualifiers !== undefined &&
          (!Array.isArray(statement.qualifiers) ||
            !statement.qualifiers.every(
              (item) => record(item) && typeof item.property === 'string' && typeof item.value === 'string',
            )))
      )
        throw new TypeError('Source snapshot contains invalid statement state');
      const facet = statement.facet;
      if (facet === undefined) continue;
      if (
        !record(facet) ||
        !['item', 'code', 'time', 'quantity'].includes(facet.kind) ||
        (facet.kind === 'time' && !Number.isSafeInteger(facet.year)) ||
        (facet.kind === 'quantity' && (!Number.isFinite(facet.amount) || typeof facet.unit !== 'string'))
      )
        throw new TypeError('Source snapshot contains invalid facet state');
    }
    if (subject.publicRating !== undefined)
      normalizePublicRatingFigure(subject.publicRating, {
        questionId: subject.publicRating.questionId,
        populationId: GLOBAL_CONTEXT.id,
        subjectId: subject.id,
      });
    subjects.set(subject.id, subject);
  }
  return subjects;
}

export function createSubjectIndexer(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  index: string;
  consumer: string;
  aroundApply?: SubjectApplyGuard;
}): Relay {
  return {
    consumer: options.consumer,
    run(partition) {
      return projectBatch(options.pool, {
        consumer: options.consumer,
        partition,
        apply: async (envelopes) => {
          const apply = async () => {
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const envelope of envelopes) {
              if (envelope.partition !== partition) continue;
              for (const event of envelope.events) {
                if (
                  event.type.startsWith('com.rezics.subject.') ||
                  event.type === 'com.rezics.library.subject.listed.v1'
                ) {
                  if (!event.subject || seen.has(event.subject)) continue;
                  if (subjectPartition(event.subject) !== partition) continue;
                  seen.add(event.subject);
                  ids.push(event.subject);
                  continue;
                }
                if (event.type !== 'com.rezics.rating.public_figure.changed.v1') continue;
                const validator = lookupEventType(event.type);
                if (!validator?.Check(event.data)) continue;
                const data = event.data as { questionId: string; populationId: string; subjectId: string };
                // Event metadata is an invalidation hint only. Accept its anchor after proving the
                // registered identity agrees with the envelope and the current public contract.
                if (
                  data.questionId !== STANDARD_QUESTION_ID ||
                  data.populationId !== GLOBAL_CONTEXT.id ||
                  event.subject !== data.subjectId ||
                  seen.has(data.subjectId)
                )
                  continue;
                try {
                  if (subjectPartition(data.subjectId) !== partition) continue;
                } catch {
                  continue;
                }
                seen.add(data.subjectId);
                ids.push(data.subjectId);
              }
            }
            if (ids.length === 0) return;

            // Every chunk must cover the entire captured batch that this apply will acknowledge.
            const obligation = envelopes.at(-1)!.position;
            for (let offset = 0; offset < ids.length; offset += 256) {
              const chunk = ids.slice(offset, offset + 256);
              const snapshot = await options.source.read(partition, chunk);
              const subjects = validateObservation(snapshot, partition, chunk, obligation);
              const indexIds = chunk.filter((id) => {
                const subject = subjects.get(id);
                return subject?.visibility === 'visible' && subject.redirect === null;
              });
              const counts = indexIds.length === 0 ? undefined : await options.listing.read(partition, indexIds);
              const actions = await prepareBoundedSortKeys(
                options.search,
                options.index,
                documentActions(snapshot, chunk, counts),
              );
              await writeIndexActions(options.search, options.index, actions);
            }
          };
          if (!options.aroundApply) return apply();
          let applied: Promise<void> | undefined;
          let duplicate = false;
          let open = true;
          try {
            await options.aroundApply(partition, envelopes, () => {
              if (!open) throw new Error('Subject apply guard has already returned');
              if (applied) {
                duplicate = true;
                throw new Error('Subject apply may only run once');
              }
              applied = apply();
              return applied;
            });
          } finally {
            open = false;
          }
          if (duplicate || !applied) throw new Error('Subject apply guard must run apply exactly once');
          await applied;
        },
      });
    },
  };
}
