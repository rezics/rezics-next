import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  GovernanceUnavailable,
  type DecisionInput,
  type DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import { KnownEffectFailure } from '../../../services/main/src/modules/governance/effects.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { SAFETY_ALERT_BASIS } from '../../../services/main/src/modules/safety-alerts/store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { safetyFixture, png, json, nciiDeclaration } from './g-744-support.ts';

for (const state of ['accepted', 'failed', 'partial'] as const) {
  test(`Cancelled safety ${state} answer admits one current replacement and retires only its completed deadline`, async () => {
    const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
      'access',
      'content',
      'relay',
    ]);
    const f = await safetyFixture(`cancelled-answer-${state}`, true, databases.urls);
    let probe: ReturnType<typeof spyOn> | undefined;
    try {
      // Exercise the owner migration on this isolated copy when the shared
      // template still predates it; template refresh belongs to the manager.
      if (
        (
          await f.stack.accessPool.query(`SELECT 1 FROM pg_constraint
        WHERE conrelid = 'access.moderation_decision'::regclass
          AND conname = 'moderation_decision_answers_step_id_key'`)
        ).rowCount
      ) {
        await f.stack.accessPool.query(
          readFileSync(
            new URL(
              '../../../services/main/migrations/access/1750_cancelled_safety_answer.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        );
      }
      const first = await f.author.upload(png(121, 121));
      const second = await f.author.upload(png(122, 122));
      const receipt = await f.report(first, 'ncii', nciiDeclaration);
      const key = randomUUID();
      await json(
        await f.call(
          'POST',
          '/v1/reports',
          {
            profile: 'content-report-v1',
            actingSubject: f.staff.actor,
            authority: { kind: 'platform', scopeId: 'governance:platform' },
            context: 'urn:rezics:context:global',
            target: {
              owner: 'content',
              resource: `https://rezics.com/id/${first.asset}`,
              component: 'body',
            },
            disclosure: 'private',
            reasonCode: 'ncii',
            statement: 'Both retained originals were reviewed.',
            evidence: [first, second].map((image) => ({
              owner: 'content',
              resource: `https://rezics.com/id/${image.asset}`,
              component: 'body',
              revision: image.revision,
              locator: null,
            })),
            idempotencyKey: key,
          },
          f.staff.token,
          key,
        ),
        201,
      );
      const step = (
        await f.stack.accessPool.query<{ id: string; due_at: Date }>(
          "SELECT id,due_at FROM access.governance_process_step WHERE case_id = $1 AND step = 'removal_deadline'",
          [receipt.caseId],
        )
      ).rows[0]!;
      const input = await f.input(receipt, first, 'restrict', null, step.id);
      input.targets.push(f.target(second));
      const accepted = await json<DecisionResult>(await f.decide(input), 202);
      expect(accepted.operation.status).toBe('accepted');
      f.setClock(step.due_at);
      await f.claim(receipt);
      const dueIds = async () =>
        (
          await json<{ items: { stepId: string }[] }>(await f.read('/v1/safety-cases/due-steps'))
        ).items.map((item) => item.stepId);
      expect(await dueIds()).toContain(step.id);
      await f.safetyAlerts.runOnce();
      const alerts = (
        await f.stack.accessPool.query<{ id: string; principal_id: string }>(
          'SELECT id,principal_id FROM access.safety_alert WHERE step_id = $1',
          [step.id],
        )
      ).rows;
      expect(alerts).toHaveLength(2);
      const alertStates = () =>
        Promise.all(
          alerts.map((alert) =>
            f.safetyAlerts.resolve({
              principalId: alert.principal_id,
              owner: 'access',
              ref: alert.id,
              revision: null,
              disclosureBasis: SAFETY_ALERT_BASIS,
            }),
          ),
        );
      if (state !== 'accepted') {
        const original = MediaStore.prototype.moderateOriginal;
        probe = spyOn(MediaStore.prototype, 'moderateOriginal').mockImplementation(async function (
          this: MediaStore,
          ...args
        ) {
          if (state === 'failed') throw new KnownEffectFailure('owner-basis-rejected');
          if (args[0].endsWith(':2')) throw new GovernanceUnavailable('owner unavailable');
          return original.apply(this, args);
        });
        const partial = await json<DecisionResult>(await f.decide(input), 202);
        expect(partial.operation.status).toBe('partial');
        expect(partial.operation.items.map((item) => item.state)).toEqual(
          state === 'failed' ? ['failed', 'pending'] : ['confirmed', 'uncertain'],
        );
        probe.mockRestore();
        probe = undefined;
      }
      const facts = (
        await f.stack.accessPool.query('SELECT * FROM access.moderation_decision WHERE id = $1', [
          accepted.decisionId,
        ])
      ).rows;
      const receipts = (
        await f.stack.accessPool.query(
          'SELECT ordinal,state,receipt FROM access.safety_decision_effect WHERE decision_id = $1 ORDER BY ordinal',
          [accepted.decisionId],
        )
      ).rows;
      const contender = {
        ...input,
        expectedGeneration: accepted.caseGeneration,
        idempotencyKey: randomUUID(),
      };
      expect((await f.decide(contender)).status).toBe(409);
      const cancelKey = randomUUID();
      const cancelled = await json<DecisionResult>(
        await f.call(
          'POST',
          `/v1/safety-decisions/${accepted.decisionId}/cancellation`,
          { actingSubject: f.staff.actor, idempotencyKey: cancelKey },
          f.staff.token,
          cancelKey,
        ),
      );
      expect(cancelled.operation.status).toBe('cancelled');
      expect(await dueIds()).toContain(step.id);
      expect((await alertStates()).map((result) => result.status)).toEqual([
        'available',
        'available',
      ]);
      expect((await json<DecisionResult>(await f.decide(input), 202)).operation.status).toBe(
        'cancelled',
      );
      expect(
        (
          await f.stack.accessPool.query(
            'SELECT ordinal,state,receipt FROM access.safety_decision_effect WHERE decision_id = $1 ORDER BY ordinal',
            [accepted.decisionId],
          )
        ).rows,
      ).toEqual(receipts);
      const replacement: DecisionInput = {
        ...contender,
        idempotencyKey: randomUUID(),
        targets: state === 'partial' ? [f.target(second)] : input.targets,
      };
      // Old generation and an unclaimed responder cannot replace the answer.
      expect(
        (
          await f.decide({
            ...replacement,
            expectedGeneration: input.expectedGeneration,
            idempotencyKey: randomUUID(),
          })
        ).status,
      ).toBe(409);
      expect([403, 404]).toContain(
        (
          await f.call(
            'POST',
            `/v1/safety-cases/${receipt.caseId}/decisions`,
            { ...replacement, actingSubject: f.backup.actor },
            f.backup.token,
            replacement.idempotencyKey,
          )
        ).status,
      );
      expect([403, 404]).toContain(
        (
          await f.call(
            'POST',
            `/v1/safety-cases/${receipt.caseId}/decisions`,
            { ...replacement, actingSubject: f.author.actor },
            f.author.token,
            replacement.idempotencyKey,
          )
        ).status,
      );
      const race = await Promise.all([
        f.decide(replacement),
        f.decide({ ...replacement, idempotencyKey: randomUUID() }),
      ]);
      expect(race.filter((response) => response.status === 202)).toHaveLength(1);
      // The winner advances the generation, invalidating the other request's
      // claim before its CAS check; either gate rejects the losing responder.
      expect([403, 409]).toContain(race.find((response) => response.status !== 202)!.status);
      const winner = await json<DecisionResult>(
        race.find((response) => response.status === 202)!,
        202,
      );
      expect(winner.decisionId).not.toBe(accepted.decisionId);
      expect(await dueIds()).toContain(step.id);
      const completed = await f.governance.resumeDecision(
        f.staff.principal,
        f.staff.actor,
        winner.decisionId,
      );
      expect(completed.operation.status).toBe('completed');
      expect(await dueIds()).not.toContain(step.id);
      expect((await alertStates()).every((result) => result.status !== 'available')).toBe(true);
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
            'SELECT ordinal,state,receipt FROM access.safety_decision_effect WHERE decision_id = $1 ORDER BY ordinal',
            [accepted.decisionId],
          )
        ).rows,
      ).toEqual(receipts);
      expect(
        (
          await f.stack.accessPool.query(
            'SELECT due_at FROM access.governance_process_step WHERE id = $1',
            [step.id],
          )
        ).rows[0]!.due_at,
      ).toEqual(step.due_at);
      if (state === 'partial') {
        expect((await f.stack.store.readAsset(first.asset))!.moderation).toBe('suppressed');
        expect((await f.governance.readEnforcement(f.target(first)))[0]!.decisionId).toBe(
          accepted.decisionId,
        );
      }
      await f.claim(receipt);
      expect(
        (
          await f.decide({
            ...replacement,
            expectedGeneration: completed.caseGeneration,
            idempotencyKey: randomUUID(),
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await f.stack.accessPool.query(
            'SELECT count(*)::int AS count FROM access.moderation_decision WHERE answers_step_id = $1',
            [step.id],
          )
        ).rows[0]!.count,
      ).toBe(2);
    } finally {
      probe?.mockRestore();
      await f.stop();
      await databases.close();
    }
  }, 180_000);
}
