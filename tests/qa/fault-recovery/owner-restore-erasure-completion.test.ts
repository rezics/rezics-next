import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { openRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import type { RecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  expectRefusedCompletion,
  liveAccess,
  lostOutcome,
  outerOperation,
  ownerRestoreErasureFixture,
  replicaAccess,
  restoreKey,
  type Copy,
} from './owner-restore-erasure-fixture.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Insert a finding without the recovery key: well-formed, but not authentic. */
async function forgeFinding(copy: Copy, key: string, reference: string) {
  const outer = await outerOperation(copy, key);
  await copy.faultRetained(
    `INSERT INTO relay.owner_reconciliation_item
       (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
     SELECT $1, max(ordinal) + 1, 'access', 'authority_fence', $2, 'matched', $3
     FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1`,
    [outer.id, reference, 'f'.repeat(64)],
  );
}

test(
  'OPS12: completion after a lost outcome authenticates its bound findings and the live Access coverage',
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
          label: 'access-state',
          reason: /restored Access differs from current retained authority/,
          tamper: async (copy) => {
            expect(
              (
                await replicaAccess(
                  copy,
                  'UPDATE access.scope_gate SET authority_epoch=authority_epoch+1 WHERE id=$1',
                  ['work:edit:' + fixture.work],
                )
              ).rowCount,
            ).toBe(1);
          },
        },
        {
          label: 'newer-frontier',
          reason: /a newer retained frontier needs reconciliation/,
          tamper: async (copy) => {
            const newer = openRecoveryPayload<RecoveryCoverage>(
              fixture.newerAuthority.sealedCoverage,
              restoreKey,
              'graph-recovery-coverage',
            );
            const { accountPg: basePg, ...baseOwners } = fixture.coverage;
            const { accountPg: newerPg, ...newerOwners } = newer;
            expect(newerOwners).toEqual(baseOwners);
            expect(newer.relay.consumer).toBe(fixture.coverage.relay.consumer);
            expect(newer.erasureJournal).toEqual(fixture.coverage.erasureJournal);
            expect(newer.erasureJournal!.epoch).toBeNull();
            expect(
              (
                await copy.owners.relay.query(
                  'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure',
                )
              ).rows,
            ).toEqual([{ epoch: newer.erasureJournal!.epoch }]);
            expect(newerPg.systemIdentifier).toBe(basePg.systemIdentifier);
            expect(
              (
                await copy.owners.account.query('SELECT $2::pg_lsn > $1::pg_lsn AS advanced', [
                  basePg.flushedLsn,
                  newerPg.flushedLsn,
                ])
              ).rows,
            ).toEqual([{ advanced: true }]);
            const journalSql =
              'SELECT to_jsonb(erasure) AS original FROM relay.erasure erasure ORDER BY erasure_epoch';
            const journal = (await copy.retainedRelay.query(journalSql)).rows;
            const liveEpoch = (
              await copy.retainedRelay.query(
                'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure',
              )
            ).rows;
            expect(liveEpoch).toEqual([{ epoch: fixture.erased.erasureEpoch }]);
            const headSql =
              'SELECT generation::text,erasure_epoch::text,coverage_digest FROM relay.recovery_coverage_head WHERE consumer=$1';
            const original = (await copy.retainedRelay.query(headSql, [newer.relay.consumer])).rows;
            expect(original).toHaveLength(1);
            expect(original[0]!.erasure_epoch).toBe(newer.erasureJournal!.epoch);
            expect(original[0]!.coverage_digest).toBe(
              createHash('sha256')
                .update(JSON.stringify(canonical(fixture.coverage)))
                .digest('hex'),
            );
            const authoritySql =
              'SELECT coverage_generation::text,revision::text,coverage_digest FROM relay.current_authority_coverage WHERE id=true';
            const originalAuthority = (await copy.retainedRelay.query(authoritySql)).rows;
            expect(originalAuthority).toHaveLength(1);
            const digest = createHash('sha256')
              .update(JSON.stringify(canonical(newer)))
              .digest('hex');
            // This is a historical newer-head fault, not a publication against the later journal.
            await copy.faultRetained([
              // Run the existing authority-pointer trigger normally within this fault transaction.
              { sql: 'SET LOCAL session_replication_role = origin' },
              {
                sql: 'UPDATE relay.recovery_coverage_head SET coverage_digest=$1,generation=generation+1,captured_at=clock_timestamp() WHERE consumer=$2',
                values: [digest, newer.relay.consumer],
              },
            ]);
            const head = (await copy.retainedRelay.query(headSql, [newer.relay.consumer])).rows;
            expect(head).toEqual([
              {
                generation: (BigInt(original[0]!.generation) + 1n).toString(),
                erasure_epoch: original[0]!.erasure_epoch,
                coverage_digest: digest,
              },
            ]);
            expect(digest).not.toBe(original[0]!.coverage_digest);
            const authority = (await copy.retainedRelay.query(authoritySql)).rows;
            expect(authority).toEqual([
              {
                coverage_generation: head[0]!.generation,
                revision: (BigInt(originalAuthority[0]!.revision) + 1n).toString(),
                coverage_digest: digest,
              },
            ]);
            expect((await copy.retainedRelay.query(journalSql)).rows).toEqual(journal);
            console.info('historical newer-head fault installed', {
              consumer: newer.relay.consumer,
              baseAccountPg: basePg,
              newerAccountPg: newerPg,
              historicalJournalEpoch: newer.erasureJournal!.epoch,
              liveJournalEpoch: liveEpoch[0]!.epoch,
              originalHead: original,
              head,
              originalAuthority,
              authority,
              journalUnchanged: true,
            });
          },
        },
        {
          // Arbitrary coverage: the live values with a finding the key never signed.
          label: 'forged-release-finding',
          reason: /restored Access differs from current retained authority/,
          tamper: async (copy, key) => {
            const live = await liveAccess(copy);
            await forgeFinding(
              copy,
              key,
              `restore-release:${'a'.repeat(64)}:${live.state.count}:${live.state.digest}:${live.outbox.count}:${live.outbox.digest}:1:1`,
            );
          },
        },
        {
          label: 'wrong-qualification-finding',
          reason: /restored Access differs from current retained authority/,
          tamper: async (copy, key) =>
            forgeFinding(copy, key, `restore-qualification:${'b'.repeat(64)}`),
        },
      ];
      let attemptOrdinal = 0;
      const copyDirectories = new Set<string>();
      for (const { label, reason, tamper } of refusals) {
        const ordinal = ++attemptOrdinal;
        await fixture.timing.phase(
          `completion.refusal.${label}`,
          async () => {
            const copy = await fixture.copy();
            try {
              expect(copyDirectories.has(copy.directory)).toBe(false);
              copyDirectories.add(copy.directory);
              const { key, lost } = await lostOutcome(fixture, copy);
              const revision = (await new ContentCore(copy.owners.content).readExactBatch(
                [fixture.revisionId], async ids => new Set(ids),
              ))[0];
              expect(revision).toMatchObject({ status: 'erased' });
              await tamper(copy, key);
              const held = await expectRefusedCompletion(fixture, copy, key, reason);
              expect(held.erasures).toEqual(lost.erasures);
              console.info('owner restore erasure case passed', {
                case: 'completion-refused-' + label,
                reason: held.hold_reason?.slice(0, 200),
                ordinal: copy.ordinal,
                directory: copy.directory,
                operationState: lost.state,
                erasures: lost.erasures,
                releases: lost.releases,
                erasedRevision: fixture.revisionId,
                revisionStatus: revision?.status,
              });
            } finally {
              await copy.dispose();
            }
          },
          ordinal,
        );
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure completion fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
