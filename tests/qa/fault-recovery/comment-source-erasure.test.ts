import { expect, spyOn, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContentComments } from '../../../services/content/src/comments.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { CommandOutcomeUnknown } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable }
  from '../../../services/main/src/modules/access/admission.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { DATASET, GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { RecoveryBudget } from '../../../scripts/ops/recovery-set.ts';
import { finishOperatorRestore, type OperatorRestoreReleaseContext }
  from '../../../scripts/ops/restore.ts';
import { ownerRestoreErasureFixture, restoreKey } from './owner-restore-erasure-fixture.ts';
import { pinnedImage } from './search-ops-support.ts';

const quotedPayload = 'erased native HTTP fixture payload';
const authoredBody = 'authored annotation stays';

interface QuotedCut {
  commentId: string;
  revisionId: string;
  exact: string;
  body: string;
  prefix: string;
  suffix: string;
  evidenceRevisionId: string;
  manifestDigest: string;
  requestDigest: string;
  start: number;
  end: number;
}

type Fixture = Awaited<ReturnType<typeof ownerRestoreErasureFixture>>;
type Copy = Awaited<ReturnType<Fixture['copy']>>;

interface SourceRow {
  commentId: string;
  exact: string | null;
  prefix: string | null;
  suffix: string | null;
  body: string;
  commentDigest: string;
  manifestDigest: string;
  evidenceDigest: string;
  selector: { exact?: string; start?: number; end?: number };
  sourceTerminal: boolean;
  sourceErasureId: string | null;
  sourceErasureEpoch: string | null;
}

function quotedCut(fixture: Fixture): QuotedCut {
  const cut = (fixture as { quotedSource?: QuotedCut }).quotedSource;
  if (!cut) throw new Error('sealed cut has no quoted source');
  return cut;
}

function operatorContext(fixture: Fixture, copy: Copy): OperatorRestoreReleaseContext {
  return {
    budget: new RecoveryBudget(),
    fuseki: copy.fuseki,
    apps: { MAIN_DATA_EPOCH: copy.lineage.dataEpoch, MAIN_ROUTING_EPOCH: copy.lineage.routingEpoch },
    manifest: {
      sealedCoverage: fixture.authority.sealedCoverage,
      sealedDeletionSets: [],
      fenceGeneration: fixture.generation,
    },
    pools: copy.owners,
  };
}

async function sourceRow(copy: Copy, revisionId: string): Promise<SourceRow> {
  const rows = (await copy.owners.content.query<{
    comment_id: string; exact: string | null; prefix: string | null; suffix: string | null;
    body: string; comment_digest: string; manifest_digest: string; evidence_digest: string;
    selector: SourceRow['selector']; source_terminal: boolean;
    source_erasure_id: string | null; source_erasure_epoch: string | null;
  }>(`SELECT c.id::text AS comment_id, c.exact, c.prefix, c.suffix, c.body,
      c.request_digest AS comment_digest, e.manifest_digest, r.request_digest AS evidence_digest,
      i.selector, i.source_terminal, i.source_erasure_id::text, i.source_erasure_epoch::text
    FROM content.comment c
    JOIN verification.evidence_item i ON i.content_revision_id = c.revision_id
    JOIN verification.evidence_set_revision e ON e.id = i.revision_id
    JOIN verification.receipt r ON r.id = e.operation_id
    WHERE c.revision_id = $1`, [revisionId])).rows;
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  return {
    commentId: row.comment_id, exact: row.exact, prefix: row.prefix, suffix: row.suffix,
    body: row.body, commentDigest: row.comment_digest, manifestDigest: row.manifest_digest,
    evidenceDigest: row.evidence_digest, selector: row.selector, sourceTerminal: row.source_terminal,
    sourceErasureId: row.source_erasure_id, sourceErasureEpoch: row.source_erasure_epoch,
  };
}

async function ownerLogins(copy: Copy) {
  return (await copy.owners.account.query<{ rolcanlogin: boolean }>(
    "SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('account','access','content','relay') ORDER BY rolname",
  )).rows;
}

async function assertClosed(fixture: Fixture, copy: Copy) {
  expect((await copy.ready()).status).toBe(503);
  expect((await copy.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
    <${DATASET}> rv:dataEpoch "${copy.lineage.dataEpoch}" ; rv:routingEpoch "${copy.lineage.routingEpoch}" ;
      rv:sequence 0 ; rv:restoreHold true . } }`)).boolean).toBe(true);
  expect((await copy.owners.access.query<{ open: boolean; generation: string }>(
    'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true',
  )).rows).toEqual([{ open: false, generation: fixture.generation }]);
  await expect(new AccessAdmissionRegistry(copy.owners.access).activePrincipalId(fixture.principal))
    .rejects.toBeInstanceOf(AdmissionUnavailable);
  expect((await ownerLogins(copy)).map(row => row.rolcanlogin)).toEqual([false, false, false, false]);
}

function assertPresent(row: SourceRow, cut: QuotedCut) {
  expect(row).toMatchObject({
    commentId: cut.commentId, exact: cut.exact, prefix: cut.prefix, suffix: cut.suffix,
    body: cut.body, manifestDigest: cut.manifestDigest, evidenceDigest: cut.requestDigest,
    sourceTerminal: false, sourceErasureId: null, sourceErasureEpoch: null,
    selector: { exact: cut.exact, start: cut.start, end: cut.end },
  });
  expect(row.commentDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(row.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(row.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(row.evidenceDigest).not.toBe('ab'.repeat(32));
}

test('physical owner restore replays one retained journal over an independent copy and drops the quote', async () => {
  expect(pinnedImage()).toBe('rezics/fuseki:6.2.0-cmd0.5.39-835daa8774ac');
  const fixture = await ownerRestoreErasureFixture();
  const operationStarted = Date.now();
  try {
    const cut = quotedCut(fixture);
    expect(cut.revisionId).toBe(fixture.revisionId);
    expect(cut.exact).toBe(quotedPayload);
    expect(cut.body).toBe(authoredBody);
    expect(fixture.availableBeforeErasure.serializedJson).toContain(cut.exact);
    expect(cut.exact).not.toBe('QUOTE-CANARY-ζ-source');
    const sealed = fixture.authority.sealedCoverage;
    const backupManifest = readFileSync(join(fixture.backupObjects, fixture.historicalManifest));
    fixture.stopOriginal();
    const copy = await fixture.copy();
    const eventSql = `SELECT to_jsonb(event) AS original FROM relay.delivered_event event
      WHERE envelope->'data'->'receipt'->>'id' = $1`;
    const headSql = `SELECT generation::text, coverage_digest, to_jsonb(head) AS original
      FROM relay.recovery_coverage_head head WHERE consumer = $1`;
    const authoritySql = `SELECT coverage_generation::text, revision::text, coverage_digest,
      to_jsonb(authority) AS original FROM relay.current_authority_coverage authority WHERE id = true`;
    try {
      const present = await sourceRow(copy, fixture.revisionId);
      assertPresent(present, cut);
      const comment = await new ContentComments(copy.owners.content).read(cut.commentId);
      expect(comment?.body).toBe(cut.body);
      expect(comment && 'selector' in comment.target && comment.target.selector.exact).toBe(cut.exact);
      await assertClosed(fixture, copy);

      const anonymous = await copy.request(randomUUID(), 'invalid-authentication');
      expect(anonymous.status).toBe(401);
      assertPresent(await sourceRow(copy, fixture.revisionId), cut);
      await assertClosed(fixture, copy);

      const foreign = JSON.stringify(sealRecoveryPayload(
        fixture.coverage, randomBytes(32).toString('hex'), 'graph-recovery-coverage'));
      const wrongKey = await copy.request(randomUUID(), undefined, {
        profile: 'owner-reconciliation-v1', kind: 'restore', sealedCoverage: foreign, sealedDeletionSets: [],
      });
      expect(wrongKey.status).toBe(400);
      assertPresent(await sourceRow(copy, fixture.revisionId), cut);
      await assertClosed(fixture, copy);

      const originalEvent = (await copy.retainedRelay.query<{ original: object }>(
        eventSql, [fixture.original.receipt])).rows;
      expect(originalEvent).toHaveLength(1);
      const restoreEvent = async () => {
        await copy.faultRetained(
          "DELETE FROM relay.delivered_event WHERE envelope->'data'->'receipt'->>'id' = $1",
          [fixture.original.receipt]);
        expect((await copy.faultRetained(
          'INSERT INTO relay.delivered_event SELECT * FROM jsonb_populate_record(NULL::relay.delivered_event, $1::jsonb)',
          [JSON.stringify(originalEvent[0]!.original)])).rowCount).toBe(1);
      };
      for (const fault of [
        { label: 'epoch', path: '{data,receipt,systemProof,erasureEpoch}',
          value: (BigInt(fixture.erased.erasureEpoch) + 1n).toString() },
        { label: 'id', path: '{data,receipt,systemProof,erasureId}', value: randomUUID() },
      ]) {
        expect((await copy.faultRetained(
          `UPDATE relay.delivered_event SET envelope = jsonb_set(envelope, '${fault.path}', to_jsonb($2::text))
           WHERE envelope->'data'->'receipt'->>'id' = $1`,
          [fixture.original.receipt, fault.value])).rowCount).toBe(1);
        const refused = await copy.request(randomUUID());
        expect(refused.status).toBe(201);
        expect(await refused.json()).toMatchObject({ state: 'held' });
        assertPresent(await sourceRow(copy, fixture.revisionId), cut);
        await assertClosed(fixture, copy);
        await restoreEvent();
        expect((await copy.retainedRelay.query(eventSql, [fixture.original.receipt])).rows)
          .toEqual(originalEvent);
      }

      const originalHead = (await copy.retainedRelay.query(headSql, [fixture.coverage.relay.consumer])).rows;
      const originalAuthority = (await copy.retainedRelay.query(authoritySql)).rows;
      expect(originalHead).toHaveLength(1);
      expect(originalAuthority).toHaveLength(1);
      await retainRecoveryCoverageHead(copy.retainedRelay, fixture.newerAuthority.sealedCoverage, restoreKey);
      const newerHead = await copy.request(randomUUID());
      expect(newerHead.status).toBe(201);
      expect(await newerHead.json()).toMatchObject({ state: 'held' });
      assertPresent(await sourceRow(copy, fixture.revisionId), cut);
      await assertClosed(fixture, copy);
      await copy.faultRetained([
        { sql: 'DELETE FROM relay.current_authority_coverage WHERE id = true' },
        { sql: 'DELETE FROM relay.recovery_coverage_head WHERE consumer = $1',
          values: [fixture.coverage.relay.consumer] },
        { sql: `INSERT INTO relay.recovery_coverage_head
            SELECT * FROM jsonb_populate_record(NULL::relay.recovery_coverage_head, $1::jsonb)`,
          values: [JSON.stringify(originalHead[0]!.original)] },
        { sql: `INSERT INTO relay.current_authority_coverage
            SELECT * FROM jsonb_populate_record(NULL::relay.current_authority_coverage, $1::jsonb)`,
          values: [JSON.stringify(originalAuthority[0]!.original)] },
      ]);

      const release = copy.fuseki.commandWithReceipt.bind(copy.fuseki);
      let lostCommittedRelease = false;
      const lost = spyOn(copy.fuseki, 'commandWithReceipt').mockImplementation(async (envelope) => {
        const result = await release(envelope);
        if (envelope.receipt.startsWith('urn:rezics:receipt:restore-release:')) {
          expect(result.status).toBe('committed');
          const cleared = await sourceRow(copy, fixture.revisionId);
          expect(cleared.exact).toBeNull();
          expect(cleared.body).toBe(cut.body);
          expect(cleared.manifestDigest).toBe(cut.manifestDigest);
          expect(cleared.evidenceDigest).toBe(cut.requestDigest);
          lostCommittedRelease = true;
          throw new CommandOutcomeUnknown('lost actual committed graph release response');
        }
        return result;
      });
      try {
        await finishOperatorRestore(operatorContext(fixture, copy),
          { reconcile: (_context, body, key) => copy.request(key, undefined, body) },
          randomUUID(), () => {});
      } finally {
        lost.mockRestore();
      }
      expect(lostCommittedRelease).toBe(true);
      const cleared = await sourceRow(copy, fixture.revisionId);
      expect(cleared).toMatchObject({
        commentId: cut.commentId, exact: null, prefix: null, suffix: null, body: cut.body,
        commentDigest: present.commentDigest, manifestDigest: cut.manifestDigest,
        evidenceDigest: cut.requestDigest, sourceTerminal: true,
        sourceErasureId: fixture.erased.erasureId, sourceErasureEpoch: fixture.erased.erasureEpoch,
        selector: { start: cut.start, end: cut.end },
      });
      expect(cleared.selector.exact).toBeUndefined();
      expect(JSON.stringify(cleared.selector)).not.toContain(cut.exact);
      const read = await new ContentComments(copy.owners.content).read(cut.commentId);
      expect(read?.body).toBe(cut.body);
      expect(read && 'selector' in read.target).toBe(false);
      expect(JSON.stringify(read)).not.toContain(cut.exact);
      const revision = (await new ContentCore(copy.owners.content).readExactBatch(
        [fixture.revisionId], async ids => new Set(ids)))[0];
      expect(revision).toMatchObject({ status: 'erased' });
      expect((await copy.ready()).status).toBe(200);
      expect((await copy.owners.access.query(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true',
      )).rows).toEqual([{ open: true, generation: (BigInt(fixture.generation) + 1n).toString() }]);
      expect((await copy.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
        <${DATASET}> rv:dataEpoch "${copy.lineage.dataEpoch}" ; rv:sequence 0 .
        FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true } } }`)).boolean).toBe(true);
      await expect(new AccessAdmissionRegistry(copy.owners.access).activePrincipalId(fixture.principal))
        .resolves.toBeDefined();
      expect((await ownerLogins(copy)).map(row => row.rolcanlogin)).toEqual([true, true, true, true]);
      expect(fixture.authority.sealedCoverage).toBe(sealed);
      expect(readFileSync(join(fixture.backupObjects, fixture.historicalManifest))).toEqual(backupManifest);
      expect(readFileSync(join(copy.directory, fixture.historicalManifest))).toEqual(backupManifest);
      expect((await copy.retainedRelay.query(headSql, [fixture.coverage.relay.consumer])).rows)
        .toEqual(originalHead);
    } finally {
      await copy.dispose();
    }
    expect(Date.now() - operationStarted).toBeLessThan(300_000);
  } finally {
    await fixture.close();
  }
}, qaStartupTestTimeout(600_000));
