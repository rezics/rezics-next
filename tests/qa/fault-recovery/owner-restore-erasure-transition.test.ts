import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import {
  AccessAdmissionRegistry,
  AdmissionUnavailable,
} from '../../../services/main/src/modules/access/admission.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  FAILED,
  accessFence,
  expectRefusedCompletion,
  failAccessCommit,
  graphReleased,
  operatorAttempt,
  outerOperation,
  ownerLogins,
  ownerRestoreErasureFixture,
  repairAccessCommit,
  replicaAccess,
} from './owner-restore-erasure-fixture.ts';

test(
  'OPS12: the release records only a proven Access transition and an Access commit failure cannot forge completion',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture();
    try {
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();

      // An unexpected Access write between the signed pre-state and the commit
      // is refused with Access and the relay rolled back; the native release
      // stays committed, so the operation settles as held and nothing opens.
      const intervening: { label: string; write: (client: PoolClient) => Promise<unknown> }[] = [
        {
          label: 'covered-table-write',
          write: (client) =>
            client.query(
              'UPDATE access.scope_gate SET authority_epoch=authority_epoch+1 WHERE id=$1',
              ['work:edit:' + fixture.work],
            ),
        },
        {
          label: 'extra-invalidation-row',
          write: (client) =>
            client.query('INSERT INTO access.discovery_source_change DEFAULT VALUES'),
        },
      ];
      for (const { label, write } of intervening) {
        const copy = await fixture.copy();
        const actual = admission.releaseAccessRecoveryFence;
        let written = false;
        const spy = spyOn(admission, 'releaseAccessRecoveryFence').mockImplementation(
          async (client, generation) => {
            if (!written) {
              written = true;
              await write(client as PoolClient);
            }
            return actual(client, generation);
          },
        );
        try {
          const key = randomUUID();
          const response = await copy.request(key);
          expect(written).toBe(true);
          expect(response.status).toBe(201);
          expect(await response.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
          const held = await outerOperation(copy, key);
          expect(held.state).toBe('held');
          expect(held.hold_reason).toMatch(/Access changed beyond the captured-generation release/);
          expect(held.releases).toHaveLength(0);
          // Rolled back: Access is still closed at the captured generation.
          expect(await accessFence(copy)).toEqual([
            { open: false, generation: fixture.generation },
          ]);
          expect((await copy.ready()).status).toBe(503);
          await expect(
            new AccessAdmissionRegistry(copy.owners.access).activePrincipalId(fixture.principal),
          ).rejects.toBeInstanceOf(AdmissionUnavailable);
          expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
            false,
            false,
            false,
            false,
          ]);
          console.info('owner restore erasure case passed', {
            case: 'transition-refused-' + label,
          });
        } finally {
          spy.mockRestore();
          await copy.dispose();
        }
      }

      // The relay commits its release finding before Access. When only the
      // Access commit fails, that finding completes nothing and a retry replaces it.
      const partial = await fixture.copy();
      try {
        const key = randomUUID();
        await failAccessCommit(partial);
        await expect(operatorAttempt(fixture, partial, key)).rejects.toThrow(FAILED);
        const stale = await outerOperation(partial, key);
        expect(stale).toMatchObject({ state: 'running' });
        expect(stale.qualifications).toHaveLength(1);
        expect(stale.releases).toHaveLength(1);
        expect(await graphReleased(partial)).toBe(true);
        expect(await accessFence(partial)).toEqual([
          { open: false, generation: fixture.generation },
        ]);
        await expect(operatorAttempt(fixture, partial, key)).rejects.toThrow(FAILED);
        expect(await accessFence(partial)).toEqual([
          { open: false, generation: fixture.generation },
        ]);
        expect((await partial.ready()).status).toBe(503);
        expect((await outerOperation(partial, key)).state).toBe('running');
        await repairAccessCommit(partial);
        await operatorAttempt(fixture, partial, key);
        const done = await outerOperation(partial, key);
        expect(done.state).toBe('reconciled');
        expect(done.qualifications).toEqual(stale.qualifications);
        expect(done.erasures).toEqual(stale.erasures);
        expect(done.releases.length).toBeGreaterThan(stale.releases.length);
        console.info('owner restore erasure case passed', {
          case: 'relay-before-access-partial-commit',
        });
      } finally {
        await partial.dispose();
      }

      // A committed relay finding cannot forge completion for an Access owner
      // that was opened by other means: it lacks the proven CAS invalidations.
      const forged = await fixture.copy();
      try {
        const key = randomUUID();
        await failAccessCommit(forged);
        await expect(operatorAttempt(fixture, forged, key)).rejects.toThrow(FAILED);
        await repairAccessCommit(forged);
        const stale = await outerOperation(forged, key);
        expect(stale.releases).toHaveLength(1);
        expect(
          (
            await replicaAccess(
              forged,
              'UPDATE access.recovery_fence SET open=true, generation=generation+1 WHERE id=true AND open=false',
            )
          ).rowCount,
        ).toBe(1);
        const held = await expectRefusedCompletion(
          fixture,
          forged,
          key,
          /Access differs from the coverage its release binding recorded/,
        );
        expect(held.releases).toEqual(stale.releases);
        console.info('owner restore erasure case passed', {
          case: 'stale-finding-cannot-forge-open-access',
        });
      } finally {
        await forged.dispose();
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure transition fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
