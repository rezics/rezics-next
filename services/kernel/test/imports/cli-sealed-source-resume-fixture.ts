import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision as vndbRevision } from '../../../../packages/conversion/src/vndb.ts';
import { converter_revision as wikidataRevision } from '../../../../packages/conversion/src/wikidata.ts';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import type { Importer } from '../../../importer/src/importer.ts';
import type { Seal } from '../../../importer/src/run-store.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

type Source = 'vndb' | 'wikidata';
type Exchange = {
  ordinal: number;
  path: string;
  method: string;
  bytes: string;
  status: number;
  response: string;
  keys: string[];
};
type Anchor = { partition: number; kind: string; key: string };
type Candidate = { id: string; source: BatchCommand['source'] | null; statement: BatchStatement };
type Journal = { key: string; bytes: string; acknowledgement: string | null };
const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sources = [
  { source: 'vndb' as const, keys: ['v123', 'v124'], converter: vndbRevision },
  { source: 'wikidata' as const, keys: [entity.id], converter: wikidataRevision },
];

/** Actual pinned COPY entries in ustar framing, including a late duplicate invalid control. */
function archive(generation: number, invalid: boolean) {
  const chunks: Uint8Array[] = [];
  for (const name of [...names, ...(invalid ? ['entry_meta'] : [])]) {
    let text = readFileSync(
      new URL(`../../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url),
      'utf8',
    );
    if (name === 'vn_titles' && generation) text = text.replace('Sentinel Harbor', `Harbor generation ${generation}`);
    if (name === 'entry_meta' && generation) text = text.replace('\t7\t6\t3', `\t${7 + generation}\t6\t3`);
    if (name === 'vn' && generation) text = text.replace('\t2\t700\t700\t', `\t2\t700\t${700 + 10 * generation}\t`);
    const body = encoder.encode(text);
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    put(0, `db/${name}`);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, body.length.toString(8).padStart(11, '0') + '\0');
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    put(
      148,
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
    );
    chunks.push(header, body);
    if (body.length % 512) chunks.push(new Uint8Array(512 - (body.length % 512)));
  }
  chunks.push(new Uint8Array(1024));
  return Buffer.concat(chunks);
}

function input(source: Source, generation: number, invalid = false): Uint8Array {
  if (source === 'vndb') return archive(generation, invalid);
  const record = structuredClone(entity);
  record.lastrevid += generation;
  if (generation) record.labels.en.value = `Book generation ${generation}`;
  // Missing closing array framing is detected only when the real reader reaches EOF.
  return encoder.encode(`[\n${JSON.stringify(record)}\n${invalid ? '' : ']\n'}`);
}

/** One real Auth/Access/application/worker world; only bytes and response-loss timing are supplied. */
export async function runJourney() {
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
    sourceStatistics: 'vndb',
  });
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/import-cli-sealed-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { flag: 'wx', mode: 0o600 });
    const support = identitySupport(runtime.identity);
    await support.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
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
    const approval = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      flag: 'wx',
      mode: 0o600,
    });
    const editor = await openApiObserver(runtime);
    const api = 'https://cli-sealed.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const anchors = new Map<string, Anchor>();
    const commands = new Map<string, BatchCommand>();

    async function receipts(keys: readonly string[]) {
      const result = [];
      for (const key of keys) {
        const anchor = anchors.get(key)!;
        const rows = (
          await runtime.database.admin.query(
            'SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key,transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
            [anchor.partition, 'account', runtime.identity.bulk.accountId, anchor.kind, anchor.key],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        result.push({ key, rows });
      }
      return result;
    }
    function inspect(feed: (typeof sources)[number]) {
      const session = new ImportSession(state);
      try {
        const source = session.store.source(feed.source);
        const active = session.store.activeRun(feed.source);
        return {
          source,
          active,
          pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
          records: feed.keys.map((key) => ({
            key,
            ...session.store.key(feed.source, key),
            claim: session.bindings.claim({ source: feed.source, external_id: key }),
          })),
          journals: feed.keys.flatMap((key) =>
            session.store.database
              .query<Journal, [string, string]>(
                'SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 100',
              )
              .all(feed.source, key),
          ),
          media: session.store.database
            .query('SELECT * FROM binding_media WHERE source=? ORDER BY external_id,key LIMIT 64')
            .all(feed.source),
          acquisitions:
            feed.source === 'vndb'
              ? session.store.database
                  .query(
                    'SELECT run_id,state,materialized_generation FROM vndb_table_runs WHERE source=? AND (materialized_generation=? OR materialized_generation=?) ORDER BY run_id LIMIT 2',
                  )
                  .all(feed.source, source.generation, active?.id ?? null)
              : [],
        };
      } finally {
        session.close();
      }
    }

    async function invoke(feed: (typeof sources)[number], bytes: Uint8Array, lose = false) {
      const start = exchanges.length;
      const controller = new AbortController();
      let coordinator: Importer | undefined;
      let consumed = 0,
        observed = 0,
        passes = 0;
      let eof = false,
        sealed = false;
      const seals: Seal[] = [];
      const authPaths: string[] = [];
      const acquisitions: unknown[] = [];
      const lost: Exchange[] = [];
      const result = await runImportCli(
        [
          '--source',
          feed.source,
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
          runtime.identity.bulk.accountId,
          '--client',
          runtime.identity.client.clientId,
        ],
        {
          signal: controller.signal,
          stdin: (async function* () {
            for (let offset = 0; offset < bytes.length; offset += 127) {
              const chunk = bytes.slice(offset, offset + 127);
              consumed += chunk.length;
              yield chunk;
            }
            eof = true;
          })(),
          observer: {
            onAccountKey(path, observed) {
              expect(path).toBe(keyPath);
              expect(observed.regularFile).toBe(true);
              expect(observed.mode & 0o777).toBe(0o600);
            },
            onInputPass() {
              passes++;
            },
            onInputChunk(_kind, size, backing) {
              observed += size;
              expect(backing).toBe(size);
            },
            onVndbStore({ store }) {
              const page = store.page.bind(store);
              store.page = (...args) => {
                const value = page(...args);
                acquisitions.push({
                  source: args[0],
                  run: args[1],
                  records: value.records.map((row) => ({ key: row.key, revision: row.revision })),
                });
                return value;
              };
            },
            onCoordinator({ importer, registration, converterModule, decoderModule }) {
              coordinator = importer;
              expect(registration.source).toBe(feed.source);
              expect(registration.converter_revision).toBe(feed.converter);
              expect(converterModule).toBe(
                import.meta.resolve(`../../../../packages/conversion/src/${feed.source}.ts`),
              );
              expect(decoderModule).toBe(
                import.meta.resolve(`../../../importer/src/${feed.source === 'vndb' ? 'vndb-tables' : 'dumps'}.ts`),
              );
              sealed = importer.session.store.activeRun(feed.source) !== null;
              const seal = importer.session.store.seal.bind(importer.session.store);
              importer.session.store.seal = (run, request) => {
                const value = seal(run, request);
                seals.push(value);
                if (value.status === 'ready') {
                  expect(eof).toBe(true);
                  expect(consumed).toBe(bytes.length);
                  sealed = true;
                }
                return value;
              };
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            expect(sealed).toBe(true);
            if (url.origin === auth) {
              authPaths.push(url.pathname);
              return support.host.service.handler(request);
            }
            expect(url.origin).toBe(api);
            expect(request.headers.has('cookie')).toBe(false);
            const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
            expect(claims.sub).toBe(runtime.identity.bulk.accountId);
            expect(String(claims.scope).split(' ').sort()).toEqual(
              [...(feed.source === 'vndb' ? VNDB_IMPORTER_SCOPES : IMPORTER_SCOPES)].sort(),
            );
            const bytes = request.method === 'GET' ? '' : await request.clone().text();
            const bulk = url.pathname === '/v1/subjects:batchWrite';
            const body = bulk ? (JSON.parse(bytes) as BatchWriteRequest) : null;
            for (const command of body?.commands ?? []) {
              expect(command.source.source).toBe(feed.source);
              if (commands.has(command.key)) expect(command).toEqual(commands.get(command.key)!);
              commands.set(command.key, command);
              const route =
                command.op === 'create'
                  ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
                  : routeOf(command.subject)!;
              anchors.set(command.key, {
                partition: partitionOf(route),
                kind: `subject.batch_${command.op}`,
                key: command.key,
              });
            }
            const statistic = /\/source-statistics\/vndb$/.test(url.pathname);
            let statisticKey: string | undefined;
            if (statistic) {
              statisticKey = JSON.parse(request.headers.get('idempotency-key')!) as string;
              anchors.set(statisticKey, {
                partition: partitionOf(routeOf(url.pathname.split('/')[3]!)!),
                kind: 'rating.source_statistic.write',
                key: statisticKey,
              });
            }
            const response = await runtime.replay(request);
            const responseBytes = await response.clone().text();
            const exchange = {
              ordinal: exchanges.length + 1,
              path: url.pathname,
              method: request.method,
              bytes,
              status: response.status,
              response: responseBytes,
              keys: body?.commands.map((command) => command.key) ?? (statisticKey ? [statisticKey] : []),
            };
            exchanges.push(exchange);
            expect(response.status, responseBytes).toBeLessThan(300);
            if (bulk) {
              for (const entry of (JSON.parse(responseBytes) as BatchWriteResult).results)
                expect('value' in entry, JSON.stringify(entry)).toBe(true);
              if (lose && body!.commands.some((command) => command.op === 'propose')) {
                await receipts(exchange.keys);
                lost.push(exchange);
                controller.abort(new DOMException('Interrupted after native commit before local ACK', 'AbortError'));
                throw controller.signal.reason;
              }
            }
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.openHandles).toBe(0);
      if (coordinator) expect(() => coordinator!.session.store.source(feed.source)).toThrow();
      expect(observed).toBe(consumed);
      if (consumed) {
        if (result.code !== 2 || feed.source === 'wikidata') expect(eof).toBe(true);
        expect(passes).toBe(1);
      } else expect(passes).toBe(0);
      const captured = exchanges.slice(start);
      const writes = captured.filter((exchange) => !['GET', 'HEAD'].includes(exchange.method));
      return {
        ...result,
        captured,
        writes,
        lost,
        consumed,
        eof,
        seals,
        authPaths,
        acquisitions,
        inputSha256: sha256(bytes),
      };
    }

    async function candidates(id: string, context: string) {
      const result = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property: 'schema:name', context, limit: '100' })}`,
      );
      expect(result.status).toBe(200);
      expect(result.body.next).toBeNull();
      return result;
    }
    async function selection(id: string, context: string) {
      const response = await editor.http(`/v1/subjects/${id}?context=${context}`);
      expect(response.status).toBe(200);
      const listing = await candidates(id, context);
      const subject = response.body.subject as { statements: Record<string, unknown[]> };
      return {
        statements: subject.statements['schema:name'],
        adoption: listing.body.adoption,
        heads: (listing.body.candidates as unknown as { id: string; head: number | null }[])
          .filter((c) => c.head !== null)
          .map((c) => ({ id: c.id, head: c.head }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    }
    async function subjectIds(feed: (typeof sources)[number]) {
      const rows = [];
      for (const key of feed.keys) {
        const result = await runtime.database.admin.query<{ subject_id: string }>(
          'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
          [tupleRoute(runtime.identity.routeKey, feed.source, key), feed.source, key],
        );
        expect(result.rows).toHaveLength(1);
        rows.push({ key, id: result.rows[0]!.subject_id });
      }
      return rows;
    }
    async function effects(ids: { id: string }[]) {
      const rows = [];
      for (const { id } of ids) {
        for (const [kind, sql] of [
          ['subject', 'SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2'],
          [
            'candidate',
            'SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
          ],
          [
            'retraction',
            'SELECT * FROM semantic.retraction WHERE route=$1 AND subject_id=$2 ORDER BY revision,candidate_id LIMIT 100',
          ],
          ['revision', 'SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 100'],
          ['statistic', "SELECT * FROM rating.source_statistic WHERE route=$1 AND subject_id=$2 AND source='vndb'"],
        ] as const) {
          const result = await runtime.database.admin.query(sql, [routeOf(id), id]);
          expect(result.rows.length).toBeLessThan(100);
          rows.push(...result.rows.map((row) => ({ id, kind, row })));
        }
      }
      return rows;
    }

    const results = [];
    let vndbInvalidBeforeResume: Awaited<ReturnType<typeof invoke>> | undefined;
    let vndbPendingBeforeInvalid: ReturnType<typeof inspect> | undefined;
    let vndbPendingAfterInvalid: ReturnType<typeof inspect> | undefined;
    for (const feed of sources) {
      const initial = await invoke(feed, input(feed.source, 0));
      expect(initial.code, JSON.stringify(initial)).toBe(0);
      const original = inspect(feed);
      expect(original.active).toBeNull();
      expect(original.source.count).toBe(feed.keys.length);
      const ids = await subjectIds(feed);
      for (const [index, record] of original.records.entries()) {
        expect(record.claim?.state).toBe('bound');
        if (record.claim?.state !== 'bound') throw new Error('Missing native CLI claim');
        expect(record.claim.subject).toBe(ids[index]!.id);
      }
      const id = ids[0]!.id;
      const contextResponse = await editor.http('/v1/contexts', {
        labels: { en: `Independent ${feed.source} recovery review` },
      });
      expect(contextResponse.status).toBe(201);
      const context = (contextResponse.body.context as { id: string }).id;
      const listed = await candidates(id, context);
      const candidate = (listed.body.candidates as unknown as Candidate[])[0]!;
      expect(candidate.source!.source).toBe(feed.source);
      expect(
        (await editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, { context, expected_head: null }))
          .status,
      ).toBe(200);
      const independent = await editor.http(`/v1/subjects/${id}/candidates`, {
        statement: {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'en', text: 'Independent community title' } },
          references:
            candidate.statement.references?.map((reference) => ({
              parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
            })) ?? [],
        },
      });
      expect(independent.status).toBe(201);
      const independentId = independent.body.candidate as string;
      expect(independentId).not.toBe(candidate.id);
      expect(
        (await editor.http(`/v1/subjects/${id}/candidates/${independentId}:accept`, { context, expected_head: null }))
          .status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${id}:adopt`, {
            context,
            property: 'schema:name',
            mode: 'replace',
            expected_head: null,
            selection: [{ candidate: independentId, rank: 'normal' }],
          })
        ).status,
      ).toBe(200);
      const independentSelectionBefore = await selection(id, context);
      expect(independentSelectionBefore.statements).toHaveLength(1);
      expect(independentSelectionBefore.heads).toHaveLength(2);

      const interrupted = await invoke(feed, input(feed.source, 1), true);
      expect([1, 130]).toContain(interrupted.code);
      expect(interrupted.lost).toHaveLength(1);
      const pending = inspect(feed);
      expect(pending.source).toEqual(original.source);
      expect(pending.records.map((record) => record.baseline)).toEqual(
        original.records.map((record) => record.baseline),
      );
      expect(pending.pending).toHaveLength(1);
      expect(pending.pending.map((row) => row.bytes)).toEqual(interrupted.lost.map((row) => row.bytes));
      expect(pending.pending.flatMap((row) => row.keys)).toEqual(interrupted.lost.flatMap((row) => row.keys));
      expect(
        pending.journals
          .filter((row) => pending.pending.flatMap((p) => p.keys).includes(row.key))
          .every((row) => row.acknowledgement === null),
      ).toBe(true);
      const receiptKeys = [...initial.writes, ...interrupted.writes].flatMap((exchange) => exchange.keys);
      const originalReceiptRowsBefore = await receipts(receiptKeys);
      const beforeEffects = await effects(ids);
      const malformed = input(feed.source, 2, true);
      if (feed.source === 'vndb') {
        expect(pending.acquisitions).toHaveLength(2);
        vndbPendingBeforeInvalid = pending;
        vndbInvalidBeforeResume = await invoke(feed, malformed);
        expect(vndbInvalidBeforeResume.code).toBe(2);
        vndbPendingAfterInvalid = inspect(feed);
        expect(await effects(ids)).toEqual(beforeEffects);
      }
      const resumed = await invoke(feed, feed.source === 'vndb' ? input(feed.source, 2) : malformed);
      expect(resumed.code, JSON.stringify(resumed)).toBe(0);
      expect(resumed.writes.filter((e) => e.path === '/v1/subjects:batchWrite').map((e) => e.bytes)).toEqual(
        pending.pending.map((row) => row.bytes),
      );
      if (feed.source === 'wikidata') expect(resumed.consumed).toBe(0);
      else {
        expect(resumed.consumed).toBe(input('vndb', 2).length);
        expect(resumed.acquisitions).toEqual([]);
      }
      const drained = inspect(feed);
      expect(drained.active).toBeNull();
      expect(drained.pending).toEqual([]);
      expect(drained.records[0]!.baseline!.recordRevision).toBe(
        String(feed.source === 'vndb' ? 8 : entity.lastrevid + 1),
      );
      if (feed.source === 'vndb') {
        expect(drained.acquisitions).toEqual(
          pending.acquisitions.filter(
            (row) => (row as { materialized_generation: string }).materialized_generation === pending.active!.id,
          ),
        );
        const statistic = await editor.http(`/v1/subjects/${id}/source-statistics`);
        expect(statistic.status).toBe(200);
        expect(statistic.body).toContainEqual(expect.objectContaining({ mean: 7.1, count: 2, licence: 'ODbL-1.0' }));
        expect(interrupted.writes.filter((e) => e.path.endsWith('/source-statistics/vndb'))).toHaveLength(1);
      }
      const afterEffects = await effects(ids);
      expect(afterEffects).toEqual(beforeEffects);
      const originalReceiptRowsAfter = await receipts(receiptKeys);
      const invalidBefore = inspect(feed);
      const invalidFresh = await invoke(feed, malformed);
      expect(invalidFresh.code).toBe(2);
      expect(invalidFresh.captured).toEqual([]);
      const invalidAfter = inspect(feed);
      expect(invalidAfter.source).toEqual(invalidBefore.source);
      expect(invalidAfter.records).toEqual(invalidBefore.records);
      expect(await effects(ids)).toEqual(afterEffects);
      const successor = await invoke(feed, input(feed.source, 2));
      expect(successor.code, JSON.stringify(successor)).toBe(0);
      expect(
        successor.writes.some((e) => JSON.parse(e.bytes)?.commands?.some((c: BatchCommand) => c.op === 'propose')),
      ).toBe(true);
      const final = inspect(feed);
      expect(final.records[0]!.baseline!.recordRevision).toBe(
        String(feed.source === 'vndb' ? 9 : entity.lastrevid + 2),
      );
      expect(final.records[0]!.baseline!.digest).not.toBe(drained.records[0]!.baseline!.digest);
      expect(final.journals.filter((row) => original.journals.some((old) => old.key === row.key))).toEqual(
        original.journals,
      );
      expect(final.media).toEqual(original.media);
      expect(await receipts(receiptKeys)).toEqual(originalReceiptRowsBefore);
      results.push({
        source: feed.source,
        interrupted,
        originalPendingBytes: pending.pending.map((row) => row.bytes),
        originalPendingKeys: pending.pending.flatMap((row) => row.keys),
        resumed,
        resumedBodies: resumed.writes.filter((e) => e.path === '/v1/subjects:batchWrite').map((e) => e.bytes),
        resumedKeys: resumed.writes.filter((e) => e.path === '/v1/subjects:batchWrite').flatMap((e) => e.keys),
        originalReceiptRowsBefore,
        originalReceiptRowsAfter,
        duplicateEffects: afterEffects.filter((row) => !beforeEffects.some((before) => isDeepStrictEqual(row, before))),
        invalidFresh,
        invalidFreshEffects: invalidFresh.writes,
        successor,
        successorFirstEffect: Math.min(...successor.writes.map((e) => e.ordinal)),
        pendingLastEffect: Math.max(...resumed.writes.map((e) => e.ordinal)),
        subjectIdsBefore: ids,
        subjectIdsAfter: await subjectIds(feed),
        independentSelectionBefore,
        independentSelectionAfter: await selection(id, context),
        original,
        pending,
        drained,
        final,
      });
    }
    if (!vndbInvalidBeforeResume || !vndbPendingBeforeInvalid || !vndbPendingAfterInvalid)
      throw new Error('VNDB invalid acquisition was not observed');
    const worker = await runtime.mediaBoundary.capture();
    expect(worker.registrations.some((registration) => registration.name === 'content.importFromUrl')).toBe(true);
    expect(worker.liveInternetRequests).toEqual([]);
    const result = {
      sources: results,
      vndbInvalidBeforeResume,
      vndbInvalidAuthAndWrites: [...vndbInvalidBeforeResume.authPaths, ...vndbInvalidBeforeResume.writes],
      vndbPendingBeforeInvalid,
      vndbPendingAfterInvalid,
      wikidataReplacementBytesReadWhileResuming: results.find((row) => row.source === 'wikidata')!.resumed.consumed,
    };
    console.log(
      JSON.stringify({
        journey: 'cli-sealed-source-resume',
        bundledRelease: bundledRelease.catalogue,
        bundledDigest,
        converterRevisions: sources.map((feed) => ({ source: feed.source, converter: feed.converter })),
        worker,
        ...result,
      }),
    );
    return { ...result, close };
  } catch (error) {
    await close();
    throw error;
  }
}
