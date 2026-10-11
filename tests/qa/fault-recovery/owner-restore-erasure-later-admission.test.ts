import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openRecoveryPayload, sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ERASURE_JOURNAL_EPOCH } from '../../../services/main/src/modules/erasure/journal.ts';
import {
  accessOutboxCoverage,
  accessStateCoverage,
} from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import type { RecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { graphReleased, outerOperation, ownerRestoreErasureFixture } from './owner-restore-erasure-fixture.ts';

test(
  'OPS12: a later public erasure admission preserves C0 and verifies its current two-cut restore baseline',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture({ laterApiAdmission: true });
    try {
      const later = fixture.laterAdmission;
      expect(later).toBeDefined();
      if (!later) throw new Error('later public erasure admission was not prepared');

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

        const twoCutKey = 'later-admission-two-cut-baseline';
        const twoCut = await copy.request(twoCutKey, undefined, body);
        expect(twoCut.status).toBe(201);
        expect(await twoCut.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
        const held = await outerOperation(copy, twoCutKey);
        // The full C0 owner baseline and authenticated C1/C0/D/J1 gate passed.
        // Native additions/release are subsequent steps, so replay cannot run yet.
        expect(held.hold_reason).toBe('Access differs from independently current authority');
        expect(held.erasures).toBeUndefined();
        expect(held.qualifications).toEqual([]);
        expect(held.releases).toEqual([]);
        expect(await graphReleased(copy)).toBe(false);
        expect(await accessStateCoverage(copy.owners.access)).toEqual(baseState);
        expect(await accessOutboxCoverage(copy.owners.access)).toEqual(baseOutbox);
        expect((await copy.ready()).status).toBe(503);
        expect((await copy.request(twoCutKey, undefined, body)).status).toBe(200);
        expect((await copy.request(twoCutKey)).status).toBe(409);

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
  // The source-only predecessor has not yet passed QA; 600 s is a hang deadline.
  qaStartupTestTimeout(600_000),
);
