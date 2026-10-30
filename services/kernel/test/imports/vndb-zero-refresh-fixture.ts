import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { SourceRecord } from '@rezics/conversion';
import { converter_revision } from '@rezics/conversion/vndb';
import { runImportCli } from '../../../importer/src/cli.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createFigureFixture, type FigureFixture } from '../rating/support/figure-fixture.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';
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
    const ordinaryTransport = createImportTransport({
      origin: VNDB_API_ORIGIN,
      tokenProvider: async () => runtime.identity.bulk.bearer,
      fetch: capture.fetch,
    });
    const open = () =>
      new Importer({
        path: state,
        transport: {
          batchWrite: ordinaryTransport.batch,
          readFence: (tuple) =>
            ordinaryTransport.fence({
              source: tuple.source,
              externalId: tuple.external_id,
              fieldGroup: tuple.field_group,
            }),
          writeSourceStatistic: ordinaryTransport.writeSourceStatistic,
          clearSourceStatistic: ordinaryTransport.clearSourceStatistic,
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
    const subjectFor = async (id: string) => {
      const reader = open();
      try {
        const binding = reader.session.bindings.claim({ source: 'vndb', external_id: id });
        if (binding?.state !== 'bound') throw new Error('Ordinary CLI did not bind VNDB subject');
        return binding.subject;
      } finally {
        await reader.close();
      }
    };
    async function publicRead(path: string) {
      const response = await runtime.replay(
        new Request(new URL(path, VNDB_API_ORIGIN), {
          headers: { authorization: `Bearer ${runtime.identity.bulk.bearer}` },
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    }
    const invoke = async (average: number | null, count: number, loss = false, replacement = false) => {
      const exchanges = capture.begin();
      const abort = new AbortController();
      const result = await runImportCli(argv, {
        signal: abort.signal,
        stdin: replacement
          ? (async function* () {
              throw new Error('Sealed resume consumed replacement archive');
              yield new Uint8Array();
            })()
          : archive(false, { v123: { count, average }, v124: { count: 4, average: 800 } }),
        observer: {
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
      return { ...result, exchanges };
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
        await figures!.database.admin.query('SELECT * FROM rating.vote WHERE target_id=$1 ORDER BY voter_id', [
          figureSubject,
        ])
      ).rows,
      importedVotes: (await runtime.database.admin.query('SELECT * FROM rating.vote WHERE target_id=$1', [subject]))
        .rows,
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
    await support.setStatisticGrant(false);
    const replay = await capture.replay(pending[0]!);
    const revokedReplay = {
      status: replay.status,
      storedSuccess: replay.status === 403 && replay.receipt === null ? null : replay.response,
    };
    expect(replay.status).toBe(403);
    await support.setStatisticGrant(true);
    // Reopen same durable state, before the replacement source stream is read.
    const resumed = await invoke(null, 0, false, true);
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
