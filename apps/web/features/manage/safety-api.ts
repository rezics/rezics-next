import { browserMainApi } from '../api/browser.ts';
import { newKey, type Outcome, send } from './commands.ts';
import { settle } from './read.ts';
import { queueQuery, type SafetyView } from './safety-state.ts';
import type { GovernanceRule, ReportEvidence, SafetyCase, SafetyDecisionInput, SafetyDecisionResult,
  SafetyPage } from './safety-types.ts';
import type { Loaded, MainClient } from './types.ts';

/** Everything the platform safety queue asks of Main, all G-565 routes. Stories pass a stand-in. */
export interface SafetyApi {
  page(view: SafetyView, cursor: string | null, now: number): Promise<Loaded<SafetyPage>>;
  detail(caseId: string): Promise<Loaded<SafetyCase>>;
  /** The staff-visible evidence of the case's first report; Main withholds urgent evidence from non-specialists. */
  evidence(reportId: string): Promise<Loaded<ReportEvidence>>;
  claim(caseId: string, key: string): Promise<Outcome<{ caseId: string; claimedBy: string }>>;
  rule(ref: string): Promise<Outcome<GovernanceRule>>;
  decide(input: SafetyDecisionInput): Promise<Outcome<SafetyDecisionResult>>;
}

const PLATFORM = 'governance:platform';

export { newKey };

/** Reads for the server render: the first page of the queue, through the session's token. */
export const readSafetyPage = (main: MainClient, actingSubject: string, view: SafetyView, now: number,
  cursor: string | null = null) => settle(() => main.v1['safety-cases'].get({ query: { actingSubject,
  ...queueQuery(view, now), ...cursor ? { cursor } : {} } }), { management: true, cursor });

/** Whether the acting Agent may read the platform queue at all; a refusal means Manage shows no Safety entry. */
export async function mayTriage(main: MainClient, actingSubject: string): Promise<boolean> {
  const page = await settle(() => main.v1['safety-cases'].get({ query: { actingSubject, limit: 1 } }),
    { management: true });
  return page.ok;
}

/** The queue through the BFF, acting as `actingSubject`. */
export function bffSafetyApi(actingSubject: string): SafetyApi {
  const main = () => browserMainApi();
  return {
    page: (view, cursor, now) => readSafetyPage(main(), actingSubject, view, now, cursor),
    detail: caseId => settle(() => main().v1['safety-cases']({ caseId }).get({ query: { actingSubject } }),
      { management: true }),
    evidence: reportId => settle(() => main().v1.reports({ report: reportId }).get({ query: { actingSubject } }),
      { management: true }),
    claim: (caseId, key) => send(() => main().v1['safety-cases']({ caseId }).claim.post({ actingSubject,
      idempotencyKey: key }, { headers: { 'idempotency-key': key } })),
    rule: ref => send(() => main().v1.governance['rule-queries'].post({ profile: 'governance-rule-query-v1', ref,
      scopeId: PLATFORM, actingSubject })),
    decide: input => send(() => main().v1['safety-cases']({ caseId: input.caseId }).decisions.post(input,
      { headers: { 'idempotency-key': input.idempotencyKey } })),
  };
}
