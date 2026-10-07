import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  finishOperatorRestore,
  restoreRecoverySet,
  type RestoredContext,
  type RestoreChecks,
} from '../restore.ts';
import { RecoveryBudget, type RecoveryManifest } from '../recovery-set.ts';

const dataEpoch = '00000000-0000-4000-8000-000000000051';
const routingEpoch = '00000000-0000-4000-8000-000000000052';

function restored(
  options: {
    graphOpen?: boolean;
    fence?: { open: boolean; generation: string } | null;
    epochFailure?: boolean;
  } = {},
) {
  const events: string[] = [];
  const context: RestoredContext = {
    budget: new RecoveryBudget(),
    manifest: {
      id: 'retained-cut',
      fenceGeneration: '9007199254740993',
      sealedCoverage: 'signed-owner-cut',
      sealedDeletionSets: ['signed-deletion-cut'],
    } as RecoveryManifest,
    apps: { MAIN_DATA_EPOCH: dataEpoch, MAIN_ROUTING_EPOCH: routingEpoch },
    appsFile: '',
    fuseki: {
      query: async (query: string) => {
        events.push('graph-release-observation');
        expect(query).toContain(dataEpoch);
        expect(query).toContain(routingEpoch);
        return { boolean: options.graphOpen ?? true };
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
          expect(query).toContain('ALTER ROLE account LOGIN');
          events.push('enable-owner-logins');
          return { rows: [] };
        },
      } as unknown as Pool,
      relay: {} as Pool,
    },
  };
  const checks: RestoreChecks = {
    verify: async () => {},
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
  const finish = () =>
    finishOperatorRestore(context, checks, 'recovery-cut-successor', () => {
      events.push('independent-frontier-and-source-check');
    });
  return { context, checks, events, finish };
}

test('operator restore default and incomplete adapters hold before reading or creating a target', async () => {
  for (const checks of [
    undefined,
    { verify: async () => {} } as unknown as RestoreChecks,
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
      'configure exact read/search/takeout checks and authenticated owner reconciliation',
    );
  }
});

test('operator finish observes both owner releases before enabling logins, using exact bigint generations', async () => {
  const fixture = restored();
  await fixture.finish();
  expect(fixture.events).toEqual([
    'independent-frontier-and-source-check',
    'authenticated-reconciliation',
    'graph-release-observation',
    'access-release-observation',
    'advance-owner-epochs',
    'enable-owner-logins',
  ]);
  expect(Object.keys(fixture.context.budget.phases)).toEqual([
    'owner-reconciliation-api',
    'release-observation-and-logins',
  ]);
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
