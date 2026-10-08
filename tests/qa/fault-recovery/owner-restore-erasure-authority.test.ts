import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  openRecoveryPayload,
  sealRecoveryPayload,
} from '../../../services/account/src/recovery-envelope.ts';
import {
  assertRetainedAuthorityCoverage,
  type RetainedAuthorityCoverage,
} from '../../../services/main/src/modules/erasure/authority.ts';
import {
  readRestoredGraphReleaseExpectation,
  type RecoveryCoverage,
  type RestoredGraphReleaseExpectation,
} from '../../../services/main/src/modules/work/restore-lineage.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  lostOutcome,
  outerOperation,
  ownerRestoreErasureFixture,
  restoreKey,
  type Copy,
  type Fixture,
} from './owner-restore-erasure-fixture.ts';

type Binding = { outerReconciliationId: string; erasuresReconciliationId?: string };

/**
 * The exported authority helper itself, on the copy's own borrowed relay and
 * Access clients in the opened captured+1 phase: only the binding it can verify
 * selects the coverage it compares to.
 */
async function openedPhase(
  fixture: Fixture,
  copy: Copy,
  options: {
    binding?: Binding;
    authority?: RetainedAuthorityCoverage;
    generation?: string;
    cut?: (expectation: RestoredGraphReleaseExpectation) => RestoredGraphReleaseExpectation;
  } = {},
) {
  const authority = options.authority ?? fixture.authority;
  const coverage = openRecoveryPayload<RecoveryCoverage>(
    fixture.authority.sealedCoverage,
    restoreKey,
    'graph-recovery-coverage',
  );
  const expectation = await readRestoredGraphReleaseExpectation(
    copy.fuseki,
    copy.lineage,
    coverage,
  );
  const relay = await copy.retainedRelay.connect();
  const access = await copy.owners.access.connect();
  try {
    await relay.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await access.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await assertRetainedAuthorityCoverage(
      relay,
      copy.owners.access,
      coverage.relay.consumer,
      authority,
      access,
      {
        fuseki: copy.fuseki,
        graphRelease: options.cut ? options.cut(expectation) : expectation,
        capturedGeneration: options.generation ?? fixture.generation,
        ...(options.binding ? { binding: options.binding } : {}),
      },
    );
  } finally {
    await relay.query('ROLLBACK').catch(() => undefined);
    await access.query('ROLLBACK').catch(() => undefined);
    relay.release();
    access.release();
  }
}

async function forge(copy: Copy, outerId: string, reference: string) {
  await copy.faultRetained(
    `INSERT INTO relay.owner_reconciliation_item
       (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
     SELECT $1, max(ordinal) + 1, 'access', 'authority_fence', $2, 'matched', $3
     FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1`,
    [outerId, reference, 'f'.repeat(64)],
  );
}

test(
  'OPS12: the authority helper takes the opened-phase Access coverage only from a verified release binding',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture();
    try {
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();
      const copy = await fixture.copy();
      try {
        const { key } = await lostOutcome(fixture, copy);
        const outer = await outerOperation(copy, key);
        const binding = { outerReconciliationId: outer.id };
        const refused = (run: () => Promise<void>, reason: RegExp) =>
          expect(run()).rejects.toThrow(reason);

        await openedPhase(fixture, copy, { binding });
        await openedPhase(fixture, copy, {
          binding: { ...binding, erasuresReconciliationId: outer.erasures!.id },
        });

        // Bare live coverage: with no binding the opened phase still compares to the signed one.
        await refused(() => openedPhase(fixture, copy), /differs from retained coverage/);
        // Missing, foreign and mismatched references.
        await refused(
          () => openedPhase(fixture, copy, { binding: { outerReconciliationId: randomUUID() } }),
          /another outer operation/,
        );
        await refused(
          () =>
            openedPhase(fixture, copy, { binding: { outerReconciliationId: outer.erasures!.id } }),
          /another outer operation/,
        );
        await refused(
          () =>
            openedPhase(fixture, copy, {
              binding: { ...binding, erasuresReconciliationId: randomUUID() },
            }),
          /no matching retained erasure record/,
        );
        // Wrong generation, cut and key.
        await refused(
          () =>
            openedPhase(fixture, copy, {
              binding,
              generation: (BigInt(fixture.generation) + 1n).toString(),
            }),
          /recovery fence is open/,
        );
        await refused(
          () =>
            openedPhase(fixture, copy, {
              binding,
              cut: (expected) => ({
                ...expected,
                effective: {
                  ...expected.effective,
                  graphSequence: (BigInt(expected.effective.graphSequence) + 1n).toString(),
                },
              }),
            }),
          /./,
        );
        const coverage = openRecoveryPayload<RecoveryCoverage>(
          fixture.authority.sealedCoverage,
          restoreKey,
          'graph-recovery-coverage',
        );
        const otherKey = 'a5'.repeat(32);
        await refused(
          () =>
            openedPhase(fixture, copy, {
              binding,
              authority: {
                sealedCoverage: JSON.stringify(
                  sealRecoveryPayload(coverage, otherKey, 'graph-recovery-coverage'),
                ),
                hmacKey: otherKey,
              },
            }),
          /no matching retained erasure record/,
        );
        // Fabricated findings, even carrying the live coverage, cannot be verified.
        await forge(
          copy,
          outer.id,
          `restore-release:${'a'.repeat(64)}:1:${'b'.repeat(64)}:1:${'c'.repeat(64)}:1:1`,
        );
        await refused(
          () => openedPhase(fixture, copy, { binding }),
          /differs from its durable release binding/,
        );
        await forge(copy, outer.id, `restore-qualification:${'d'.repeat(64)}`);
        await refused(
          () => openedPhase(fixture, copy, { binding }),
          /differs from its durable qualification/,
        );
        console.info('owner restore erasure case passed', {
          case: 'authority-helper-opened-phase',
        });
      } finally {
        await copy.dispose();
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure authority fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
