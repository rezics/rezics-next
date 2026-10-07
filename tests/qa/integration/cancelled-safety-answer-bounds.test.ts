import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, type Pool } from 'pg';
import {
  GovernanceUnavailable,
  type DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { RightsCounterNotices } from '../../../services/main/src/modules/rights/counter-notice-worker.ts';
import {
  SAFETY_ALERT_BASIS,
  SAFETY_ALERT_COST,
  SAFETY_ALERT_SOURCE_SQL,
} from '../../../services/main/src/modules/safety-alerts/store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { json, nciiDeclaration, png, safetyFixture } from './g-744-support.ts';

type Fixture = Awaited<ReturnType<typeof safetyFixture>>;
type Statement = { text: string; values: unknown[] };
type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
};

async function migrate(pool: Pool) {
  const legacy = await pool.query(`SELECT 1 FROM pg_constraint
    WHERE conrelid = 'access.moderation_decision'::regclass
      AND conname = 'moderation_decision_answers_step_id_key'`);
  if (legacy.rowCount)
    await pool.query(
      readFileSync(
        new URL(
          '../../../services/main/migrations/access/1750_cancelled_safety_answer.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const current = await pool.query(`SELECT 1 FROM pg_indexes
    WHERE schemaname = 'access' AND indexname = 'moderation_decision_answers_step'
      AND indexdef LIKE '%case_sequence DESC%'`);
  if (!current.rowCount)
    await pool.query(
      readFileSync(
        new URL(
          '../../../services/main/migrations/access/1751_current_safety_answer.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
}

/** Capture the statements the owners execute, including interpolated shared SQL.
 * EXPLAIN replays those statements, never a parallel test-only query model. */
async function capture<T>(work: () => Promise<T>, allDecisionReads = false) {
  const statements: Statement[] = [];
  const original = Client.prototype.query;
  const probe = spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args
  ) {
    const [query, values] = args;
    if (
      typeof query === 'string' &&
      (query.includes('answers_step_id') || (allDecisionReads && /^\s*SELECT\b/.test(query))) &&
      /access\.moderation_decision\b/.test(query) &&
      !query.includes('EXPLAIN')
    ) {
      statements.push({ text: query, values: Array.isArray(values) ? values : [] });
    }
    return original.apply(this, args);
  });
  try {
    return { result: await work(), statements };
  } finally {
    probe.mockRestore();
  }
}

function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

async function answerVisits(pool: Pool, statement: Statement, indexed: boolean, latest = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Alert source is an INSERT: preserve the owner's output while measuring
    // the exact production statement. No planner settings are overridden.
    const explained = await client.query<{ 'QUERY PLAN': [{ Plan: Plan }] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
      statement.values,
    );
    const scans = nodes(explained.rows[0]!['QUERY PLAN'][0].Plan).filter(
      (node) => node['Relation Name'] === 'moderation_decision',
    );
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(
        scan['Actual Rows'] +
          (scan['Rows Removed by Filter'] ?? 0) +
          (scan['Rows Removed by Index Recheck'] ?? 0),
      ).toBeLessThanOrEqual(indexed ? 1 : 4);
      if (indexed && scan['Actual Loops'] > 0) {
        if (latest) expect(scan['Index Name']).toBe('moderation_decision_answers_step');
        expect(scan['Node Type']).toBe('Index Scan');
      }
    }
    for (const scan of nodes(explained.rows[0]!['QUERY PLAN'][0].Plan).filter((node) =>
      ['safety_decision_operation', 'safety_decision_effect'].includes(node['Relation Name'] ?? ''),
    )) {
      const bound = scan['Relation Name'] === 'safety_decision_operation' ? 1 : 64;
      expect(
        scan['Actual Rows'] +
          (scan['Rows Removed by Filter'] ?? 0) +
          (scan['Rows Removed by Index Recheck'] ?? 0),
      ).toBeLessThanOrEqual(indexed ? bound : Math.max(4, bound));
      if (indexed && scan['Actual Loops'] > 0) expect(scan['Node Type']).not.toBe('Seq Scan');
    }
    if (indexed) {
      // Ordering must be supplied by the seek, rather than sorting every
      // historical answer beneath LIMIT 1.
      for (const limit of nodes(explained.rows[0]!['QUERY PLAN'][0].Plan).filter(
        (node) => node['Node Type'] === 'Limit',
      )) {
        const answerScans = nodes(limit).filter(
          (node) => node['Relation Name'] === 'moderation_decision',
        );
        if (
          answerScans.length &&
          !nodes(limit)
            .slice(1)
            .some((node) => node['Node Type'] === 'Limit')
        )
          expect(nodes(limit).some((node) => node['Node Type'] === 'Sort')).toBe(false);
      }
    }
    return scans.reduce(
      (sum, scan) =>
        sum +
        scan['Actual Loops'] *
          (scan['Actual Rows'] +
            (scan['Rows Removed by Filter'] ?? 0) +
            (scan['Rows Removed by Index Recheck'] ?? 0)),
      0,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Seed retained attempts through every ordinary immutable/head guard, without
 * running thousands of network effects or weakening the owner constraints. */
async function appendCancelled(pool: Pool, sourceId: string, count: number, stepId?: string) {
  await pool.query(`DO $history$
    DECLARE source access.moderation_decision; attempt uuid; sequence bigint;
      answer_step uuid := NULLIF('${stepId ?? ''}','')::uuid;
    BEGIN
      SELECT * INTO STRICT source FROM access.moderation_decision WHERE id = '${sourceId}'::uuid;
      FOR attempt_number IN 1..${count} LOOP
        attempt := gen_random_uuid();
        SELECT generation + 1 INTO sequence FROM access.governance_case
          WHERE id = source.case_id FOR UPDATE;
        INSERT INTO access.moderation_decision
          (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,
           authority_kind,authority_scope_id,authority_epoch,authority_proof_digest,
           idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,
           rationale,disclosure,answers_step_id,statement_of_reasons)
        VALUES (attempt,source.kind,source.outcome,source.context,source.case_id,sequence,
          source.principal_id,source.acting_subject,source.authority_kind,source.authority_scope_id,
          source.authority_epoch,source.authority_proof_digest,
          source.idempotency_key || ':history:' || sequence,source.request_digest,
          source.rule_ref,source.rule_revision,source.rule_digest,source.evidence_digest,
          source.rationale,source.disclosure,COALESCE(answer_step,source.answers_step_id),source.statement_of_reasons);
        INSERT INTO access.safety_decision_operation (decision_id,cancelled) VALUES (attempt,true);
        INSERT INTO access.moderation_decision_target
          (decision_id,ordinal,owner,resource,component,locator,scope_kind,revision,expected_head,
           effect,expires_at,participant_subject)
        SELECT attempt,ordinal,owner,resource,component,locator,scope_kind,revision,expected_head,
          effect,expires_at,participant_subject FROM access.moderation_decision_target WHERE decision_id = source.id;
        INSERT INTO access.safety_decision_effect (decision_id,ordinal,plan,state,receipt,continuation,error)
        SELECT attempt,ordinal,plan,state,receipt,continuation,error FROM access.safety_decision_effect
          WHERE decision_id = source.id;
        UPDATE access.governance_case SET generation = sequence,decision_head = attempt
          WHERE id = source.case_id;
      END LOOP;
    END $history$`);
  await pool.query(
    'ANALYZE access.moderation_decision,access.safety_decision_operation,access.safety_decision_effect',
  );
}

async function cancel(f: Fixture, decisionId: string) {
  const key = randomUUID();
  const result = await json<DecisionResult>(
    await f.call(
      'POST',
      `/v1/safety-decisions/${decisionId}/cancellation`,
      { actingSubject: f.staff.actor, idempotencyKey: key },
      f.staff.token,
      key,
    ),
  );
  expect(result.operation.status).toBe('cancelled');
}

test('admission, due queue and alert checks seek one answer across thousands of cancelled attempts', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('cancelled-answer-bounds', true, databases.urls);
  try {
    await migrate(f.stack.accessPool);
    const image = await f.author.upload(png(151, 151));
    const receipt = await f.report(image, 'ncii', nciiDeclaration);
    const step = (
      await f.stack.accessPool.query<{ id: string; due_at: Date }>(
        "SELECT id,due_at FROM access.governance_process_step WHERE case_id = $1 AND step = 'removal_deadline'",
        [receipt.caseId],
      )
    ).rows[0]!;
    const initial = await f.input(receipt, image, 'restrict', null, step.id);
    const admission = await capture(() => f.decide(initial));
    const accepted = await json<DecisionResult>(admission.result, 202);
    const admissionQuery = admission.statements.find((query) =>
      query.text.includes('SELECT 1 FROM ('),
    )!;
    expect(admissionQuery).toBeDefined();
    await cancel(f, accepted.decisionId);
    f.setClock(step.due_at);
    const facts = (
      await f.stack.accessPool.query('SELECT * FROM access.moderation_decision WHERE id = $1', [
        accepted.decisionId,
      ])
    ).rows;
    const counts: Record<string, number[]> = {};
    for (const history of [1, 4000]) {
      if (history > 1) await appendCancelled(f.stack.accessPool, accepted.decisionId, history - 1);
      expect(
        (
          await f.stack.accessPool.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM access.moderation_decision WHERE answers_step_id = $1',
            [step.id],
          )
        ).rows[0]!.count,
      ).toBe(history);
      (counts.admission ??= []).push(
        await answerVisits(f.stack.accessPool, admissionQuery, history > 1),
      );
      const due = await capture(() => f.read('/v1/safety-cases/due-steps'));
      expect(
        (await json<{ items: { stepId: string }[] }>(due.result)).items.some(
          (item) => item.stepId === step.id,
        ),
      ).toBe(true);
      expect(due.statements).toHaveLength(1);
      (counts.queue ??= []).push(
        await answerVisits(f.stack.accessPool, due.statements[0]!, history > 1),
      );
      const source: Statement = {
        text: SAFETY_ALERT_SOURCE_SQL,
        values: [
          f.staff.principalId,
          'primary',
          step.due_at,
          SAFETY_ALERT_COST.leadMs,
          f.staff.principalId,
          SAFETY_ALERT_COST.acknowledgementMs,
          true,
          SAFETY_ALERT_COST.batch,
        ],
      };
      (counts.alertSource ??= []).push(await answerVisits(f.stack.accessPool, source, history > 1));
      const alerts = await capture(() => f.safetyAlerts.runOnce());
      expect(alerts.statements.some((query) => query.text === source.text)).toBe(true);
      const resolve = alerts.statements.find((query) =>
        query.text.includes('SELECT a.id,a.case_id'),
      )!;
      expect(resolve).toBeDefined();
      (counts.alertResolution ??= []).push(
        await answerVisits(f.stack.accessPool, resolve, history > 1),
      );
    }
    for (const values of Object.values(counts)) {
      expect(values).toHaveLength(2);
      expect(values[1]).toBeLessThanOrEqual(values[0]!);
      expect(values[1]).toBeLessThanOrEqual(1);
      expect(values[0]).toBeGreaterThan(0);
      expect(values[1]).toBeGreaterThan(0);
    }
    console.log(`cancelled answer seek visits (1,4000 histories): ${JSON.stringify(counts)}`);
    expect(
      (
        await f.stack.accessPool.query('SELECT * FROM access.moderation_decision WHERE id = $1', [
          accepted.decisionId,
        ])
      ).rows,
    ).toEqual(facts);
    expect(
      (
        await f.stack.accessPool.query(
          'SELECT due_at FROM access.governance_process_step WHERE id = $1',
          [step.id],
        )
      ).rows[0]!.due_at,
    ).toEqual(step.due_at);
    const completed = await f.complete(await f.input(receipt, image, 'restrict', null, step.id));
    expect(completed.operation.status).toBe('completed');
    expect(
      (
        await json<{ items: { stepId: string }[] }>(await f.read('/v1/safety-cases/due-steps'))
      ).items.some((item) => item.stepId === step.id),
    ).toBe(false);
    const alert = (
      await f.stack.accessPool.query<{ id: string; principal_id: string }>(
        'SELECT id,principal_id FROM access.safety_alert WHERE step_id = $1 ORDER BY created_at DESC LIMIT 1',
        [step.id],
      )
    ).rows[0]!;
    expect(
      (
        await f.safetyAlerts.resolve({
          principalId: alert.principal_id,
          owner: 'access',
          ref: alert.id,
          revision: null,
          disclosureBasis: SAFETY_ALERT_BASIS,
        })
      ).status,
    ).toBe('undisclosed');
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);

test('automatic counter-notice continuation seeks the current attempt without renewing receipt clocks', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('counter-answer-bounds', true, databases.urls);
  let fault: ReturnType<typeof spyOn> | undefined;
  try {
    await migrate(f.stack.accessPool);
    const image = await f.author.upload(png(152, 152));
    const receipt = await f.report(image, 'copyright', {
      contactEmail: 'claimant@example.test',
      copyright: {
        signature: 'Claimant',
        claimantName: 'Claimant',
        claimedWork: 'Original image',
        claimantAddress: 'Private address',
        claimantPhone: '+1 555 0100',
        materialLocation: 'Reported image',
        goodFaith: true,
        accurateAndAuthorizedUnderPerjury: true,
      },
    });
    const restricted = await f.complete(await f.input(receipt, image, 'interim_restrict'));
    await f.author.grant('governance:platform', 'governance.appeal');
    const counter = await f.governance.recordStep(f.author.principal, {
      caseId: receipt.caseId,
      decisionId: restricted.decisionId,
      actingSubject: f.author.actor,
      process: 'dmca_512',
      step: 'counter_notice',
      partySubject: f.author.actor,
      statement: 'The image was mistakenly identified.',
      documentDigest: null,
      occurredAt: new Date().toISOString(),
      dueAt: null,
      idempotencyKey: randomUUID(),
      contentLanguage: 'en',
      counterNotice: {
        signature: 'Uploader',
        name: 'Uploader',
        address: 'Private address',
        phone: '+1 555 0101',
        materialLocation: 'Reported original',
        courtJurisdiction: 'US district court',
        goodFaithMistakeUnderPerjury: true,
        consentToJurisdiction: true,
        acceptService: true,
      },
    });
    let now = new Date();
    const worker = new RightsCounterNotices(
      f.stack.accessPool,
      f.governance,
      async () => 'sent',
      () => now,
    );
    expect(await worker.runPage()).toEqual({ processed: 1, deferred: 0 });
    const clock = async () =>
      (
        await f.stack.accessPool.query<{
          received_at: Date;
          delivered_at: Date;
          not_before: Date;
          not_after: Date;
        }>(
          'SELECT received_at,delivered_at,not_before,not_after FROM access.rights_counter_notice WHERE step_id = $1',
          [counter.stepId],
        )
      ).rows[0]!;
    const originalClock = await clock();
    now = new Date(originalClock.not_after.getTime() + 1);
    f.setClock(now);
    const input = await f.input(receipt, image, 'restore', null, counter.stepId);
    input.idempotencyKey = `rights-deadline:${counter.stepId}`;
    const accepted = await f.governance.decide(f.staff.principal, input, true);
    await cancel(f, accepted.decisionId);
    const original = MediaStore.prototype.moderateOriginal;
    fault = spyOn(MediaStore.prototype, 'moderateOriginal').mockImplementation(async function (
      this: MediaStore,
      ...args
    ) {
      if (!args[3]) throw new GovernanceUnavailable('synthetic restoration owner interruption');
      return original.apply(this, args);
    });
    const latest = await capture(() => f.governance.restoreCounterNotice(counter.stepId), true);
    expect(latest.result.phase).toBe('restoring');
    const currentQuery = latest.statements.find((query) =>
      query.text.includes('COALESCE(o.cancelled,false)'),
    )!;
    expect(currentQuery).toBeDefined();
    const small = await answerVisits(f.stack.accessPool, currentQuery, false);
    await cancel(f, latest.result.decisionId!);
    await appendCancelled(f.stack.accessPool, accepted.decisionId, 3998);
    expect(
      (
        await f.stack.accessPool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM access.moderation_decision WHERE answers_step_id = $1',
          [counter.stepId],
        )
      ).rows[0]!.count,
    ).toBe(4000);
    const bounded = await capture(() => f.governance.restoreCounterNotice(counter.stepId), true);
    expect(bounded.result.phase).toBe('restoring');
    const bigQuery = bounded.statements.find((query) =>
      query.text.includes('COALESCE(o.cancelled,false)'),
    )!;
    expect(bigQuery).toBeDefined();
    const big = await answerVisits(f.stack.accessPool, bigQuery, true);
    expect(big).toBeLessThanOrEqual(small);
    expect(big).toBeLessThanOrEqual(1);
    expect(big).toBeGreaterThan(0);
    // Source recovery must also stay bounded: a reverse seek by restrictive
    // outcome would walk cancelled restorations even with a bounded answer.
    const automaticVisits: number[] = [];
    for (const statement of bounded.statements.filter((query) => /^\s*SELECT\b/.test(query.text))) {
      automaticVisits.push(
        await answerVisits(
          f.stack.accessPool,
          statement,
          true,
          statement.text.includes('ORDER BY case_sequence DESC'),
        ),
      );
    }
    expect(automaticVisits.length).toBeGreaterThan(1);
    console.log(
      `automatic counter-notice seek visits: ${JSON.stringify({ small, big, automaticVisits })}`,
    );
    expect(await clock()).toEqual(originalClock);
    fault.mockRestore();
    fault = undefined;
    expect((await f.governance.restoreCounterNotice(counter.stepId)).phase).toBe('done');
    expect(await clock()).toEqual(originalClock);
    expect((await f.stack.store.readAsset(image.asset))!.moderation).toBe('none');
  } finally {
    fault?.mockRestore();
    await f.stop();
    await databases.close();
  }
}, 180_000);
