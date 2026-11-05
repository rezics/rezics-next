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
    defect:
      'An undeclared production change can alter authorization, disclosure, rights, deletion or account controls.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Keep protected production files unchanged or declare every applicable risk area.',
  },
  'dev-landing-transpile': {
    defect:
      'A changed dev TypeScript file contains a compile error, including the observed boot-breaking const reassignment.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair:
      'Return the first Bun diagnostic and retained log to the original worker session; repair in place and transpile the recomposed candidate before landing. Cost target: <1000ms per typical landing. Measured disposable fixture: 7ms for 7 changed files, 4 executable TypeScript entries and 180 source bytes.',
  },
  'dev-landing-architecture': {
    defect:
      'A final dev candidate introduces a module-boundary violation beyond its captured base, allowing new architecture drift to land.',
    owner: 'control-plane',
    since: '2026-11-06',
    repair:
      'Return the added architecture violation lines and retained log to the original worker session; repair in place and recheck the recomposed candidate before landing. Cost target: <15000ms per candidate. Measured full base-delta check: 14.6s for 7,433 production files in this worktree; original full check: 10.5s for 6,876 files, no database.',
  },
  'dev-landing-schema': {
    defect:
      'A changed Kernel migration reached dev without its regenerated schema dump, so the schema preflight rejects the candidate.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair:
      'Return the first regeneration error to the original worker session; repair the migration in place and regenerate the dumps on the recomposed candidate before landing. Cost target: <30000ms per migration landing. Measured fresh throwaway database: 9173ms for the derived schema command with unchanged dumps.',
  },
  'dev-landing-kernel-import': {
    defect:
      'A changed Kernel source graph has a TDZ import cycle or Reylo SQL/query-key mismatch that unbundled transpile cannot see, so published dev cannot boot.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair:
      'Import services/kernel/src/server.ts and worker.ts with one migrated throwaway database and explicit DATABASE_URL; return the first diagnostic and retained log to the original worker session; repair in place and re-import the recomposed candidate before landing. Cost target: <60000ms per Kernel-source landing. Measured representative candidate: setup 37473ms, import 223297ms, cleanup 0ms, total 260770ms for both Kernel entries against a migrated throwaway database.',
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
    defect: 'A candidate file matched a protected production risk area not declared by its brief.',
    owner: 'control-plane',
    since: '2026-11-05',
    repair: 'Declare the applicable production risk area or correct a tooling-path ownership rule.',
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

/** Guards recorded when a dev landing returns a repair to its source owner's session. */
export const DEV_LANDING_REPAIR_GUARDS = [
  'dev-landing-transpile',
  'dev-landing-architecture',
  'dev-landing-schema',
  'dev-landing-kernel-import',
] as const;
export type DevLandingRepairGuard = (typeof DEV_LANDING_REPAIR_GUARDS)[number];

export function isDevLandingRepairGuard(id: GuardId): id is DevLandingRepairGuard {
  return (DEV_LANDING_REPAIR_GUARDS as readonly GuardId[]).includes(id);
}

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
const durationHours = (duration: number): number => {
  return Number.isFinite(duration) ? Math.max(0, duration) / HOUR_MS : 0;
};

export function guardLedger(
  records: readonly AttemptRecord[],
  attempts: readonly Attempt[],
  now = Date.now(),
): GuardLedgerRow[] {
  const start = now - 7 * DAY_MS;
  const detailsByRecord = new WeakMap<
    AttemptRecord,
    { endedAt: number; durationHours: number; nextAttemptKey: string }
  >();
  const recordsByAttempt = new Map<string, AttemptRecord>();
  for (const record of records) {
    const taskId = record.taskId;
    const attempt = record.attempt;
    const endedAt = Date.parse(record.endedAt);
    detailsByRecord.set(record, {
      endedAt,
      durationHours: durationHours(endedAt - Date.parse(record.startedAt)),
      nextAttemptKey: attemptKey(taskId, attempt + 1),
    });
    recordsByAttempt.set(attemptKey(taskId, attempt), record);
  }
  const attemptsByAttempt = new Map<string, Attempt>();
  for (const attempt of attempts) attemptsByAttempt.set(attemptKey(attempt.taskId, attempt.attempt), attempt);

  type GuardTotals = {
    firings: number;
    attemptHours: number;
    nextAttemptHours: number;
    tokens: number;
    nextAttempts: number;
    rewritten: number;
    landed: number;
  };
  const totalsByGuard = new Map<GuardId, GuardTotals>();
  for (const id of Object.keys(GUARDS) as GuardId[])
    totalsByGuard.set(id, {
      firings: 0,
      attemptHours: 0,
      nextAttemptHours: 0,
      tokens: 0,
      nextAttempts: 0,
      rewritten: 0,
      landed: 0,
    });

  for (const record of records) {
    const details = detailsByRecord.get(record)!;
    if (!Number.isFinite(details.endedAt) || details.endedAt < start || details.endedAt > now) continue;
    const guardIds = new Set(record.guardIds ?? []);
    if (guardIds.size === 0) continue;

    const tokens = record.tokens.input + record.tokens.output;
    const nextRecord = recordsByAttempt.get(details.nextAttemptKey);
    const nextAttempt = attemptsByAttempt.get(details.nextAttemptKey);
    let nextAttemptHours = 0;
    let rewritten = false;
    let landed = false;
    let hasNext = false;
    if (nextRecord && nextAttempt) {
      hasNext = true;
      nextAttemptHours = detailsByRecord.get(nextRecord)!.durationHours;
      rewritten = Boolean(nextAttempt.newBriefHash);
      landed = nextRecord.outcome === 'passed' || nextRecord.outcome === 'verified';
    }

    for (const id of guardIds) {
      const totals = totalsByGuard.get(id);
      if (!totals) continue;
      totals.firings++;
      totals.attemptHours += details.durationHours;
      totals.tokens += tokens;
      if (hasNext) {
        totals.nextAttempts++;
        totals.nextAttemptHours += nextAttemptHours;
        if (rewritten) totals.rewritten++;
        if (landed) totals.landed++;
      }
    }
  }

  return (Object.keys(GUARDS) as GuardId[])
    .map((id) => {
      const totals = totalsByGuard.get(id)!;
      const rewrittenShare = totals.nextAttempts ? totals.rewritten / totals.nextAttempts : null;
      return {
        id,
        ...GUARDS[id],
        firings: totals.firings,
        attemptHours: totals.attemptHours,
        nextAttemptHours: totals.nextAttemptHours,
        tokens: totals.tokens,
        rewrittenShare,
        landedShare: totals.nextAttempts ? totals.landed / totals.nextAttempts : null,
        action:
          totals.firings >= 20 && rewrittenShare !== null && rewrittenShare < 0.1
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
