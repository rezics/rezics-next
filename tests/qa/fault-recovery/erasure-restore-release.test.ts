import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../support/postgres-cluster.ts';
import { openRecoveryPayload, sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { accountCredentialsPresent } from '../../../services/main/src/modules/erasure/account.ts';
import { ensureRetentionDomain, readErasure, retireRetentionDomain } from '../../../services/main/src/modules/erasure/journal.ts';
import { readRestoredGraphReleaseExpectation, readRestoredGraphReleaseProof } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { withRetainedErasureRestoreScenario, constructRetainedErasureCandidatesInOrder } from './retained-erasure-recovery-fixture.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { publishedWork, unerased } from '../../../services/main/src/modules/work/public-patterns.ts';

test('OPS11/OPS12/IAM11/SEARCH20: composed retained erasure release reopens protected reads and preserves sanitized archive custody', async () => {
  await withRetainedErasureRestoreScenario(async scenario => {
    const {
      runId, state, compose, recoveryKey, relay, erased, operator, actor, work,
      laterAuthorityScope, first, second, third, payload, payloadBody, unrelated, later, staleTarget,
      laterPreparation, contentErasure, accountErasureId, pinnedErasure, ownerErasure,
      surviving,
      credentials, exact, bindCandidate, ownerOperationFor, interruptBeforeOwnerRelease,
      expectBothHoldsClosed, offline, readJournal, refreshOperatorToken, pools, replayClusters, phase,
    } = scenario;
    const staleErasure = await ownerErasure(staleTarget, 'stale-target');
    const sealedDeletionSet = third.deletionSet;
    if (!sealedDeletionSet) throw new Error('final retained Account deletion set is unavailable');
    const ownerRestoreInput = { sealedCoverage: third.authority.sealedCoverage,
      sealedDeletionSets: [sealedDeletionSet] };
    const [firstCandidate, secondCandidate, successfulCandidate] = await constructRetainedErasureCandidatesInOrder(
      [first, second, third], bindCandidate);
    const successfulOperations = ownerOperationFor(successfulCandidate, third);
    const successfulKey = `erasure-restore-owner-${randomUUID()}`;
    await interruptBeforeOwnerRelease(successfulCandidate, third, successfulOperations, successfulKey);
    expect(await successfulOperations.reconcileRestore(ownerRestoreInput, successfulKey))
      .toMatchObject({ kind: 'restore', scope: 'product', state: 'reconciled' });
    const successful = successfulCandidate.restored;
    const successfulOuter = (await relay.query<{ id: string; state: string }>(
      'SELECT id, state FROM relay.owner_reconciliation WHERE operation_id = $1',
      [`owner:reconcile:${successfulKey}`])).rows[0]!;
    expect(successfulOuter.state).toBe('reconciled');
    const successfulBindings = (await relay.query<{ item_ref: string }>(`SELECT item_ref
      FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
        AND item_ref LIKE 'restore-%' ORDER BY ordinal`, [successfulOuter.id])).rows.map(row => row.item_ref);
    expect(successfulBindings.filter(ref => ref.startsWith('restore-qualification:'))).toHaveLength(1);
    expect(successfulBindings.filter(ref => ref.startsWith('restore-release:'))).toHaveLength(1);
    const successfulGraphRelease = await readRestoredGraphReleaseExpectation(
      successfulCandidate.candidateGraph.fuseki, successfulCandidate.candidateGraph.lineage, third.coverage);
    const nativeRelease = await readRestoredGraphReleaseProof(
      successfulCandidate.candidateGraph.fuseki, successfulGraphRelease);
    expect(nativeRelease?.receipt).toMatchObject({
      id: expect.stringMatching(/^urn:rezics:receipt:restore-release:/),
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      dataEpoch: successfulCandidate.candidateGraph.lineage.dataEpoch,
      sequence: '0',
    });
    expect((await successful.access.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0])
      .toEqual({ open: true, generation: (BigInt(third.restoredFence) + 1n).toString() });
    expect(await exact(successful.content, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(successful.content, later)).toMatchObject({ status: 'erased' });
    expect(await exact(successful.content, staleTarget)).toMatchObject({ status: 'erased' });
    expect(await exact(successful.content, unrelated)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: 'unrelated public text' }) });
    expect(await credentials(successful.account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await accountCredentialsPresent(successful.account, [erased.id])).toEqual(new Set());
    expect(await credentials(successful.account, operator.id)).toMatchObject({ users: '1' });
    // Releasing the current cut must leave the original unsafe copies fenced.
    for (const candidate of [firstCandidate, secondCandidate]) {
      await expectBothHoldsClosed(candidate);
      expect(await exact(candidate.restored.content, payload)).toMatchObject({ status: 'available',
        serializedJson: JSON.stringify({ body: payloadBody }) });
      expect((await readJournal(offline(candidate))).status).toBe(503);
    }
    expect(await credentials(firstCandidate.restored.account, erased.id))
      .toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect(await credentials(secondCandidate.restored.account, erased.id))
      .toEqual({ users: '0', passwords: '0', sessions: '0' });
    await firstCandidate.dispose();
    await secondCandidate.dispose();
    expect((await successful.content.query<{ pin_active: boolean; status: string }>(
      'SELECT pin_active, status FROM content.publication_preparation WHERE operation_id = $1',
      [laterPreparation])).rows[0]).toEqual({ pin_active: true, status: 'active' });
    expect((await successful.content.query<{ revision_id: string; erasure_id: string;
      erasure_epoch: string }>(`SELECT revision_id::text AS revision_id, erasure_id::text AS erasure_id,
        erasure_epoch::text AS erasure_epoch FROM content.revision_erasure
      WHERE revision_id = ANY($1::uuid[]) ORDER BY revision_id`, [[later, staleTarget]])).rows)
      .toEqual([{ revision_id: later, erasure_id: pinnedErasure.erasureId,
        erasure_epoch: pinnedErasure.erasureEpoch }, { revision_id: staleTarget,
        erasure_id: staleErasure.erasureId, erasure_epoch: staleErasure.erasureEpoch }]
        .sort((left, right) => left.revision_id.localeCompare(right.revision_id)));
    // The reopened Main APIs serve protected reads from the successfully released copy.
    const successfulMain = offline(successfulCandidate);
    const reopened = await readJournal(successfulMain);
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ erasureId: contentErasure.erasureId, stage: 'verified' });
    // Inspect the restored graph itself: the original Work still exists, but
    // its current Content pin is erased. Release must not disclose that closure.
    const restoredGraph = successfulCandidate.candidateGraph.fuseki;
    const erasedBasis = await restoredGraph.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?head ?publication ?revision WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ; rv:head ?head .
          ?variant rv:resource ${iri(work)} ; rv:contentPublicationHead ?publication }
        GRAPH ${iri(GRAPHS.revisions)} { ?publication rv:contentRevision ?revision .
          ?revision a rv:ErasedRevision }
      }`);
    expect(erasedBasis.results?.bindings).toEqual([expect.objectContaining({
      head: expect.objectContaining({ type: 'uri' }),
      revision: expect.objectContaining({ value: `urn:rezics:content:revision:${later}` }),
    })]);
    const erasedWorkRead = await successfulMain.handle(new Request(
      `http://main.local/v1/works/${work.slice(-36)}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${await refreshOperatorToken()}` } }));
    expect(erasedWorkRead.status).toBe(404);
    const survivingBasis = await restoredGraph.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?main ?publicSelection ?publicContribution ?publicDecision ?publicDraft WHERE {
        ${publishedWork(iri(surviving.work), '?main')}
        ${unerased(iri(surviving.work))}
      }`);
    expect(survivingBasis.results?.bindings).toEqual([{
      main: { type: 'uri', value: surviving.mainVersion },
      publicSelection: { type: 'uri', value: surviving.selection },
      publicContribution: { type: 'uri', value: surviving.contribution },
      publicDecision: { type: 'uri', value: surviving.publicationDecision },
      publicDraft: { type: 'uri', value: surviving.draftRevision },
    }]);
    const protectedWorkRead = await successfulMain.handle(new Request(
      `http://main.local/v1/works/${surviving.work.slice(-36)}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${await refreshOperatorToken()}` } }));
    expect(protectedWorkRead.status).toBe(200);
    expect(await protectedWorkRead.json()).toMatchObject({ id: surviving.work });

    // IAM11: build a fresh logical archive only from the reconciled cut. This
    // local, separate cluster represents off-host custody; no pre-erasure
    // physical fileset or WAL is copied into it. The retained relay journal is
    // one of the four owner archives and must survive beside the owner rows.
    const offHost = join(state, 'off-host-custody');
    mkdirSync(offHost, { recursive: true, mode: 0o700 });
    const offHostExpiry = new Date(Date.now() + 14 * 24 * 60 * 60_000);
    for (const owner of ['account', 'access', 'content', 'relay'] as const) {
      await ensureRetentionDomain(relay, { label: `${owner}:off-host:${runId}`,
        owner, store: 'postgresql', custody: 'archive', expiresAt: offHostExpiry });
    }
    const archives = new Map<string, string>();
    const archive = (name: 'account' | 'access' | 'content' | 'relay', port: number) => {
      const file = join(offHost, `${name}.dump`);
      execFileSync('pg_dump', ['-Fc', '-f', file, '-h', '127.0.0.1', '-p', String(port),
        '-U', 'postgres', name], { cwd: state, timeout: 60_000,
        env: { ...process.env, PGPASSWORD: compose.POSTGRES_PASSWORD! } });
      archives.set(name, file);
      return createHash('sha256').update(readFileSync(file)).digest('hex');
    };
    const archiveDigests = [archive('account', successful.port),
      archive('access', successful.port), archive('content', successful.port),
      archive('relay', Number(compose.POSTGRES_PORT))];
    const sealedCustody = JSON.stringify(sealRecoveryPayload({
      format: 'rezics-sanitized-custody-v1',
      erasedSubjects: [erased.id], erasureEpoch: staleErasure.erasureEpoch,
      archives: Object.fromEntries([...archives.keys()].map((name, index) =>
        [name, archiveDigests[index]])),
    }, recoveryKey, 'sanitized-custody'));
    const custodyFile = join(offHost, 'manifest.json');
    writeFileSync(custodyFile, sealedCustody, { mode: 0o600, flag: 'wx' });
    const custody = openRecoveryPayload<{ erasureEpoch: string;
      archives: Record<string, string> }>(readFileSync(custodyFile, 'utf8'),
    recoveryKey, 'sanitized-custody');
    expect(custody.erasureEpoch).toBe(staleErasure.erasureEpoch);
    for (const [name, file] of archives) {
      expect(createHash('sha256').update(readFileSync(file)).digest('hex'))
        .toBe(custody.archives[name]);
    }
    const offHostCluster = await startPostgresCluster({ role: 'postgres' });
    replayClusters.push(offHostCluster);
    const offHostPort = offHostCluster.port;
    const offHostAdmin = new Pool({ host: '127.0.0.1', port: offHostPort,
      database: 'postgres', user: 'postgres' });
    pools.push(offHostAdmin);
    // Access measured 52.308 s after loaded runs hit 60 s; 180 s is a hang detector.
    const offHostRestoreTimeoutMs = 180_000;
    for (const name of ['account', 'access', 'content', 'relay'] as const) {
      await offHostAdmin.query(`CREATE DATABASE ${name}`);
      await phase(`archive.pg-restore.${name}`, async () => {
        execFileSync('pg_restore', ['--no-owner', '--no-acl', '-h', '127.0.0.1',
          '-p', String(offHostPort), '-U', 'postgres', '-d', name, archives.get(name)!],
        { cwd: state, timeout: offHostRestoreTimeoutMs, stdio: 'pipe' });
      });
    }
    const copy = (database: string) => new Pool({ host: '127.0.0.1', port: offHostPort,
      database, user: 'postgres' });
    const offAccount = copy('account');
    const offAccess = copy('access');
    const offContent = copy('content');
    const offRelay = copy('relay');
    pools.push(offAccount, offAccess, offContent, offRelay);
    expect(await credentials(offAccount, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await credentials(offAccount, operator.id)).toMatchObject({ users: '1' });
    expect(await exact(offContent, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(offContent, later)).toMatchObject({ status: 'erased' });
    expect(await exact(offContent, staleTarget)).toMatchObject({ status: 'erased' });
    expect((await offContent.query<{ pin_active: boolean; status: string }>(
      'SELECT pin_active, status FROM content.publication_preparation WHERE operation_id = $1',
      [laterPreparation])).rows[0]).toEqual({ pin_active: true, status: 'active' });
    expect((await offContent.query<{ erasure_id: string; erasure_epoch: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(`SELECT
        erasure_id::text AS erasure_id, erasure_epoch::text AS erasure_epoch,
        graph_receipt, graph_data_epoch, graph_sequence::text AS graph_sequence
      FROM content.publication_erasure_supersession WHERE operation_id = $1`,
    [laterPreparation])).rows).toEqual([{ erasure_id: pinnedErasure.erasureId,
      erasure_epoch: pinnedErasure.erasureEpoch, graph_receipt: pinnedErasure.nativeProof.receipt,
      graph_data_epoch: pinnedErasure.nativeProof.dataEpoch,
      graph_sequence: pinnedErasure.nativeProof.sequence }]);
    expect((await offContent.query<{ revision_id: string; erasure_id: string;
      erasure_epoch: string }>(`SELECT revision_id::text AS revision_id, erasure_id::text AS erasure_id,
        erasure_epoch::text AS erasure_epoch FROM content.revision_erasure
      WHERE revision_id = ANY($1::uuid[]) ORDER BY revision_id`, [[later, staleTarget]])).rows)
      .toEqual([{ revision_id: later, erasure_id: pinnedErasure.erasureId,
        erasure_epoch: pinnedErasure.erasureEpoch }, { revision_id: staleTarget,
        erasure_id: staleErasure.erasureId, erasure_epoch: staleErasure.erasureEpoch }]
        .sort((left, right) => left.revision_id.localeCompare(right.revision_id)));
    expect(await exact(offContent, unrelated)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: 'unrelated public text' }) });
    expect((await offAccess.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1', [laterAuthorityScope])).rows[0]?.open).toBe(false);
    expect(await readErasure(offRelay, contentErasure.erasureId)).toMatchObject({
      erasureEpoch: contentErasure.erasureEpoch, suppression: 'suppressed',
      targets: [expect.objectContaining({ owner: 'content', kind: 'content_revision', ref: payload,
        completionState: 'completed', completionEvidenceRef: expect.stringMatching(/^[a-f0-9]{64}$/) })] });
    expect(await readErasure(offRelay, accountErasureId)).toMatchObject({ suppression: 'suppressed' });
    for (const [entry, revisionId] of [[pinnedErasure, later], [staleErasure, staleTarget]] as const) {
      const archivedErasure = await readErasure(offRelay, entry.erasureId);
      const retainedErasure = await readErasure(relay, entry.erasureId);
      // Archive hosts can use a different database collation. Custody preserves
      // every disposition field, not the locale's ordering of domain labels.
      const byDomain = (left: { domain: string }, right: { domain: string }) =>
        left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0;
      expect({ ...archivedErasure, dispositions: [...archivedErasure.dispositions].sort(byDomain) })
        .toEqual({ ...retainedErasure, dispositions: [...retainedErasure.dispositions].sort(byDomain) });
      expect(archivedErasure).toMatchObject({ erasureId: entry.erasureId,
        erasureEpoch: entry.erasureEpoch, stage: 'inventory_complete',
        suppression: 'suppressed', destruction: 'retained',
        targets: [expect.objectContaining({ ordinal: 1, owner: 'content',
          kind: 'content_revision', ref: revisionId })] });
    }

    // Retire the three historical physical backup directories only after the
    // sanitized archive has been restored and probed. The evidence digest
    // identifies this local archive set, not production media destruction.
    const custodyDigest = createHash('sha256').update(JSON.stringify(archiveDigests)).digest('hex');
    for (const copyInfo of [first, second, third]) {
      rmSync(copyInfo.backup, { recursive: true });
      expect(existsSync(copyInfo.backup)).toBe(false);
      for (const owner of ['account', 'content'] as const) {
        await retireRetentionDomain(relay, `${owner}:backup:${copyInfo === first ? 'before'
          : copyInfo === second ? 'after-account' : 'after-authority'}:${runId}`,
        'expired', custodyDigest);
      }
    }

  });
// Hang detector: measured 221 s unloaded, 325/338 s busy; well above 221 s on a quiet host is still a regression.
}, qaStartupTestTimeout(600_000));
