import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { safetyFixture, json, type Receipt } from './g-744-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { fixtureReasons } from './g-565-decision-support.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import {
  SafetyDecisionMail,
  SafetyNoticeContinuation,
  type SafetyNoticeMail,
} from '../../../services/main/src/modules/governance/notices-mail.ts';
import type {
  DecisionInput,
  DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import { safetyCorrespondenceApi } from '../../../services/account/src/email-safety.ts';
import { symmetricDecrypt } from 'better-auth/crypto';

test('report enforcement reaches two authors and three private reporters across durable pages without duplicate mail', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
    'account',
  ]);
  const f = await safetyFixture('report-enforcement', true, databases.urls);
  const accountPool = new Pool({ connectionString: databases.urls.account });
  const account = await ratingAccount({
    ...Bun.env,
    ACCOUNT_DATABASE_URL: databases.urls.account,
  } as Record<string, string>);
  const secret = Bun.env.ACCOUNT_SECRET!;
  const api = safetyCorrespondenceApi(accountPool, secret, 'notice-test-secret', account.issuer);
  try {
    const coauthor = await f.stack.member('coauthor');
    const work = await f.stack.publicWork(f.author.actor);
    await f.stack.contribution(work.work, coauthor.actor, 'ja', 'The second author contribution.');
    // The fixture authors use real native contribution commands and real Access
    // representations; bind those principals to the two real Account inboxes.
    await f.stack.accessPool.query(
      `UPDATE access.principal SET account_issuer = $1,account_subject =
      CASE id WHEN $2::uuid THEN $3 ELSE $5 END WHERE id IN ($2::uuid,$4::uuid)`,
      [account.issuer, f.author.principalId, account.a.id, coauthor.principalId, account.b.id],
    );
    const reporters: Receipt[] = [];
    for (let i = 0; i < 3; i++)
      reporters.push(
        await json<Receipt>(
          await f.call('POST', '/v1/public-reports', {
            profile: 'public-report-v1',
            target: work.work,
            category: 'harassment',
            statement: 'Review the retained Work.',
            contentLanguage: 'en',
            contactEmail: `reporter-${i}@example.test`,
          }),
          201,
        ),
      );
    expect(new Set(reporters.map((r) => r.caseId)).size).toBe(1);
    await f.claim(reporters[0]!);
    const retained = (
      await f.stack.accessPool.query<{ evidence_digest: string; revision: string }>(
        `SELECT r.evidence_digest,e.revision
      FROM access.governance_report r JOIN access.governance_evidence e ON e.report_id = r.id
      WHERE r.id = $1`,
        [reporters[0]!.reportId],
      )
    ).rows[0]!;
    const generation = (
      await f.stack.accessPool.query<{ generation: string }>(
        'SELECT generation::text FROM access.governance_case WHERE id = $1',
        [reporters[0]!.caseId],
      )
    ).rows[0]!.generation;
    const rule = (
      await f.stack.accessPool.query<{ ref: string; revision: string; digest: string }>(
        'SELECT ref,revision::text,digest FROM access.governance_rule_head WHERE scope_id = $1',
        ['governance:platform'],
      )
    ).rows[0]!;
    const input: DecisionInput = {
      caseId: reporters[0]!.caseId,
      expectedGeneration: generation,
      actingSubject: f.staff.actor,
      outcome: 'restrict',
      targets: [
        {
          owner: 'graph',
          resource: work.work,
          component: 'title',
          locator: null,
          scopeKind: 'exact_revision',
          revision: retained.revision,
          expectedHead: retained.revision,
          effect: 'disclosure',
        },
      ],
      rule,
      evidenceDigest: retained.evidence_digest,
      reversesDecisionId: null,
      answersStepId: null,
      rationale: 'Reviewed the reported title.',
      disclosure: 'private',
      reasons: fixtureReasons,
      idempotencyKey: randomUUID(),
    };
    const missing = await f.decide({ ...input, reasons: undefined });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: 'invalid_request' });
    const statements: string[] = [];
    const pool = f.stack.accessPool;
    const originalConnect = pool.connect;
    pool.connect = ((...args: unknown[]) => {
      if (args.length) return Reflect.apply(originalConnect, pool, args);
      return Reflect.apply(originalConnect, pool, []).then(
        (connection: object) =>
          new Proxy(connection, {
            get(client, key) {
              if (key === 'query')
                return (...queryArgs: unknown[]) => {
                  statements.push(String(queryArgs[0]));
                  return Reflect.apply(Reflect.get(client, 'query'), client, queryArgs);
                };
              const value = Reflect.get(client, key);
              return typeof value === 'function' ? value.bind(client) : value;
            },
          }),
      );
    }) as Pool['connect'];
    let accepted: DecisionResult;
    try {
      accepted = await json<DecisionResult>(await f.decide(input), 202);
    } finally {
      pool.connect = originalConnect;
    }
    expect(statements.filter((sql) => sql.includes('evidence_digest = $2 LIMIT 1'))).toHaveLength(
      1,
    );
    expect(
      statements.filter((sql) => sql.includes('target_key = access.governance_target_key')),
    ).toHaveLength(input.targets.length);
    expect(statements.some((sql) => /SELECT DISTINCT e.owner/.test(sql))).toBe(false);
    expect(statements.some((sql) => /SELECT evidence_digest AS digest/.test(sql))).toBe(false);
    const completed = await json<DecisionResult>(await f.decide(input));
    expect(completed.operation.status).toBe('completed');
    const effects = ownerModerationEffects(new ContentModeration(f.stack.contentPool), f.stack.env);
    let loseAck = true;
    const submissions: SafetyNoticeMail[] = [];
    const source = () =>
      new SafetyDecisionMail(
        pool,
        account.issuer,
        async (mail) => {
          submissions.push(mail);
          const response = await api.handle(
            new Request('http://account.local/api/internal/safety-correspondence', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: 'Bearer notice-test-secret',
              },
              body: JSON.stringify(mail),
            }),
          );
          expect(response.status, await response.clone().text()).toBe(200);
          if (loseAck) {
            loseAck = false;
            throw new Error('lost committed intake acknowledgement');
          }
        },
        effects,
        2,
      );
    f.producer.setSafetyCorrespondence(source());
    await expect(f.producer.runSafetyCorrespondenceOnce()).rejects.toBeInstanceOf(
      SafetyNoticeContinuation,
    );
    expect(
      (
        await pool.query(
          "SELECT 1 FROM access.notification_producer_cursor WHERE consumer = 'safety-correspondence-v1'",
        )
      ).rowCount,
    ).toBe(0);
    let complete = false;
    let lost = false;
    let pages = 0;
    for (; pages < 20 && !complete; pages++) {
      const before = submissions.length;
      try {
        complete = await source().enqueuePage(accepted!.decisionId);
      } catch (error) {
        expect(String(error)).toContain('lost committed');
        lost = true;
      }
      expect(submissions.length - before).toBeLessThanOrEqual(2);
    }
    expect(complete).toBe(true);
    expect(lost).toBe(true);
    expect(pages).toBeGreaterThan(2);
    expect(
      (
        await pool.query(
          'SELECT principal_id FROM access.safety_party_notice WHERE decision_id = $1',
          [accepted!.decisionId],
        )
      ).rows
        .map((r) => r.principal_id)
        .sort(),
    ).toEqual([f.author.principalId, coauthor.principalId].sort());
    expect(
      (
        await pool.query('SELECT 1 FROM access.safety_notice_mail_receipt WHERE decision_id = $1', [
          accepted!.decisionId,
        ])
      ).rowCount,
    ).toBe(5);
    const queued = (
      await accountPool.query<{ payload: string }>('SELECT payload FROM rezics_account_email')
    ).rows;
    expect(queued).toHaveLength(5);
    const payloads = await Promise.all(
      queued.map(async (row) =>
        JSON.parse(await symmetricDecrypt({ key: secret, data: row.payload })),
      ),
    );
    for (const address of [account.a.email, account.b.email]) {
      const payload = payloads.find((p) => p.to === address);
      expect(payload.message).toContain(fixtureReasons.facts);
      expect(payload.message).toContain('X-Rezics-Case-Credential');
    }
    for (const payload of payloads.filter((p) => p.to.startsWith('reporter-'))) {
      expect(payload.message).not.toContain(fixtureReasons.facts);
      for (const mail of submissions)
        if (mail.credential) expect(payload.message).not.toContain(mail.credential);
    }
    const beforeRetry = submissions.length;
    await source().enqueueDecision(accepted!.decisionId);
    expect(submissions).toHaveLength(beforeRetry);
    expect((await accountPool.query('SELECT 1 FROM rezics_account_email')).rowCount).toBe(5);
    const events =
      await pool.query(`SELECT row_to_json(e)::text AS body FROM access.notification_producer_event e
      UNION ALL SELECT row_to_json(o)::text FROM access.outbox o`);
    for (const reporter of reporters)
      expect(JSON.stringify(events.rows)).not.toContain(reporter.credential);
    expect(JSON.stringify(events.rows)).not.toContain('reporter-0@example.test');
    const plan = await pool.query(
      `EXPLAIN (FORMAT JSON) SELECT 1 FROM access.governance_case_evidence
      WHERE case_id = $1 AND target_key = access.governance_target_key($2,$3,$4,$5,$6) AND available LIMIT 1`,
      [input.caseId, 'graph', work.work, 'title', null, retained.revision],
    );
    expect(JSON.stringify(plan.rows)).toContain('governance_case_evidence_pkey');
  } finally {
    await account.close();
    await accountPool.end();
    await f.stop();
    await databases.close();
  }
}, 120_000);
