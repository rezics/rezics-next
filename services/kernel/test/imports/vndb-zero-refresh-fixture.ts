import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { SourceRecord } from '../../../../packages/conversion/src/index.ts';
import { converter_revision } from '../../../../packages/conversion/src/vndb.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createFigureFixture, type FigureFixture } from '../rating/support/figure-fixture.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { archive } from './vndb-materialization-native-fixture.ts';
import { captureVndbStatistics, VNDB_API_ORIGIN } from './vndb-statistics-driver.ts';

/** Real CLI/native archive and adjacent registered-source UNKNOWN branch in one imports world.
 * The existing figure fixture supplies an independent real native-vote/worker control.
 * HTTP injection only forwards requests and loses a response after the native commit.
 */
export async function runJourney() {
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
    sourceStatistics: 'vndb',
  });
  let directory: string | undefined;
  let figures: FigureFixture | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await figures?.close();
      } finally {
        try {
          await runtime.close();
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    })());
  try {
    await mkdir('.temp', { recursive: true });
    directory = await mkdtemp('.temp/vndb-zero-');
    const state = join(directory, 'state.sqlite');
    const support = identitySupport(runtime.identity);
    await support.renewManagement();
    const kid = randomUUID(),
      pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approved = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approved.reference });
    const keyPath = join(directory, 'account.jwk');
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const argv = [
      '--source',
      'vndb',
      '--dump',
      '-',
      '--state',
      state,
      '--api',
      VNDB_API_ORIGIN,
      '--auth',
      auth,
      '--account-key',
      keyPath,
      '--account',
      runtime.identity.bulk.accountId,
      '--client',
      runtime.identity.client.clientId,
    ];
    const capture = captureVndbStatistics(runtime);
    const records = new Map<string, SourceRecord>();
    let credential = runtime.bulk;
    let renewal: Promise<void> | undefined;
    const currentBearer = async () => {
      if ((decodeJwt(credential.bearer).exp ?? 0) * 1000 < Date.now() + 60_000) {
        renewal ??= support
          .issue(runtime.identity.bulk.accountId, runtime.identity.client.scopes)
          .then((fresh) => {
            credential = fresh;
          })
          .finally(() => {
            renewal = undefined;
          });
        await renewal;
      }
      return credential.bearer;
    };
    const ordinaryTransport = createImportTransport({
      origin: VNDB_API_ORIGIN,
      tokenProvider: currentBearer,
      fetch: capture.fetch,
    });
    const open = () =>
      new Importer({
        path: state,
        transport: {
          setSourceRecordMetadata: ordinaryTransport.setSourceRecordMetadata,
          batchWrite: ordinaryTransport.batch,
          readFence: (tuple) =>
            ordinaryTransport.fence({
              source: tuple.source,
              externalId: tuple.external_id,
              fieldGroup: tuple.field_group,
            }),
          writeSourceStatistic: ordinaryTransport.writeSourceStatistic,
          clearSourceStatistic: ordinaryTransport.clearSourceStatistic,
          readSourceStatistics: ordinaryTransport.readSourceStatistics,
          readPublicFigure: ordinaryTransport.readPublicFigure,
        },
      });
    const baseline = async () => {
      const reader = open();
      try {
        const source = reader.session.store.source('vndb');
        return { generation: source.generation, count: source.count };
      } finally {
        await reader.close();
      }
    };
    const subjectFor = async (id: string, source = 'vndb') => {
      const reader = open();
      try {
        const binding = reader.session.bindings.claim({ source, external_id: id });
        if (binding?.state !== 'bound') throw new Error('Ordinary CLI did not bind VNDB subject');
        return binding.subject;
      } finally {
        await reader.close();
      }
    };
    async function publicRead(path: string) {
      const response = await runtime.replay(
        new Request(new URL(path, VNDB_API_ORIGIN), {
          headers: { authorization: `Bearer ${await currentBearer()}` },
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    }
    const invoke = async (average: number | null, count: number, loss = false, sourceAlias = 'vndb') => {
      const exchanges = capture.begin();
      const abort = new AbortController();
      let sourceRecords = 0;
      const result = await runImportCli(sourceAlias === 'vndb' ? argv : [...argv, '--source-alias', sourceAlias], {
        signal: abort.signal,
        stdin: archive(false, { v123: { count, average }, v124: { count: 4, average: 800 } }),
        observer: {
          onPageRecords(count) {
            sourceRecords += count;
          },
          onVndbStore({ store }) {
            const page = store.page.bind(store);
            store.page = (...args) => {
              const result = page(...args);
              for (const row of result.records)
                records.set(row.key, {
                  source: 'vndb',
                  key: row.key,
                  revision: String(row.revision),
                  payload: structuredClone(row.record),
                });
              return result;
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (new URL(request.url).origin === auth) return support.host.service.handler(request);
          expect(new URL(request.url).origin).toBe(VNDB_API_ORIGIN);
          const response = await capture.fetch(request);
          if (loss && request.url.endsWith('/source-statistics/vndb:clear') && response.status === 204) {
            // Abort this invocation after observing the actual committed response/receipt.
            abort.abort(new Error('Committed zero clear response lost at HTTP boundary'));
            throw new TypeError('Committed zero clear response lost at HTTP boundary');
          }
          return response;
        }) as typeof fetch,
      });
      return { ...result, exchanges, sourceRecords };
    };
    const initial = await invoke(700, 2);
    expect(initial.code).toBe(0);
    const subject = await subjectFor('v123'),
      independent = await subjectFor('v124');
    const originalSubjectBefore = subject;
    const subjectViewBefore = await publicRead(`/v1/subjects/${subject}`);
    const independentBefore = await publicRead(`/v1/subjects/${independent}/source-statistics`);
    expect(independentBefore).toHaveLength(1);
    const semanticSnapshot = () => capture.bulkReceiptRows();
    const candidates = async () =>
      (
        await runtime.database.admin.query<{ id: string }>(
          'SELECT candidate_id AS id FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id',
          [routeOf(subject), subject],
        )
      ).rows;
    const originalCandidates = await candidates();
    expect(originalCandidates.length).toBeGreaterThan(0);
    const originalSemanticReceiptsBefore = await semanticSnapshot();

    // Actual supported fixture: native public vote commands and worker publication, no SQL vote/prior setup.
    figures = await createFigureFixture({ subjects: 1, partitions: 1, deferMembership: true });
    const figureSubject = figures.subjectIds[0]!;
    for (const voter of figures.globalVoters) await figures.vote(figureSubject, voter, 16);
    await figures.published(figureSubject, figures.globalVoters.length);
    const voteControl = async () => ({
      figure: await figures!.figure(figureSubject),
      votes: (
        await Promise.all(
          figures!.globalVoters.map(
            async (voter) =>
              (
                await figures!.database.admin.query(
                  'SELECT * FROM rating.vote WHERE route=$1 AND voter_id=$2 AND target_id=$3',
                  [routeOf(voter.id), voter.id, figureSubject],
                )
              ).rows,
          ),
        )
      ).flat(),
      importedVotes: (
        await runtime.database.admin.query(
          'SELECT * FROM rating.vote WHERE route=$1 AND voter_id=$2 AND target_id=$3',
          [routeOf(runtime.identity.bulk.accountId), runtime.identity.bulk.accountId, subject],
        )
      ).rows,
    });
    const nativeVotesAndFigureBefore = await voteControl();
    expect(nativeVotesAndFigureBefore.votes.length).toBeGreaterThan(0);
    expect(nativeVotesAndFigureBefore.importedVotes).toEqual([]);

    const zero = await invoke(null, 0);
    const clearExchange = zero.exchanges.find((e) => e.path.endsWith('/source-statistics/vndb:clear'));
    if (!clearExchange?.body || !clearExchange.receipt) throw new Error('Missing native clear response/receipt');
    expect(clearExchange.status).toBe(204);
    const clear = { status: clearExchange.status, body: JSON.parse(clearExchange.body) };
    const publicAfterZero = await publicRead(`/v1/subjects/${subject}/source-statistics`);
    const unchanged = await invoke(null, 0);
    const statisticRequests = (exchanges: typeof zero.exchanges) =>
      exchanges.filter((e) => e.path.includes('/source-statistics/'));
    const unchangedStatisticRequests = statisticRequests(unchanged.exchanges);
    expect((await invoke(700, 2)).code).toBe(0);
    const zeroMean = await invoke(0, 0);
    const publicAfterZeroMean = await publicRead(`/v1/subjects/${subject}/source-statistics`);
    expect((await invoke(700, 2)).code).toBe(0);
    const positiveBeforeUnknown = await publicRead(`/v1/subjects/${subject}/source-statistics`);
    expect(positiveBeforeUnknown).toHaveLength(1);

    // UNKNOWN cannot be represented by the pinned native headers. This adjacent branch uses the
    // same ordinary registration/coordinator, sanitized grouped records, state, server and account.
    const registration = createSourceRegistration('vndb');
    const adjacent = async (partial = false) => {
      const caller = open();
      try {
        return await caller.runRecords(
          registration,
          (async function* () {
            for (const original of records.values()) {
              const row = structuredClone(original);
              if (row.key === 'v123') {
                const payload = row.payload as { vn: { c_average?: number | null; c_votecount?: number } };
                delete payload.vn.c_average;
                if (!partial) delete payload.vn.c_votecount;
              }
              yield row;
            }
          })(),
        );
      } finally {
        await caller.close();
      }
    };
    const unknownExchanges = capture.begin();
    expect((await adjacent()).status).toBe('committed');
    const unknownStatisticRequests = statisticRequests(unknownExchanges);
    const publicAfterUnknown = await publicRead(`/v1/subjects/${subject}/source-statistics`);
    const malformedPair = await adjacent(true);
    expect((await invoke(700, 2)).code).toBe(0);
    const beforeLostResponseBaseline = await baseline();
    const lost = await invoke(null, 0, true);
    expect(lost.code).not.toBe(0);
    const lostResponse = { completedBaseline: await baseline() };
    const pending = statisticRequests(lost.exchanges);
    expect(pending).toHaveLength(1);
    const pendingClearBytes = pending.map((e) => e.body),
      pendingClearKeys = pending.map((e) => e.idempotencyKey);
    expect(pending[0]!.receipt).not.toBeNull();
    await support.renewManagement();
    await support.setStatisticGrant(false);
    const replay = await capture.replay(pending[0]!);
    const revokedReplay = {
      status: replay.status,
      storedSuccess: replay.receipt,
    };
    expect(replay.status).toBe(403);
    expect(JSON.stringify(replay.response)).not.toContain('sourceRecordId');
    expect(JSON.stringify(replay.response)).not.toContain('removed');
    await support.renewManagement();
    await support.setStatisticGrant(true);
    // Preserve the existing native archive admission gate. The valid replacement archive has
    // positive votes, but its grouped SourceRecord stream must remain unread during sealed replay.
    const resumed = await invoke(900, 5);
    expect(resumed.sourceRecords).toBe(0);
    const resumedClears = statisticRequests(resumed.exchanges);
    const resumedClearBytes = resumedClears.map((e) => e.body),
      resumedClearKeys = resumedClears.map((e) => e.idempotencyKey);
    const key = JSON.parse(pendingClearKeys[0]!) as string;
    const receipt = await runtime.database.admin.query<{ position: string }>(
      `SELECT position::text FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
       AND principal_id=$2 AND command_kind='rating.source_statistic.clear' AND idempotency_key=$3`,
      [partitionOf(routeOf(subject)!), runtime.identity.bulk.accountId, key],
    );
    expect(receipt.rows).toHaveLength(1);
    const events = await runtime.database.admin.query(
      `SELECT id FROM core.outbox WHERE partition_no=$1 AND position=$2 AND subject=$3
       AND type='com.rezics.rating.source_statistic.changed.v1'`,
      [partitionOf(routeOf(subject)!), receipt.rows[0]!.position, subject],
    );
    const clearNativeEffectCount = events.rows.length;
    const originalSubjectAfter = await subjectFor('v123');
    expect(await publicRead(`/v1/subjects/${subject}`)).toEqual(subjectViewBefore);
    expect(await publicRead(`/v1/subjects/${subject}/source-statistics`)).toEqual([]);
    const originalSemanticReceiptsAfter = await semanticSnapshot();
    const independentAfter = await publicRead(`/v1/subjects/${independent}/source-statistics`);
    const nativeVotesAndFigureAfter = await voteControl();
    const afterCandidates = await candidates();
    const duplicateCandidateEffects = afterCandidates.filter(
      (row) => !originalCandidates.some((prior) => prior.id === row.id),
    );
    expect(afterCandidates).toEqual(originalCandidates);
    // Supplemental alias outcomes share the CLI, private state, native archive, Auth and public runtime.
    async function aliasJourney() {
      const alias = 'feed-two';
      const positive = await invoke(700, 2, false, alias);
      expect(positive.code).toBe(0);
      const aliasSubject = await subjectFor('v123', alias);
      const aliasIndependent = await subjectFor('v124', alias);
      const read = () => publicRead(`/v1/subjects/${aliasSubject}/source-statistics`);
      const independentBefore = await publicRead(`/v1/subjects/${aliasIndependent}/source-statistics`);
      const positiveExchange = positive.exchanges.find((e) => e.method === 'PUT' && e.body?.includes('v123'))!;
      const positiveBody = JSON.parse(positiveExchange.body!);
      expect(positiveExchange.status).toBe(200);
      const zero = await invoke(null, 0, false, alias);
      expect(zero.code).toBe(0);
      const clear = zero.exchanges.find((e) => e.path.endsWith(':clear') && e.body?.includes('v123'))!;
      const afterZero = await read();
      expect((await invoke(800, 3, false, alias)).code).toBe(0);
      const beforeMismatch = await read();
      for (const value of [
        { sourceAlias: 'feed-one', sourceRecordId: 'v123', count: 0 as const, asOf: '2026-10-25' },
        { sourceAlias: alias, sourceRecordId: 'v999', count: 0 as const, asOf: '2026-10-25' },
      ]) {
        await ordinaryTransport.clearSourceStatistic({
          subjectId: aliasSubject,
          source: 'vndb',
          value,
          idempotencyKey: randomUUID(),
        });
        expect(await read()).toEqual(beforeMismatch);
      }
      // One subject/provider slot: replace its association through the real public PUT, then
      // an old alias clear must leave that current other association intact.
      await ordinaryTransport.writeSourceStatistic({
        subjectId: aliasSubject,
        source: 'vndb',
        value: { ...positiveBody, sourceAlias: 'feed-one' },
        idempotencyKey: randomUUID(),
      });
      const otherAssociation = await read();
      expect(otherAssociation).toEqual([{ source: 'vndb', ...positiveBody, sourceAlias: 'feed-one' }]);
      await ordinaryTransport.clearSourceStatistic({
        subjectId: aliasSubject,
        source: 'vndb',
        value: { sourceAlias: alias, sourceRecordId: 'v123', count: 0, asOf: '2026-10-25' },
        idempotencyKey: randomUUID(),
      });
      const afterStaleClear = await read();
      expect((await invoke(900, 4, false, alias)).code).toBe(0);
      const beforeCanonicalFence = await read();
      const editor = await openApiObserver(runtime);
      const fence = async (source: string) => {
        const response = await editor.http('/v1/sourceFences:takedown', {
          source,
          externalId: 'v123',
          fieldGroup: 'facts',
          reason: 'Exact alias statistic control',
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      };
      await fence('vndb');
      const afterCanonicalFence = await read();
      await fence(alias);
      const afterAliasFence = await read();
      const fenced = await invoke(850, 6, false, alias);
      expect(fenced.code).toBe(0);
      const fencedStatisticRequests = statisticRequests(fenced.exchanges);
      const fencedZero = await invoke(null, 0, false, alias);
      expect(fencedZero.code).toBe(0);
      const fencedClear = fencedZero.exchanges.find((e) => e.path.endsWith(':clear') && e.body?.includes('v123'))!;
      return {
        positiveBody,
        clear: { status: clear.status, body: JSON.parse(clear.body!), receipt: clear.receipt },
        afterZero,
        beforeMismatch,
        otherAssociation,
        afterStaleClear,
        beforeCanonicalFence,
        afterCanonicalFence,
        afterAliasFence,
        fencedStatisticRequests,
        fencedClear: { status: fencedClear.status, body: JSON.parse(fencedClear.body!), receipt: fencedClear.receipt },
        independentBefore,
        independentAfter: await publicRead(`/v1/subjects/${aliasIndependent}/source-statistics`),
      };
    }
    console.log(
      JSON.stringify({
        converter_revision,
        sourceRecordId: 'v123',
        asOf: clear.body.asOf,
        clear: clearExchange,
        pending,
        resumed: resumedClears,
        revokedReplay,
        clearNativeEffectCount,
        baseline: await baseline(),
        semanticReceipts: originalSemanticReceiptsAfter,
        candidateIds: afterCandidates,
        independentAfter,
        nativeVotesAndFigureAfter,
      }),
    );
    return {
      aliasJourney,
      initial,
      zero,
      clear,
      sourceRecordId: 'v123',
      asOf: clear.body.asOf,
      publicAfterZero,
      unchanged,
      unchangedStatisticRequests,
      zeroMean,
      publicAfterZeroMean,
      unknownStatisticRequests,
      publicAfterUnknown,
      positiveBeforeUnknown,
      malformedPair,
      originalSubjectBefore,
      originalSubjectAfter,
      originalSemanticReceiptsBefore,
      originalSemanticReceiptsAfter,
      lostResponse,
      beforeLostResponseBaseline,
      resumed,
      resumedClearBytes,
      resumedClearKeys,
      pendingClearBytes,
      pendingClearKeys,
      clearNativeEffectCount,
      revokedReplay,
      independentBefore,
      independentAfter,
      nativeVotesAndFigureBefore,
      nativeVotesAndFigureAfter,
      duplicateCandidateEffects,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
