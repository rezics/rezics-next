import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { DATASET, GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { finishOperatorRestore } from '../../../scripts/ops/restore.ts';
import {
  operatorContext,
  ownerLogins,
  ownerRestoreErasureFixture,
  restoreKey,
  type Copy,
  type Fixture,
} from './owner-restore-erasure-fixture.ts';

async function outerOperation(copy: Copy, key: string) {
  const record = (
    await copy.retainedRelay.query<{ id: string; state: string; hold_reason: string | null }>(
      'SELECT id,state,hold_reason FROM relay.owner_reconciliation WHERE operation_id=$1',
      ['owner:reconcile:' + key],
    )
  ).rows[0]!;
  const bindings = (
    await copy.retainedRelay.query<{ item_ref: string }>(
      `SELECT item_ref FROM relay.owner_reconciliation_item WHERE reconciliation_id=$1
       AND item_ref ~ '^restore-(qualification|release):' ORDER BY ordinal`,
      [record.id],
    )
  ).rows.map((row) => row.item_ref);
  const erasures = (
    await copy.retainedRelay.query<{ id: string; state: string; outcome_digest: string }>(
      'SELECT id,state,outcome_digest FROM relay.owner_reconciliation WHERE operation_id=$1',
      ['owner:reconcile:' + key + ':erasures'],
    )
  ).rows[0];
  return {
    ...record,
    erasures,
    qualifications: bindings.filter((ref) => ref.startsWith('restore-qualification:')),
    releases: bindings.filter((ref) => ref.startsWith('restore-release:')),
  };
}

async function graphReleased(copy: Copy) {
  return (
    await copy.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
      <${DATASET}> rv:dataEpoch "${copy.lineage.dataEpoch}" ; rv:sequence 0 .
      FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true } } }`)
  ).boolean;
}

async function accessFence(copy: Copy) {
  return (
    await copy.owners.access.query<{ open: boolean; generation: string }>(
      'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
    )
  ).rows;
}

/** Same operator command and key for every attempt; only the reconcile call may fail. */
function operatorAttempt(fixture: Fixture, copy: Copy, key: string) {
  return finishOperatorRestore(
    operatorContext(fixture, copy),
    { reconcile: (_context, body, attempt) => copy.request(attempt, undefined, body) },
    key,
    () => {},
  );
}

async function failOuterOutcome(copy: Copy, key: string) {
  await copy.faultRetained([
    {
      sql: `CREATE FUNCTION relay.g1351_fail_outer_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state = 'reconciled' AND NEW.operation_id = 'owner:reconcile:${key}' THEN
            RAISE EXCEPTION 'fault: outer restore outcome write' USING ERRCODE = 'XX000';
          END IF;
          RETURN NEW;
        END $$`,
    },
    {
      sql: `CREATE TRIGGER g1351_fail_outer_outcome BEFORE UPDATE ON relay.owner_reconciliation
        FOR EACH ROW EXECUTE FUNCTION relay.g1351_fail_outer_outcome()`,
    },
  ]);
}

async function repairOuterOutcome(copy: Copy) {
  await copy.faultRetained([
    { sql: 'DROP TRIGGER g1351_fail_outer_outcome ON relay.owner_reconciliation' },
    { sql: 'DROP FUNCTION relay.g1351_fail_outer_outcome()' },
  ]);
}

test(
  'OPS12: an interrupted authenticated Owner restore resumes or completes from its durable qualification',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture();
    try {
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();
      // A genuine owner interruption after the exact native release is not a
      // definitive conflict: the same key resumes from its durable qualification.
      const lostAccess = await fixture.copy();
      try {
        const actualGraphCommand = lostAccess.fuseki.commandWithReceipt.bind(lostAccess.fuseki);
        let nativeCommitted = false;
        const committed = spyOn(lostAccess.fuseki, 'commandWithReceipt').mockImplementation(
          async (envelope) => {
            const result = await actualGraphCommand(envelope);
            if (envelope.receipt.startsWith('urn:rezics:receipt:restore-release:')) {
              expect(result.status).toBe('committed');
              nativeCommitted = true;
            }
            return result;
          },
        );
        const actualRelease = admission.releaseAccessRecoveryFence;
        let connectionLost = false;
        const lose = spyOn(admission, 'releaseAccessRecoveryFence').mockImplementation(
          async (client, generation) => {
            if (!connectionLost) {
              expect(nativeCommitted).toBe(true);
              connectionLost = true;
              (client as PoolClient).on('error', () => {});
              const pid = (
                await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')
              ).rows[0]!.pid;
              await lostAccess.owners.account.query('SELECT pg_terminate_backend($1)', [pid]);
            }
            return actualRelease(client, generation);
          },
        );
        const key = randomUUID();
        try {
          await expect(operatorAttempt(fixture, lostAccess, key)).rejects.toThrow(
            'Owner reconciliation did not verify the restore (503',
          );
          expect(connectionLost).toBe(true);
          expect(await graphReleased(lostAccess)).toBe(true);
          expect(await accessFence(lostAccess)).toEqual([
            { open: false, generation: fixture.generation },
          ]);
          expect((await lostAccess.ready()).status).toBe(503);
          expect((await ownerLogins(lostAccess)).map((row) => row.rolcanlogin)).toEqual([
            false,
            false,
            false,
            false,
          ]);
        } finally {
          lose.mockRestore();
        }
        const interrupted = await outerOperation(lostAccess, key);
        expect(interrupted).toMatchObject({ state: 'running', hold_reason: null });
        expect(interrupted.erasures).toMatchObject({ state: 'reconciled' });
        expect(interrupted.qualifications).toHaveLength(1);
        expect(interrupted.releases).toHaveLength(0);
        const heldCommands = spyOn(lostAccess.resources.erasures!.maintenance, 'command');
        committed.mockClear();
        try {
          await operatorAttempt(fixture, lostAccess, key);
          expect(heldCommands).not.toHaveBeenCalled();
          expect(committed).not.toHaveBeenCalled();
        } finally {
          heldCommands.mockRestore();
          committed.mockRestore();
        }
        const resumed = await outerOperation(lostAccess, key);
        expect(resumed).toMatchObject({ state: 'reconciled' });
        expect(resumed.erasures).toEqual(interrupted.erasures);
        expect(resumed.qualifications).toEqual(interrupted.qualifications);
        expect(resumed.releases).toHaveLength(1);
        expect(await accessFence(lostAccess)).toEqual([
          { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
        ]);
        expect((await lostAccess.ready()).status).toBe(200);
        expect((await ownerLogins(lostAccess)).map((row) => row.rolcanlogin)).toEqual([
          true,
          true,
          true,
          true,
        ]);
        expect(
          (
            await new ContentCore(lostAccess.owners.content).readExactBatch(
              [fixture.revisionId],
              async (ids) => new Set(ids),
            )
          )[0],
        ).toMatchObject({ status: 'erased' });
        console.info('owner restore erasure case passed', { case: 'resume-after-lost-access' });
      } finally {
        await lostAccess.dispose();
      }

      // Both owners committed and only the outer outcome write failed: the same
      // key completes from the bound post-CAS Access state, without any owner effect.
      const lostOutcome = await fixture.copy();
      try {
        const key = randomUUID();
        await failOuterOutcome(lostOutcome, key);
        await expect(operatorAttempt(fixture, lostOutcome, key)).rejects.toThrow(
          /Owner reconciliation did not verify the restore \(50[0-9]/,
        );
        await repairOuterOutcome(lostOutcome);
        expect(await graphReleased(lostOutcome)).toBe(true);
        const generation = (BigInt(fixture.generation) + 1n).toString();
        expect(await accessFence(lostOutcome)).toEqual([{ open: true, generation }]);
        expect((await ownerLogins(lostOutcome)).map((row) => row.rolcanlogin)).toEqual([
          false,
          false,
          false,
          false,
        ]);
        const lost = await outerOperation(lostOutcome, key);
        expect(lost).toMatchObject({ state: 'running', hold_reason: null });
        expect(lost.qualifications).toHaveLength(1);
        expect(lost.releases).toHaveLength(1);
        const heldCommands = spyOn(lostOutcome.resources.erasures!.maintenance, 'command');
        const graphCommands = spyOn(lostOutcome.fuseki, 'commandWithReceipt');
        const released = spyOn(admission, 'releaseAccessRecoveryFence');
        try {
          await operatorAttempt(fixture, lostOutcome, key);
          expect(heldCommands).not.toHaveBeenCalled();
          expect(graphCommands).not.toHaveBeenCalled();
          expect(released).not.toHaveBeenCalled();
        } finally {
          released.mockRestore();
          graphCommands.mockRestore();
          heldCommands.mockRestore();
        }
        const completed = await outerOperation(lostOutcome, key);
        expect(completed).toMatchObject({ state: 'reconciled' });
        expect(completed.erasures).toEqual(lost.erasures);
        expect(completed.releases).toEqual(lost.releases);
        expect(await accessFence(lostOutcome)).toEqual([{ open: true, generation }]);
        expect((await ownerLogins(lostOutcome)).map((row) => row.rolcanlogin)).toEqual([
          true,
          true,
          true,
          true,
        ]);
        console.info('owner restore erasure case passed', { case: 'complete-after-lost-outcome' });
      } finally {
        await lostOutcome.dispose();
      }

      // Completion authenticates the bound evidence; any difference is definitive.
      for (const drift of ['access-state', 'newer-frontier'] as const) {
        const copy = await fixture.copy();
        try {
          const key = randomUUID();
          await failOuterOutcome(copy, key);
          await expect(operatorAttempt(fixture, copy, key)).rejects.toThrow(
            /Owner reconciliation did not verify the restore \(50[0-9]/,
          );
          await repairOuterOutcome(copy);
          if (drift === 'access-state') {
            const gate = 'work:edit:' + fixture.work;
            const client = await copy.owners.access.connect();
            try {
              await client.query('BEGIN');
              await client.query('SET LOCAL session_replication_role = replica');
              expect(
                (
                  await client.query(
                    'UPDATE access.scope_gate SET authority_epoch=authority_epoch+1 WHERE id=$1',
                    [gate],
                  )
                ).rowCount,
              ).toBe(1);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          } else {
            await retainRecoveryCoverageHead(
              copy.retainedRelay,
              fixture.newerAuthority.sealedCoverage,
              restoreKey,
            );
          }
          const response = await copy.request(key);
          // The same key resumes its running operation and settles it as held.
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
          const held = await outerOperation(copy, key);
          expect(held.state).toBe('held');
          expect(held.hold_reason).toMatch(
            drift === 'access-state' ? /release binding/ : /not the retained current capture/,
          );
          expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
            false,
            false,
            false,
            false,
          ]);
          console.info('owner restore erasure case passed', { case: 'completion-' + drift });
        } finally {
          await copy.dispose();
        }
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure interruption fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
