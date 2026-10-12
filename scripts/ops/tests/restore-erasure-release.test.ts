import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import type {
  FusekiClient,
  MembershipPreparationInput,
  MembershipPreparationResult,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  finishAndVerifyRestore,
  finishOperatorRestore,
  recordRestoreFailure,
  restoreRecoverySet,
  type OperatorRestoreReleaseContext,
  type RestoreEvidence,
  type RestoreChecks,
} from '../restore.ts';
import { RecoveryBudget } from '../recovery-set.ts';
import { FusekiHttpError } from '../../../services/main/src/infrastructure/fuseki.ts';
import { isRestoreTransientFailure, RestoreInterrupted } from '../../../services/main/src/modules/work/restore-lineage.ts';

const dataEpoch = '00000000-0000-4000-8000-000000000051';
const routingEpoch = '00000000-0000-4000-8000-000000000052';

function membershipResult(complete: boolean): MembershipPreparationResult {
  return {
    status: 'committed',
    complete,
    placements: 0,
    receipts: [],
    examined: 0,
    phase: complete ? 4 : 0,
    after: '',
    restarted: false,
  };
}

function restored(
  options: {
    graphOpen?: boolean;
    fence?: { open: boolean; generation: string } | null;
    epochFailure?: boolean;
    lineage?: { dataEpoch: string; routingEpoch: string };
    ownerLogins?: { role: string; enabled: boolean }[];
    membership?: { statuses?: unknown[]; preparations?: unknown[] };
    afterLogin?: () => void;
    loginReadbackFailure?: boolean | Error;
  } = {},
) {
  const events: string[] = [];
  const preparationCalls: MembershipPreparationInput[] = [];
  const targetLineage = options.lineage ?? { dataEpoch, routingEpoch };
  const statuses = [
    ...(options.membership?.statuses ?? [{ needsPreparation: true }, { needsPreparation: false }]),
  ];
  const preparations = [...(options.membership?.preparations ?? [membershipResult(true)])];
  const context: OperatorRestoreReleaseContext = {
    budget: new RecoveryBudget(),
    manifest: {
      fenceGeneration: '9007199254740993',
      sealedCoverage: 'signed-owner-cut',
      sealedDeletionSets: ['signed-deletion-cut'],
    },
    apps: {
      MAIN_DATA_EPOCH: targetLineage.dataEpoch,
      MAIN_ROUTING_EPOCH: targetLineage.routingEpoch,
    },
    fuseki: {
      query: async (query: string) => {
        events.push('graph-release-observation');
        expect(query).toContain(targetLineage.dataEpoch);
        expect(query).toContain(targetLineage.routingEpoch);
        return { boolean: options.graphOpen ?? true };
      },
      membershipPreparationStatus: async () => {
        events.push('membership-status');
        const status = statuses.shift();
        if (status instanceof Error) throw status;
        return status;
      },
      membershipPrepare: async (input: MembershipPreparationInput) => {
        events.push('membership-prepare');
        preparationCalls.push(input);
        const result = preparations.shift();
        if (result instanceof Error) throw result;
        return result as MembershipPreparationResult;
      },
    } as FusekiClient,
    pools: {
      access: {
        query: async (query: string) => {
          expect(query).toStartWith('SELECT open, generation');
          events.push('access-release-observation');
          const fence =
            options.fence === undefined
              ? { open: true, generation: '9007199254740994' }
              : options.fence;
          return { rows: fence ? [fence] : [] };
        },
      } as unknown as Pool,
      content: {
        query: async () => {
          events.push('advance-owner-epochs');
          if (options.epochFailure) throw new Error('restore epoch advancement interrupted');
          return { rows: [] };
        },
      } as unknown as Pool,
      account: {
        query: async (query: string) => {
          if (query.startsWith('ALTER ROLE')) {
            expect(query).toContain('ALTER ROLE account LOGIN');
            events.push('enable-owner-logins');
            options.afterLogin?.();
            return { rows: [] };
          }
          expect(query).toContain('FROM pg_roles');
          events.push('observe-owner-logins');
          if (options.loginReadbackFailure) throw options.loginReadbackFailure === true
            ? new Error('pg_roles readback unavailable') : options.loginReadbackFailure;
          return {
            rows:
              options.ownerLogins ??
              ['account', 'access', 'content', 'relay'].map((role) => ({
                role,
                enabled: true,
                rolname: role,
                rolcanlogin: true,
              })),
          };
        },
      } as unknown as Pool,
    },
  };
  const checks: RestoreChecks<OperatorRestoreReleaseContext> = {
    verify: async () => {},
    verifyServing: async (received) => {
      expect(received).toBe(context);
      events.push('serving-verification');
    },
    reconcile: async (received, body, key) => {
      expect(received).toBe(context);
      expect(body).toEqual({
        profile: 'owner-reconciliation-v1',
        kind: 'restore',
        sealedCoverage: 'signed-owner-cut',
        sealedDeletionSets: ['signed-deletion-cut'],
      });
      expect(key).toBe('recovery-cut-successor');
      events.push('authenticated-reconciliation');
      return Response.json({ state: 'reconciled', disposition: 'matched' });
    },
  };
  const finishOnlyChecks: Pick<RestoreChecks<OperatorRestoreReleaseContext>, 'reconcile'> = {
    get reconcile() {
      return checks.reconcile;
    },
  };
  const finish = () =>
    finishOperatorRestore(context, finishOnlyChecks, 'recovery-cut-successor', () => {
      events.push('independent-frontier-and-source-check');
    });
  const proof: RestoreEvidence = {
    project: 'rezics-qa-erasure-successor',
    state: 'held',
    reconcileCompleted: false,
    graphReleaseObserved: false,
    accessReleaseObserved: false,
    membershipPrepared: false,
    loginEnabled: false,
    servingVerified: false,
    phases: context.budget.phases,
    elapsedMs: 0,
    admissionWaitMs: 0,
    budgetMs: 600_000,
  };
  const finishAndVerify = () =>
    finishAndVerifyRestore(
      context,
      checks,
      'recovery-cut-successor',
      () => {
        events.push('independent-frontier-and-source-check');
      },
      proof,
    );
  return { context, checks, events, preparationCalls, finish, finishAndVerify, proof };
}

test('operator restore default and incomplete adapters hold before reading or creating a target', async () => {
  for (const checks of [
    undefined,
    { verify: async () => {} } as unknown as RestoreChecks,
    {
      verify: async () => {},
      reconcile: async () => Response.json({}),
    } as unknown as RestoreChecks,
    { reconcile: async () => Response.json({}) } as unknown as RestoreChecks,
  ]) {
    await expect(
      restoreRecoverySet({
        set: '.temp/restore-erasure-missing-set',
        frontier: '.temp/restore-erasure-missing-frontier',
        project: 'rezics-qa-erasure-successor',
        key: 'ab'.repeat(32),
        checks,
      }),
    ).rejects.toThrow(
      'configure exact read/search/takeout checks, authenticated owner reconciliation, and post-release serving verification',
    );
  }
});

test('full restore verifies serving after release on the same budget before marking evidence verified', async () => {
  const fixture = restored();
  const budget = fixture.context.budget;
  await fixture.finishAndVerify();
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'membership-status',
    'membership-prepare',
    'membership-status',
    'advance-owner-epochs',
    'enable-owner-logins',
    'observe-owner-logins',
    'serving-verification',
  ]);
  expect(fixture.proof).toMatchObject({
    state: 'verified',
    reconcileCompleted: true,
    graphReleaseObserved: true,
    accessReleaseObserved: true,
    membershipPrepared: true,
    loginEnabled: true,
    servingVerified: true,
  });
  expect(fixture.proof.phases).toHaveProperty('serving-verification');
  expect(fixture.context.budget).toBe(budget);
  expect(Object.keys(budget.phases)).toEqual([
    'owner-reconciliation-api',
    'release-observation',
    'membership-preparation',
    'epoch-advancement-and-logins',
    'serving-verification',
  ]);
});

test('readiness failure leaves observed release evidence and records successful target stop', async () => {
  const fixture = restored();
  fixture.checks.verifyServing = async (context) => {
    expect(context).toBe(fixture.context);
    expect(fixture.proof.state).toBe('released');
    fixture.events.push('serving-verification');
    throw new Error('restored target is not ready');
  };
  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    'Full restore serving verification failed; reconciliation completed; graph release observed; Access release observed; membership preparation prepared; LOGIN enabled; serving verification not passed: restored target is not ready',
  );
  expect(fixture.proof).toMatchObject({
    state: 'released',
    reconcileCompleted: true,
    graphReleaseObserved: true,
    accessReleaseObserved: true,
    membershipPrepared: true,
    loginEnabled: true,
    servingVerified: false,
    targetStopped: true,
    failure:
      'Full restore serving verification failed; reconciliation completed; graph release observed; Access release observed; membership preparation prepared; LOGIN enabled; serving verification not passed: restored target is not ready',
  });
  expect(fixture.events.slice(-3)).toEqual([
    'observe-owner-logins',
    'serving-verification',
    'stop-target',
  ]);
});

test.each([
  { cleanupFails: false, targetStopped: true },
  { cleanupFails: true, targetStopped: false },
])(
  'records release and LOGIN when the deadline expires immediately after LOGIN (cleanup stopped: $targetStopped)',
  async ({ cleanupFails, targetStopped }) => {
    let now = 0;
    const fixture = restored({
      afterLogin: () => {
        now = 600_000;
      },
    });
    fixture.context.budget = new RecoveryBudget(() => now);
    fixture.proof.phases = fixture.context.budget.phases;

    let failure: unknown;
    try {
      await fixture.finishAndVerify();
    } catch (error) {
      failure = error;
      recordRestoreFailure(fixture.proof, error, () => {
        fixture.events.push('stop-target');
        if (cleanupFails) throw new Error('docker stop failed');
      });
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('deadline exceeded');
    expect((failure as Error).message).toContain(
      'graph release observed; Access release observed; membership preparation prepared; LOGIN enabled',
    );
    expect((failure as Error).message).toContain('600-second budget');
    expect((failure as Error).message).not.toContain('serving remains held');
    expect(fixture.proof).toMatchObject({
      state: 'released',
      reconcileCompleted: true,
      graphReleaseObserved: true,
      accessReleaseObserved: true,
      membershipPrepared: true,
      loginEnabled: true,
      servingVerified: false,
      targetStopped,
      failure: (failure as Error).message,
    });
    expect(fixture.proof.state).not.toBe('verified');
    expect(fixture.events.slice(-2)).toEqual(['observe-owner-logins', 'stop-target']);
    if (cleanupFails) {
      expect(fixture.proof.cleanupFailure).toBe('docker stop failed');
    } else {
      expect(fixture.proof.cleanupFailure).toBeUndefined();
    }
    expect(fixture.proof.phases['epoch-advancement-and-logins']).toBe(600_000);
    expect(fixture.events).not.toContain('serving-verification');
  },
);

test('matched reconciliation at the deadline is completed but release remains unobserved before cleanup', async () => {
  let now = 0;
  const fixture = restored();
  fixture.context.budget = new RecoveryBudget(() => now);
  fixture.proof.phases = fixture.context.budget.phases;
  fixture.checks.reconcile = async () => {
    fixture.events.push('authenticated-reconciliation');
    now = 600_000;
    return Response.json({ state: 'reconciled', disposition: 'matched' });
  };

  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('600-second budget');
  expect((failure as Error).message).toContain('reconciliation completed');
  expect((failure as Error).message).toContain('graph release not observed');
  expect((failure as Error).message).toContain('Access release not observed');
  expect((failure as Error).message).toContain('LOGIN not enabled');
  expect((failure as Error).message).not.toContain('serving remains held');
  expect(fixture.proof).toMatchObject({
    state: 'held',
    reconcileCompleted: true,
    graphReleaseObserved: false,
    accessReleaseObserved: false,
    membershipPrepared: false,
    loginEnabled: false,
    servingVerified: false,
    targetStopped: true,
    failure: (failure as Error).message,
  });
  expect(fixture.proof.state).not.toBe('verified');
  expect(fixture.proof.phases['owner-reconciliation-api']).toBe(600_000);
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'stop-target',
  ]);
});

test('a recreated target cannot inherit a prior matched reconciliation release', async () => {
  const fixture = restored({
    graphOpen: false,
    lineage: {
      dataEpoch: '00000000-0000-4000-8000-000000000061',
      routingEpoch: '00000000-0000-4000-8000-000000000062',
    },
  });
  fixture.checks.reconcile = async (_context, _body, key) => {
    expect(key).toBe('recovery-cut-successor');
    fixture.events.push('replayed-authenticated-reconciliation');
    return Response.json({
      state: 'reconciled',
      disposition: 'matched',
      replayed: true,
    });
  };

  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('did not release the restored graph');
  expect(fixture.proof).toMatchObject({
    state: 'held',
    reconcileCompleted: true,
    graphReleaseObserved: false,
    accessReleaseObserved: false,
    membershipPrepared: false,
    loginEnabled: false,
    servingVerified: false,
    targetStopped: true,
  });
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'replayed-authenticated-reconciliation',
    'graph-release-observation',
    'stop-target',
  ]);
});

test('committed owner LOGIN remains evidence when readback does not confirm every role', async () => {
  const fixture = restored({
    ownerLogins: [
      { role: 'account', enabled: true },
      { role: 'access', enabled: true },
      { role: 'content', enabled: true },
      { role: 'relay', enabled: false },
    ].map(({ role, enabled }) => ({
      role,
      enabled,
      rolname: role,
      rolcanlogin: enabled,
    })),
  });

  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(
    'LOGIN enabled, but pg_roles readback did not confirm every restored owner role',
  );
  expect(fixture.proof).toMatchObject({
    state: 'released',
    reconcileCompleted: true,
    graphReleaseObserved: true,
    accessReleaseObserved: true,
    membershipPrepared: true,
    loginEnabled: true,
    targetStopped: true,
  });
  expect(fixture.events.slice(-2)).toEqual(['observe-owner-logins', 'stop-target']);
});

test('a pg_roles query failure preserves the committed LOGIN fact', async () => {
  const fixture = restored({ loginReadbackFailure: true });
  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('LOGIN enabled, pg_roles readback failed');
  expect(fixture.proof).toMatchObject({
    state: 'released',
    reconcileCompleted: true,
    graphReleaseObserved: true,
    accessReleaseObserved: true,
    membershipPrepared: true,
    loginEnabled: true,
    servingVerified: false,
    targetStopped: true,
  });
  expect(fixture.events.slice(-3)).toEqual([
    'enable-owner-logins',
    'observe-owner-logins',
    'stop-target',
  ]);
});

test('a transient pg_roles readback failure keeps its shared classification after LOGIN commits', async () => {
  const original = Object.assign(new Error('pg_roles connection reset'), { code: 'ECONNRESET' });
  const fixture = restored({ loginReadbackFailure: original });
  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('LOGIN enabled, pg_roles readback failed');
  const causes: unknown[] = [];
  for (let cause: unknown = failure; cause instanceof Error; cause = cause.cause) causes.push(cause);
  expect(causes.some(cause => cause instanceof RestoreInterrupted)).toBe(true);
  expect(causes).toContain(original);
  expect(isRestoreTransientFailure(failure)).toBe(true);
  expect(fixture.proof).toMatchObject({ state: 'released', loginEnabled: true, servingVerified: false,
    targetStopped: true });
  expect(fixture.events.slice(-3)).toEqual([
    'enable-owner-logins',
    'observe-owner-logins',
    'stop-target',
  ]);
});

for (const phase of ['before-LOGIN', 'LOGIN-write', 'LOGIN-readback'] as const) {
  for (const transport of ['Fuseki-503', 'ECONNRESET'] as const) {
    test(`operator ${phase}: ${transport} preserves retryable causes and same-key completion enables LOGIN once`, async () => {
      const fixture = restored({ membership: { statuses: [{ needsPreparation: false }, { needsPreparation: false }] } });
      const original = transport === 'Fuseki-503'
        ? new FusekiHttpError('Fuseki query returned 503', 503, 'Service Unavailable')
        : Object.assign(new Error('owner connection reset'), { code: 'ECONNRESET' });
      const failure = new Error('owner unavailable during login completion', { cause: original });
      let armed = true;
      let loginEnabled = false;
      let loginEffects = 0;
      const accountQuery = fixture.context.pools.account.query.bind(fixture.context.pools.account);
      const contentQuery = fixture.context.pools.content.query.bind(fixture.context.pools.content);
      const account = spyOn(fixture.context.pools.account, 'query').mockImplementation((async (sql: string) => {
        const loginWrite = sql.startsWith('ALTER ROLE');
        if (armed && (phase === 'LOGIN-write' && loginWrite || phase === 'LOGIN-readback' && !loginWrite)) {
          throw failure;
        }
        const result = await accountQuery(sql);
        if (loginWrite && !loginEnabled) { loginEnabled = true; loginEffects++; }
        return result;
      }) as typeof fixture.context.pools.account.query);
      const content = spyOn(fixture.context.pools.content, 'query').mockImplementation((async (sql: string) => {
        if (armed && phase === 'before-LOGIN') throw failure;
        return contentQuery(sql);
      }) as typeof fixture.context.pools.content.query);
      try {
        let rejected: unknown;
        try { await fixture.finishAndVerify(); } catch (error) { rejected = error; }
        expect(rejected).toBeInstanceOf(Error);
        expect(isRestoreTransientFailure(rejected)).toBe(true);
        let cause = rejected;
        while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
        expect(cause).toBe(original);
        recordRestoreFailure(fixture.proof, rejected, () => fixture.events.push('stop-target'));
        expect(fixture.proof).toMatchObject({ state: phase === 'LOGIN-readback' ? 'released' : 'held',
          reconcileCompleted: true,
          graphReleaseObserved: true, accessReleaseObserved: true,
          loginEnabled: phase === 'LOGIN-readback', servingVerified: false });
        expect(loginEnabled).toBe(phase === 'LOGIN-readback');
        armed = false;
        await fixture.finishAndVerify();
        expect(fixture.proof).toMatchObject({ state: 'verified', loginEnabled: true, servingVerified: true });
        expect(loginEffects).toBe(1);
        expect(fixture.events.filter(event => event === 'authenticated-reconciliation')).toHaveLength(2);
        expect(fixture.events.filter(event => event === 'graph-release-observation')).toHaveLength(2);
        expect(fixture.events.filter(event => event === 'access-release-observation')).toHaveLength(2);
        expect(fixture.events).toContain('observe-owner-logins');
      } finally { account.mockRestore(); content.mockRestore(); }
    });
  }
}

test('membership preparation failure preserves both observed releases and keeps state held', async () => {
  const fixture = restored({
    membership: { preparations: [new Error('membership preparation interrupted')] },
  });
  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('membership preparation interrupted');
  expect((failure as Error).message).toContain('graph release observed; Access release observed');
  expect((failure as Error).message).toContain('LOGIN not enabled');
  expect(fixture.proof).toMatchObject({
    state: 'held',
    reconcileCompleted: true,
    graphReleaseObserved: true,
    accessReleaseObserved: true,
    membershipPrepared: false,
    loginEnabled: false,
    servingVerified: false,
    targetStopped: true,
  });
  expect(fixture.events).not.toContain('advance-owner-epochs');
  expect(fixture.events).not.toContain('enable-owner-logins');
});

test('owner epoch failure preserves prepared membership and both observed releases', async () => {
  const fixture = restored({ epochFailure: true });
  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => fixture.events.push('stop-target'));
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('restore epoch advancement interrupted');
  expect((failure as Error).message).toContain('membership preparation prepared');
  expect((failure as Error).message).toContain('LOGIN not enabled');
  expect(fixture.proof).toMatchObject({
    state: 'held',
    reconcileCompleted: true,
    graphReleaseObserved: true,
    accessReleaseObserved: true,
    membershipPrepared: true,
    loginEnabled: false,
    servingVerified: false,
    targetStopped: true,
  });
  expect(fixture.events).not.toContain('enable-owner-logins');
});

test('serving verification shares the recovery deadline and reports failed target cleanup', async () => {
  let now = 0;
  const fixture = restored();
  fixture.context.budget = new RecoveryBudget(() => now);
  fixture.proof.phases = fixture.context.budget.phases;
  fixture.checks.verifyServing = async () => {
    fixture.events.push('serving-verification');
    now = 600_000;
  };
  let failure: unknown;
  try {
    await fixture.finishAndVerify();
  } catch (error) {
    failure = error;
    recordRestoreFailure(fixture.proof, error, () => {
      fixture.events.push('stop-target');
      throw new Error('docker recovery step failed (exit 1); serving remains held');
    });
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    'Full restore serving verification failed; reconciliation completed; graph release observed; Access release observed; membership preparation prepared; LOGIN enabled; serving verification not passed: Recovery exceeded its 600-second budget',
  );
  expect(fixture.proof).toMatchObject({
    state: 'released',
    reconcileCompleted: true,
    graphReleaseObserved: true,
    accessReleaseObserved: true,
    membershipPrepared: true,
    loginEnabled: true,
    servingVerified: false,
    targetStopped: false,
    cleanupFailure: 'docker recovery step failed (exit 1)',
  });
  expect(fixture.proof.state).not.toBe('verified');
  expect(fixture.events.slice(-3)).toEqual([
    'observe-owner-logins',
    'serving-verification',
    'stop-target',
  ]);
  expect(fixture.proof.phases['serving-verification']).toBe(600_000);
});

test('operator finish observes both owner releases before enabling logins, using exact bigint generations', async () => {
  const fixture = restored();
  const startedAt = Date.now();
  await fixture.finish();
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'membership-status',
    'membership-prepare',
    'membership-status',
    'advance-owner-epochs',
    'enable-owner-logins',
    'observe-owner-logins',
  ]);
  expect(fixture.preparationCalls).toHaveLength(1);
  expect(fixture.preparationCalls[0]).toMatchObject({ dataEpoch, routingEpoch });
  expect(Number.isSafeInteger(fixture.preparationCalls[0]?.deadline)).toBe(true);
  expect(fixture.preparationCalls[0]!.deadline).toBeGreaterThanOrEqual(startedAt + 540_000);
  expect(fixture.preparationCalls[0]!.deadline).toBeLessThanOrEqual(Date.now() + 540_000);
  expect(Object.keys(fixture.context.budget.phases)).toEqual([
    'owner-reconciliation-api',
    'release-observation',
    'membership-preparation',
    'epoch-advancement-and-logins',
  ]);
});

test('operator finish confirms an already complete native membership proof without preparing again', async () => {
  const fixture = restored({
    membership: {
      statuses: [{ needsPreparation: false }, { needsPreparation: false }],
      preparations: [],
    },
  });
  await fixture.finish();
  await fixture.finish();
  expect(fixture.events.filter((event) => event === 'membership-status')).toHaveLength(2);
  expect(fixture.events.filter((event) => event === 'graph-release-observation')).toHaveLength(2);
  expect(fixture.events.filter((event) => event === 'access-release-observation')).toHaveLength(2);
  expect(fixture.events).not.toContain('membership-prepare');
  expect(fixture.events).toContain('enable-owner-logins');
});

test('operator finish resumes native membership progress across bounded turns', async () => {
  const fixture = restored({
    membership: {
      preparations: [membershipResult(false), membershipResult(true)],
    },
  });
  await fixture.finish();
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'membership-status',
    'membership-prepare',
    'membership-prepare',
    'membership-status',
    'advance-owner-epochs',
    'enable-owner-logins',
    'observe-owner-logins',
  ]);
  expect(fixture.preparationCalls).toHaveLength(2);
  expect(fixture.preparationCalls.map((call) => [call.dataEpoch, call.routingEpoch])).toEqual([
    [dataEpoch, routingEpoch],
    [dataEpoch, routingEpoch],
  ]);
  expect(new Set(fixture.preparationCalls.map((call) => call.requestId)).size).toBe(2);
  expect(fixture.preparationCalls[0]?.deadline).toBe(fixture.preparationCalls[1]?.deadline);
});

test('operator finish completes membership preparation beyond 256 native turns', async () => {
  const fixture = restored({
    membership: {
      preparations: [
        ...Array.from({ length: 256 }, () => membershipResult(false)),
        membershipResult(true),
      ],
    },
  });
  await fixture.finish();
  expect(fixture.preparationCalls).toHaveLength(257);
  expect(new Set(fixture.preparationCalls.map((call) => call.deadline)).size).toBe(1);
  expect(fixture.events.at(-3)).toBe('advance-owner-epochs');
  expect(fixture.events.at(-2)).toBe('enable-owner-logins');
  expect(fixture.events.at(-1)).toBe('observe-owner-logins');
});

test('operator finish refuses release when membership status still needs preparation', async () => {
  const fixture = restored({
    membership: {
      statuses: [{ needsPreparation: true }, { needsPreparation: true }],
      preparations: [membershipResult(true)],
    },
  });
  await expect(fixture.finish()).rejects.toThrow(
    'Native membership preparation did not confirm completion',
  );
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'membership-status',
    'membership-prepare',
    'membership-status',
  ]);
  expect(fixture.events).not.toContain('enable-owner-logins');
});

test.each([undefined, { needsPreparation: 'no' }] as const)(
  'operator finish refuses an invalid native membership status (%j)',
  async (status) => {
    const fixture = restored({ membership: { statuses: [status] } });
    await expect(fixture.finish()).rejects.toThrow(
      'Native membership preparation status is invalid',
    );
    expect(fixture.events).toEqual([
      'independent-frontier-and-source-check',
      'authenticated-reconciliation',
      'graph-release-observation',
      'access-release-observation',
      'membership-status',
    ]);
    expect(fixture.events).not.toContain('enable-owner-logins');
  },
);

test.each(['conflict', 'invalid', 'unknown-profile', 'deadline'] as const)(
  'operator finish keeps logins held when native membership preparation is refused with %s',
  async (status) => {
    const fixture = restored({
      membership: { preparations: [{ status }] },
    });
    await expect(fixture.finish()).rejects.toThrow(`Fuseki command ${status}`);
    expect(fixture.events).toEqual([
      'independent-frontier-and-source-check',
      'authenticated-reconciliation',
      'graph-release-observation',
      'access-release-observation',
      'membership-status',
      'membership-prepare',
    ]);
    expect(fixture.events).not.toContain('enable-owner-logins');
  },
);

test('partial native membership progress cannot outlive the restore deadline', async () => {
  const fixture = restored({
    membership: { preparations: [membershipResult(false), membershipResult(true)] },
  });
  let now = 0;
  fixture.context.budget = new RecoveryBudget(() => now);
  const prepare = fixture.context.fuseki.membershipPrepare.bind(fixture.context.fuseki);
  fixture.context.fuseki.membershipPrepare = async (input, signal) => {
    const result = await prepare(input, signal);
    now = 600_000;
    return result;
  };
  await expect(fixture.finish()).rejects.toThrow('600-second budget');
  expect(fixture.preparationCalls).toHaveLength(1);
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'membership-status',
    'membership-prepare',
  ]);
  expect(fixture.events).not.toContain('enable-owner-logins');
});

test('an unmatched restored membership epoch cannot outlive the shared recovery budget', async () => {
  const fixture = restored({
    membership: {
      preparations: [{ status: 'guard-unmatched' }],
    },
  });
  let now = 0;
  fixture.context.budget = new RecoveryBudget(() => now);
  const prepare = fixture.context.fuseki.membershipPrepare.bind(fixture.context.fuseki);
  fixture.context.fuseki.membershipPrepare = async (input, signal) => {
    const result = await prepare(input, signal);
    now = 600_000;
    return result;
  };
  await expect(fixture.finish()).rejects.toThrow('600-second budget');
  expect(fixture.events.slice(0, 4)).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
  ]);
  expect(fixture.preparationCalls).toHaveLength(1);
  expect(fixture.events).not.toContain('advance-owner-epochs');
  expect(fixture.events).not.toContain('enable-owner-logins');
});

test('lost native acknowledgment keeps logins held and the next finish resumes preparation', async () => {
  const fixture = restored({
    membership: {
      statuses: [
        { needsPreparation: true },
        { needsPreparation: true },
        { needsPreparation: false },
      ],
      preparations: [
        membershipResult(false),
        new Error('Membership preparation outcome unknown'),
        membershipResult(true),
      ],
    },
  });
  await expect(fixture.finish()).rejects.toThrow('Membership preparation outcome unknown');
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'membership-status',
    'membership-prepare',
    'membership-prepare',
  ]);
  expect(fixture.events).not.toContain('enable-owner-logins');

  const secondFinishStart = fixture.events.length;
  await fixture.finish();
  expect(fixture.events.slice(secondFinishStart)).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'membership-status',
    'membership-prepare',
    'membership-status',
    'advance-owner-epochs',
    'enable-owner-logins',
    'observe-owner-logins',
  ]);
  expect(new Set(fixture.preparationCalls.map((call) => call.requestId)).size).toBe(3);
});

test.each([
  ['held', 'conflict', 200],
  ['reconciled', 'unavailable', 200],
  ['running', 'matched', 200],
  ['reconciled', 'matched', 503],
  [null, null, 200],
] as const)(
  'operator keeps logins held for %s/%s reconciliation with HTTP %i',
  async (state, disposition, status) => {
    const fixture = restored();
    fixture.checks.reconcile = async () => {
      fixture.events.push('authenticated-reconciliation');
      return Response.json(state === null ? null : { state, disposition }, { status });
    };
    await expect(fixture.finish()).rejects.toThrow('did not verify the restore');
    expect(fixture.events).toEqual([
      'independent-frontier-and-source-check',
      'authenticated-reconciliation',
    ]);
  },
);

test('a matched response cannot bypass the restored graph hold or a different lineage', async () => {
  const fixture = restored({ graphOpen: false });
  await expect(fixture.finish()).rejects.toThrow('did not release the restored graph');
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
  ]);
  expect(fixture.preparationCalls).toHaveLength(0);
  expect(fixture.events).not.toContain('membership-status');
});

test.each([
  null,
  { open: false, generation: '9007199254740993' },
  { open: true, generation: '9007199254740993' },
  { open: true, generation: '9007199254740995' },
])(
  'a matched response cannot bypass missing, held or changed Access release evidence (%j)',
  async (fence) => {
    const fixture = restored({ fence });
    await expect(fixture.finish()).rejects.toThrow(
      'did not release the captured Access recovery generation',
    );
    expect(fixture.events).toEqual([
      'independent-frontier-and-source-check',
      'authenticated-reconciliation',
      'graph-release-observation',
      'access-release-observation',
    ]);
    expect(fixture.preparationCalls).toHaveLength(0);
    expect(fixture.events).not.toContain('membership-status');
  },
);

test('interrupted retained-erasure replay never advances epochs or enables owner logins', async () => {
  const fixture = restored();
  fixture.checks.reconcile = async () => {
    fixture.events.push('retained-erasure-replay');
    throw new Error('retained erasure replay interrupted');
  };
  await expect(fixture.finish()).rejects.toThrow('retained erasure replay interrupted');
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'retained-erasure-replay',
  ]);
});

test('a moved independently retained frontier fails before owner reconciliation', async () => {
  const fixture = restored();
  await expect(
    finishOperatorRestore(fixture.context, fixture.checks, 'recovery-cut-successor', () => {
      throw new Error('a newer retained frontier exists');
    }),
  ).rejects.toThrow('a newer retained frontier exists');
  expect(fixture.events).toEqual([]);
});

test('interrupted owner epoch advancement leaves login roles held', async () => {
  const fixture = restored({ epochFailure: true });
  await expect(fixture.finish()).rejects.toThrow('restore epoch advancement interrupted');
  expect(fixture.events).not.toContain('enable-owner-logins');
});
