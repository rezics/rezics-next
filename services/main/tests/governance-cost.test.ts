import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import {
  validateDecisionEvidence,
  GOVERNANCE_VALIDATION_COST,
} from '../src/modules/governance/decision-evidence.ts';
import {
  GovernanceDenied,
  GovernanceInvalid,
  GovernanceStale,
  GovernanceStore,
  type DecisionInput,
} from '../src/modules/governance/store.ts';

const input: DecisionInput = {
  caseId: '00000000-0000-4000-8000-000000000001',
  expectedGeneration: '0',
  actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  outcome: 'restrict',
  targets: [
    {
      owner: 'graph',
      resource: 'urn:work',
      component: 'title',
      locator: null,
      scopeKind: 'exact_revision',
      revision: 'urn:revision',
      expectedHead: 'urn:revision',
      effect: 'disclosure',
    },
  ],
  rule: { ref: 'urn:rule', revision: '1', digest: 'a'.repeat(64) },
  evidenceDigest: 'b'.repeat(64),
  reversesDecisionId: null,
  answersStepId: null,
  rationale: null,
  disclosure: 'private',
  idempotencyKey: 'decision',
  reasons: {
    facts: 'Reviewed facts.',
    scope: 'One title.',
    duration: 'Until review.',
    automation: false,
    contentLanguage: 'en',
    appealRoute: '/v1/public-reports/{caseId}/correspondence',
  },
};

test('decision validation makes indexed probes only for the digest and cited targets', async () => {
  for (const retainedReports of [3, 100_000]) {
    const statements: { sql: string; args?: unknown[] }[] = [];
    const client = {
      query: async (sql: string, args?: unknown[]) => {
        statements.push({ sql, args });
        if (sql.includes('governance_report')) {
          expect(sql).toContain('evidence_digest = $2 LIMIT 1');
          expect(args).toEqual([input.caseId, input.evidenceDigest]);
          return { rows: [{ id: String(retainedReports) }], rowCount: 1 };
        }
        expect(sql).toContain('LIMIT 1');
        return { rows: [], rowCount: sql.includes('automated') ? 0 : 1 };
      },
    } as unknown as PoolClient;
    const targets = [
      input.targets[0]!,
      { ...input.targets[0]!, scopeKind: 'component' as const, revision: null },
    ];
    await validateDecisionEvidence(client, { ...input, targets });
    expect(statements).toHaveLength(
      GOVERNANCE_VALIDATION_COST.basisReads +
        GOVERNANCE_VALIDATION_COST.automationReads +
        targets.length,
    );
    const probes = statements.filter((statement) => statement.sql.includes('target_key ='));
    expect(probes[0]!.args).toEqual([
      input.caseId,
      'graph',
      'urn:work',
      'title',
      null,
      'urn:revision',
      true,
    ]);
    expect(probes[1]!.args?.[5]).toBeNull();
    expect(
      statements.every((statement) => !statement.sql.includes('JOIN access.governance_report')),
    ).toBe(true);
  }
});

test('decision membership rejects absent, unavailable and undisclosed automation bases', async () => {
  for (const failure of ['basis', 'target', 'automation']) {
    const client = {
      query: async (sql: string) => {
        if (sql.includes('governance_report'))
          return { rows: failure === 'basis' ? [] : [{ id: 'report' }] };
        if (sql.includes('automated'))
          return { rows: [], rowCount: failure === 'automation' ? 1 : 0 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    await expect(validateDecisionEvidence(client, input)).rejects.toBeInstanceOf(
      failure === 'basis'
        ? GovernanceStale
        : failure === 'automation'
          ? GovernanceInvalid
          : GovernanceDenied,
    );
  }
});

test('every notifying outcome refuses missing reasons before consulting owners', async () => {
  const store = new GovernanceStore({} as never, {} as never, {} as never, {} as never);
  const admitted = store as unknown as {
    transaction: (work: (client: PoolClient) => Promise<unknown>) => Promise<unknown>;
    decider: () => Promise<void>;
    replayDecision: () => Promise<unknown>;
  };
  admitted.transaction = async (work) =>
    work({
      query: async () => ({
        rows: [{ kind: 'content_report', scope: 'governance:platform', urgent: false }],
      }),
    } as unknown as PoolClient);
  admitted.decider = async () => {};
  admitted.replayDecision = async () => null;
  for (const outcome of [
    'restrict',
    'interim_restrict',
    'final_restrict',
    'dismiss',
    'restore',
    'reverse',
  ] as const) {
    await expect(
      store.decide(
        { issuer: 'issuer', subject: 'staff' },
        {
          ...input,
          outcome,
          reasons: undefined,
          reversesDecisionId: outcome === 'reverse' ? input.caseId : null,
        },
      ),
    ).rejects.toThrow('notifying decisions require a statement of reasons');
  }
});

test('a retained legacy decision can replay its original request without inventing reasons', async () => {
  const store = new GovernanceStore({} as never, {} as never, {} as never, {} as never);
  const retained = store as unknown as {
    transaction: (work: (client: PoolClient) => Promise<unknown>) => Promise<unknown>;
    decider: () => Promise<void>;
    replayDecision: () => Promise<unknown>;
    resumeDecision: () => Promise<unknown>;
  };
  retained.transaction = async (work) =>
    work({
      query: async () => ({
        rows: [{ kind: 'content_report', scope: 'governance:platform', urgent: false }],
      }),
    } as unknown as PoolClient);
  retained.decider = async () => {};
  retained.replayDecision = async () => ({ decisionId: input.caseId });
  retained.resumeDecision = async () => ({ decisionId: input.caseId, replayed: true });
  expect(
    await store.decide({ issuer: 'issuer', subject: 'staff' }, { ...input, reasons: undefined }),
  ).toEqual({ decisionId: input.caseId, replayed: true } as never);
});
