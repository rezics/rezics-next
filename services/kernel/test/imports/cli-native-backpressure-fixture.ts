import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { Statement, Subject } from '../../../../specs/semantic-driver.ts';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { createImporter } from '../../../importer/src/importer.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Leg = 'recovered' | 'exhausted' | 'resumed';
type LogicalCall = { leg: Leg; bytes: string; keys: string[]; physical: number };
type Exchange = {
  leg: Leg;
  caller: 'cli' | 'competing-replay';
  path: string;
  bytes: string;
  status: number;
  response: string;
  atMs: number;
  retryAfterSeconds: number | null;
};
type PendingRow = { record_key: string; bytes: string; keys_json: string };
type Candidate = { id: string; statement: Statement };

// Supplied synthetic metadata, with no posts, method text or invented native revisions.
const rows = Array.from({ length: 17 }, (_, i) => ({
  id: 920001 + i,
  type: 2,
  name: `Backpressure title ${i + 1}`,
  ...(i === 0 ? { images: { large: 'https://lain.bgm.tv/cover.jpg' } } : {}),
}));
const source = 'bangumi';
const target = String(rows[1]!.id);
const feed = (records: typeof rows) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const keys = (bytes: string) => (JSON.parse(bytes) as BatchWriteRequest).commands.map((c) => c.key);

/** One CLI/Auth/kernel/worker world. Only external routing and competing request scheduling are supplied. */
export async function runCliNativeBackpressureJourney() {
  const runtime = await openApiRuntime(
    { batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 },
    undefined,
    undefined,
    { maximum: 8, seconds: 2 },
  );
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/imports-backpressure-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'operator.jwk');
    await writeFile(state, '', { mode: 0o600 });
    const identity = runtime.identity;
    const support = identitySupport(identity);
    const editor = await openApiObserver(runtime);
    await support.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approval = await identity.auth.internal.approveCredentialEffect(effect);
    await identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const api = 'https://kernel.import.test';
    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const logicalCalls: LogicalCall[] = [];
    const activeCalls = new Map<string, LogicalCall>();
    const actualScheduledWaits: { leg: Leg; atMs: number; durationMs: number; finishedAtMs?: number }[] = [];
    const authPaths: string[] = [];
    const publicReads: { path: string; status: number; body: unknown }[] = [];
    const knownCommands = new Map<string, BatchCommand>();
    let competingRequest: Request | undefined;
    let workerStarted = false;
    let writeTail = Promise.resolve();
    const revisions: { source: string; converter: string; module: string }[] = [];

    async function capture(request: Request, leg: Leg, caller: Exchange['caller']) {
      const url = new URL(request.url);
      const bytes = await request.clone().text();
      const atMs = Date.now();
      const response = await runtime.replay(request);
      const responseBytes = await response.clone().text();
      const hint = response.headers.get('retry-after');
      exchanges.push({
        leg,
        caller,
        path: url.pathname,
        bytes,
        atMs,
        status: response.status,
        response: responseBytes,
        retryAfterSeconds: hint === null ? null : Number(hint),
      });
      return response;
    }

    async function invoke(leg: Leg, records: typeof rows) {
      let consumed = false;
      const text = feed(records);
      const result = await runImportCli(
        [
          '--source',
          source,
          '--dump',
          '-',
          '--state',
          state,
          '--api',
          api,
          '--auth',
          auth,
          '--account-key',
          keyPath,
          '--account',
          identity.bulk.accountId,
          '--client',
          identity.client.clientId,
        ],
        {
          stdin: (async function* () {
            yield new TextEncoder().encode(text);
            consumed = true;
          })(),
          clock: {
            now: Date.now,
            async sleep(ms) {
              const wait = { leg, atMs: Date.now(), durationMs: ms, finishedAtMs: undefined as number | undefined };
              actualScheduledWaits.push(wait);
              await Bun.sleep(ms);
              wait.finishedAtMs = Date.now();
            },
          },
          createImporter(options) {
            // Keep the exact options object: the CLI attaches its real media resolver after construction.
            const batchWrite = options.transport.batchWrite;
            options.transport.batchWrite = async (request) => {
              const bytes = JSON.stringify(request);
              const call = { leg, bytes, keys: request.commands.map((c) => c.key), physical: 0 };
              logicalCalls.push(call);
              expect(activeCalls.has(bytes)).toBe(false);
              activeCalls.set(bytes, call);
              try {
                return await batchWrite(request);
              } finally {
                activeCalls.delete(bytes);
              }
            };
            return createImporter(options);
          },
          observer: {
            onAccountKey(_path, observation) {
              expect(observation.mode & 0o777).toBe(0o600);
              expect(observation.importedKey.extractable).toBe(false);
            },
            onCoordinator({ registration, converterModule }) {
              revisions.push({
                source: registration.source,
                converter: registration.converter_revision,
                module: converterModule,
              });
            },
          },
          fetch: (async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === auth) {
              authPaths.push(url.pathname);
              return support.host.service.handler(request);
            }
            expect(url.origin).toBe(api);
            expect(consumed).toBe(true); // Complete acquisition precedes every application effect/read.
            expect(request.headers.has('cookie')).toBe(false);
            if (url.pathname.startsWith('/v1/media/') && url.pathname.endsWith(':importStatus')) {
              const id = url.pathname.split('/')[3]!.split(':')[0]!;
              if (!workerStarted) {
                await runtime.mediaBoundary.start();
                workerStarted = true;
              }
              await runtime.mediaBoundary.drain({ mediaIds: [id], maxJobs: 16, signal: request.signal });
            }
            if (url.pathname !== '/v1/subjects:batchWrite') return capture(request, leg, 'cli');
            const saved = request.clone();
            const bytes = await request.clone().text();
            const body = JSON.parse(bytes) as BatchWriteRequest;
            const call = activeCalls.get(bytes);
            if (!call) throw new Error('Physical write without an observed coordinator invocation');
            call.physical++;
            for (const command of body.commands) {
              const old = knownCommands.get(command.key);
              if (old) expect(command).toEqual(old);
              expect(command.source.source).toBe(source);
              expect(command.source.converter_revision).toBe(converter_revision);
              expect(command.source.record_revision).toBe('unversioned');
              expect(command.source.digest).toMatch(/^[0-9a-f]{64}$/);
              knownCommands.set(command.key, command);
            }
            // Serialize only public write scheduling, as the native runtime's ordinary transport does.
            const previous = writeTail;
            let release!: () => void;
            writeTail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
            try {
              if (
                leg === 'exhausted' &&
                body.commands.some((c) => c.source.external_id === target && c.op !== 'create')
              ) {
                if (!competingRequest) throw new Error('Missing committed baseline request for real competing traffic');
                // Actual receipt replays spend native admission units. No counter, clock, reply or policy is changed.
                // With maximum eight and at least one unit per request, nine sends suffice to observe refusal.
                let refused = false;
                for (let send = 0; send < 9; send++) {
                  const headers = new Headers(competingRequest.headers);
                  headers.set('authorization', request.headers.get('authorization')!);
                  const competitor = new Request(competingRequest.clone(), { headers });
                  const reply = await capture(competitor, leg, 'competing-replay');
                  const status = reply.status;
                  await reply.body?.cancel();
                  if (status === 429) {
                    refused = true;
                    break;
                  }
                  expect(status).toBe(200);
                }
                expect(refused).toBe(true);
              }
              const response = await capture(request, leg, 'cli');
              if (leg === 'recovered' && response.status === 200 && body.commands.length >= 2)
                competingRequest ??= saved;
              return response;
            } finally {
              release();
            }
          }) as typeof fetch,
        },
      );
      expect(result.openHandles).toBe(0);
      expect(activeCalls.size).toBe(0);
      expect((await stat(state)).mode & 0o777).toBe(0o600);
      return result;
    }

    function local<T>(read: (db: Database) => T): T {
      const db = new Database(state, { readonly: true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    }
    function baseline() {
      const session = new ImportSession(state);
      try {
        return {
          source: session.store.source(source),
          records: rows.map((r) => session.store.key(source, String(r.id)).baseline),
        };
      } finally {
        session.close();
      }
    }
    function bindings() {
      return local((db) =>
        rows.map((r) => {
          const owner = [source, String(r.id)];
          const claim = db
            .query('SELECT state,subject,bootstrap_key FROM binding_records WHERE source=? AND external_id=?')
            .get(...owner) as { state: string; subject: string; bootstrap_key: string };
          expect(claim.state).toBe('bound');
          return {
            id: String(r.id),
            claim,
            bootstrap: db
              .query('SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?')
              .get(...owner, claim.bootstrap_key),
            media: db
              .query(
                'SELECT key,bytes,accepted,status FROM binding_media WHERE source=? AND external_id=? ORDER BY key LIMIT 64',
              )
              .all(...owner),
          };
        }),
      );
    }
    async function receipts(commands: readonly BatchCommand[]) {
      const result = [];
      for (const command of commands) {
        const route =
          command.op === 'create'
            ? tupleRoute(identity.routeKey, source, command.source.external_id)
            : routeOf(command.subject)!;
        const receipt = await runtime.database.admin.query(
          'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', identity.bulk.accountId, `subject.batch_${command.op}`, command.key],
        );
        expect(receipt.rows).toHaveLength(1);
        result.push({ key: command.key, ...receipt.rows[0] });
      }
      return result;
    }
    async function selection(id: string, context: string) {
      const path = `/v1/subjects/${id}?context=${context}`;
      const response = await editor.http(path);
      expect(response.status).toBe(200);
      publicReads.push({ path, ...response });
      return (response.body.subject as Subject).statements['schema:name'];
    }

    const recovered = await invoke('recovered', rows);
    expect(recovered.code, recovered.stderr).toBe(0);
    const completedBaselineBefore = baseline();
    expect(completedBaselineBefore.source.count).toBe(rows.length);
    const originalBindings = bindings();
    const originalCommands = [...knownCommands.values()];
    const originalReceiptRowsBefore = await receipts(originalCommands);
    const id = originalBindings[1]!.claim.subject;
    const listing = await editor.http(`/v1/subjects/${id}/candidates?property=schema:name&limit=100`);
    expect(listing.status).toBe(200);
    const imported = (listing.body.candidates as Candidate[])[0]!;
    const independent = await editor.http(`/v1/subjects/${id}/candidates`, {
      statement: {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'Independent accepted community title' } },
        references: imported.statement.references.map((reference) => ({
          parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
        })),
      },
    });
    expect(independent.status).toBe(201);
    const candidate = independent.body.candidate as string;
    const created = await editor.http('/v1/contexts', { labels: { en: 'Independent backpressure review' } });
    expect(created.status).toBe(201);
    const context = (created.body.context as { id: string }).id;
    expect(
      (await editor.http(`/v1/subjects/${id}/candidates/${candidate}:accept`, { context, expected_head: null })).status,
    ).toBe(200);
    const current = await editor.http(
      `/v1/subjects/${id}/candidates?property=schema:name&limit=100&context=${context}`,
    );
    expect(current.status).toBe(200);
    expect(
      (
        await editor.http(`/v1/subjects/${id}:adopt`, {
          context,
          property: 'schema:name',
          mode: 'replace',
          selection: [{ candidate, rank: 'normal' }],
          expected_head: (current.body.adoption as { head: number } | null)?.head ?? null,
        })
      ).status,
    ).toBe(200);
    const independentSelectionBefore = await selection(id, context);
    expect(independentSelectionBefore).toHaveLength(1);
    expect(independentSelectionBefore![0]!.value.content).toEqual({
      language: 'en',
      text: 'Independent accepted community title',
    });
    const cover = [...knownCommands.values()].find((c) => c.op === 'propose' && c.source.field_group === 'cover');
    if (!cover || cover.op !== 'propose') throw new Error('Missing actual CLI cover proposal');
    const mediaId = cover.statement.value.content as string;
    const mediaBefore = await runtime.mediaBoundary.observe(mediaId);
    expect(mediaBefore.row.state).toBe('available');
    expect(mediaBefore.variants.length).toBeGreaterThan(0);

    const changed = rows.map((r, i) => (i === 0 ? r : { ...r, name: `${r.name} refreshed` }));
    const exhausted = await invoke('exhausted', changed);
    expect(exhausted.code, exhausted.stderr).toBe(1);
    const completedBaselineAfterExhaustion = baseline();
    const pending = local(
      (db) =>
        db
          .query(
            'SELECT record_key,bytes,keys_json FROM run_envelopes WHERE source=? AND pending=1 ORDER BY record_key,envelope_index LIMIT 100',
          )
          .all(source) as PendingRow[],
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(100);
    const pendingPreparedBytes = pending.map((r) => r.bytes);
    const pendingPreparedKeys = pending.map((r) => JSON.parse(r.keys_json) as string[]);
    for (const row of pending) {
      expect(keys(row.bytes)).toEqual(JSON.parse(row.keys_json));
      expect(logicalCalls.some((c) => c.leg === 'exhausted' && c.bytes === row.bytes)).toBe(true);
    }
    const failedCalls = logicalCalls.filter(
      (c) =>
        c.leg === 'exhausted' &&
        (JSON.parse(c.bytes) as BatchWriteRequest).commands.some((command) => command.source.external_id === target),
    );
    expect(failedCalls.length).toBeGreaterThan(1);
    expect(new Set(failedCalls.map((c) => c.bytes)).size).toBe(1);
    const successfulNeighbors = exchanges.filter(
      (e) =>
        e.leg === 'exhausted' &&
        e.caller === 'cli' &&
        e.path === '/v1/subjects:batchWrite' &&
        e.status === 200 &&
        (JSON.parse(e.response) as BatchWriteResult).results.every((r) => r.status === 200 || r.status === 201),
    );
    expect(successfulNeighbors.length).toBeGreaterThan(0);
    expect(bindings()).toEqual(originalBindings);

    // Real elapsed admission recovery; never edit counters, server time, actor tier or configuration.
    await Bun.sleep(2000);
    const resumed = await invoke('resumed', changed);
    expect(resumed.code, resumed.stderr).toBe(0);
    const resumedCalls = [
      ...new Map(logicalCalls.filter((c) => c.leg === 'resumed').map((c) => [c.bytes, c])).values(),
    ];
    // All work was prepared before exhaustion. Fresh invocation drains exactly those durable envelopes.
    const resumedBodies = resumedCalls.map((c) => c.bytes).sort();
    const resumedKeys = resumedBodies.map(keys);
    const pendingOrder = pending
      .map((r, i) => ({ bytes: r.bytes, keys: pendingPreparedKeys[i]! }))
      .sort((a, b) => (a.bytes < b.bytes ? -1 : a.bytes > b.bytes ? 1 : 0));
    expect(resumedBodies).toEqual(pendingPreparedBytes.toSorted());
    expect(baseline().source.count).toBe(rows.length);
    expect(bindings()).toEqual(originalBindings);
    const originalReceiptRowsAfter = await receipts(originalCommands);
    const independentSelectionAfter = await selection(id, context);
    expect(await runtime.mediaBoundary.observe(mediaId)).toEqual(mediaBefore);
    const duplicateEffectRows = [];
    for (const binding of originalBindings) {
      const subject = binding.claim.subject;
      const duplicates = await runtime.database.admin.query(
        'SELECT statement,count(*) FROM semantic.candidate WHERE route=$1 AND subject_id=$2 GROUP BY statement HAVING count(*)>1 LIMIT 100',
        [routeOf(subject), subject],
      );
      duplicateEffectRows.push(...duplicates.rows);
      const claims = await runtime.database.admin.query(
        'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
        [tupleRoute(identity.routeKey, source, binding.id), source, binding.id],
      );
      expect(claims.rows).toEqual([{ subject_id: subject }]);
    }
    await receipts([...knownCommands.values()]);
    const counts = new Map<string, { invocations: number; physical: number }>();
    for (const call of logicalCalls) {
      expect(call.physical).toBeLessThanOrEqual(6);
      for (const key of call.keys) {
        const identity = `${call.leg}:${key}`;
        const value = counts.get(identity) ?? { invocations: 0, physical: 0 };
        value.invocations++;
        value.physical += call.physical;
        counts.set(identity, value);
      }
    }
    const nativeRateResponses = exchanges.filter((e) => e.status === 429);
    const trace = await runtime.mediaBoundary.capture();
    expect(trace.executedJobs).toBeGreaterThan(0);
    expect(trace.liveInternetRequests).toEqual([]);
    expect(authPaths.filter((p) => p === '/signin/key')).toHaveLength(3);
    console.log(
      'CLI native backpressure evidence',
      JSON.stringify({
        bundle: bundledDigest,
        revisions,
        records: rows.length,
        recovered,
        exhausted,
        resumed,
        exchanges,
        logicalCalls,
        actualScheduledWaits,
        authPaths,
        completedBaselineBefore,
        completedBaselineAfterExhaustion,
        pending,
        originalBindings,
        originalReceiptRowsBefore,
        originalReceiptRowsAfter,
        independentSelectionBefore,
        independentSelectionAfter,
        publicReads,
        media: {
          id: mediaId,
          row: mediaBefore.row,
          events: mediaBefore.events,
          jobs: trace.executedJobs,
          calls: trace.calls,
        },
        growth: 'No new native PostgreSQL growth measurement',
      }),
    );
    return {
      recovered,
      exhausted,
      resumed,
      nativeRateResponses,
      actualScheduledWaits,
      completedBaselineBefore,
      completedBaselineAfterExhaustion,
      pendingPreparedBytes: pendingOrder.map((r) => r.bytes),
      pendingPreparedKeys: pendingOrder.map((r) => r.keys),
      maxLogicalInvocationsForOneWrite: Math.max(...[...counts.values()].map((c) => c.invocations)),
      maxPhysicalSendsForOneWrite: Math.max(...[...counts.values()].map((c) => c.physical)),
      resumedBodies,
      resumedKeys,
      originalReceiptRowsBefore,
      originalReceiptRowsAfter,
      duplicateEffectRows,
      independentSelectionBefore,
      independentSelectionAfter,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
