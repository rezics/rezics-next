import type {
  PublicFilterConsumerContext,
  PublicFilterConsumerUnavailable,
} from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterCost } from './public-filter-source-contract.ts';

/** Agreed background-only additive capability on subjectSource; never exposed to request capture. */
export interface SubjectSourceKeyPages {
  readSubjectKeyPage(
    request: Readonly<{
      partition: number;
      epoch: number;
      after: Readonly<{ route: number; id: string }> | null;
      through: bigint;
      inputLimit: number;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{
        status: 'progress' | 'complete';
        partition: number;
        epoch: number;
        through: bigint;
        keys: readonly string[];
        after: Readonly<{ route: number; id: string }> | null;
        position: bigint;
        cost: PublicFilterCost;
      }>
    | Readonly<{ status: 'changed' | 'gap'; cost: PublicFilterCost }>
    | PublicFilterConsumerUnavailable
  >;
}

/** PROVISIONAL Semantic producer adapter. No unavailable owner becomes a complete empty page. */
export const readSubjectKeyPage: SubjectSourceKeyPages['readSubjectKeyPage'] = async () => ({
  status: 'unavailable',
  reason: 'source_pending',
  cost: {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  },
});
