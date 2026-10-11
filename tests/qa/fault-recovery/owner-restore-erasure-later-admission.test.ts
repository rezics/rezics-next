import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ERASURE_JOURNAL_EPOCH } from '../../../services/main/src/modules/erasure/journal.ts';
import {
  accessOutboxCoverage,
  accessStateCoverage,
} from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import type { RecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { ownerRestoreErasureFixture } from './owner-restore-erasure-fixture.ts';

test(
  'OPS12: a later public erasure admission advances current Access while the physical base stays unchanged',
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
  qaStartupTestTimeout(600_000),
);
