import { expect, test } from 'bun:test';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { assertReplayedCommentSourcesTerminal }
  from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
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
  body: string;
  start: number;
  end: number;
  manifestDigest: string;
  requestDigest: string;
}

interface PlantedSource {
  selector: { exact?: string; start?: number; end?: number };
  source_terminal: boolean;
  source_erasure_id: string | null;
  source_erasure_epoch: string | null;
  manifest_digest: string;
  request_digest: string;
  exact: string | null;
  prefix: string | null;
  suffix: string | null;
  body: string;
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

async function plantedSource(copy: Copy, revisionId: string): Promise<PlantedSource> {
  const rows = (await copy.owners.content.query<PlantedSource>(
    `SELECT i.selector, i.source_terminal, i.source_erasure_id::text, i.source_erasure_epoch::text,
      e.manifest_digest, r.request_digest, c.exact, c.prefix, c.suffix, c.body
    FROM verification.evidence_item i
    JOIN verification.evidence_set_revision e ON e.id = i.revision_id
    JOIN verification.receipt r ON r.id = e.operation_id
    JOIN content.comment c ON c.revision_id = i.content_revision_id
    WHERE i.content_revision_id = $1`,
    [revisionId],
  )).rows;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function openEvidenceRevisions(copy: Copy, revisionId: string): Promise<string[]> {
  return (await copy.owners.content.query<{ revision_id: string }>(
    'SELECT revision_id::text FROM verification.open_evidence_source_revisions($1::uuid[])',
    [[revisionId]],
  )).rows.map((row) => row.revision_id);
}

/** The closure already refused. The replay's source clear uses this journal call. */
async function expectTerminalSourceRepaired(fixture: Fixture, copy: Copy, cut: Quoted) {
  const open = await openEvidenceRevisions(copy, cut.revisionId);
  expect(open).toEqual([cut.revisionId]);
  const client = await copy.owners.content.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const cleared = await client.query<{ cleared: number }>(
      'SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, $3::bigint) AS cleared',
      [open, fixture.erased.erasureId, fixture.erased.erasureEpoch],
    );
    expect(cleared.rows[0]?.cleared).toBe(1);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const repaired = await plantedSource(copy, cut.revisionId);
  expect(repaired.selector).toEqual({ start: cut.start, end: cut.end });
  expect(repaired.selector.exact).toBeUndefined();
  expect(JSON.stringify(repaired.selector)).not.toContain(cut.exact);
  expect(repaired).toMatchObject({
    source_terminal: true,
    source_erasure_id: fixture.erased.erasureId,
    source_erasure_epoch: fixture.erased.erasureEpoch,
    manifest_digest: cut.manifestDigest,
    request_digest: cut.requestDigest,
    exact: null,
    prefix: null,
    suffix: null,
    body: cut.body,
  });
  expect(await openEvidenceRevisions(copy, cut.revisionId)).toEqual([]);
  await assertReplayedCommentSourcesTerminal(copy.owners.content, [cut.revisionId],
    fixture.erased.erasureId, fixture.erased.erasureEpoch);
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
      const refusals: {
        label: string;
        tamper: (copy: Copy) => Promise<void>;
        after?: (copy: Copy) => Promise<void>;
      }[] = [
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
        {
          // The row stays terminal and keeps its erasure journal. A probe that only
          // visits non-terminal selectors does not see this quote.
          label: 'replanted-terminal-evidence-source',
          tamper: (copy) =>
            tamperContent(
              copy,
              `UPDATE verification.evidence_item
               SET selector = selector || jsonb_build_object('exact', $2::text)
               WHERE content_revision_id = $1 AND source_terminal`,
              [cut.revisionId, cut.exact],
            ),
          after: (copy) => expectTerminalSourceRepaired(fixture, copy, cut),
        },
      ];
      for (const { label, tamper, after } of refusals) {
        const copy = await fixture.copy();
        try {
          const { key, lost } = await lostOutcome(fixture, copy);
          await tamper(copy);
          if (label === 'replanted-terminal-evidence-source') {
            const planted = await plantedSource(copy, cut.revisionId);
            expect(planted).toMatchObject({
              source_terminal: true,
              source_erasure_id: fixture.erased.erasureId,
              source_erasure_epoch: fixture.erased.erasureEpoch,
              manifest_digest: cut.manifestDigest,
              request_digest: cut.requestDigest,
              exact: null,
              prefix: null,
              suffix: null,
              body: cut.body,
            });
            expect(planted.selector.exact).toBe(cut.exact);
            expect(planted.selector.start).toBe(cut.start);
            expect(planted.selector.end).toBe(cut.end);
          }
          const held = await expectRefusedCompletion(
            fixture,
            copy,
            key,
            /erased source selectors remain/,
          );
          expect(held.erasures).toEqual(lost.erasures);
          if (after) await after(copy);
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
