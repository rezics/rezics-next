import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AccessAdmissionRegistry, AdmissionUnavailable } from '../../../services/main/src/modules/access/admission.ts';
import { accountCredentialsPresent } from '../../../services/main/src/modules/erasure/account.ts';
import { readErasure, sha256 } from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold, verifyErasure } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { withRetainedErasureRestoreScenario, constructRetainedErasureCandidatesInOrder } from './retained-erasure-recovery-fixture.ts';

test('OPS11/OPS12/IAM11/SEARCH20: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles', async () => {
  await withRetainedErasureRestoreScenario(async scenario => {
    const {
      runId, account, access, contentPool, relay, issuer, erased, operator, actor, work,
      laterAuthorityScope, first, second, third, payload, payloadBody, later, staleTarget,
      laterPreparation, originalPayload, contentErasure, accountErasureId, pinnedErasure,
      ownerErasure, credentials, exact, bindCandidate, readFindings, expectFinding,
      expectFindingPrefix, expectCustodyFindings, expectBothHoldsClosed, offline, readJournal,
    } = scenario;
    // OPS11: preserve the real Main erasure proof and all three retained backup domains.
    expect(await verifyErasure(relay, { account, access }, accountErasureId, `verify:${accountErasureId}`))
      .toMatchObject({ state: 'reconciled' });
    expect(await verifyErasure(relay, { content: contentPool }, contentErasure.erasureId,
      `verify:${contentErasure.erasureId}`)).toMatchObject({ state: 'reconciled' });
    for (const [erasureId, owner] of [[accountErasureId, 'account'], [contentErasure.erasureId, 'content']] as const) {
      const report = await readErasure(relay, erasureId);
      expect(report).toMatchObject({ stage: 'verified', suppression: 'suppressed', destruction: 'retained' });
      const copies = new Map(report.dispositions.map(entry => [entry.domain, entry]));
      expect(copies.get(`${owner}:postgresql:live`)).toMatchObject({ suppression: 'suppressed', destruction: 'retained' });
      expect(copies.get(`${owner}:postgresql-wal:live`)).toMatchObject({ store: 'postgresql_wal',
        suppression: 'suppressed', destruction: 'retained' });
      expect(copies.get(`${owner}:backup:before:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: first.expiresAt.toISOString() });
      expect(copies.get(`${owner}:backup:after-account:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: second.expiresAt.toISOString() });
      expect(copies.get(`${owner}:backup:after-authority:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: third.expiresAt.toISOString() });
    }
    const [firstCandidate, secondCandidate, thirdCandidate] = await constructRetainedErasureCandidatesInOrder(
      [first, second, third], bindCandidate);
    const secondRestored = secondCandidate.restored;
    const thirdRestored = thirdCandidate.restored;
    expect((await secondRestored.access.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1', [laterAuthorityScope])).rows[0]?.open).toBe(true);
    const staleAuthority = await reconcileRestoredErasures(relay, secondRestored, {
      operationId: `restore-stale-authority-${runId}`, consumer: second.consumer,
      replay: true, authority: second.authority,
    });
    expect(staleAuthority).toMatchObject({ state: 'held' });
    const staleAuthorityFindings = await readFindings(staleAuthority.reconciliationId);
    expectCustodyFindings(staleAuthorityFindings);
    expectFinding(staleAuthorityFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'conflict' });
    expectFinding(staleAuthorityFindings, { owner: 'content', item_kind: 'revision',
      item_ref: payload, disposition: 'conflict' });
    expect(await exact(secondRestored.content, payload)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: payloadBody }) });
    expect((await secondRestored.content.query<{ availability: string; serialized_bytes: Buffer; body: object }>(
      'SELECT availability, serialized_bytes, body FROM content.revision WHERE id = $1', [payload])).rows[0])
      .toEqual({ availability: 'available', serialized_bytes: originalPayload.serialized_bytes,
        body: originalPayload.body });
    expect(await credentials(secondRestored.account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    await expectBothHoldsClosed(secondCandidate);
    await expect(releaseErasureRestoreHold(relay, secondRestored, staleAuthority.reconciliationId,
      second.restoredFence, second.authority)).rejects.toBeInstanceOf(ErasureRestoreHold);
    await expectBothHoldsClosed(secondCandidate);
    expect((await thirdRestored.access.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1', [laterAuthorityScope])).rows[0]?.open).toBe(false);

    // Backup 1 still holds the erased payload and the erased member's credentials.
    const older = firstCandidate.restored;
    expect(await exact(older.content, payload)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: payloadBody }) });
    expect(await credentials(older.account, erased.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect(await accountCredentialsPresent(older.account, [erased.id])).toEqual(new Set([erased.id]));
    // OPS12: protected reads and new effects stay offline on the fenced restore.
    const olderMain = offline(firstCandidate);
    expect((await readJournal(olderMain)).status).toBe(503);
    await expect(new AccessAdmissionRegistry(older.access).canReadWork({ issuer, subject: operator.id }, actor, work))
      .rejects.toBeInstanceOf(AdmissionUnavailable);
    await expect(releaseErasureRestoreHold(relay, older, randomUUID(), first.restoredFence, first.authority))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    const olderPass = await reconcileRestoredErasures(relay, older,
      { operationId: `restore-before-${runId}`, consumer: first.consumer, replay: true,
        authority: first.authority });
    expect(olderPass).toMatchObject({ state: 'held' });
    const olderFindings = await readFindings(olderPass.reconciliationId);
    expectCustodyFindings(olderFindings);
    expectFinding(olderFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'conflict' });
    expectFinding(olderFindings, { owner: 'account', item_kind: 'erasure',
      item_ref: `account-subject:${sha256(erased.id)}`, disposition: 'conflict' });
    expect(await exact(older.content, payload)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: payloadBody }) });
    expect((await older.content.query<{ availability: string; serialized_bytes: Buffer; body: object }>(
      'SELECT availability, serialized_bytes, body FROM content.revision WHERE id = $1', [payload])).rows[0])
      .toEqual({ availability: 'available', serialized_bytes: originalPayload.serialized_bytes,
        body: originalPayload.body });
    expect(await credentials(older.account, erased.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    await expect(releaseErasureRestoreHold(relay, older, olderPass.reconciliationId,
      first.restoredFence, first.authority))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    await expectBothHoldsClosed(firstCandidate);
    expect((await readJournal(olderMain)).status).toBe(503);
    expect(await credentials(older.account, erased.id)).toMatchObject({ users: '1' });

    // The final backup includes the API erasure and current Access authority;
    // the retained owner chain has since erased the pinned later target.
    const currentCandidate = thirdCandidate;
    const current = currentCandidate.restored;
    expect(await credentials(current.account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await accountCredentialsPresent(current.account, [erased.id])).toEqual(new Set());
    expect(await exact(current.content, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(current.content, later)).toMatchObject({ status: 'available' });
    expect(await exact(current.content, staleTarget)).toMatchObject({ status: 'available' });
    expect((await current.content.query<{ pin_active: boolean; status: string }>(
      'SELECT pin_active, status FROM content.publication_preparation WHERE operation_id = $1',
      [laterPreparation])).rows[0]).toEqual({ pin_active: true, status: 'active' });
    const currentMain = offline(currentCandidate);
    const unreplayed = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-hold-${runId}`, consumer: third.consumer, replay: false,
        authority: third.authority });
    expect(unreplayed).toMatchObject({ state: 'held' });
    const unreplayedFindings = await readFindings(unreplayed.reconciliationId);
    expectCustodyFindings(unreplayedFindings);
    expectFinding(unreplayedFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'matched' });
    expectFinding(unreplayedFindings, { owner: 'content', item_kind: 'revision',
      item_ref: later, disposition: 'conflict' });
    expectFinding(unreplayedFindings, { owner: 'content', item_kind: 'retention_pin',
      item_ref: `publication:${pinnedErasure.erasureId}`, disposition: 'conflict' });
    await expect(releaseErasureRestoreHold(relay, current, unreplayed.reconciliationId,
      third.restoredFence, third.authority))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    await expectBothHoldsClosed(currentCandidate);
    expect((await readJournal(currentMain)).status).toBe(503);
    const replayed = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-replay-${runId}`, consumer: third.consumer, replay: true,
        authority: third.authority });
    expect(replayed).toMatchObject({ state: 'reconciled' });
    const replayedFindings = await readFindings(replayed.reconciliationId);
    expectCustodyFindings(replayedFindings);
    expectFinding(replayedFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'matched' });
    expectFinding(replayedFindings, { owner: 'graph', item_kind: 'erasure',
      item_ref: pinnedErasure.erasureId, disposition: 'replayed' });
    expectFindingPrefix(replayedFindings, { owner: 'graph', item_kind: 'receipt',
      item_refPrefix: `original-erasure:${pinnedErasure.erasureId}:`, disposition: 'matched' });
    expectFinding(replayedFindings, { owner: 'content', item_kind: 'revision',
      item_ref: later, disposition: 'replayed' });
    expect(pinnedErasure.retainedEvent).toMatchObject({
      erasure_epoch: pinnedErasure.erasureEpoch,
      native_data_epoch: pinnedErasure.nativeProof.dataEpoch,
      native_sequence: pinnedErasure.nativeProof.sequence,
      receipt: pinnedErasure.nativeProof.receipt,
      relay_scope: MAIN_RELAY_STREAM_SCOPE,
    });
    expect((await current.content.query<{ erasure_id: string; erasure_epoch: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(`SELECT
        erasure_id::text AS erasure_id, erasure_epoch::text AS erasure_epoch,
        graph_receipt, graph_data_epoch, graph_sequence::text AS graph_sequence
      FROM content.publication_erasure_supersession WHERE operation_id = $1`,
    [laterPreparation])).rows).toEqual([{ erasure_id: pinnedErasure.erasureId,
      erasure_epoch: pinnedErasure.erasureEpoch, graph_receipt: pinnedErasure.nativeProof.receipt,
      graph_data_epoch: pinnedErasure.nativeProof.dataEpoch,
      graph_sequence: pinnedErasure.nativeProof.sequence }]);
    expect(await exact(current.content, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(current.content, later)).toMatchObject({ status: 'erased' });

    // A second retained owner erasure is introduced only after the first replay
    // qualification, making that qualification stale before release.
    const staleErasure = await ownerErasure(staleTarget, 'stale-target');
    await expect(releaseErasureRestoreHold(relay, current, replayed.reconciliationId,
      third.restoredFence, third.authority))
      .rejects.toMatchObject({ message: 'a newer retained frontier needs reconciliation' });
    await expectBothHoldsClosed(currentCandidate);
    expect((await readJournal(currentMain)).status).toBe(503);
    const final = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-final-${runId}`, consumer: third.consumer, replay: true,
        authority: third.authority });
    expect(final).toMatchObject({ state: 'reconciled', erasureEpoch: staleErasure.erasureEpoch });
    expect(final.reconciliationId).not.toBe(replayed.reconciliationId);
    const finalFindings = await readFindings(final.reconciliationId);
    expectCustodyFindings(finalFindings);
    expectFinding(finalFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'matched' });
    expectFinding(finalFindings, { owner: 'graph', item_kind: 'erasure',
      item_ref: staleErasure.erasureId, disposition: 'replayed' });
    expectFindingPrefix(finalFindings, { owner: 'graph', item_kind: 'receipt',
      item_refPrefix: `original-erasure:${staleErasure.erasureId}:`, disposition: 'matched' });
    expectFinding(finalFindings, { owner: 'content', item_kind: 'revision',
      item_ref: staleTarget, disposition: 'replayed' });
    expect((await current.content.query<{ erasure_id: string; erasure_epoch: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(`SELECT
        erasure_id::text AS erasure_id, erasure_epoch::text AS erasure_epoch,
        graph_receipt, graph_data_epoch, graph_sequence::text AS graph_sequence
      FROM content.publication_erasure_supersession WHERE operation_id = $1`,
    [laterPreparation])).rows).toEqual([{ erasure_id: pinnedErasure.erasureId,
      erasure_epoch: pinnedErasure.erasureEpoch, graph_receipt: pinnedErasure.nativeProof.receipt,
      graph_data_epoch: pinnedErasure.nativeProof.dataEpoch,
      graph_sequence: pinnedErasure.nativeProof.sequence }]);
    expect((await current.content.query<{ revision_id: string; erasure_id: string;
      erasure_epoch: string }>(`SELECT revision_id::text AS revision_id, erasure_id::text AS erasure_id,
        erasure_epoch::text AS erasure_epoch FROM content.revision_erasure
      WHERE revision_id = ANY($1::uuid[]) ORDER BY revision_id`, [[later, staleTarget]])).rows)
      .toEqual([{ revision_id: later, erasure_id: pinnedErasure.erasureId,
        erasure_epoch: pinnedErasure.erasureEpoch }, { revision_id: staleTarget,
        erasure_id: staleErasure.erasureId, erasure_epoch: staleErasure.erasureEpoch }]
        .sort((left, right) => left.revision_id.localeCompare(right.revision_id)));
    expect(await exact(current.content, staleTarget)).toMatchObject({ status: 'erased' });
    // Finish the stale-copy probes before disposing their held resources.
    await expectBothHoldsClosed(firstCandidate);
    await expectBothHoldsClosed(secondCandidate);
    await expectBothHoldsClosed(currentCandidate);
    expect((await readJournal(olderMain)).status).toBe(503);
    expect((await readJournal(currentMain)).status).toBe(503);
    await firstCandidate.dispose();
    await secondCandidate.dispose();
    await currentCandidate.dispose();
  });
// Hang detector: measured 178 s unloaded, 272/321 s busy; well above 178 s on a quiet host is still a regression.
}, qaStartupTestTimeout(600_000));
