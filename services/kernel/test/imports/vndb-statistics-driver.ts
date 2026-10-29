import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { Exchange, Observation, VndbStatisticsDriver } from '../../../../specs/imports-vndb-statistics-driver.ts';
import { readArchive } from '../../../importer/src/archive.ts';
import { DEFAULT_DUMP_CHUNK_BYTES } from '../../../importer/src/dumps-bytes.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, VndbTablesStore } from '../../../importer/src/vndb-tables.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

export const VNDB_API_ORIGIN = 'https://kernel.import.test';
type Receipt = {
  partition_no: number;
  principal_kind: string;
  principal_id: string;
  command_kind: string;
  idempotency_key: string;
  position: string;
  transaction_id: string;
};
type Anchor = { partition: number; kind: string; key: string; subject: string | null };
const identity = (row: Receipt) =>
  JSON.stringify({
    partition_no: row.partition_no,
    principal_kind: row.principal_kind,
    principal_id: row.principal_id,
    command_kind: row.command_kind,
    idempotency_key: row.idempotency_key,
  });

/** HTTP/storage observations shared by the two actual callers, without owning a second server. */
export function captureVndbStatistics(runtime: ApiRuntime) {
  const subjects = new Map<string, string>();
  const anchors = new Map<string, Anchor>();
  const requests = new WeakMap<Exchange, Request>();
  let exchanges: Exchange[] = [];
  let loseResponse = false;

  async function receipt(anchor: Anchor): Promise<Receipt | null> {
    const result = await runtime.database.admin.query<Receipt>(
      `SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key,position::text,transaction_id
       FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind=$3 AND idempotency_key=$4`,
      [anchor.partition, runtime.identity.bulk.accountId, anchor.kind, anchor.key],
    );
    return result.rows[0] ?? null;
  }

  async function dispatch(request: Request): Promise<{ response: Response; exchange: Exchange }> {
    const saved = request.clone();
    const body = request.body === null ? null : await request.clone().text();
    const response = await runtime.replay(request);
    const value: unknown = await response.clone().json();
    const path = new URL(request.url).pathname;
    let committed: Receipt | null = null;
    if (response.status === 200 && path === '/v1/subjects:batchWrite') {
      const input = JSON.parse(body!) as BatchWriteRequest;
      const result = value as BatchWriteResult;
      for (let i = 0; i < input.commands.length; i++) {
        const command = input.commands[i]!;
        const reply = result.results[i]!;
        if (reply.status >= 300) continue;
        let subject: string | null = null;
        if (command.op === 'create' && 'value' in reply && 'id' in reply.value && typeof reply.value.id === 'string') {
          subject = reply.value.id;
          subjects.set(command.source.external_id, subject);
        }
        const route =
          command.op === 'create'
            ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const anchor = {
          partition: partitionOf(route),
          kind: `subject.batch_${command.op}`,
          key: command.key,
          subject,
        };
        const row = await receipt(anchor);
        if (!row) throw new Error('Successful native bulk command has no receipt');
        anchors.set(identity(row), anchor);
      }
    }
    if (response.status === 200 && request.method === 'PUT' && path.endsWith('/source-statistics/vndb')) {
      const subject = path.split('/')[3]!;
      if (![...subjects.values()].includes(subject))
        throw new Error('Statistic subject was not resolved by public bulk');
      const key: unknown = JSON.parse(request.headers.get('idempotency-key')!);
      if (typeof key !== 'string') throw new Error('Missing native statistic key');
      const anchor = { partition: partitionOf(routeOf(subject)!), kind: 'rating.source_statistic.write', key, subject };
      committed = await receipt(anchor);
      if (!committed) throw new Error('Successful native statistic command has no receipt');
      anchors.set(identity(committed), anchor);
    }
    const exchange: Exchange = {
      method: request.method,
      path,
      authorization: request.headers.get('authorization'),
      idempotencyKey: request.headers.get('idempotency-key'),
      body,
      status: response.status,
      response: value,
      receipt: committed ? identity(committed) : null,
      responseLost: false,
    };
    requests.set(exchange, saved);
    exchanges.push(exchange);
    return { response, exchange };
  }

  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { response, exchange } = await dispatch(request);
    if (loseResponse && exchange.receipt !== null) {
      loseResponse = false;
      exchange.responseLost = true;
      // Handler and exact receipt observation completed before normal bounded HTTP retry.
      throw new TypeError('Committed statistic response lost at HTTP boundary');
    }
    return response;
  }) as typeof globalThis.fetch;

  return {
    fetch,
    begin(loss = false) {
      exchanges = [];
      loseResponse = loss;
      return exchanges;
    },
    async replay(exchange: Exchange) {
      const original = requests.get(exchange);
      if (!original) throw new Error('Replay requires an actual captured request');
      return (await dispatch(original.clone())).exchange;
    },
    async bulkReceipts() {
      const rows: string[] = [];
      for (const anchor of anchors.values()) {
        if (!anchor.kind.startsWith('subject.batch_')) continue;
        const row = await receipt(anchor);
        if (!row) throw new Error('Native bulk receipt disappeared');
        rows.push(identity(row));
      }
      return rows.sort();
    },
    async observe(baseline: Observation['baseline']): Promise<Observation> {
      const subjectId = subjects.get('v123') ?? null;
      let current: Observation['current'] = null;
      let currentRequest: Observation['currentRequest'] = null;
      if (subjectId) {
        const path = `/v1/subjects/${subjectId}/source-statistics`;
        const request = new Request(new URL(path, VNDB_API_ORIGIN));
        const { response, exchange } = await dispatch(request);
        currentRequest = { method: exchange.method, path: exchange.path, authorization: exchange.authorization };
        current = { status: response.status, body: exchange.response };
      }
      const storage: Observation['storage'] = {
        statistics: [],
        statisticTransactions: [],
        statisticEvents: [],
        statisticReceipts: [],
        nativeVoteRows: 0,
      };
      for (const subject of [...new Set(subjects.values())].sort()) {
        const route = routeOf(subject)!;
        const rows = await runtime.database.admin.query<{
          source: 'vndb';
          source_record_id: string;
          scale_min: number;
          scale_max: number;
          mean: string;
          count: number;
          as_of: string;
          licence: string;
          attribution: string;
          transaction_id: string;
        }>(
          `SELECT source,source_record_id,scale_min,scale_max,mean::text,count,as_of::text,licence,attribution,transaction_id
            FROM rating.source_statistic WHERE route=$1 AND subject_id=$2 AND source='vndb'`,
          [route, subject],
        );
        for (const row of rows.rows) {
          storage.statistics.push({
            source: row.source,
            sourceRecordId: row.source_record_id,
            scale: { min: row.scale_min, max: row.scale_max },
            mean: Number(row.mean),
            count: row.count,
            asOf: row.as_of,
            licence: row.licence,
            attribution: row.attribution,
          });
          storage.statisticTransactions.push(row.transaction_id);
        }
        const votes = await runtime.database.admin.query(
          'SELECT question_id FROM rating.vote WHERE route=$1 AND voter_id=$2 AND target_id=$3',
          [routeOf(runtime.identity.bulk.accountId), runtime.identity.bulk.accountId, subject],
        );
        storage.nativeVoteRows += votes.rows.length;
      }
      for (const [key, anchor] of anchors) {
        if (anchor.kind !== 'rating.source_statistic.write') continue;
        const row = await receipt(anchor);
        if (!row || identity(row) !== key) throw new Error('Native statistic receipt disappeared');
        storage.statisticReceipts.push(identity(row));
        const events = await runtime.database.admin.query<{ id: string }>(
          `SELECT id FROM core.outbox WHERE partition_no=$1 AND position=$2 AND subject=$3
           AND type='com.rezics.rating.source_statistic.changed.v1' ORDER BY event_seq`,
          [anchor.partition, row.position, anchor.subject],
        );
        storage.statisticEvents.push(...events.rows.map((event) => event.id));
      }
      storage.statisticReceipts.sort();
      storage.statisticEvents.sort();
      storage.statisticTransactions.sort();
      return { subjectId, current, currentRequest, storage, baseline };
    },
  };
}

export async function createVndbStatisticsDriver(): Promise<VndbStatisticsDriver> {
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
    sourceStatistics: 'vndb',
  });
  let directory: string | undefined;
  let importer: Importer | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await importer?.close();
      } finally {
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
          await runtime.close();
        }
      }
    })());
  try {
    directory = await mkdtemp(join(tmpdir(), 'vndb-statistics-'));
    const path = join(directory, 'import.sqlite');
    const capture = captureVndbStatistics(runtime);
    const registration = createSourceRegistration('vndb');
    const support = identitySupport(runtime.identity);
    let credential = runtime.identity.bulk;
    const transport = createImportTransport({
      origin: VNDB_API_ORIGIN,
      tokenProvider: async () => credential.bearer,
      fetch: capture.fetch,
    });
    const open = () =>
      new Importer({
        path,
        transport: {
          batchWrite: (request) => transport.batch(request),
          readFence: (tuple) =>
            transport.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
          writeSourceStatistic: (input, signal) => transport.writeSourceStatistic(input, signal),
        },
      });
    importer = open();
    return {
      identity: runtime.identity,
      issue: (scopes) => support.issue(runtime.identity.bulk.accountId, scopes),
      setStatisticGrant: (enabled) => support.setStatisticGrant(enabled),
      async run(input, options = {}) {
        credential = options.credential ?? runtime.identity.bulk;
        const exchanges = capture.begin(options.loseStatisticResponse);
        const sourceRecords: Awaited<ReturnType<VndbStatisticsDriver['run']>>['sourceRecords'] = [];
        const tables = new VndbTablesStore(importer!.session.store.database);
        const acquisition = randomUUID();
        await tables.begin(registration.source, acquisition);
        try {
          await tables.stage(
            registration.source,
            acquisition,
            readArchive(input, {
              maxTotalBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
              maxChunkBytes: DEFAULT_DUMP_CHUNK_BYTES,
              maxMetadataBytes: 4096,
            }),
          );
        } catch {
          return { outcome: 'invalid-dump', exchanges, sourceRecords };
        }
        async function* records(): AsyncGenerator<SourceRecord> {
          let after: string | null = null;
          for (;;) {
            const page = tables.page(registration.source, acquisition, { after, limit: 16 });
            for (const row of page.records) {
              sourceRecords.push({
                key: row.key,
                revision: row.revision,
                average: row.record.vn.c_average,
                count: row.record.vn.c_votecount,
              });
              yield { source: 'vndb', key: row.key, revision: String(row.revision), payload: row.record };
            }
            if (page.next === null) return;
            after = page.next;
          }
        }
        const result = await importer!.runRecords(registration, records(), {
          ...(options.disappearanceThreshold === undefined
            ? {}
            : { disappearanceThreshold: options.disappearanceThreshold }),
        });
        if (result.status === 'committed' || result.status === 'invalid-dump' || result.status === 'mass-disappearance')
          return { outcome: result.status, exchanges, sourceRecords };
        if (exchanges.some((exchange) => exchange.status === 403))
          return { outcome: 'denied', exchanges, sourceRecords };
        throw new Error(`Native VNDB import failed: ${JSON.stringify({ result, exchanges })}`);
      },
      observe() {
        const source = importer!.session.store.source(registration.source);
        // The maintained complete-generation pointer is RunStore's source fingerprint.
        return capture.observe({ fingerprint: source.generation, records: source.count });
      },
      replay: capture.replay,
      async reopen() {
        await importer!.close();
        importer = open();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
