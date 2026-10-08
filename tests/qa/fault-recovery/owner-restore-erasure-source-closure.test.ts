import { expect, test } from 'bun:test';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  expectRefusedCompletion,
  lostOutcome,
  operatorAttempt,
  outerOperation,
  ownerLogins,
  ownerRestoreErasureFixture,
  type Copy,
  type Fixture,
} from './owner-restore-erasure-fixture.ts';

interface Quoted {
  commentId: string;
  revisionId: string;
  exact: string;
  prefix: string;
  suffix: string;
}

function quoted(fixture: Fixture): Quoted {
  const cut = (fixture as { quotedSource?: Quoted }).quotedSource;
  if (!cut) throw new Error('sealed cut has no quoted source');
  return cut;
}

/** A restored copy that keeps a stored source again, the state of an unreplayed or tampered owner. */
async function tamperContent(copy: Copy, sql: string, values: unknown[]) {
  const client = await copy.owners.content.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    expect((await client.query(sql, values)).rowCount).toBe(1);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test(
  'OPS12: a same-key completion after a lost outcome re-reads the erased closure and refuses a stored comment or evidence source',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture();
    try {
      const cut = quoted(fixture);
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();
      const refusals: { label: string; tamper: (copy: Copy) => Promise<void> }[] = [
        {
          label: 'reexposed-comment-source',
          tamper: (copy) =>
            tamperContent(
              copy,
              'UPDATE content.comment SET exact=$2, prefix=$3, suffix=$4 WHERE id=$1',
              [cut.commentId, cut.exact, cut.prefix, cut.suffix],
            ),
        },
        {
          label: 'reexposed-evidence-source',
          tamper: (copy) =>
            tamperContent(
              copy,
              `UPDATE verification.evidence_item
               SET selector = selector || jsonb_build_object('exact', $2::text),
                   source_terminal = false, source_erasure_id = NULL, source_erasure_epoch = NULL
               WHERE content_revision_id = $1`,
              [cut.revisionId, cut.exact],
            ),
        },
      ];
      for (const { label, tamper } of refusals) {
        const copy = await fixture.copy();
        try {
          const { key, lost } = await lostOutcome(fixture, copy);
          await tamper(copy);
          const held = await expectRefusedCompletion(
            fixture,
            copy,
            key,
            /erased source selectors remain/,
          );
          expect(held.erasures).toEqual(lost.erasures);
          console.info('owner restore erasure case passed', {
            case: 'source-closure-refused-' + label,
            reason: held.hold_reason?.slice(0, 200),
          });
        } finally {
          await copy.dispose();
        }
      }
      // Control: the untouched copy completes under the same key and opens the owners.
      const control = await fixture.copy();
      try {
        const { key, lost } = await lostOutcome(fixture, control);
        await operatorAttempt(fixture, control, key);
        const completed = await outerOperation(control, key);
        expect(completed).toMatchObject({ state: 'reconciled' });
        expect(completed.erasures).toEqual(lost.erasures);
        expect((await ownerLogins(control)).map((row) => row.rolcanlogin)).toEqual([
          true,
          true,
          true,
          true,
        ]);
      } finally {
        await control.dispose();
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure source closure fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
