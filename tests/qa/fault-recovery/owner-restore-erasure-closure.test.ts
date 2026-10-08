import { expect, test } from 'bun:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  expectRefusedCompletion,
  lostOutcome,
  ownerRestoreErasureFixture,
  type Copy,
} from './owner-restore-erasure-fixture.ts';

test(
  'OPS12: completion after a lost outcome re-reads historical custody, the original event and the erased Content closure',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture();
    try {
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();
      const refusals: {
        label: string;
        reason: RegExp;
        tamper: (copy: Copy, key: string) => Promise<void>;
      }[] = [
        {
          label: 'missing-historical-root',
          reason: /custody is unavailable or divergent/,
          tamper: async (copy) => unlinkSync(join(copy.directory, fixture.historicalManifest)),
        },
        {
          label: 'corrupt-historical-root',
          reason: /custody is unavailable or divergent/,
          tamper: async (copy) =>
            writeFileSync(join(copy.directory, fixture.modelShape), 'corrupt original shape'),
        },
        {
          label: 'missing-original-event',
          reason: /./,
          tamper: async (copy) => {
            expect(
              (
                await copy.faultRetained(
                  "DELETE FROM relay.delivered_event WHERE envelope->'data'->'receipt'->>'id'=$1",
                  [fixture.original.receipt],
                )
              ).rowCount,
            ).toBe(1);
          },
        },
        {
          label: 'reexposed-erased-content',
          reason: /still exposes an erased revision/,
          tamper: async (copy) => {
            const client = await copy.owners.content.connect();
            try {
              await client.query('BEGIN');
              await client.query('SET LOCAL session_replication_role = replica');
              expect(
                (
                  await client.query(
                    'UPDATE content.revision_erasure SET erasure_id=$2 WHERE revision_id=$1',
                    [fixture.revisionId, randomUUID()],
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
          },
        },
        {
          label: 'missing-erasure-tombstone',
          reason: /still exposes an erased revision/,
          tamper: async (copy) => {
            const client = await copy.owners.content.connect();
            try {
              await client.query('BEGIN');
              await client.query('SET LOCAL session_replication_role = replica');
              expect(
                (
                  await client.query('DELETE FROM content.revision_erasure WHERE revision_id=$1', [
                    fixture.revisionId,
                  ])
                ).rowCount,
              ).toBe(1);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          },
        },
      ];
      for (const { label, reason, tamper } of refusals) {
        const copy = await fixture.copy();
        try {
          const { key, lost } = await lostOutcome(fixture, copy);
          await tamper(copy, key);
          const held = await expectRefusedCompletion(fixture, copy, key, reason);
          expect(held.erasures).toEqual(lost.erasures);
          console.info('owner restore erasure case passed', {
            case: 'closure-refused-' + label,
            reason: held.hold_reason?.slice(0, 200),
          });
        } finally {
          await copy.dispose();
        }
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure closure fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
