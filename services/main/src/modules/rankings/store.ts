import type { Pool } from 'pg';
import type { RankingCheckpoint, RankingInterval, RankingMetric } from './projection.ts';

export interface RankingPopulation {
  metric: RankingMetric;
  interval: RankingInterval;
  bucket: string;
  context: string;
}
export interface RankingCandidate { work: string; score: string; growth: string }
export interface RankingCaptureRow {
  generation: string;
  content_epoch: string;
  content_sequence: string;
  content_scan_sequence: string;
  graph_epoch: string;
  review_position: string;
  review_scan_position: string;
  review_head: string | null;
  coverage_intact: boolean;
  revision: string;
  removal_revision: string;
  removal_pending: boolean;
  rows: RankingCandidate[];
  removed: boolean;
}
export interface RankingPopulationCapture {
  checkpoint: RankingCheckpoint;
  revision: string;
  removalRevision: string;
  rows: RankingCandidate[];
  population: RankingPopulation;
}

const checkpointFields = `c.generation,c.content_epoch,c.content_sequence::text,
  c.content_scan_sequence::text,c.graph_epoch,c.review_position::text,c.review_scan_position::text,
  h.position::text AS review_head,
  c.content_sequence = COALESCE((SELECT min(position)-1 FROM access.read_ranking_pending
    WHERE generation=c.generation AND source='content'),c.content_scan_sequence)
  AND c.review_position = COALESCE((SELECT min(position)-1 FROM access.read_ranking_pending
    WHERE generation=c.generation AND source='review'),c.review_scan_position) AS coverage_intact`;
const pendingRemoval = `($1='reviews' AND (c.review_scan_position<c.review_rebuild_position
  OR EXISTS (SELECT 1 FROM access.read_ranking_removal
    WHERE generation=c.generation AND context=$4 AND interval=$2 AND bucket=$3::date))) AS removal_pending`;

/** Revision and bounded candidate rows share one PostgreSQL statement snapshot. */
export async function captureRankingPopulation(access: Pool, population: RankingPopulation,
  order: 'score' | 'growth', after: { value: string; work: string } | null, limit: number) {
  const key = order === 'score' ? 'score' : 'growth';
  return (await access.query<RankingCaptureRow>(`SELECT ${checkpointFields},
    COALESCE(p.revision,0)::text AS revision,COALESCE(p.removal_revision,0)::text AS removal_revision,
    ${pendingRemoval},false AS removed,
    COALESCE(page.rows,'[]'::jsonb) AS rows
    FROM access.read_ranking_checkpoint c
    LEFT JOIN access.reader_review_rank_head h ON h.singleton
    LEFT JOIN access.read_ranking_publication p ON p.generation=c.generation
      AND p.metric=$1 AND p.interval=$2 AND p.bucket=$3::date AND p.context=$4
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('work',work,'score',score::text,'growth',growth::text)
        ORDER BY ${key} DESC,work) AS rows FROM (
        SELECT work,score,growth FROM access.read_ranking_admitted a
        WHERE a.generation=c.generation AND a.metric=$1 AND a.interval=$2
          AND a.bucket=$3::date AND a.context=$4
          ${order === 'growth' ? 'AND growth>0' : ''}
          AND ($5::bigint IS NULL OR ${key}<$5::bigint OR (${key}=$5::bigint AND work>$6))
        ORDER BY a.${key} DESC,work LIMIT $7
      ) candidates
    ) page WHERE c.singleton`, [population.metric,population.interval,population.bucket,
    population.context,after?.value ?? null,after?.work ?? '',limit])).rows[0];
}

/** Additions may publish after capture. Only exact captured removals fence delivery. */
export async function fenceRankingPopulation(access: Pool, capture: RankingPopulationCapture) {
  const p = capture.population;
  return (await access.query<RankingCaptureRow>(`SELECT ${checkpointFields},
    $5::text AS revision,COALESCE(p.removal_revision,0)::text AS removal_revision,
    ${pendingRemoval},'[]'::jsonb AS rows,
    EXISTS (SELECT 1 FROM unnest($6::text[]) works(work) WHERE NOT EXISTS (
      SELECT 1 FROM access.read_ranking_admitted a WHERE a.generation=$7::uuid
        AND a.metric=$1 AND a.interval=$2 AND a.bucket=$3::date AND a.context=$4
        AND a.work=works.work)) AS removed
    FROM access.read_ranking_checkpoint c LEFT JOIN access.reader_review_rank_head h ON h.singleton
    LEFT JOIN access.read_ranking_publication p ON p.generation=c.generation
      AND p.metric=$1 AND p.interval=$2 AND p.bucket=$3::date AND p.context=$4
    WHERE c.singleton`,[p.metric,p.interval,p.bucket,p.context,capture.revision,
    capture.rows.map(row => row.work),capture.checkpoint.generation])).rows[0];
}
