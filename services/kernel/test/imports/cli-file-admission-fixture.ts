import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { SourceId } from '@rezics/conversion';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { runImportCli } from '../../../importer/src/cli.ts';
import { DEFAULT_DUMP_CHUNK_BYTES, DEFAULT_DUMP_RECORD_BYTES } from '../../../importer/src/dumps-bytes.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import type { Seal } from '../../../importer/src/run-store.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

const encoder = new TextEncoder();
const fixture = (path: string) =>
  readFileSync(new URL(`../../../../specs/fixtures/imports/${path}`, import.meta.url), 'utf8');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sources = ['bangumi', 'openlibrary', 'vndb', 'wikidata'] as const;

/** Synthetic ustar envelope around the unchanged pinned COPY-text tables. No SQL is parsed. */
function member(path: string, bytes: Uint8Array) {
  const header = new Uint8Array(512);
  const put = (offset: number, text: string) => header.set(encoder.encode(text), offset);
  put(0, path);
  for (const offset of [100, 108, 116]) put(offset, '0000644\0');
  put(124, bytes.length.toString(8).padStart(11, '0') + '\0');
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
  return Buffer.concat([header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512)]);
}
function archive(successor = false, extra?: string) {
  const parts: Uint8Array[] = [];
  // Ignored zero bytes move the title table across a real descriptor read boundary.
  // They contain neither post text nor executable SQL.
  parts.push(member('padding', new Uint8Array(DEFAULT_DUMP_CHUNK_BYTES - 2048)));
  for (const name of ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta']) {
    let text = fixture(`vndb-tables/db/${name}`);
    if (successor && name === 'vn_titles') text = text.replace('Sentinel Harbor', 'Successor Harbor');
    parts.push(member(`db/${name}`, encoder.encode(text)));
  }
  if (extra) parts.push(member(extra, new Uint8Array(0)));
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

function scalar(source: Exclude<SourceId, 'vndb'>, successor = false) {
  let lines: string[];
  if (source === 'bangumi') {
    // These pinned public catalogue records have no user/account fields.
    const records = fixture('api/bangumi.jsonl')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    records[1].name = successor ? 'Successor 🌙' : 'Boundary 🌙';
    lines = records.map((record) => JSON.stringify(record));
  } else if (source === 'openlibrary') {
    // Explicit bibliographic projection; never retain private fields or user posts.
    const work = { type: { key: '/type/work' }, key: '/works/OL900000001W', revision: 7, title: 'The Glass Atlas' };
    const edition = {
      type: { key: '/type/edition' },
      key: '/books/OL900000002M',
      revision: successor ? 12 : 11,
      title: successor ? 'Successor 🌙' : 'Boundary 🌙',
      last_modified: { type: '/type/datetime', value: '2025-01-02T03:04:05.123456' },
      works: [{ key: work.key }],
    };
    lines = [work, edition].map((r) =>
      [r.type.key, r.key, r.revision, '2025-01-02T03:04:05.123456', JSON.stringify(r)].join('\t'),
    );
  } else {
    const pinned = JSON.parse(fixture('api/wikidata.jsonl').trimEnd().split('\n')[0]!);
    const record = {
      type: pinned.type,
      id: pinned.id,
      lastrevid: pinned.lastrevid,
      labels: pinned.labels,
      claims: { P31: pinned.claims.P31 },
      aliases: {},
      descriptions: {},
      sitelinks: {},
    };
    const other = {
      ...record,
      id: 'Q572',
      lastrevid: successor ? 24681013 : 24681012,
      labels: { en: { language: 'en', value: successor ? 'Successor 🌙' : 'Boundary 🌙' } },
    };
    lines = [record, other].map((r) => JSON.stringify(r));
  }
  const prefix = source === 'wikidata' ? '[\n' : '';
  const comma = source === 'wikidata' ? ',' : '';
  const second = lines[1]!;
  const emoji = Buffer.byteLength(second.slice(0, second.indexOf('🌙')));
  // Put the first byte of a four-byte scalar at the last byte of the descriptor chunk.
  const padding = DEFAULT_DUMP_CHUNK_BYTES - 1 - emoji - Buffer.byteLength(prefix + lines[0] + comma + '\n');
  expect(padding).toBeGreaterThan(0);
  const text =
    prefix + lines[0] + comma + ' '.repeat(padding) + '\n' + second + '\n' + (source === 'wikidata' ? ']\n' : '');
  const bytes = encoder.encode(text);
  expect(bytes[DEFAULT_DUMP_CHUNK_BYTES - 1]).toBe(0xf0);
  return { bytes, lines };
}

type Exchange = { source: SourceId; path: string; method: string; bytes: string; status: number; response: string };
type Anchor = { source: SourceId; partition: number; kind: string; key: string };

/** One native application/Auth/worker world, with observation only at the documented CLI boundaries. */
export async function runCliFileAdmissionJourney() {
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
    directory = await mkdtemp('/dev/shm/import-file-admission-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { mode: 0o600, flag: 'wx' });
    const native = identitySupport(runtime.identity);
    const editor = await openApiObserver(runtime);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
      flag: 'wx',
    });
    const api = 'https://kernel.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const authRequests: { path: string; status: number }[] = [];
    const anchors = new Map<string, Anchor>();
    const commands = new Map<string, BatchCommand>();
    const subjects = new Map<string, { source: SourceId; id: string }>();
    const mediaIds = new Set<string>();
    const evidence: unknown[] = [];
    const evidencePath = join(import.meta.dir, '../../../../.temp/cli-file-admission.json');
    await mkdir(join(import.meta.dir, '../../../../.temp'), { recursive: true });

    async function receipts() {
      const rows = [];
      for (const anchor of anchors.values()) {
        const result = await runtime.database.admin.query(
          'SELECT * FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [anchor.partition, 'account', runtime.identity.bulk.accountId, anchor.kind, anchor.key],
        );
        expect(result.rows.length).toBe(1);
        rows.push({ anchor, rows: result.rows });
      }
      return rows;
    }
    function baseline() {
      const session = new ImportSession(state);
      try {
        return sources.map((source) => {
          const current = session.store.source(source);
          return {
            source,
            ...current,
            records:
              current.generation === null
                ? []
                : session.store.database
                    .query(
                      'SELECT record_key,row_json,projection_json,bytes,keys_json FROM run_entries WHERE source=? AND run_id=? ORDER BY record_key LIMIT 16',
                    )
                    .all(source, current.generation),
            journal: session.store.database
              .query('SELECT * FROM binding_journal WHERE source=? ORDER BY external_id,key LIMIT 100')
              .all(source),
          };
        });
      } finally {
        session.close();
      }
    }
    async function objects() {
      const rows = [];
      for (const { source, id } of subjects.values()) {
        const response = await editor.http(`/v1/subjects/${id}`);
        expect(response.status).toBe(200);
        const candidates = await runtime.database.admin.query(
          'SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
          [routeOf(id), id],
        );
        rows.push({
          source,
          id,
          response: { status: response.status, body: response.body },
          candidates: candidates.rows,
        });
      }
      const media = [];
      for (const id of mediaIds) media.push(await runtime.mediaBoundary.observe(id));
      return { subjects: rows, media };
    }
    async function invoke(source: SourceId, label: string, bytes: Uint8Array) {
      const dump = join(directory!, `${source}.dump`);
      await writeFile(dump, bytes, { mode: 0o600 });
      const start = exchanges.length,
        authStart = authRequests.length;
      const seals: { complete: boolean; result: Seal }[] = [];
      const chunks: { bytes: number; backing: number }[] = [];
      const registrations: {
        source: string;
        sourceKind: SourceId;
        converter: string;
        converterModule: string;
        decoderModule: string;
      }[] = [];
      let passes = 0;
      let database: ImportSession['store']['database'] | undefined;
      const result = await runImportCli(
        [
          '--source',
          source,
          '--dump',
          dump,
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
          observer: {
            onInputPass(kind) {
              expect(kind).toBe('dump');
              passes++;
            },
            onInputChunk(_kind, bytes, backing) {
              chunks.push({ bytes, backing });
              expect(backing).toBe(bytes);
            },
            onAccountKey(path, observation) {
              expect(path).toBe(keyPath);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onCoordinator({ importer, registration, converterModule, decoderModule }) {
              database = importer.session.store.database;
              registrations.push({
                source: registration.source,
                sourceKind: registration.sourceKind,
                converter: registration.converter_revision,
                converterModule,
                decoderModule,
              });
              const store = importer.session.store,
                seal = store.seal.bind(store);
              store.seal = (run, input) => {
                const result = seal(run, input);
                seals.push({ complete: input.complete, result });
                return result;
              };
            },
            onVndbStore({ importer }) {
              database = importer.session.store.database;
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === auth) {
              expect(seals.some((s) => s.complete && s.result.status === 'ready')).toBe(true);
              const response = await native.host.service.handler(request);
              authRequests.push({ path: url.pathname, status: response.status });
              return response;
            }
            expect(url.origin).toBe(api);
            expect(seals.some((s) => s.complete && s.result.status === 'ready')).toBe(true);
            // Drain actual registered jobs before the CLI's ordinary reservation GET.
            const status = /^\/v1\/media\/([^/]+):importStatus$/.exec(url.pathname);
            if (status)
              await runtime.mediaBoundary.drain({
                mediaIds: [status[1]!],
                maxJobs: 16,
                signal: new AbortController().signal,
              });
            const body = request.body === null ? '' : await request.clone().text();
            const response = await runtime.replay(request);
            const reply = await response.clone().text();
            exchanges.push({
              source,
              path: url.pathname,
              method: request.method,
              bytes: body,
              status: response.status,
              response: reply,
            });
            if (url.pathname === '/v1/subjects:batchWrite' && response.status === 200) {
              const batch = JSON.parse(body) as BatchWriteRequest;
              const answers = JSON.parse(reply) as BatchWriteResult;
              for (let index = 0; index < batch.commands.length; index++) {
                const command = batch.commands[index]!,
                  answer = answers.results[index]!;
                expect(answer.status, JSON.stringify(answer)).toBeLessThan(300);
                const prior = commands.get(command.key);
                if (prior) expect(command).toEqual(prior);
                commands.set(command.key, command);
                const route =
                  command.op === 'create'
                    ? tupleRoute(runtime.identity.routeKey, source, command.source.external_id)
                    : routeOf(command.subject)!;
                anchors.set(command.key, {
                  source,
                  partition: partitionOf(route),
                  kind: `subject.batch_${command.op}`,
                  key: command.key,
                });
                if (command.op === 'create' && 'value' in answer && 'id' in answer.value)
                  subjects.set(`${source}:${command.source.external_id}`, { source, id: answer.value.id });
              }
            }
            if (
              request.method === 'PUT' &&
              url.pathname.endsWith('/source-statistics/vndb') &&
              response.status === 200
            ) {
              const id = url.pathname.split('/')[3]!;
              const key = JSON.parse(request.headers.get('idempotency-key')!) as string;
              anchors.set(key, {
                source,
                partition: partitionOf(routeOf(id)!),
                kind: 'rating.source_statistic.write',
                key,
              });
            }
            if (url.pathname === '/v1/media:importFromUrl' && response.status === 202) {
              const id = (JSON.parse(reply) as { media: { id: string } }).media.id;
              mediaIds.add(id);
              const key = JSON.parse(request.headers.get('idempotency-key')!) as string;
              anchors.set(key, {
                source,
                partition: partitionOf(routeOf(id)!),
                kind: 'content.media.importFromUrl',
                key,
              });
            }
            return response;
          }) as typeof fetch,
        },
      );
      if (database) expect(() => database!.query('SELECT 1').get()).toThrow();
      expect(passes).toBe(1);
      expect(result.openHandles).toBe(0);
      if (result.code === 0) expect(chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBe(bytes.length);
      const observation = {
        ...result,
        passes,
        chunks,
        seals,
        registrations,
        authRequests: authRequests.slice(authStart),
        exchanges: exchanges.slice(start),
      };
      evidence.push({ source, label, inputBytes: bytes.length, inputDigest: digest(bytes), ...observation });
      await writeFile(
        evidencePath,
        JSON.stringify(
          { bundle: { release: bundledRelease.catalogue, digest: bundledDigest }, invocations: evidence },
          null,
          2,
        ),
      );
      return observation;
    }
    const results = [];
    for (const source of sources) {
      const input = source === 'vndb' ? archive() : scalar(source).bytes;
      const initial = await invoke(source, 'initial', input);
      expect(initial.code, JSON.stringify(initial)).toBe(0);
      const nativeReceiptRows = (await receipts()).filter((row) => row.anchor.source === source);
      expect(nativeReceiptRows.length).toBeGreaterThan(0);
      const initialObjects = await objects();
      const invalids =
        source === 'vndb'
          ? [input.subarray(0, input.length - 700), archive(false, '../escape'), archive(false, 'db/vn')]
          : [
              encoder.encode('{' + '\n'),
              input.subarray(0, input.length - 7),
              encoder.encode(scalar(source).lines[0] + '\n' + scalar(source).lines[0] + '\n'),
              encoder.encode('x'.repeat(DEFAULT_DUMP_RECORD_BYTES + 1) + '\n'),
            ];
      const rejected = [];
      for (let index = 0; index < invalids.length; index++) {
        const baselineBefore = baseline(),
          receiptRowsBefore = await receipts(),
          objectsBefore = await objects();
        const outcome = await invoke(source, `rejected-${index}`, invalids[index]!);
        const baselineAfter = baseline(),
          receiptRowsAfter = await receipts(),
          objectsAfter = await objects();
        expect(objectsAfter).toEqual(objectsBefore);
        rejected.push({
          ...outcome,
          publicWrites: outcome.exchanges.filter((e) => !['GET', 'HEAD'].includes(e.method)),
          baselineBefore,
          baselineAfter,
          receiptRowsBefore,
          receiptRowsAfter,
        });
      }
      const acceptedSuccessor = await invoke(
        source,
        'successor',
        source === 'vndb' ? archive(true) : scalar(source, true).bytes,
      );
      const final = baseline().find((row) => row.source === source)!;
      const projection = final.records[0] as { projection_json: string };
      const sourceKindAfter = (JSON.parse(projection.projection_json) as { sourceKind: SourceId }).sourceKind;
      results.push({
        source: initial.registrations[0]!.sourceKind,
        initial,
        actualInputPasses: initial.passes,
        nativeReceiptRows,
        initialObjects,
        rejected,
        acceptedSuccessor,
        sourceKindAfter,
      });
    }
    const userPostOrDumpSqlEffects = exchanges.filter((e) => /\/posts(?:\/|$)|\/sql(?:\/|$)/u.test(e.path));
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          bundle: { release: bundledRelease.catalogue, digest: bundledDigest },
          invocations: evidence,
          receipts: await receipts(),
          objects: await objects(),
          media: await runtime.mediaBoundary.capture(),
        },
        null,
        2,
      ),
    );
    return { sources: results, userPostOrDumpSqlEffects, close };
  } catch (error) {
    await close();
    throw error;
  }
}
