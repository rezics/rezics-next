import { expect, test } from 'bun:test';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
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
          reason: /Access differs from the coverage its release binding recorded/,
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
          reason: /differs from its durable release binding/,
          tamper: async (copy) =>
            retainRecoveryCoverageHead(
              copy.retainedRelay,
              fixture.newerAuthority.sealedCoverage,
              restoreKey,
            ),
        },
        {
          // Arbitrary coverage: the live values with a finding the key never signed.
          label: 'forged-release-finding',
          reason: /differs from its durable release binding/,
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
          reason: /differs from its durable qualification/,
          tamper: async (copy, key) =>
            forgeFinding(copy, key, `restore-qualification:${'b'.repeat(64)}`),
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
            case: 'completion-refused-' + label,
            reason: held.hold_reason?.slice(0, 200),
          });
        } finally {
          await copy.dispose();
        }
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
