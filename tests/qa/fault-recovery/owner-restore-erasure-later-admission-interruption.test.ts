import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import * as contentErasure from '../../../services/main/src/modules/erasure/content.ts';
import * as accountCoverage from '../../../services/account/src/recovery-coverage.ts';
import * as accessCoverage from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import * as commerceCoverage from '../../../services/main/src/modules/commerce/recovery-coverage.ts';
import * as pgCoverage from '../../../services/main/src/modules/work/pg-recovery-frontier.ts';
import * as subjectDeletion from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import * as relayCoverage from '../../../services/main/src/modules/outbox/relay.ts';
import * as journalCoverage from '../../../services/main/src/modules/erasure/core-journal-coverage.ts';
import * as erasureAuthority from '../../../services/main/src/modules/erasure/authority.ts';
import * as custody from '../../../services/main/src/modules/erasure/custody.ts';
import { RestoreLineageConflict } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { readGraphErasureProof } from '../../../services/main/src/modules/erasure/graph.ts';
import { readErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import * as binding from '../../../services/main/src/modules/owner/restore-release-binding.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { finishOperatorRestore } from '../../../scripts/ops/restore.ts';
import { RecoveryRefusal } from '../../../scripts/ops/recovery-set.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  accessFence,
  failAccessCommit,
  failOuterOutcome,
  graphReleased,
  liveAccess,
  operatorContext,
  outerOperation,
  ownerLogins,
  ownerRestoreErasureFixture,
  repairAccessCommit,
  repairOuterOutcome,
  type Copy,
} from './owner-restore-erasure-fixture.ts';

/** Restore the exact outer custody after a deliberate refusal, without recapturing authority. */
async function preservedOuter(copy: Copy, key: string) {
  const outer = await outerOperation(copy, key);
  const items = (
    await copy.retainedRelay.query<{ row: object }>(
      `SELECT to_jsonb(i) AS row FROM relay.owner_reconciliation_item i
     WHERE reconciliation_id=$1 ORDER BY ordinal`,
      [outer.id],
    )
  ).rows;
  return async () => {
    await copy.faultRetained([
      {
        sql: 'DELETE FROM relay.owner_reconciliation_item WHERE reconciliation_id=$1',
        values: [outer.id],
      },
      ...items.map(({ row }) => ({
        sql: 'INSERT INTO relay.owner_reconciliation_item SELECT * FROM jsonb_populate_record(NULL::relay.owner_reconciliation_item,$1::jsonb)',
        values: [JSON.stringify(row)],
      })),
      {
        sql: 'UPDATE relay.owner_reconciliation SET state=$2, hold_reason=$3 WHERE id=$1',
        values: [outer.id, outer.state, outer.hold_reason],
      },
    ]);
    expect(await outerOperation(copy, key)).toEqual(outer);
    expect(
      (
        await copy.retainedRelay.query(
          `SELECT to_jsonb(i) AS row FROM relay.owner_reconciliation_item i
       WHERE reconciliation_id=$1 ORDER BY ordinal`,
          [outer.id],
        )
      ).rows,
    ).toEqual(items);
  };
}

type QualificationArgs = Parameters<typeof binding.requireQualification>;

test(
  'OPS12: later-admission restore refuses partial replay and resumes every durable owner interruption without duplicate effects',
  async () => {
    const started = Date.now();
    const fixture = await ownerRestoreErasureFixture({ laterApiAdmission: true });
    const later = fixture.laterAdmission!;
    const body = {
      profile: 'owner-reconciliation-v1' as const,
      kind: 'restore' as const,
      sealedCoverage: fixture.baseAuthority.sealedCoverage,
      retainedAuthorityCoverage: fixture.currentAuthority.sealedCoverage,
      sealedDeletionSets: [],
    };
    const base = {
      state: {
        count: fixture.baseCoverage.accessStateCount,
        digest: fixture.baseCoverage.accessStateDigest,
      },
      outbox: {
        count: fixture.baseCoverage.accessOutboxCount,
        digest: fixture.baseCoverage.accessOutboxDigest,
      },
    };
    const current = {
      state: {
        count: fixture.currentCoverage.accessStateCount,
        digest: fixture.currentCoverage.accessStateDigest,
      },
      outbox: {
        count: fixture.currentCoverage.accessOutboxCount,
        digest: fixture.currentCoverage.accessOutboxDigest,
      },
    };
    const attachment = readFileSync(fixture.nativeAccessAttachment!.path);
    const ciphertextDigest = createHash('sha256').update(attachment).digest('hex');
    const attempt = async (copy: Copy, key: string, input = body) => {
      const attemptStarted = Date.now();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          finishOperatorRestore(
            operatorContext(fixture, copy),
            {
              reconcile: (_context, _body, id) => copy.request(id, undefined, input),
            },
            key,
            () => {},
          ),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('operator restore exceeded 180 s hang deadline')),
              180_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        const elapsedMs = Date.now() - attemptStarted;
        console.info('later admission interruption operator duration', { key, elapsedMs });
        expect(elapsedMs).toBeLessThan(180_000);
      }
    };
    const closed = async (copy: Copy, released = false) => {
      expect(await graphReleased(copy)).toBe(released);
      expect(await accessFence(copy)).toEqual([{ open: false, generation: fixture.generation }]);
      expect((await copy.ready()).status).toBe(503);
      expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
        false,
        false,
        false,
        false,
      ]);
      await expect(
        new admission.AccessAdmissionRegistry(copy.owners.access).activePrincipalId(
          fixture.principal,
        ),
      ).rejects.toBeInstanceOf(admission.AdmissionUnavailable);
    };
    const exactNativeAdmission = async (copy: Copy, count: number) => {
      expect(
        (
          await copy.owners.access.query(
            'SELECT count(*)::int AS count FROM access.admission WHERE id=$1',
            [later.admissionId],
          )
        ).rows,
      ).toEqual([{ count }]);
    };
    const noDuplicateRetry = async (copy: Copy, key: string) => {
      const before = await outerOperation(copy, key);
      const access = await liveAccess(copy);
      const journal = await readErasure(copy.retainedRelay, later.erasureId);
      const content = new ContentCore(copy.owners.content);
      const revisions = await content.readExactBatch(
        [fixture.revisionId, fixture.laterRevisionId],
        async (ids) => new Set(ids),
      );
      const graphProof = await readGraphErasureProof(
        copy.fuseki,
        copy.lineage,
        later.erasureId,
        later.erasureEpoch,
        [fixture.revisionId],
      );
      const maintenance = spyOn(copy.resources.erasures!.maintenance, 'command');
      const commands = spyOn(copy.fuseki, 'commandWithReceipt');
      const imported = spyOn(copy.resources, 'nativeAccessAttachment');
      const released = spyOn(admission, 'releaseAccessRecoveryFence');
      try {
        await attempt(copy, key);
        expect(maintenance).not.toHaveBeenCalled();
        expect(commands).not.toHaveBeenCalled();
        expect(imported).not.toHaveBeenCalled();
        expect(released).not.toHaveBeenCalled();
      } finally {
        released.mockRestore();
        imported.mockRestore();
        commands.mockRestore();
        maintenance.mockRestore();
      }
      expect(await outerOperation(copy, key)).toEqual(before);
      expect(await liveAccess(copy)).toEqual(access);
      expect(await readErasure(copy.retainedRelay, later.erasureId)).toEqual(journal);
      expect(
        await content.readExactBatch(
          [fixture.revisionId, fixture.laterRevisionId],
          async (ids) => new Set(ids),
        ),
      ).toEqual(revisions);
      expect(
        await readGraphErasureProof(
          copy.fuseki,
          copy.lineage,
          later.erasureId,
          later.erasureEpoch,
          [fixture.revisionId],
        ),
      ).toEqual(graphProof);
      expect(graphProof).toEqual(fixture.original);
      expect(revisions[0]?.status).toBe('erased');
      expect(revisions[1]?.status).toBe('available');
      await exactNativeAdmission(copy, 1);
      expect(await accessFence(copy)).toEqual([
        { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
      ]);
      expect((await copy.ready()).status).toBe(200);
      expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
        true,
        true,
        true,
        true,
      ]);
    };
    try {
      expect(later).toBeDefined();
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();

      // A real graph suppression commits, but Content replay cannot finish.
      // There is no qualification: the held outcome must never resume its changed base.
      const partial = await fixture.copy();
      try {
        const key = randomUUID();
        const content = new ContentCore(partial.owners.content);
        const revisions = await content.readExactBatch(
          [fixture.revisionId, fixture.laterRevisionId],
          async (ids) => new Set(ids),
        );
        const maintenance = spyOn(partial.resources.erasures!.maintenance, 'command');
        const nativeCommands = spyOn(partial.fuseki, 'commandWithReceipt');
        const contentFailure = spyOn(contentErasure, 'applyContentErasure').mockImplementation(
          async (_pool, command) => {
            expect(command.graphProof).toEqual(fixture.original);
            throw new contentErasure.ContentErasureStale(
              'fault: Content interrupted after committed graph suppression',
            );
          },
        );
        try {
          await expect(attempt(partial, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          expect(contentFailure).toHaveBeenCalled();
          expect(maintenance).toHaveBeenCalledTimes(1);
        } finally {
          contentFailure.mockRestore();
        }
        const held = await outerOperation(partial, key);
        expect(held.state).toBe('held');
        expect(held.hold_reason).toMatch(/retained erasure reconciliation is held/);
        expect(held.qualifications).toHaveLength(0);
        expect(held.releases).toHaveLength(0);
        expect(await liveAccess(partial)).toEqual(base);
        await exactNativeAdmission(partial, 0);
        await closed(partial);
        maintenance.mockClear();
        nativeCommands.mockClear();
        try {
          await expect(attempt(partial, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          expect(maintenance).not.toHaveBeenCalled();
          expect(nativeCommands).not.toHaveBeenCalled();
        } finally {
          nativeCommands.mockRestore();
          maintenance.mockRestore();
        }
        expect(await outerOperation(partial, key)).toEqual(held);
        expect(
          await content.readExactBatch(
            [fixture.revisionId, fixture.laterRevisionId],
            async (ids) => new Set(ids),
          ),
        ).toEqual(revisions);
        await closed(partial);
        console.info('later admission interruption proved', {
          case: 'prequalification-partial-replay-held',
        });
      } finally {
        await partial.dispose();
      }

      // PostgreSQL commits the relay qualification before the Access transaction.
      // A deferred fault at that commit leaves authentic qualification and exact C0.
      const rolledBack = await fixture.copy();
      try {
        const key = randomUUID();
        await rolledBack.owners.access.query(`CREATE FUNCTION access.fail_native_delta_commit()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'fault: native Access qualification commit connection lost' USING ERRCODE='08006';
          END $$`);
        await rolledBack.owners.access.query(`CREATE CONSTRAINT TRIGGER fail_native_delta_commit
          AFTER INSERT ON access.admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          WHEN (NEW.id='${later.admissionId}'::uuid) EXECUTE FUNCTION access.fail_native_delta_commit()`);
        try {
          await expect(attempt(rolledBack, key)).rejects.toBeInstanceOf(RecoveryRefusal);
        } finally {
          await rolledBack.owners.access.query(
            'DROP TRIGGER fail_native_delta_commit ON access.admission',
          );
          await rolledBack.owners.access.query('DROP FUNCTION access.fail_native_delta_commit()');
        }
        const interrupted = await outerOperation(rolledBack, key);
        expect(interrupted).toMatchObject({ state: 'running', hold_reason: null });
        expect(interrupted.erasures?.state).toBe('reconciled');
        expect(interrupted.qualifications).toHaveLength(1);
        expect(interrupted.releases).toHaveLength(0);
        expect(await liveAccess(rolledBack)).toEqual(base);
        await exactNativeAdmission(rolledBack, 0);
        await closed(rolledBack);
        const maintenance = spyOn(rolledBack.resources.erasures!.maintenance, 'command');
        const imported = spyOn(rolledBack.resources, 'nativeAccessAttachment');
        const qualified = spyOn(binding, 'recordQualification');
        try {
          await attempt(rolledBack, key);
          expect(imported).toHaveBeenCalledTimes(1);
          expect(maintenance).not.toHaveBeenCalled();
          expect(qualified).not.toHaveBeenCalled();
        } finally {
          qualified.mockRestore();
          imported.mockRestore();
          maintenance.mockRestore();
        }
        const done = await outerOperation(rolledBack, key);
        expect(done.state).toBe('reconciled');
        expect(done.erasures).toEqual(interrupted.erasures);
        expect(done.qualifications).toEqual(interrupted.qualifications);
        expect(done.releases).toHaveLength(1);
        await noDuplicateRetry(rolledBack, key);
        console.info('later admission interruption proved', {
          case: 'qualification-survives-D-rollback-C0',
        });
      } finally {
        await rolledBack.dispose();
      }

      // This candidate begins with a non-resume qualification, so both commits
      // survive. Its subsequent interruptions exercise the distinct C1 resume.
      const qualified = await fixture.copy();
      try {
        const key = randomUUID();
        const stopBeforeRelease = spyOn(binding, 'captureReleaseBasis').mockImplementation(
          async () => {
            throw new Error('fault: interrupted after durable qualification before native release');
          },
        );
        try {
          await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          expect(stopBeforeRelease).toHaveBeenCalledTimes(1);
        } finally {
          stopBeforeRelease.mockRestore();
        }
        const interrupted = await outerOperation(qualified, key);
        expect(interrupted).toMatchObject({ state: 'running', hold_reason: null });
        expect(interrupted.erasures?.state).toBe('reconciled');
        expect(interrupted.qualifications).toHaveLength(1);
        expect(interrupted.releases).toHaveLength(0);
        expect(await liveAccess(qualified)).toEqual(current);
        await exactNativeAdmission(qualified, 1);
        await closed(qualified);

        const restoreOuter = await preservedOuter(qualified, key);
        const maintenance = spyOn(qualified.resources.erasures!.maintenance, 'command');
        let graphCommands = spyOn(qualified.fuseki, 'commandWithReceipt');
        const imported = spyOn(qualified.resources, 'nativeAccessAttachment');
        const requalified = spyOn(binding, 'recordQualification');
        const actualRequire = binding.requireQualification;
        // D and replay have committed: C0 cannot admit a fresh operation. Every
        // adapter must leave this exact operation retryable on transport loss.
        // The unit table completes an independent same-key operation per site;
        // this native C1 drill keeps the same durable findings across all sites
        // and completes it below without importing D or replaying erasures again.
        const qualifiedSites = [
          ['Access outbox', () => spyOn(accessCoverage, 'scanAccessOutbox')],
          ['Access state', () => spyOn(accessCoverage, 'scanAccessState')],
          ['Commerce', () => spyOn(commerceCoverage, 'assertCommerceRecoveryCoverageOnClient')],
          ['Account WAL', () => spyOn(pgCoverage, 'assertPgRecoveryFrontier')],
          ['Account rows', () => spyOn(accountCoverage, 'assertAccountRecoveryCoverage')],
          ['Account absent subjects', () => spyOn(subjectDeletion, 'assertAccountSubjectDeletionsAbsent')],
          ['captured relay scan', () => spyOn(relayCoverage, 'relayCoverageOnClient')],
          ['captured journal scan', () => spyOn(journalCoverage, 'captureErasureJournalCoreCoverage')],
          ['retained two-cut journal scan', () => {
            const actual = journalCoverage.captureErasureJournalCoreCoverage;
            return spyOn(journalCoverage, 'captureErasureJournalCoreCoverage').mockImplementationOnce(actual);
          }, 2],
          ['retained relay prefix', () => spyOn(relayCoverage, 'relayPrefixCoverageOnClient')],
          ['retained relay scan', () => {
            const actual = relayCoverage.relayCoverageOnClient;
            return spyOn(relayCoverage, 'relayCoverageOnClient').mockImplementationOnce(actual);
          }, 2],
          ['retained suppression originals', () => spyOn(custody, 'readRetainedNativeGraphSuppressionProof')],
          ['retained authority', () => spyOn(erasureAuthority, 'assertRetainedAuthorityCapture')],
          ['retained reconciliation / Content basis', () => spyOn(binding, 'captureReleaseBasis')],
          ['native graph release', () => spyOn(qualified.fuseki, 'commandWithReceipt')],
        ] as const;
        for (const [site, install, calls = 1] of qualifiedSites) {
          for (const code of ['ECONNRESET', '57P01', 'integrity']) {
            const failure = code === 'integrity'
              ? new RestoreLineageConflict('integrity mismatch: connection timeout ECONNRESET 57P01')
              : Object.assign(new Error('owner unavailable'), { code });
            const injected = install().mockImplementationOnce(async () => { throw failure; });
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(injected).toHaveBeenCalledTimes(calls);
              const failed = await outerOperation(qualified, key);
              expect(failed.state).toBe(code === 'integrity' ? 'held' : 'running');
              if (code !== 'integrity') expect(failed.hold_reason).toBeNull();
              expect(failed.erasures).toEqual(interrupted.erasures);
              expect(failed.qualifications).toEqual(interrupted.qualifications);
              expect(failed.releases).toHaveLength(0);
              expect(await liveAccess(qualified)).toEqual(current);
              expect(maintenance).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              await closed(qualified);
              console.info('qualified owner wrapper proved', { site, code, state: failed.state });
            } finally {
              injected.mockRestore();
              // A terminal mismatch is deliberately isolated just like the
              // binding-denial matrix; ordinary transport retries need no repair.
              if (code === 'integrity') await restoreOuter();
            }
          }
        }
        graphCommands = spyOn(qualified.fuseki, 'commandWithReceipt');
        const denials: [string, (args: QualificationArgs) => void][] = [
          [
            'C0-envelope',
            (args) => {
              args[6]!.baseCoverageEnvelope += ' ';
            },
          ],
          [
            'C0-digest',
            (args) => {
              args[6]!.baseCoverageDigest = '0'.repeat(64);
            },
          ],
          [
            'C1-digest',
            (args) => {
              args[6]!.currentCoverageDigest = '0'.repeat(64);
            },
          ],
          [
            'D-digest',
            (args) => {
              args[6]!.nativeAccessDigest = '0'.repeat(64);
            },
          ],
          [
            'G0-binding',
            (args) => {
              args[6]!.baseFenceGeneration = '999999';
            },
          ],
          [
            'G0-release-generation',
            (args) => {
              args[4] = '999999';
            },
          ],
          [
            'J1-epoch',
            (args) => {
              args[6]!.journal.epoch = '999999';
            },
          ],
          [
            'J1-count',
            (args) => {
              args[6]!.journal.count = '999999';
            },
          ],
          [
            'J1-digest',
            (args) => {
              args[6]!.journal.digest = '0'.repeat(64);
            },
          ],
          [
            'native-data-epoch',
            (args) => {
              args[5].lineage.dataEpoch = randomUUID();
            },
          ],
          [
            'native-routing-epoch',
            (args) => {
              args[5].lineage.routingEpoch = randomUUID();
            },
          ],
          [
            'native-cutover',
            (args) => {
              args[5].restoreCutover += ':other';
            },
          ],
          [
            'native-saved-epoch',
            (args) => {
              args[5].saved.dataEpoch = randomUUID();
            },
          ],
          [
            'native-saved-sequence',
            (args) => {
              args[5].saved.graphSequence = '999999';
            },
          ],
          [
            'native-effective-epoch',
            (args) => {
              args[5].effective.dataEpoch = randomUUID();
            },
          ],
          [
            'native-effective-sequence',
            (args) => {
              args[5].effective.graphSequence = '999999';
            },
          ],
          [
            'erasures-id',
            (args) => {
              args[3].id = randomUUID();
            },
          ],
          [
            'erasures-consumer',
            (args) => {
              args[3].consumer += ':other';
            },
          ],
          [
            'erasures-request',
            (args) => {
              args[3].requestDigest = '0'.repeat(64);
            },
          ],
          [
            'erasures-outcome',
            (args) => {
              args[3].outcomeDigest = '0'.repeat(64);
            },
          ],
          [
            'coverage-generation',
            (args) => {
              args[3].coverageGeneration = '999999';
            },
          ],
          [
            'erasures-frontier',
            (args) => {
              args[3].erasureEpoch = '999999';
            },
          ],
          [
            'erasures-items',
            (args) => {
              args[3].items++;
            },
          ],
          [
            'erasures-cuts',
            (args) => {
              args[3].cuts = '0'.repeat(64);
            },
          ],
        ];
        for (const phase of ['saved', 'effective'] as const)
          for (const field of ['streamScope', 'dataEpoch', 'sequence'] as const)
            denials.push([
              `native-${phase}-main-${field}`,
              (args) => {
                expect(args[5][phase].main).toBeDefined();
                args[5][phase].main![field] = field === 'dataEpoch' ? randomUUID() : '999999';
              },
            ]);
        try {
          // Fault the real authenticator's bound identity one member at a time.
          // The recorded HMAC is untouched, and the authenticated route must hold.
          for (const [label, tamper] of denials) {
            const denied = spyOn(binding, 'requireQualification').mockImplementation(
              async (...args) => {
                args[3] = structuredClone(args[3]);
                args[5] = structuredClone(args[5]);
                args[6] = structuredClone(args[6]);
                expect(args[6]).toBeDefined();
                tamper(args);
                return actualRequire(...args);
              },
            );
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(denied).toHaveBeenCalledTimes(1);
              const held = await outerOperation(qualified, key);
              expect(held.state).toBe('held');
              expect(held.hold_reason).toBe(
                'durable restore qualification differs from the retained record',
              );
              expect(held.erasures).toEqual(interrupted.erasures);
              expect(maintenance).not.toHaveBeenCalled();
              expect(graphCommands).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              expect(await liveAccess(qualified)).toEqual(current);
              await closed(qualified);
              console.info('later admission binding refusal proved', {
                label,
                gate: held.hold_reason,
              });
            } finally {
              denied.mockRestore();
              await restoreOuter();
            }
          }
          await qualified.faultRetained(
            `UPDATE relay.owner_reconciliation_item SET item_ref=$2, evidence_digest=$3
             WHERE reconciliation_id=$1 AND item_ref LIKE 'restore-qualification:%'`,
            [interrupted.id, 'restore-qualification:' + 'a'.repeat(64), 'a'.repeat(64)],
          );
          try {
            await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
            expect((await outerOperation(qualified, key)).hold_reason).toBe(
              'durable restore qualification differs from the retained record',
            );
          } finally {
            await restoreOuter();
          }

          // Native release and the relay finding commit, while Access rolls back
          // its CAS to the same exact C1. No D import or replay is needed on retry.
          await failAccessCommit(qualified);
          try {
            await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          } finally {
            await repairAccessCommit(qualified);
          }
          const nativeReleased = await outerOperation(qualified, key);
          expect(nativeReleased).toMatchObject({ state: 'running', hold_reason: null });
          expect(nativeReleased.erasures).toEqual(interrupted.erasures);
          expect(nativeReleased.qualifications).toEqual(interrupted.qualifications);
          expect(nativeReleased.releases).toHaveLength(1);
          expect(await liveAccess(qualified)).toEqual(current);
          await closed(qualified, true);
          expect(maintenance).not.toHaveBeenCalled();
          expect(imported).not.toHaveBeenCalled();
          expect(requalified).not.toHaveBeenCalled();
          expect(graphCommands).toHaveBeenCalledTimes(1);
          graphCommands.mockClear();

          await failOuterOutcome(qualified, key);
          try {
            await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          } finally {
            await repairOuterOutcome(qualified);
          }
          const lost = await outerOperation(qualified, key);
          expect(lost).toMatchObject({ state: 'running', hold_reason: null });
          expect(lost.erasures).toEqual(interrupted.erasures);
          expect(lost.qualifications).toEqual(interrupted.qualifications);
          expect(lost.releases).toHaveLength(2);
          expect(await graphReleased(qualified)).toBe(true);
          expect(await accessFence(qualified)).toEqual([
            { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
          ]);
          expect((await ownerLogins(qualified)).map((row) => row.rolcanlogin)).toEqual([
            false,
            false,
            false,
            false,
          ]);
          expect(maintenance).not.toHaveBeenCalled();
          expect(graphCommands).not.toHaveBeenCalled();
          expect(imported).not.toHaveBeenCalled();
          expect(requalified).not.toHaveBeenCalled();

          // Completion must authenticate every persisted release member, even
          // while live owners already have their exact opened post-state.
          const restoreLost = await preservedOuter(qualified, key);
          const accessAfter = await liveAccess(qualified);
          const release = lost.releases.at(-1)!;
          for (const [label, index] of [
            ['release-HMAC', 1],
            ['post-state-count', 2],
            ['post-state-digest', 3],
            ['post-outbox-count', 4],
            ['post-outbox-digest', 5],
            ['discovery-invalidation', 6],
            ['also-enjoyed-invalidation', 7],
          ] as const) {
            const changed = release.split(':');
            changed[index] = [1, 3, 5].includes(index) ? '0'.repeat(64) : '999999';
            await qualified.faultRetained(
              `UPDATE relay.owner_reconciliation_item SET item_ref=$2, evidence_digest=$3
               WHERE reconciliation_id=$1 AND item_ref=$4`,
              [lost.id, changed.join(':'), '0'.repeat(64), release],
            );
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect((await outerOperation(qualified, key)).state).toBe('held');
              expect(await liveAccess(qualified)).toEqual(accessAfter);
              expect(await graphReleased(qualified)).toBe(true);
              expect((await ownerLogins(qualified)).map((row) => row.rolcanlogin)).toEqual([
                false,
                false,
                false,
                false,
              ]);
              expect(maintenance).not.toHaveBeenCalled();
              expect(graphCommands).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              console.info('later admission binding refusal proved', {
                label,
                phase: 'released-completion',
              });
            } finally {
              await restoreLost();
            }
          }

          const released = spyOn(admission, 'releaseAccessRecoveryFence');
          try {
            await attempt(qualified, key);
            expect(released).not.toHaveBeenCalled();
          } finally {
            released.mockRestore();
          }
          const done = await outerOperation(qualified, key);
          expect(done.state).toBe('reconciled');
          expect(done.erasures).toEqual(lost.erasures);
          expect(done.qualifications).toEqual(lost.qualifications);
          expect(done.releases).toEqual(lost.releases);
          expect(maintenance).not.toHaveBeenCalled();
          expect(graphCommands).not.toHaveBeenCalled();
          expect(imported).not.toHaveBeenCalled();
          expect(requalified).not.toHaveBeenCalled();
          expect(await liveAccess(qualified)).toEqual(accessAfter);
        } finally {
          requalified.mockRestore();
          imported.mockRestore();
          graphCommands.mockRestore();
          maintenance.mockRestore();
        }
        await noDuplicateRetry(qualified, key);
        console.info('later admission interruption proved', {
          case: 'closed-C1-native-release-and-lost-outcome',
        });
      } finally {
        await qualified.dispose();
      }
      expect(
        createHash('sha256')
          .update(readFileSync(fixture.nativeAccessAttachment!.path))
          .digest('hex'),
      ).toBe(ciphertextDigest);
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - started;
      console.info('later admission interruption fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  // 600 s is a hang deadline. The source plus one copy measured 242,936 ms in
  // QA20261011t220649-f78dff; this complete three-copy drill measured 204,240 ms
  // (205.91 s file) in QA20261011t233604-c97d55. Attempts each stay under 180 s.
  qaStartupTestTimeout(600_000),
);
