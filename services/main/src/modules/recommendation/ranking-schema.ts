// Typed declarations for ranking generations (Access migration 111). These
// are not access.realm_native_variant_recommendation, a Realm reading hint.
import { declareTable } from './generation-schema.ts';

const RANKING_POPULATIONS = ['public', 'realm', 'personal'] as const;
type RankingPopulation = (typeof RANKING_POPULATIONS)[number];
const RANKING_CANDIDATE_GRAINS = ['work', 'main-version'] as const;

export interface RankingGenerationRow {
  generation_id: string;
  family: 'ranking';
  population: RankingPopulation;
  realm: string | null;
  principal_id: string | null;
  candidate_grain: (typeof RANKING_CANDIDATE_GRAINS)[number];
  score_policy: string;
  context: string | null;
  context_revision: string | null;
  semantic_selection_revision: string | null;
  preference_revision: string | null;
  partition_count: number;
}

export interface RankingPartitionRow {
  generation_id: string;
  partition: number;
  candidate_count: string;
  signal_count: string;
  score_total: string;
}

/** Sparse positive score; order is score descending, then candidate IRI. */
export interface RankingScoreRow {
  generation_id: string;
  partition: number;
  candidate: string;
  score: string;
  signal_count: string;
}

/** Latest coalesced weight of one private rating slot in a build. */
export interface RankingSignalSlotRow {
  generation_id: string;
  slot: string;
  candidate: string;
  weight: string;
  source_sequence: string;
  source_event: string;
  contributor_principal_id: string | null;
}

export const rankingTables = [
  declareTable<RankingGenerationRow>()('access', 'ranking_generation',
    ['generation_id', 'family', 'population', 'realm', 'principal_id', 'candidate_grain', 'score_policy',
      'context', 'context_revision', 'semantic_selection_revision', 'preference_revision', 'partition_count']),
  declareTable<RankingPartitionRow>()('access', 'ranking_partition',
    ['generation_id', 'partition', 'candidate_count', 'signal_count', 'score_total']),
  declareTable<RankingScoreRow>()('access', 'ranking_score',
    ['generation_id', 'partition', 'candidate', 'score', 'signal_count']),
  declareTable<RankingSignalSlotRow>()('access', 'ranking_signal_slot',
    ['generation_id', 'slot', 'candidate', 'weight', 'source_sequence', 'source_event',
      'contributor_principal_id']),
] as const;
