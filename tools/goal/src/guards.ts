import type { GateOutcome, GateOutcomeRefusal, GateStage } from './contracts.ts';
import type { Attempt, AttemptRecord, FailureClass } from './types.ts';

export type GuardDefinition = {
  defect: string;
  owner: string;
  since: string;
  repair: string;
};

export const GUARDS = {
  environment: {
    defect: 'A shared tool or provider failure prevents reliable work.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Repair the environment or route around a confirmed provider fault.',
  },
  'pool-exhausted': {
    defect: 'The selected provider allowance is confirmed exhausted.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Retry after reset or route to an available pool.',
  },
  'repeated-assertion': {
    defect: 'The same failing assertion recurred without a changed brief.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Amend the brief or repair the assertion before retrying.',
  },
  'new-failure': {
    defect: 'The current attempt failed its acceptance outcome.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Use the failure evidence to repair the implementation in place.',
  },
  'early-stop': {
    defect: 'The worker ended without reporting a blocking failure.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Continue the task or report the concrete blocker.',
  },
  question: {
    defect: 'Work is waiting for an unresolved manager question.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Answer the question and resume the current attempt.',
  },
  decision: {
    defect: 'Work is waiting for a recorded manager decision.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Record the reversible decision and continue.',
  },
  blocker: {
    defect: 'A concrete blocker prevents the next task action.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Resolve the named blocker at the point it occurs.',
  },
  handoff: {
    defect: 'The task cannot proceed until its owner receives a handoff.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Send the specific decision or missing implementation handoff.',
  },
  info: {
    defect: 'The task was parked for an informational manager disposition.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Use the information to resume or close the task.',
  },
  'spec-conflict': {
    defect: 'The implementation brief conflicts with an adopted contract.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Resolve the conflicting requirement and issue a current brief.',
  },
  'undeclared-risk-area': {
    defect: 'A change enters a protected risk area the brief did not declare.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Keep the protected file unchanged or declare its owning risk area.',
  },
  'round-limit': {
    defect: 'The attempt reached its configured repair round limit.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Split the repair or issue a brief with the remaining evidence.',
  },
  stalled: {
    defect: 'The same failure or no-progress condition persisted across attempts.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Change the approach and resume from the recorded failure evidence.',
  },
  'failed-after-consult': {
    defect: 'The repaired attempt still failed after consultation.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Turn the consultation into a concrete implementation change.',
  },
  'goal-unmet': {
    defect: 'The task did not satisfy its owning Goal outcome.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Complete the unmet clause or record its exact remaining blocker.',
  },
  'goal-met': {
    defect: 'The Goal completion transition requires a verified terminal outcome.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Verify the named Goal completion evidence before closing it.',
  },
  'goal-idle': {
    defect: 'The Goal has no eligible task in flight.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Dispatch the next approved outcome or close the Goal.',
  },
  'research-complete': {
    defect: 'A research result awaits its owner decision and consumer handoff.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Adopt the finding in its owner document and brief the consumer.',
  },
  instruction: {
    defect: 'A task requires an explicit instruction before it can continue.',
    owner: 'manager',
    since: '2026-11-05',
    repair: 'Give the missing instruction and resume the existing task.',
  },
  'acceptance-failed': {
    defect: 'A required acceptance or typecheck failed on the landing candidate.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Return the exact failing check evidence to the worker for in-place repair.',
  },
  'setup-failed': {
    defect: 'The landing candidate could not be prepared for integration.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Repair the candidate preparation step and retry the same landing.',
  },
  'rebase-conflict': {
    defect: 'A source change conflicts with the current landing target.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Resolve the conflict in the worker branch or with the dev resolver.',
  },
  'scope-failed': {
    defect: 'A landing scope check rejected an unsafe source change.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Repair the protected-path change or declare its risk area.',
  },
  'frozen-acceptance-change': {
    defect: 'A worker changed acceptance files frozen by the controller.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Restore the frozen file and keep acceptance changes in the owning controller.',
  },
  'no-effect': {
    defect: 'A non-dev landing candidate contributes no change to its target.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Treat the contribution as already present or amend it to add an effect.',
  },
  'merge-failed': {
    defect: 'The candidate could not be committed to its integration target.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Repair the source merge condition and retry the landing.',
  },
} satisfies Record<string, GuardDefinition>;

export type GuardId = keyof typeof GUARDS;

export const FAILURE_GUARDS = {
  environment: 'environment',
  'pool-exhausted': 'pool-exhausted',
  'repeated-assertion': 'repeated-assertion',
  'new-failure': 'new-failure',
  'early-stop': 'early-stop',
  question: 'question',
  decision: 'decision',
  blocker: 'blocker',
  handoff: 'handoff',
  info: 'info',
  'spec-conflict': 'spec-conflict',
  'scope-growth': 'undeclared-risk-area',
  'round-limit': 'round-limit',
  stalled: 'stalled',
  'failed-after-consult': 'failed-after-consult',
  'goal-unmet': 'goal-unmet',
  'goal-met': 'goal-met',
  'goal-idle': 'goal-idle',
  'research-complete': 'research-complete',
  instruction: 'instruction',
} satisfies Record<FailureClass, GuardId>;

export const REFUSAL_GUARDS = {
  'acceptance-failed': 'acceptance-failed',
  'setup-failed': 'setup-failed',
  'rebase-conflict': 'rebase-conflict',
  'scope-failed': 'scope-failed',
  'undeclared-risk-area': 'undeclared-risk-area',
  'frozen-acceptance-change': 'frozen-acceptance-change',
  'no-effect': 'no-effect',
  'merge-failed': 'merge-failed',
} satisfies Record<GateOutcomeRefusal['kind'], GuardId>;

export function guardIdsForFailure(failure: FailureClass, refusal?: GateOutcomeRefusal): GuardId[] {
  return [...new Set([FAILURE_GUARDS[failure], ...(refusal ? [REFUSAL_GUARDS[refusal.kind]] : [])])];
}

export function refusalForStage(stage: GateStage, assertion = ''): GateOutcomeRefusal {
  if (stage === 'setup') return { kind: 'setup-failed' };
  if (stage === 'rebase') return { kind: 'rebase-conflict' };
  if (stage === 'scope')
    return assertion.toLowerCase().includes('undeclared risk area')
      ? { kind: 'undeclared-risk-area' }
      : { kind: 'scope-failed' };
  if (stage === 'gate') return { kind: 'acceptance-failed' };
  return { kind: 'merge-failed' };
}

export function ensureGateOutcomeRefusal(outcome: GateOutcome): GateOutcome {
  if (outcome.passed) delete outcome.refusal;
  else outcome.refusal ??= refusalForStage(outcome.stage, outcome.firstFailure?.assertion);
  return outcome;
}

export type GuardLedgerRow = GuardDefinition & {
  id: GuardId;
  firings: number;
  attemptHours: number;
  nextAttemptHours: number;
  tokens: number;
  rewrittenShare: number | null;
  landedShare: number | null;
  action: 'repairable in place' | 'monitor';
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const attemptKey = (taskId: string, attempt: number) => `${taskId}:${attempt}`;
const durationHours = (record: Pick<AttemptRecord, 'startedAt' | 'endedAt'>): number => {
  const duration = Date.parse(record.endedAt) - Date.parse(record.startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) / HOUR_MS : 0;
};
const inWindow = (value: string, start: number, now: number) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= start && time <= now;
};

export function guardLedger(
  records: readonly AttemptRecord[],
  attempts: readonly Attempt[],
  now = Date.now(),
): GuardLedgerRow[] {
  const start = now - 7 * DAY_MS;
  const recordsByAttempt = new Map(records.map((record) => [attemptKey(record.taskId, record.attempt), record]));
  const attemptsByAttempt = new Map(attempts.map((attempt) => [attemptKey(attempt.taskId, attempt.attempt), attempt]));
  return (Object.keys(GUARDS) as GuardId[])
    .map((id) => {
      const firings = records.filter((record) => inWindow(record.endedAt, start, now) && record.guardIds?.includes(id));
      const next = firings.flatMap((record) => {
        const nextRecord = recordsByAttempt.get(attemptKey(record.taskId, record.attempt + 1));
        const nextAttempt = attemptsByAttempt.get(attemptKey(record.taskId, record.attempt + 1));
        return nextRecord && nextAttempt ? [{ record: nextRecord, attempt: nextAttempt }] : [];
      });
      const rewritten = next.filter(({ attempt }) => Boolean(attempt.newBriefHash)).length;
      const landed = next.filter(({ record }) => record.outcome === 'passed' || record.outcome === 'verified').length;
      const rewrittenShare = next.length ? rewritten / next.length : null;
      return {
        id,
        ...GUARDS[id],
        firings: firings.length,
        attemptHours: firings.reduce((sum, record) => sum + durationHours(record), 0),
        nextAttemptHours: next.reduce((sum, item) => sum + durationHours(item.record), 0),
        tokens: firings.reduce((sum, record) => sum + record.tokens.input + record.tokens.output, 0),
        rewrittenShare,
        landedShare: next.length ? landed / next.length : null,
        action:
          firings.length >= 20 && rewrittenShare !== null && rewrittenShare < 0.1
            ? ('repairable in place' as const)
            : ('monitor' as const),
      };
    })
    .sort((a, b) => b.firings - a.firings || a.id.localeCompare(b.id));
}

export function formatGuardLedger(rows: readonly GuardLedgerRow[]): string[] {
  const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  return [
    'Guard ledger (trailing 7 days):',
    '  guard | defect | owner | since | firings | attempt h | next-attempt h | tokens | rewritten | landed | repair',
    ...rows.map(
      (row) =>
        `  ${row.id} | ${row.defect} | ${row.owner} | ${row.since} | ${row.firings} | ${row.attemptHours.toFixed(2)} | ${row.nextAttemptHours.toFixed(2)} | ${row.tokens} | ${pct(row.rewrittenShare)} | ${pct(row.landedShare)} | ${row.action}: ${row.repair}`,
    ),
  ];
}

export function guardEndingCounts(
  records: readonly AttemptRecord[],
  start: string,
  end: string,
): { guardId: GuardId; firings: number }[] {
  const counts = new Map<GuardId, number>();
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  for (const record of records) {
    const ended = Date.parse(record.endedAt);
    if (!Number.isFinite(ended) || ended < startMs || ended >= endMs) continue;
    for (const guardId of new Set(record.guardIds ?? [])) counts.set(guardId, (counts.get(guardId) ?? 0) + 1);
  }
  return [...counts].map(([guardId, firings]) => ({ guardId, firings })).sort((a, b) => b.firings - a.firings);
}
