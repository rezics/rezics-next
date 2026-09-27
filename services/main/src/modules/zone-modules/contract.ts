import { t } from 'elysia';
import { pageFields, readId, workCard } from '../work/read-contract.ts';
import { realmDecision } from '../realm-reads/read-contract.ts';

export const ZONE_MODULE_COST = { pageSize: 20, candidateRows: 21, typeRows: 160,
  serialHeads: 20, summaryBatches: 2, graphCalls: 160, graphBytes: 4 * 1024 * 1024,
  deadlineMs: 10_000 } as const;

export const zoneWork = t.Object({ ...workCard.properties, evidence: readId,
  dataEpoch: t.String(), sequence: t.String() });
export const zoneWorkPage = t.Object({ profile: t.Union([
  t.Literal('zone-new-adoptions-v1'), t.Literal('zone-recently-completed-v1')]),
  realm: readId, items: t.Array(zoneWork, { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
export const zoneDecisionPage = t.Object({ profile: t.Literal('zone-recent-decisions-v1'), realm: readId,
  items: t.Array(realmDecision, { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields,
  summary: t.Object({ adoption: t.Integer({ minimum: 0 }), classification: t.Integer({ minimum: 0 }),
    semanticRuleChange: t.Integer({ minimum: 0 }), basis: t.Literal('exact-page') }) });
export const zoneChapterPage = t.Object({ profile: t.Literal('zone-latest-chapters-v1'), realm: readId,
  items: t.Array(t.Object({ work: workCard, chapter: readId, publication: readId,
    contentRevision: t.String(), language: t.String(), dataEpoch: t.String(), sequence: t.String() }),
  { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
