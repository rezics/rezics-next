/** Native Search producer for Library's retained preparation episode. */
import type {
  NativePreparationWorkFactory,
  NativePreparationWork,
  PreparationSourcePrefix,
} from '../../library/adapters/index.ts';
import type { CollectionSourceObservation } from '../../library/contract/index.ts';
import { MEMBERS_PREPARATION_SOURCE_PATHS } from '../scope-members-source-declaration.ts';
import { createSearchScopeSource } from '../scope-source.ts';
import { collectionPublicationScopeRuntime } from '../work.ts';
import { meterMembersDefinition, withMembersWorkBudget } from '../scope-members-work-cost.ts';

import { readScopeWorkDefinition } from '../scope-work-context.ts';
import type { NativeScopeWork } from '../../library/adapters/index.ts';

export const nativeLibraryScopeWork: NativeScopeWork = { readDefinition: readScopeWorkDefinition };

type OrderedSource = ReturnType<typeof createSearchScopeSource>;

/** Resolve the existing worker runtime at dispatch, after Search registration has installed it. */
export const createLibraryPreparationWork: NativePreparationWorkFactory = (context): NativePreparationWork => ({
  withBudget: withMembersWorkBudget,
  definition: meterMembersDefinition,
  async prefix(input): Promise<PreparationSourcePrefix | null> {
    const runtime = collectionPublicationScopeRuntime(context);
    if (!runtime) return null;
    const work = input.budget;
    const source = createSearchScopeSource({
      ...runtime,
      evidence: {
        work: input.work,
        access: input.access,
        routeKey: input.routeKey,
        deadline: input.deadline,
      },
    });
    const prepared = await work.compose(async (allowance) => {
      const value = await source.prepare(input.definition.filter, {
        allowance,
        releaseDigest: input.definition.release.digest,
        order: { kind: input.definition.sort, source: input.sourceIdentity },
      });
      return { value, work: source.work(value) };
    });
    type IdRequest = Parameters<OrderedSource['sourcePrefix']>[1];
    type OrdinalRequest = Parameters<OrderedSource['ordinalPrefix']>[1];
    type Evaluation = Parameters<OrderedSource['evaluate']>[2];
    type Checkpoint = {
      id: IdRequest['afterSubjectId'];
      ordinal: OrdinalRequest['after'];
      progress: Evaluation['progress'];
    };
    const checkpoint: Checkpoint = input.checkpoint
      ? JSON.parse(input.checkpoint)
      : { id: null, ordinal: null, progress: null };
    let subjects: readonly string[], exhausted: boolean;
    let observation: CollectionSourceObservation;
    if (input.definition.sort === 'ordinal') {
      const page = await work.compose((allowance) =>
        source.ordinalPrefix(prepared.value, { after: checkpoint.ordinal, quota: 1, allowance }),
      );
      checkpoint.ordinal = page.frontier.after;
      subjects = page.subjects.map((row) => row.subject);
      exhausted = page.exhausted;
      observation = page.observation;
    } else {
      const page = await work.compose((allowance) =>
        source.sourcePrefix(prepared.value, {
          afterSubjectId: checkpoint.id,
          candidateLimit: MEMBERS_PREPARATION_SOURCE_PATHS().id.candidatePrefixMaximum,
          allowance,
        }),
      );
      const candidate = page.candidates[0];
      subjects = [];
      exhausted = page.exhausted && page.candidates.length === 0;
      observation = page.observation;
      if (candidate) {
        const evaluated = await work.compose(async (allowance) => {
          const remaining = allowance.remaining;
          const value = await source.evaluate(prepared.value, [candidate.subjectId], {
            allowance,
            progress: checkpoint.progress ?? null,
            rawKeys: remaining.candidateKeys,
            native: {
              rows: remaining.nativeRows,
              points: remaining.nativePoints,
              witnesses: remaining.witnessKeys,
              bytes: remaining.bytes,
              emptySeeks: remaining.emptySeeks,
            },
          });
          return { value, work: source.work(value) };
        });
        checkpoint.progress = evaluated.value.progress;
        const match = evaluated.value.values[0];
        if (match !== true && match !== false && match !== 'not_proven')
          throw new TypeError('Missing preparation evaluation');
        if (match !== 'not_proven') {
          if (match) subjects = [candidate.subjectId];
          checkpoint.id = candidate.subjectId;
          checkpoint.progress = null;
          exhausted = page.exhausted && page.candidates.length === 1;
        }
      }
    }
    return { checkpoint: JSON.stringify(checkpoint), subjects, exhausted, observation };
  },
});
