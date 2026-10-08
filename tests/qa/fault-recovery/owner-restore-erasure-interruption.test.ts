import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  accessFence,
  failOuterOutcome,
  graphReleased,
  operatorAttempt,
  outerOperation,
  ownerLogins,
  ownerRestoreErasureFixture,
  repairOuterOutcome,
} from './owner-restore-erasure-fixture.ts';

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
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure interruption fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
