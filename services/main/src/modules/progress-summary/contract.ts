import { t } from 'elysia';
import { readId, readLanguage } from '../work/read-contract.ts';
import { editionPreference } from '../session/preference-contract.ts';
import { SERIES_COST, SERIES_POLICY } from '../session/series-policy.ts';
import { seriesSummary } from '../session/series-contract.ts';

export const WORK_PROGRESS_COST = { compositionQueries: 1, releaseQueries: 1,
  coverageQueries: 1, librarySql: 1, preferenceSql: 1, sessionSql: SERIES_COST.sessionSql,
  // With no edition pins: three reader-state reads plus one media batch each
  // for the Work basis, coverage admission and final disclosure fence.
  directWorkContentSql: 6,
  sessions: SERIES_COST.sessions, releaseCandidates: SERIES_COST.releaseCandidates,
  selectionPins: SERIES_COST.selectionPins } as const;

export const workSummary = t.Object({ resource: readId, scope: t.Literal('work'),
  policy: t.Literal(SERIES_POLICY), language: t.Nullable(readLanguage),
  status: t.Nullable(t.Union([t.Literal('finished'), t.Literal('reading'), t.Literal('not-started')])),
  counts: t.Object({ completed: t.Integer({ minimum: 0, maximum: 1 }),
    required: t.Literal(1), completedRequired: t.Integer({ minimum: 0, maximum: 1 }) }),
  states: t.Object({ correspondenceUnresolved: t.Boolean() }),
  partial: t.Boolean(), preference: t.Nullable(editionPreference),
  revisions: t.Object({ work: t.Object({ resource: readId, revision: readId }),
    sessions: seriesSummary.properties.revisions.properties.sessions,
    library: t.Array(t.Object({ work: readId, version: t.Integer() }), { maxItems: 1 }),
    selections: seriesSummary.properties.revisions.properties.selections,
    graph: seriesSummary.properties.revisions.properties.graph }),
  continuation: t.Object({ sessions: t.Nullable(t.String()), releases: t.Nullable(t.String()) }) });

export const progressSummary = t.Union([seriesSummary, workSummary]);
