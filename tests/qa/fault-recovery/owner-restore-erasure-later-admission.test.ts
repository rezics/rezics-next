import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openRecoveryPayload, sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ERASURE_JOURNAL_EPOCH, readErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import { probeContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import { readGraphErasureProof } from '../../../services/main/src/modules/erasure/graph.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import {
  accessOutboxCoverage,
  accessStateCoverage,
} from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import type { RecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { accessFence, expectReviewedAccountUsageChanges, graphReleased, outerOperation, ownerRestoreErasureFixture } from './owner-restore-erasure-fixture.ts';

test(
  'OPS12: a later public erasure admission restores native Access and releases against both authenticated cuts',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture({ laterApiAdmission: true });
    try {
      const later = fixture.laterAdmission;
      expect(later).toBeDefined();
      if (!later) throw new Error('later public erasure admission was not prepared');

      expectReviewedAccountUsageChanges(later.accountChanges);
      expect(fixture.currentCoverage.account).toEqual(fixture.baseCoverage.account);

      expect(fixture.erased.erasureId).toBe(later.erasureId);
      expect(fixture.erased.erasureEpoch).toBe(later.erasureEpoch);
      const admission = (
        await fixture.source.access.query<{
          state: string;
          action: string;
          scope_id: string;
          graph_outcome: string;
          graph_data_epoch: string;
          graph_sequence: string;
        }>(
          `SELECT state, action, scope_id, graph_outcome, graph_data_epoch,
             graph_sequence::text AS graph_sequence
           FROM access.admission WHERE id=$1`,
          [later.admissionId],
        )
      ).rows[0];
      expect(admission).toMatchObject({
        state: 'sealed',
        action: 'erasure.request',
        scope_id: `erasure:${fixture.work}`,
        graph_outcome: 'succeeded',
        graph_data_epoch: ERASURE_JOURNAL_EPOCH,
        graph_sequence: later.erasureEpoch,
      });
      const journalLink = (
        await fixture.source.relay.query<{ admission_id: string | null }>(
          'SELECT admission_id FROM relay.erasure WHERE id=$1',
          [later.erasureId],
        )
      ).rows;
      expect(journalLink).toEqual([{ admission_id: later.admissionId }]);

      expect(BigInt(later.currentGeneration)).toBe(BigInt(later.baseGeneration) + 2n);
      expect(later.baseGeneration).toBe(fixture.generation);
      expect(
        (
          await fixture.source.access.query<{ open: boolean; generation: string }>(
            'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id=true',
          )
        ).rows,
      ).toEqual([{ open: false, generation: later.currentGeneration }]);

      const baseState = {
        count: fixture.baseCoverage.accessStateCount,
        digest: fixture.baseCoverage.accessStateDigest,
      };
      const currentState = {
        count: fixture.currentCoverage.accessStateCount,
        digest: fixture.currentCoverage.accessStateDigest,
      };
      const baseOutbox = {
        count: fixture.baseCoverage.accessOutboxCount,
        digest: fixture.baseCoverage.accessOutboxDigest,
      };
      const currentOutbox = {
        count: fixture.currentCoverage.accessOutboxCount,
        digest: fixture.currentCoverage.accessOutboxDigest,
      };
      expect(currentState).not.toEqual(baseState);
      expect(currentOutbox).not.toEqual(baseOutbox);
      expect(fixture.baseCoverage.nativeAccessErasure).toBeUndefined();
      expect(
        openRecoveryPayload<RecoveryCoverage>(
          fixture.baseAuthority.sealedCoverage,
          fixture.baseAuthority.hmacKey,
          'graph-recovery-coverage',
        ),
      ).toEqual(fixture.baseCoverage);
      expect(
        openRecoveryPayload<RecoveryCoverage>(
          fixture.currentAuthority.sealedCoverage,
          fixture.currentAuthority.hmacKey,
          'graph-recovery-coverage',
        ),
      ).toEqual(fixture.currentCoverage);
      const reference = fixture.currentCoverage.nativeAccessErasure;
      const attachment = fixture.nativeAccessAttachment;
      const custody = fixture.attachmentCustody;
      expect(reference).toBeDefined();
      expect(attachment).toBeDefined();
      if (!reference || !attachment || !custody)
        throw new Error('native Access custody was not retained');
      expect(reference.summary).toEqual(attachment.value);
      expect(reference.summary).toMatchObject({
        baseFenceGeneration: later.baseGeneration,
        sourceFenceGeneration: later.currentGeneration,
        baseState,
        sourceState: currentState,
        baseOutbox,
        sourceOutbox: currentOutbox,
      });
      expect(reference.baseCoverageDigest).toBe(
        createHash('sha256').update(fixture.baseAuthority.sealedCoverage).digest('hex'),
      );
      const baseJournal = fixture.baseCoverage.erasureJournal;
      const currentJournal = fixture.currentCoverage.erasureJournal;
      if (!baseJournal || !currentJournal)
        throw new Error('signed erasure journals were not captured');
      expect(reference.sourceErasureJournal).toEqual(currentJournal);
      expect(reference.baseErasureJournal).toEqual(baseJournal);
      expect(reference.sourceErasureJournal.epoch).toBe(later.erasureEpoch);
      const ciphertext = readFileSync(attachment.path);
      expect(reference.ciphertextDigest).toBe(
        createHash('sha256').update(ciphertext).digest('hex'),
      );
      expect(reference.ciphertextBytes).toBe(String(ciphertext.byteLength));
      expect(reference.recipientFingerprint).toBe(custody.recipient);
      const plaintext = execFileSync('gpg', ['--batch', '--decrypt', attachment.path], {
        env: custody.offhost,
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(reference.summary.plaintextDigest).toBe(
        createHash('sha256').update(plaintext).digest('hex'),
      );
      expect(reference.summary.plaintextBytes).toBe(String(plaintext.byteLength));
      const nativeRows = plaintext
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        nativeRows
          .filter((row) => row.kind === 'row' && row.table === 'access.admission')
          .map((row) => row.values.id),
      ).toEqual([later.admissionId]);

      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();
      const copy = await fixture.copy();
      try {
        expect(await accessStateCoverage(copy.owners.access)).toEqual(baseState);
        expect(await accessOutboxCoverage(copy.owners.access)).toEqual(baseOutbox);
        expect(
          (
            await copy.owners.access.query('SELECT id FROM access.admission WHERE id=$1', [
              later.admissionId,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (
            await copy.owners.relay.query('SELECT id FROM relay.erasure WHERE id=$1', [
              later.erasureId,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (
            await copy.owners.access.query<{ open: boolean; generation: string }>(
              'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id=true',
            )
          ).rows,
        ).toEqual([{ open: false, generation: fixture.generation }]);

        const body = {
          profile: 'owner-reconciliation-v1' as const,
          kind: 'restore' as const,
          sealedCoverage: fixture.baseAuthority.sealedCoverage,
          retainedAuthorityCoverage: fixture.currentAuthority.sealedCoverage,
          sealedDeletionSets: [],
        };
        // Omitting C1 still demands that C0 itself be independently current.
        const sameCutKey = 'later-admission-same-cut';
        const sameCut = await copy.request(sameCutKey);
        expect(sameCut.status).toBe(201);
        expect(await sameCut.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
        expect((await outerOperation(copy, sameCutKey)).hold_reason)
          .toBe('signed recovery coverage is not the retained current capture');

        const wrongBase = JSON.stringify(sealRecoveryPayload({
          ...fixture.baseCoverage, accessStateDigest: '0'.repeat(64),
        }, fixture.baseAuthority.hmacKey, 'graph-recovery-coverage'));
        const wrongBaseKey = 'later-admission-wrong-physical-base';
        const refusedBase = await copy.request(wrongBaseKey, undefined,
          { ...body, sealedCoverage: wrongBase });
        expect(refusedBase.status).toBe(201);
        expect(await refusedBase.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
        expect((await outerOperation(copy, wrongBaseKey)).hold_reason)
          .toBe('Access state differs from recovery coverage');

        const invalidCurrentKey = 'later-admission-invalid-current';
        const invalidCurrent = await copy.request(invalidCurrentKey, undefined,
          { ...body, retainedAuthorityCoverage: 'invalid-current-envelope' });
        expect(invalidCurrent.status).toBe(201);
        expect(await invalidCurrent.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
        expect((await outerOperation(copy, invalidCurrentKey)).hold_reason)
          .toBe('independently current authority capture is invalid or superseded');

        const twoCutKey = 'later-admission-two-cut-replay';
        const content = new ContentCore(copy.owners.content);
        const unrelatedBefore = (await content.readExactBatch([fixture.laterRevisionId], async ids => new Set(ids)))[0];
        expect(unrelatedBefore?.status).toBe('available');
        const twoCut = await copy.request(twoCutKey, undefined, body);
        expect(twoCut.status).toBe(201);
        const released = await outerOperation(copy, twoCutKey);
        expect(released.hold_reason).toBeNull();
        expect(await twoCut.json()).toMatchObject({ state: 'reconciled', disposition: 'matched' });
        expect(released.erasures?.state).toBe('reconciled');
        expect(released.qualifications).toHaveLength(1);
        expect(released.releases).toHaveLength(1);
        expect(await graphReleased(copy)).toBe(true);
        expect(await accessFence(copy)).toEqual([{ open: true,
          generation: (BigInt(fixture.generation) + 1n).toString() }]);
        const postState = await accessStateCoverage(copy.owners.access);
        expect(postState.count).toBe((BigInt(currentState.count) + 2n).toString());
        expect(postState.digest).not.toBe(currentState.digest);
        expect(await accessOutboxCoverage(copy.owners.access)).toEqual(currentOutbox);
        expect((await probeContentErasure(copy.owners.content, later.erasureId,
          [fixture.revisionId], later.erasureEpoch)).get(fixture.revisionId)).toBe('erased');
        const [erasedAfter, unrelatedAfter] = await content.readExactBatch(
          [fixture.revisionId, fixture.laterRevisionId], async ids => new Set(ids));
        expect(erasedAfter?.status).toBe('erased');
        expect(unrelatedAfter).toEqual(unrelatedBefore);
        const journalAfter = await readErasure(copy.retainedRelay, later.erasureId);
        expect(journalAfter).toMatchObject({
          erasureEpoch: later.erasureEpoch,
          admissionId: later.admissionId,
          suppression: 'suppressed',
          blockedReason: null,
        });
        expect(journalAfter.targets.map(target => ({
          kind: target.kind, ref: target.ref, completionState: target.completionState,
        }))).toEqual([{ kind: 'content_revision', ref: fixture.revisionId, completionState: 'completed' }]);
        expect(journalAfter.targets[0]?.completionEvidenceRef).toMatch(/^[0-9a-f]{64}$/);
        expect(journalAfter.targets[0]?.completedAt).not.toBeNull();
        const suppressionAfter = await readGraphErasureProof(copy.fuseki, copy.lineage,
          later.erasureId, later.erasureEpoch, [fixture.revisionId]);
        expect(suppressionAfter).toEqual(fixture.original);
        expect((await copy.ready()).status).toBe(200);
        const retry = await copy.request(twoCutKey, undefined, body);
        expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({ state: 'reconciled', disposition: 'matched', replayed: true });
        expect(await outerOperation(copy, twoCutKey)).toEqual(released);
        expect(await accessStateCoverage(copy.owners.access)).toEqual(postState);
        expect(await accessOutboxCoverage(copy.owners.access)).toEqual(currentOutbox);
        expect(await readErasure(copy.retainedRelay, later.erasureId)).toEqual(journalAfter);
        expect(await content.readExactBatch([fixture.revisionId, fixture.laterRevisionId],
          async ids => new Set(ids))).toEqual([erasedAfter, unrelatedBefore]);
        expect(await readGraphErasureProof(copy.fuseki, copy.lineage,
          later.erasureId, later.erasureEpoch, [fixture.revisionId])).toEqual(suppressionAfter);
        expect(await graphReleased(copy)).toBe(true);
        expect(await accessFence(copy)).toEqual([{ open: true,
          generation: (BigInt(fixture.generation) + 1n).toString() }]);
        expect((await copy.request(twoCutKey)).status).toBe(409);
      } finally {
        await copy.dispose();
      }
      console.info('owner restore erasure case passed', {
        case: 'later-public-admission-preserves-physical-base',
      });
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure later-admission fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  // 600 s is a hang deadline: verified replay measured 242,936 ms fixture work
  // (246.0 s file) in QA 20261011t220649-f78dff, including native source/copy startup.
  qaStartupTestTimeout(600_000),
);
