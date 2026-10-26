import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchReference } from '@rezics/definitions/bulk';
import type {
  ImportedFieldDriver,
  Contribution,
  Field,
  ImageInput,
  FetchCase,
  Media,
  Persona,
  Provenance,
  Trace,
  Tuple,
} from '../../../../specs/imported-field-driver.ts';
import { createNativeContentSystem } from './support/native-system.ts';
import { observeSql, type SqlExecution, type SqlObserver } from './support/sql-observer.ts';
import {
  createObjectStore,
  createSourceServer,
  startNativeWorker,
  MAX_SOURCE_BYTES,
  type ObjectStore,
  type SourceServer,
  type SourceKind,
  type WorkerProcess,
} from './support/imported-field-fixtures.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import insertProposalRevision from '../../src/semantic/candidates-insert-proposal-revision.sql';
import { slotId } from '../../src/semantic/slots.ts';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { assertGrowth, measure, openGrowthDatabase, seed, type Cost, type Population } from '../support/growth.ts';
import { transformImage } from '../../src/content/image-transform.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import permissionCheckStatement from '../../src/access/permission-check.sql';

const HASH = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceRevisionInsert = insertProposalRevision.sql;
const permissionCheck = permissionCheckStatement.sql;
const control = new AsyncLocalStorage<string>();
type ActorCredential = { bearer: string; actor: AccountActor };
type RequestSpan = { start: number; end: number; method: string; path: string; body?: unknown };
type RecordedAuthorization = Trace['authorization'][number];

function decodeJson(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  throw new Error('Native PostgreSQL did not return document bytea');
}
function urlReference(url: string): BatchReference {
  return {
    parts: [
      {
        property: { id: 'schema:url' },
        value: { type: 'value', content: url },
      },
    ],
  } as BatchReference;
}
function sourceRecord(provenance: Provenance, fieldGroup = provenance.fieldGroup) {
  return {
    source: provenance.source,
    external_id: provenance.externalId,
    record_revision: provenance.recordRevision,
    digest: provenance.digest,
    converter_revision: provenance.converterRevision,
    field_group: fieldGroup,
  };
}
function parseReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const reference of value) {
    const parts = reference && typeof reference === 'object' ? (reference as Record<string, unknown>).parts : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const snak = part as Record<string, unknown>;
      const property =
        snak.property && typeof snak.property === 'object' ? (snak.property as Record<string, unknown>).id : undefined;
      const valueNode =
        snak.value && typeof snak.value === 'object' ? (snak.value as Record<string, unknown>) : undefined;
      if (property === 'schema:url' && valueNode?.type === 'value' && typeof valueNode.content === 'string')
        urls.push(valueNode.content);
    }
  }
  return urls;
}
function importedProvenance(source: unknown, rights: unknown): Provenance {
  const src = decodeJson(source);
  const right = decodeJson(rights);
  return {
    source: String(src.source),
    externalId: String(src.external_id),
    fieldGroup: String(src.field_group),
    recordRevision: String(src.record_revision),
    digest: String(src.digest),
    converterRevision: String(src.converter_revision),
    references: parseReferences(src.references),
    rights: {
      spdx: String(right.license),
      obligations: Array.isArray(right.obligations) ? right.obligations.map(String) : [],
      attribution: String(right.attribution),
    },
  };
}
function fenceTuples(records: readonly SqlExecution[]): Tuple[] {
  const result: Tuple[] = [];
  for (const entry of records) {
    if (!/content\.source_fences/i.test(entry.statement)) continue;
    for (const parameter of entry.parameters) {
      if (typeof parameter !== 'string' || !parameter.startsWith('[')) continue;
      let requested: unknown;
      try {
        requested = JSON.parse(parameter);
      } catch {
        continue;
      }
      if (!Array.isArray(requested)) continue;
      for (const value of requested) {
        const row = decodeJson(value);
        if (
          typeof row.source === 'string' &&
          typeof row.external_id === 'string' &&
          typeof row.field_group === 'string'
        )
          result.push({ source: row.source, externalId: row.external_id, fieldGroup: row.field_group });
      }
    }
  }
  return result;
}
function canonicalTime(value: string | undefined): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}
function transactionTime(time: AuthoritativeTime | undefined): string | null {
  if (time === undefined) return null;
  return authoritativeTimeValue(time);
}
function publicReferenceUrl(provenance: Provenance): string {
  const url = provenance.references[0];
  if (!url) throw new Error('Imported source is missing its cited URL');
  return url;
}
function requestKey(): string {
  return randomUUID();
}

function growthExternalIds(routeKey: Uint8Array, source: string, partition: number, count: number): string[] {
  const ids: string[] = [];
  for (let candidate = 0; ids.length < count; candidate++) {
    const externalId = `seed-${candidate}`;
    if (partitionOf(tupleRoute(routeKey, source, externalId)) === partition) ids.push(externalId);
  }
  return ids;
}

export async function createImportedFieldDriver(): Promise<ImportedFieldDriver> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const native = await createNativeContentSystem({ databaseUrl });
  let observer: SqlObserver | undefined;
  let store: ObjectStore | undefined;
  let sources: SourceServer | undefined;
  let worker: WorkerProcess | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const spans = new Map<string, RequestSpan>();
  const authorization = new Map<string, RecordedAuthorization[]>();
  const fenceChecks = new Map<string, Trace['fenceChecks']>();
  let commandTime = new Date();
  const refreshFields = new Map<string, Field>();
  const refreshTuples = new Map<string, Tuple>();
  const mediaByKey = new Map<string, string>();
  const mediaInputs = new Map<string, ImageInput>();
  const knownDocuments = new Set<string>();
  const fixtureKeys = new Set<string>();
  const API_BASE = 'https://content.test';
  let importer: ActorCredential;
  let governance: ActorCredential;
  let operator: ActorCredential;
  let container = { id: '', route: 0, partition: 0 };
  let importerCredential = native.actors.other;
  let restartedAfterPurgeFailure = false;
  let workerOptions: Parameters<typeof startNativeWorker>[0];

  const close = () =>
    (closing ??= (async () => {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      const release = async (action: () => Promise<unknown> | unknown) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      const ownedWorker = worker;
      worker = undefined;
      await release(async () => {
        if (!ownedWorker) return;
        try {
          await ownedWorker.stop();
        } catch (error) {
          await ownedWorker.kill();
          throw error;
        }
      });
      await release(async () => observer?.close());
      await release(() => sources?.close());
      await release(() => store?.close());
      await release(async () => native.close());
      if (failures.length) throw new AggregateError(failures, 'Imported field driver cleanup failed');
    })());

  try {
    const pool = native.database.pool;
    const authPool = native.database.authPool;
    await setupSemantic(pool, bundledRelease);
    const sourceServer = await createSourceServer();
    const objectStore = createObjectStore();
    sources = sourceServer;
    store = objectStore;

    const currentRequest = control;
    const baseAccess: Access = native.access;
    const authorize = baseAccess.authorize.bind(baseAccess);
    const tracedAccess = deriveAccess(baseAccess, {
      authorize: async (client, actor, action, resource, evidence, time) => {
        const decision = await authorize(client, actor, action, resource, evidence, time);
        const key = currentRequest.getStore();
        if (key) {
          const list = authorization.get(key) ?? [];
          list.push({
            action,
            anchor: JSON.stringify({ route: resource.route, id: resource.id }),
            at: canonicalTime(transactionTime(time) ?? commandTime.toISOString()),
            allowed: decision,
          });
          authorization.set(key, list);
        }
        return decision;
      },
    });
    const roleCatalogue = resourceRoleCatalogue(baseAccess);
    if (roleCatalogue) installResourceRoleCatalogue(tracedAccess, roleCatalogue);
    const kernel = createKernel({
      pool,
      routeKey: native.routeKey,
      tokens: native.tokenKeys,
      clock: () => new Date(commandTime),
      access: () => tracedAccess,
      writeRate: createWriteRateLimiter({
        secret: `${randomUUID()}${randomUUID()}`,
        overrides: JSON.stringify({
          'new-account': {
            write: { maximum: 100_000, seconds: 60 },
            upload: { maximum: 100_000, seconds: 60 },
          },
        }),
      }),
      ratePeer: () => '127.0.0.1',
      content: { fetchConfig: { allowedHosts: ['images.example.test'] }, cursorNow: () => Date.now() },
    });
    const actions = actionCatalogue(kernel);
    const governanceId = String(
      (await pool.query<{ account_id: string }>('SELECT account_id FROM access.governance_bootstrap WHERE route = 0'))
        .rows[0]?.account_id ?? '',
    );
    if (!governanceId) throw new Error('Operator governance bootstrap did not create the Global Context authority');
    operator = await native.auth.issue({
      accountId: governanceId,
      clientId: native.auth.ordinaryClient.id,
      scopes: [...actions.keys()].filter((action) => action !== 'media:complete').sort(),
    });
    importer = importerCredential;
    governance = await native.auth.issue({
      accountId: native.actors.moderator.actor.accountId,
      clientId: native.actors.moderator.actor.clientId,
      scopes: [...actions.keys()].filter((action) => action !== 'media:complete').sort(),
    });

    const grant = async (credential: ActorCredential, subjectId: string, actionsToGrant: readonly string[]) => {
      const key = requestKey();
      const body = {
        resource: { route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id },
        subject: { kind: 'account', id: subjectId },
        actions: [...new Set(actionsToGrant)].sort(),
        valid: '(,)',
      };
      const response = await callRaw(credential, 'POST', '/v1/grants', body, key);
      if (response.status !== 201)
        throw new Error(
          `Native public grant API failed (${response.status}): ${JSON.stringify(response.body)}; authorizations=${JSON.stringify(authorization.get(key) ?? [])}`,
        );
    };
    await grant(operator, importer.actor.accountId, [
      'subject:batch_write',
      'statement:propose',
      'source_fence:read',
      'media:import_from_url',
    ]);
    await grant(operator, governance.actor.accountId, [
      'subject:batch_write',
      'subject:merge',
      'statement:propose',
      'context:accept',
      'context:adopt',
      'moderation:hide',
      'moderation:takedown',
      'source_fence:read',
      'source_fence:takedown',
    ]);

    const importedSummaryRoute = tupleRoute(native.routeKey, 'bangumi', '42');
    let seedExternalId = '';
    for (let candidate = 0; candidate < 1024; candidate++) {
      const externalId = `subject-${candidate}`;
      const route = tupleRoute(native.routeKey, 'subjectseed', externalId);
      if (partitionOf(route) !== partitionOf(importedSummaryRoute)) {
        seedExternalId = externalId;
        break;
      }
    }
    if (!seedExternalId) throw new Error('Could not anchor the portable subject apart from its imported tuple');
    const created = await batch(importer, [
      {
        op: 'create',
        key: requestKey(),
        source: {
          source: 'subjectseed',
          external_id: seedExternalId,
          record_revision: 'unversioned',
          digest: '0'.repeat(64),
          converter_revision: 'seed-v1',
          field_group: 'facts',
        },
        subject: { type: 'schema:Book', labels: { en: 'Imported field fixture' } },
      },
    ]);
    const initial = decodeJson(Array.isArray(created.body.results) ? created.body.results[0] : undefined);
    const initialValue = decodeJson(initial.value);
    const subjectId = typeof initialValue.id === 'string' ? initialValue.id : '';
    const route = routeOf(subjectId);
    if (created.status !== 200 || initial.status !== 201 || !subjectId || route === null)
      throw new Error(`Portable subject seed failed through Kernel API: ${JSON.stringify(created.body)}`);
    container = { id: subjectId, route, partition: partitionOf(route) };
    observer = observeSql(pool);

    const appName = String((await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name);
    const authName = String(
      (await authPool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name,
    );
    const appUrl = new URL(databaseUrl);
    appUrl.pathname = `/${appName}`;
    const authUrl = new URL(databaseUrl);
    authUrl.pathname = `/${authName}`;
    workerOptions = {
      databaseUrl: appUrl.href,
      authDatabaseUrl: authUrl.href,
      executorId: `imported-field-${appName}`,
      storageEndpoint: objectStore.endpoint,
      sourceEndpoint: sourceServer.endpoint,
      routeKey: native.routeKey,
      partition: container.partition,
    };
    worker = await startNativeWorker(workerOptions);

    async function callRaw(
      credential: ActorCredential | undefined,
      method: string,
      path: string,
      body?: unknown,
      key?: string,
      headersExtra: Record<string, string> = {},
      traceKeyOverride?: string,
    ) {
      const traceKey = traceKeyOverride ?? key ?? requestKey();
      const headers = new Headers(headersExtra);
      if (credential) headers.set('authorization', `Bearer ${credential.bearer}`);
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (key !== undefined) headers.set('idempotency-key', JSON.stringify(key));
      const response = await currentRequest.run(traceKey, async () => {
        const start = observer?.records.length ?? 0;
        const result = await kernel.handle(
          new Request(`${API_BASE}${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        const end = observer?.records.length ?? start;
        spans.set(traceKey, { start, end, method, path, ...(body === undefined ? {} : { body }) });
        const text = await result.text();
        let payload: unknown = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = text;
          }
        }
        return { status: result.status, body: payload, headers: result.headers };
      });
      return response;
    }

    function credentialFor(as: Persona): ActorCredential | undefined {
      if (as === 'anonymous') return undefined;
      if (as === 'account') return native.actors.author;
      if (as === 'importer') return importer;
      return governance;
    }

    async function batch(credential: ActorCredential, commands: unknown[]) {
      const firstKey = decodeJson(commands[0]).key;
      const result = await callRaw(
        credential,
        'POST',
        '/v1/subjects:batchWrite',
        { commands },
        undefined,
        {},
        typeof firstKey === 'string' ? firstKey : undefined,
      );
      return { status: result.status, body: decodeJson(result.body) };
    }

    async function receipt(key: string, route: number, principalId: string, commandKind?: string) {
      const parameters: unknown[] = [partitionOf(route), principalId, key];
      const filter = commandKind ? 'AND command_kind = $4' : '';
      if (commandKind) parameters.push(commandKind);
      const result = await pool.query<{
        transaction_id: string;
        response: unknown;
        partition_no: number;
        position: string;
      }>(
        `SELECT partition_no, transaction_id::text, response, position::text FROM core.receipt
         WHERE partition_no = $1 AND principal_kind = 'account' AND principal_id = $2 AND idempotency_key = $3 ${filter}
         ORDER BY position DESC LIMIT 1`,
        parameters,
      );
      return result.rows[0] ?? null;
    }

    const subject = { id: subjectId, partition: container.partition };
    const stopWorker = async () => {
      if (!worker) return;
      const active = worker;
      worker = undefined;
      await active.stop();
    };
    const ensureWorker = async () => {
      if (!worker) worker = await startNativeWorker(workerOptions);
    };
    const importedDriver: ImportedFieldDriver = {
      importerId: importer.actor.accountId,
      platformResource: JSON.stringify({ route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id }),
      subject,
      async setTime(at) {
        commandTime = new Date(at);
      },
      async refresh(as, field, key, untrusted) {
        refreshFields.set(key, field);
        refreshTuples.set(key, { source: field.source, externalId: field.externalId, fieldGroup: field.fieldGroup });
        const command: Record<string, unknown> = {
          op: 'propose',
          key,
          source: sourceRecord(field),
          subject: field.subjectId,
          statement: {
            property: { id: 'schema:abstract' },
            value: { type: 'value', content: { language: 'en', document: field.document } },
            references: field.references.map(urlReference),
          },
          rights: {
            license: field.rights.spdx,
            obligations: field.rights.obligations,
            attribution: field.rights.attribution,
          },
          ...(untrusted ?? {}),
        };
        const result = await callRaw(
          credentialFor(as),
          'POST',
          '/v1/subjects:batchWrite',
          { commands: [command] },
          key,
        );
        const body = decodeJson(result.body);
        const first = decodeJson(Array.isArray(body.results) ? body.results[0] : undefined);
        const span = spans.get(key);
        const current = observer!.records.slice(span?.start ?? 0, span?.end ?? observer!.records.length);
        const fenceIndex = current.findIndex((entry) => /content\.source_fences/i.test(entry.statement));
        if (fenceIndex >= 0) {
          const receiptIndex = current.findIndex((entry) => /core\.receipt/i.test(entry.statement));
          const bodyIndex = current.findIndex((entry) => /content\.imported_field/i.test(entry.statement));
          const at = canonicalTime(authorization.get(key)?.find((entry) => entry.action === 'statement:propose')?.at);
          const currentChecks = fenceChecks.get(key) ?? [];
          currentChecks.push(
            ...fenceTuples([current[fenceIndex]!]).map((tuple) => ({
              tuple,
              authoritativeTime: at,
              beforeReceiptAndBody:
                (receiptIndex < 0 || fenceIndex < receiptIndex) && (bodyIndex < 0 || fenceIndex < bodyIndex),
            })),
          );
          fenceChecks.set(key, currentChecks);
        }
        return { status: Number(first.status ?? result.status), body: result.body };
      },
      async contribution(key): Promise<Contribution> {
        const field = refreshFields.get(key);
        if (!field) throw new Error('No Kernel refresh was issued for this receipt key');
        const route = routeOf(field.subjectId);
        if (route === null) throw new Error('Imported field subject is unroutable');
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const result = await connection.query<{
            id: string;
            revision: number;
            document: Buffer;
            digest: string;
            source: unknown;
            rights: unknown;
            route: number;
            candidate: string;
            statement: unknown;
            transaction_id: string;
            candidate_transaction_id: string;
          }>(
            `WITH receipt AS (
               SELECT response->'value'->>'candidate' AS candidate
               FROM core.receipt
               WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
                 AND command_kind='subject.batch_propose' AND idempotency_key=$3
             )
             SELECT i.id::text, i.revision::int, i.body AS document,
                    encode(i.body_sha256, 'hex') AS digest, i.source, i.rights, i.route,
                    c.candidate_id::text AS candidate, c.statement,
                    r.recorded_transaction_id::text AS transaction_id,
                    r.recorded_transaction_id::text AS candidate_transaction_id
             FROM receipt x
             JOIN semantic.candidate c ON c.route=$5 AND c.subject_id=$4 AND c.candidate_id=x.candidate::uuid
             JOIN content.imported_field i ON i.route=c.route AND i.subject=c.subject_id AND i.candidate=c.candidate_id
             JOIN semantic.revision r ON r.route=c.route AND r.subject_id=c.subject_id AND r.revision=i.revision
             WHERE c.route=$5 AND c.revision=i.revision`,
            [partitionOf(route), importer.actor.accountId, key, field.subjectId, route],
          );
          await connection.query('COMMIT');
          const row = result.rows[0];
          if (!row) throw new Error(`No committed native imported field matches refresh receipt ${key}`);
          const contentBytes = bytes(row.document);
          knownDocuments.add(row.id);
          const semanticBody = decodeJson(row.statement);
          const value = decodeJson(semanticBody.value);
          const content = decodeJson(value.content);
          if (content.document !== row.id || content.digest !== row.digest)
            throw new Error('Semantic reference does not point to the exact native document row');
          return {
            id: row.id,
            revision: String(row.revision),
            documentId: row.id,
            digest: row.digest,
            bytes: contentBytes,
            provenance: importedProvenance(row.source, row.rights),
            partition: row.route >>> 4,
            transactionId: row.transaction_id,
            semantic: {
              documentId: row.id,
              digest: row.digest,
              body: null,
              transactionId: row.candidate_transaction_id,
              adoption: 'proposal',
            },
          };
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch {
            /* preserve the failed inspection */
          }
          throw error;
        } finally {
          connection.release();
        }
      },
      async fence(as, tuple, key) {
        const result = await callRaw(
          credentialFor(as),
          'POST',
          '/v1/sourceFences:takedown',
          {
            source: tuple.source,
            externalId: tuple.externalId,
            fieldGroup: tuple.fieldGroup,
            reason: 'Imported source takedown complaint',
          },
          key,
        );
        return { status: result.status, body: result.body };
      },
      async check(as, tuple) {
        const query = new URLSearchParams({
          source: tuple.source,
          externalId: tuple.externalId,
          fieldGroup: tuple.fieldGroup,
        });
        const result = await callRaw(credentialFor(as), 'GET', `/v1/sourceFences:check?${query}`);
        return { status: result.status, body: result.body };
      },
      async tupleHome(tuple) {
        const route = tupleRoute(native.routeKey, tuple.source, tuple.externalId);
        return { route, partition: partitionOf(route) };
      },
      async trace(key): Promise<Trace> {
        const span = spans.get(key);
        const records = observer!.records.slice(span?.start ?? 0, span?.end ?? observer!.records.length);
        const knownTuple = refreshTuples.get(key);
        const tuple = knownTuple ??
          mediaInputs.get(key)?.provenance ?? { source: 'bangumi', externalId: '42', fieldGroup: 'summary' };
        const accountId =
          key.startsWith('') && refreshFields.has(key) ? importer.actor.accountId : governance.actor.accountId;
        const commandKind = refreshFields.has(key) ? 'subject.batch_propose' : 'content.source-fence.takedown';
        const receiptRoute = refreshFields.has(key)
          ? routeOf(refreshFields.get(key)!.subjectId)
          : tupleRoute(native.routeKey, tuple.source, tuple.externalId);
        if (receiptRoute === null) throw new Error('Traced command has no native receipt route');
        const row = await receipt(key, receiptRoute, accountId, commandKind);
        const writes = row
          ? (
              await pool.query<{ partition_no: number }>(
                `SELECT DISTINCT partition_no FROM core.outbox
               WHERE partition_no=$1 AND position=$2 ORDER BY partition_no`,
                [row.partition_no, row.position],
              )
            ).rows.map((write) => ({ partition: write.partition_no, transactionId: row.transaction_id }))
          : [];
        const checks = fenceChecks.get(key) ?? [];
        const inspected = authorization.get(key) ?? [];
        let crossPartitionJoins = 0;
        for (const entry of records) {
          if (!/\bJOIN\b/i.test(entry.statement)) continue;
          const partitions = new Set<number>();
          for (const match of entry.statement.matchAll(/(?:\b\w+\.)?route\s*=\s*\$(\d+)/gi)) {
            const routeValue = entry.parameters[Number(match[1]) - 1];
            if (
              typeof routeValue === 'number' &&
              Number.isInteger(routeValue) &&
              routeValue >= 0 &&
              routeValue <= 65_535
            )
              partitions.add(partitionOf(routeValue));
          }
          if (partitions.size > 1) crossPartitionJoins++;
        }
        return {
          writes,
          crossPartitionJoins,
          fenceChecks: checks,
          authorization: inspected,
        };
      },
      async hashEvidence(documentId) {
        const route = routeOf(documentId);
        if (route === null) throw new Error('Document id is unroutable');
        const found = await pool.query<{ digest: string }>(
          `SELECT encode(body_sha256,'hex') AS digest FROM content.imported_field WHERE route=$1 AND id=$2`,
          [route, documentId],
        );
        const nativeDigest = found.rows[0]?.digest;
        if (!nativeDigest) throw new Error('Native document digest is missing');
        const client = await pool.connect();
        let mismatchedWriteRejected = false;
        try {
          await client.query('BEGIN');
          await client.query('SAVEPOINT imported_field_hash_probe');
          try {
            await client.query(
              `UPDATE content.imported_field SET body_sha256=decode(repeat('00',32),'hex') WHERE route=$1 AND id=$2`,
              [route, documentId],
            );
          } catch (error) {
            mismatchedWriteRejected =
              typeof error === 'object' && error !== null && 'code' in error && String(error.code) === '23514';
          }
          await client.query('ROLLBACK TO SAVEPOINT imported_field_hash_probe');
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        return { nativeDigest, mismatchedWriteRejected };
      },
      async effects() {
        const tables = [
          'content.imported_field',
          'content.media',
          'content.media_variant',
          'content.source_fences',
          'semantic.subject',
          'semantic.revision',
          'semantic.candidate',
          'semantic.source_candidate',
          'semantic.adoption',
          'semantic.redirect',
          'core.receipt',
          'core.outbox',
        ];
        const result: Record<string, unknown> = {};
        const client = await pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          for (const table of tables) {
            const [schema, name] = table.split('.') as [string, string];
            const rows = await client.query(
              `SELECT to_jsonb(row_value) AS row FROM ${schema}.${name} AS row_value ORDER BY to_jsonb(row_value)::text`,
            );
            result[table] = rows.rows.map((row) => row.row);
          }
          await client.query('COMMIT');
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* keep inspection failure */
          }
          throw error;
        } finally {
          client.release();
        }
        result.storage = [...store!.objects.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, HASH(value)]);
        return result;
      },
      async access(as, action, change) {
        if (change === 'revoke-grant') {
          const grantor = as === 'importer' ? operator : governance;
          const recipient = as === 'importer' ? importer : governance;
          const key = requestKey();
          const result = await callRaw(
            grantor,
            'POST',
            '/v1/grants:revoke',
            {
              resource: PLATFORM_RESOURCE,
              subject: { kind: 'account', id: recipient.actor.accountId },
              actions: [action],
              valid: '(,)',
            },
            key,
          );
          if (result.status !== 200)
            throw new Error(
              `Native public grant revoke failed (${result.status}): ${JSON.stringify(result.body)}; authorizations=${JSON.stringify(authorization.get(key) ?? [])}`,
            );
          return;
        }
        const target = as === 'importer' ? importer : governance;
        const scopes = target.actor.scopes.filter((scope) => scope !== action);
        const issued = await native.auth.issue({
          accountId: target.actor.accountId,
          clientId: target.actor.clientId,
          scopes,
        });
        if (as === 'importer') importer = issued;
        else governance = issued;
      },
      async adoptManual() {
        const key = requestKey();
        const proposed = await batch(governance, [
          {
            op: 'propose',
            key,
            subject: subjectId,
            source: {
              source: 'manual',
              external_id: randomUUID(),
              record_revision: 'unversioned',
              digest: '1'.repeat(64),
              converter_revision: 'manual-v1',
              field_group: 'facts',
            },
            statement: {
              property: { id: 'schema:inLanguage' },
              value: { type: 'value', content: 'en' },
              references: [urlReference('https://bgm.tv/subject/42')],
            },
          },
        ]);
        const proposedResult = decodeJson(Array.isArray(proposed.body.results) ? proposed.body.results[0] : undefined);
        const candidate = String(decodeJson(proposedResult.value).candidate ?? '');
        if (proposed.status !== 200 || proposedResult.status !== 201 || !candidate)
          throw new Error(`Manual Global Context proposal failed: ${JSON.stringify(proposed.body)}`);
        const accepted = await callRaw(
          governance,
          'POST',
          `/v1/subjects/${subjectId}/candidates/${candidate}:accept`,
          { context: GLOBAL_CONTEXT, expected_head: null },
          requestKey(),
        );
        if (accepted.status !== 200)
          throw new Error(`Manual statement acceptance failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
        const adopted = await callRaw(
          governance,
          'POST',
          `/v1/subjects/${subjectId}:adopt`,
          {
            context: GLOBAL_CONTEXT,
            property: 'schema:inLanguage',
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            expected_head: null,
          },
          requestKey(),
        );
        if (adopted.status !== 200)
          throw new Error(`Manual statement adoption failed: ${adopted.status} ${JSON.stringify(adopted.body)}`);
        return candidate;
      },
      async adopted() {
        const rows = await pool.query<{ selection: unknown }>(
          `SELECT selection FROM semantic.adoption WHERE route=$1 AND subject_id=$2 AND context_id=$3 AND slot_id=$4 ORDER BY head DESC LIMIT 1`,
          [container.route, subjectId, GLOBAL_CONTEXT, slotId(subjectId, 'schema:inLanguage')],
        );
        const selection = rows.rows[0]?.selection;
        const first = Array.isArray(selection) ? selection[0] : undefined;
        return typeof first === 'object' && first !== null && 'candidate' in first
          ? String((first as { candidate: unknown }).candidate)
          : '';
      },
      async projection(mode) {
        if (mode === 'pause') {
          await stopWorker();
          return;
        }
        if (mode === 'replay') await stopWorker();
        await ensureWorker();
        await pool.query(
          `SELECT c.consumer, c.epoch, c.position, o.position AS outbox_position, o.event_seq
           FROM core.consumer_checkpoint c
           LEFT JOIN LATERAL (
             SELECT position, event_seq FROM core.outbox
             WHERE partition_no=c.partition_no ORDER BY position DESC, event_seq DESC LIMIT 1
           ) o ON true
           WHERE c.partition_no=$1 ORDER BY c.consumer`,
          [container.partition],
        );
      },
      async mergeSubject() {
        const source = {
          source: 'mergefixture',
          external_id: randomUUID(),
          record_revision: 'unversioned',
          digest: '2'.repeat(64),
          converter_revision: 'merge-v1',
          field_group: 'facts',
        };
        const created = await batch(importer, [
          { op: 'create', key: requestKey(), source, subject: { type: 'schema:Book', labels: { en: 'Merge target' } } },
        ]);
        const row = decodeJson(Array.isArray(created.body.results) ? created.body.results[0] : undefined);
        const secondary = String(decodeJson(row.value).id ?? '');
        if (created.status !== 200 || row.status !== 201 || !secondary)
          throw new Error('Could not create merge fixture subject');
        const merged = await callRaw(
          governance,
          'POST',
          '/v1/subjects:merge',
          { subjects: [subjectId, secondary] },
          requestKey(),
        );
        if (merged.status !== 200)
          throw new Error(`Actual semantic merge failed (${merged.status}): ${JSON.stringify(merged.body)}`);
        const deadline = Date.now() + 10_000;
        let caughtUp = false;
        while (!caughtUp && Date.now() < deadline) {
          const settled = await callRaw(governance, 'GET', `/v1/subjects/${subjectId}/links`);
          if (settled.status !== 200)
            throw new Error(`Native semantic link projection failed after merge (${settled.status})`);
          caughtUp = decodeJson(decodeJson(settled.body).freshness).caught_up === true;
          if (!caughtUp) await Bun.sleep(25);
        }
        if (!caughtUp) throw new Error('Native semantic link projection did not catch up after merge');
      },
      async race(field, key) {
        let barrier: ReturnType<SqlObserver['hold']> | undefined;
        try {
          barrier = observer!.hold({ statement: sourceRevisionInsert }, 'before');
        } catch (error) {
          throw new Error(`Could not install SQL-boundary race barrier: ${String(error)}`);
        }
        const writePromise = this.refresh('importer', field, key);
        await barrier.entered;
        const fenceReply = await this.fence('governance', field, requestKey());
        const fenceCommittedBeforeWrite = fenceReply.status >= 200 && fenceReply.status < 300;
        barrier.release();
        const write = await writePromise;
        if (!fenceCommittedBeforeWrite)
          throw new Error(
            `Tuple fence did not commit at the SQL-boundary race (${fenceReply.status}): ${JSON.stringify(fenceReply.body)}; subject write=${write.status} ${JSON.stringify(write.body)}`,
          );
        if (write.status < 200 || write.status >= 300) {
          const span = spans.get(key);
          const statements = observer!.records
            .slice(span?.start ?? 0, span?.end ?? observer!.records.length)
            .map(({ statement }) => statement.replace(/\s+/g, ' ').trim())
            .slice(-30);
          throw new Error(
            `SQL-boundary race subject write failed (${write.status}): ${JSON.stringify(write.body)}; request=${JSON.stringify(spans.get(key))}; last SQL=${JSON.stringify(statements)}`,
          );
        }
        return { prepared: true, fenceCommittedBeforeWrite, write };
      },
      async disclose(as) {
        const docs: string[] = [];
        const bodies: string[] = [];
        for (const documentId of knownDocuments) {
          const exact = await this.exact(as, documentId, '1');
          if (exact.status < 200 || exact.status >= 300) continue;
          const document = decodeJson(decodeJson(exact.body).document);
          docs.push(documentId);
          if (document.body && typeof document.body === 'object')
            bodies.push(serializeDocument(document.body as never));
        }
        const mediaIds: string[] = [];
        for (const mediaId of mediaByKey.values()) {
          const result = await this.download(as, mediaId);
          if (result.status >= 200 && result.status < 300) mediaIds.push(mediaId);
        }
        return { documents: docs, media: mediaIds, bodies };
      },
      async exact(as, documentId, revision) {
        const result = await callRaw(credentialFor(as), 'GET', `/v1/documents/${documentId}`);
        if (result.status >= 200 && result.status < 300) {
          const document = decodeJson(decodeJson(result.body).document);
          if (String(document.revision) !== revision)
            throw new Error(`Exact document API returned revision ${String(document.revision)}, expected ${revision}`);
        }
        return { status: result.status, body: result.body };
      },
      async fetchFixture(kind: FetchCase): Promise<ImageInput> {
        const id = requestKey();
        fixtureKeys.add(id);
        const sourceUrl =
          kind === 'unallowed-host'
            ? `https://not-allowed.example.test/${id}/image`
            : sourceServer.url(id, kind as SourceKind);
        const tuple: Tuple = { source: 'bangumi', externalId: '42', fieldGroup: 'cover' };
        const references = [
          publicReferenceUrl({
            ...tuple,
            recordRevision: 'native-revision-2',
            digest: 'b'.repeat(64),
            converterRevision: 'cover-v1',
            references: ['https://bgm.tv/subject/42'],
            rights: {
              spdx: 'CC-BY-SA-3.0',
              obligations: ['cc:Attribution', 'cc:ShareAlike'],
              attribution: 'via Bangumi',
            },
          }),
        ];
        const provenance: Provenance = {
          ...tuple,
          recordRevision: 'native-revision-2',
          digest: 'b'.repeat(64),
          converterRevision: 'cover-v1',
          references,
          rights: {
            spdx: 'CC-BY-SA-3.0',
            obligations: ['cc:Attribution', 'cc:ShareAlike'],
            attribution: 'via Bangumi',
          },
        };
        const input = { sourceUrl, credit: 'rights holder', provenance };
        mediaInputs.set(id, input);
        return input;
      },
      async importUrl(as, input: ImageInput, key) {
        mediaInputs.set(key, input);
        const sourceUrl = input.sourceUrl;
        const body = {
          containerId: subjectId,
          sourceUrl,
          credit: {
            rightsHolder: input.credit,
            via: { name: 'Bangumi', url: publicReferenceUrl(input.provenance) },
            license: 'LicenseRef-unknown',
            obligations: [],
          },
          provenance: sourceRecord(input.provenance, 'cover'),
        };
        (body.provenance as Record<string, unknown>).references = input.provenance.references.map(urlReference);
        const result = await callRaw(credentialFor(as), 'POST', '/v1/media:importFromUrl', body, key);
        const root = decodeJson(result.body);
        const media = decodeJson(root.media);
        if (typeof media.id === 'string') mediaByKey.set(key, media.id);
        return { status: result.status, body: result.body };
      },
      async drain() {
        await ensureWorker();
        const ids = [...mediaByKey.values()];
        const deadline = Date.now() + 90_000;
        while (ids.length) {
          if (Date.now() >= deadline)
            throw new Error(
              `Timed out waiting for native import and shared image jobs; listCalls=${JSON.stringify(store!.listCalls)} pendingListFailures=${store!.pendingListFailures}; ${worker?.diagnostics() ?? 'worker stopped'}`,
            );
          const states = await Promise.all(
            ids.map(async (id) => {
              const response = await callRaw(importer, 'GET', `/v1/media/${id}:importStatus`);
              if (response.status !== 200)
                throw new Error(
                  `Native import status denied (${response.status}) for ${id}: ${JSON.stringify(response.body)}`,
                );
              return String(decodeJson(decodeJson(response.body).media).state ?? 'missing');
            }),
          );
          if (states.every((state) => state === 'available' || state === 'rejected')) break;
          await Bun.sleep(50);
        }
        const rejectedIds = await Promise.all(
          ids.map(async (id) => ((await readMedia(id)).state === 'rejected' ? id : null)),
        ).then((values) => values.filter((id): id is string => id !== null));
        if (rejectedIds.length > 0) {
          const retryDeadline = Math.min(deadline, Date.now() + 60_000);
          let completed = false;
          let lastWorkflows: { inputs: string; status: string; error: unknown }[] = [];
          while (Date.now() < retryDeadline) {
            const workflows = await pool.query<{ inputs: string; status: string; error: unknown }>(
              `SELECT wi.inputs, ws.status, ws.error
               FROM dbos.workflow_status ws
               JOIN dbos.workflow_input wi
                 ON ws.workflow_uuid::text = wi.workflow_uuid::text
               WHERE ws.name='content.purge'`,
            );
            lastWorkflows = workflows.rows;
            const states = new Map<string, string[]>();
            for (const workflow of workflows.rows) {
              for (const id of rejectedIds) {
                if (!workflow.inputs.includes(id)) continue;
                const matches = states.get(id) ?? [];
                matches.push(workflow.status);
                states.set(id, matches);
              }
            }
            const statuses = rejectedIds.map((id) => states.get(id) ?? []);
            completed = statuses.every(
              (matches) =>
                matches.length > 0 && matches.every((status) => status === 'SUCCESS' || status === 'CANCELLED'),
            );
            if (completed) break;
            const failed = workflows.rows.find(
              (workflow) => rejectedIds.some((id) => workflow.inputs.includes(id)) && workflow.status === 'ERROR',
            );
            if (failed)
              throw new Error(
                `Native DBOS purge failed after restart: ${JSON.stringify(failed)}; listCalls=${JSON.stringify(store!.listCalls)}`,
              );
            if (!restartedAfterPurgeFailure && store!.listFailures > 0) {
              await worker!.kill();
              worker = await startNativeWorker(workerOptions);
              restartedAfterPurgeFailure = true;
            }
            await Bun.sleep(100);
          }
          if (!completed && rejectedIds.length > 0)
            throw new Error(
              `Native DBOS purge did not finish after restart: ${JSON.stringify(rejectedIds)}; workflows=${JSON.stringify(lastWorkflows)}; listCalls=${JSON.stringify(store!.listCalls)}; ${worker?.diagnostics() ?? 'worker stopped'}`,
            );
        }
        for (const [key, id] of mediaByKey) {
          const input = mediaInputs.get(key);
          if (!input || new URL(input.sourceUrl).pathname.split('/')[2] !== 'valid') continue;
          const media = await readMedia(id);
          if (media.state !== 'rejected') continue;
          const details = await pool.query(`SELECT decision FROM content.media WHERE route=$1 AND media_id=$2`, [
            routeOf(id),
            id,
          ]);
          const workflow = await pool.query(
            `SELECT name, status, error, inputs FROM dbos.workflow_status WHERE inputs::text LIKE '%' || $1 || '%' ORDER BY created_at DESC LIMIT 10`,
            [id],
          );
          throw new Error(
            `Valid native media import ${id} was rejected: decision=${JSON.stringify(details.rows[0])}; workflows=${JSON.stringify(workflow.rows)}; sourceRequests=${JSON.stringify(sources!.requests.get(new URL(input.sourceUrl).pathname.split('/')[1]!))}; storagePuts=${JSON.stringify(store!.puts)}; worker=${worker?.diagnostics()}`,
          );
        }
      },
      async media(key): Promise<Media> {
        const mediaId = mediaByKey.get(key);
        if (!mediaId) throw new Error(`No native media reservation for request ${key}`);
        return readMedia(mediaId);
      },
      async rejectedImport(key) {
        let mediaId = mediaByKey.get(key);
        if (!mediaId) {
          const lookup = await pool.query<{ media_id: string }>(
            'SELECT media_id::text FROM content.media WHERE reservation_request_id=$1 LIMIT 1',
            [key],
          );
          mediaId = lookup.rows[0]?.media_id;
        }
        const media = mediaId ? await readMedia(mediaId) : null;
        const storedKeys = mediaId ? store!.keys(`m/${mediaId}/`) : [];
        const purgeWorkflows = mediaId
          ? await pool.query<{ status: string; inputs: string; error: unknown }>(
              `SELECT ws.status, wi.inputs, ws.error
               FROM dbos.workflow_status ws
               JOIN dbos.workflow_input wi
                 ON ws.workflow_uuid::text = wi.workflow_uuid::text
               WHERE ws.name='content.purge' AND wi.inputs LIKE '%' || $1 || '%'`,
              [mediaId],
            )
          : { rows: [] };
        const pendingPurge = purgeWorkflows.rows.some(
          (workflow) => workflow.status !== 'SUCCESS' && workflow.status !== 'CANCELLED',
        );
        if (pendingPurge)
          throw new Error(
            `Native purge workflow remains pending for ${mediaId}: ${JSON.stringify(purgeWorkflows.rows)}; listCalls=${JSON.stringify(store!.listCalls)}`,
          );
        return { media, storedKeys, pendingPurge };
      },
      async fetchEvidence(id) {
        const input = mediaInputs.get(id);
        const fixtureId = input ? new URL(input.sourceUrl).pathname.split('/')[1] : undefined;
        const attempts = fixtureId ? (sources!.externalRequests.get(fixtureId) ?? []) : [];
        return {
          unallowedRequests: attempts.filter((value) => new URL(value).hostname !== 'images.example.test'),
          unsafeRequests: attempts.filter((value) => {
            const url = new URL(value);
            return url.protocol !== 'https:' || url.hostname !== 'images.example.test';
          }),
        };
      },
      async imageEvidence(id) {
        const mediaId = mediaByKey.get(id);
        if (!mediaId) throw new Error(`No native media reservation for image evidence key ${id}`);
        const rows = await pool.query<{ key: string; format: string }>(
          'SELECT key, format FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width LIMIT 1',
          [routeOf(mediaId), mediaId],
        );
        const first = rows.rows[0];
        if (!first) throw new Error('Shared Sharp worker did not store a media variant');
        const encoded = store!.objects.get(first.key);
        if (!encoded) throw new Error(`Native variant ${first.key} was not retained at the S3 boundary`);
        const metadata = await sharp(encoded).metadata();
        const metadataFields = ['exif', 'icc', 'iptc', 'xmp', 'tifftagPhotoshop'].filter(
          (field) => metadata[field as keyof typeof metadata] !== undefined,
        );
        const fixtureId = mediaInputs.get(id)
          ? new URL(mediaInputs.get(id)!.sourceUrl).pathname.split('/')[1]
          : undefined;
        const fetches = fixtureId ? (sources!.requests.get(fixtureId) ?? []) : [];
        return {
          sub: importer.actor.accountId,
          principalKind: importer.actor.kind,
          websiteSession: importer.actor.clientId !== native.auth.ordinaryClient.id,
          tokenExchange: importer.actor.requestedBy !== null,
          scopes: [...importer.actor.scopes],
          sharpVersion: String((sharp as unknown as { versions?: { sharp?: string } }).versions?.sharp ?? 'sharp'),
          sharedPipeline: rows.rows.length > 0,
          limitInputPixels: 40_000_000,
          decoded: {
            format: metadata.format === 'heif' ? first.format : (metadata.format ?? ''),
            width: metadata.width ?? 0,
            height: metadata.height ?? 0,
            metadata: metadataFields,
          },
          configuredCaps: { bytes: MAX_SOURCE_BYTES, redirects: 3, milliseconds: 15_000 },
          fetches,
          clientActor: importer.actor.kind !== 'account',
        };
      },
      async cover(as, mediaId, key, fault) {
        const permissionBarrier =
          fault === 'before-commit'
            ? observer!.hold({ statement: permissionCheck, occurrence: 2 }, 'before')
            : undefined;
        const field = mediaInputs.get([...mediaByKey.entries()].find(([, value]) => value === mediaId)?.[0] ?? '');
        if (!field) throw new Error('Cover proposal lacks its actual URL import provenance');
        const source = sourceRecord(field.provenance, 'cover');
        let statement: Record<string, unknown> = {
          property: { id: 'schema:image' },
          value: { type: 'value', content: mediaId },
          references: field.provenance.references.map(urlReference),
        };
        if (fault === 'invalid-proposal')
          statement = { property: { id: 'schema:image' }, value: { type: 'somevalue' }, references: [] };
        if (fault === 'non-cover-role')
          statement = {
            property: { id: 'schema:abstract' },
            value: { type: 'value', content: mediaId },
            references: field.provenance.references.map(urlReference),
          };
        const requestBody = { commands: [{ op: 'propose', key, source, subject: subjectId, statement }] };
        const request = batch(credentialFor(as) as ActorCredential, requestBody.commands);
        let revokedForRace = false;
        let result: Awaited<typeof request>;
        try {
          if (permissionBarrier) {
            await permissionBarrier.entered;
            await this.access('importer', 'statement:propose', 'revoke-grant');
            revokedForRace = true;
            permissionBarrier.release();
          }
          result = await request;
        } finally {
          permissionBarrier?.release();
          if (revokedForRace) await grant(operator, importer.actor.accountId, ['statement:propose']);
        }
        if (result.status >= 500)
          throw new Error(
            `Native cover proposal failed (${result.status}): ${JSON.stringify(result.body)}; request=${JSON.stringify(spans.get(key))}; authorization=${JSON.stringify(authorization.get(key) ?? [])}`,
          );
        const command = decodeJson(Array.isArray(result.body.results) ? result.body.results[0] : undefined);
        const status = Number(command.status ?? result.status);
        if (status >= 500)
          throw new Error(
            `Native cover command failed (${status}): ${JSON.stringify(result.body)}; request=${JSON.stringify(spans.get(key))}; authorization=${JSON.stringify(authorization.get(key) ?? [])}`,
          );
        if (fault === 'before-commit' && status >= 200 && status < 300)
          console.error(
            `Native cover authorization unexpectedly allowed: response=${JSON.stringify(result.body)}; request=${JSON.stringify(spans.get(key))}; authorization=${JSON.stringify(authorization.get(key) ?? [])}`,
          );
        return { status, body: result.body };
      },
      async coverReference(key) {
        const command = await receipt(key, container.route, importer.actor.accountId, 'subject.batch_propose');
        if (!command) throw new Error('Cover command receipt is absent');
        const root = decodeJson(command.response);
        const value = decodeJson(root.value);
        const candidate = String(value.candidate ?? '');
        const query = await pool.query<{ media_id: string; candidate: string; route: number; claim_tx: string }>(
          `SELECT m.media_id::text, c.candidate_id::text AS candidate, m.route,
                  r.recorded_transaction_id::text AS claim_tx
           FROM semantic.candidate c
           JOIN semantic.revision r ON r.route=c.route AND r.subject_id=c.subject_id AND r.revision=c.revision
           JOIN content.media m ON m.route=c.route AND m.media_id::text = c.statement #>> '{value,content}'
           WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3`,
          [container.route, subjectId, candidate],
        );
        const row = query.rows[0];
        if (!row) throw new Error('Native cover candidate/reference is missing');
        const imported = await readMedia(row.media_id);
        return {
          mediaId: row.media_id,
          role: 'cover',
          credit: imported.credit,
          sourceLink: imported.sourceLink,
          partition: row.route >>> 4,
          claimTransactionId: row.claim_tx,
          commandTransactionId: command.transaction_id,
        };
      },
      async download(as, mediaId, ifNoneMatch) {
        const headers = ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {};
        const result = await callRaw(
          credentialFor(as),
          'GET',
          `/v1/media/${mediaId}:authorizeDownload?variant=webp-320`,
          undefined,
          undefined,
          headers,
        );
        return { status: result.status, body: result.body };
      },
      async setContainer(mode) {
        const path = `/v1/subjects/${subjectId}`;
        let result;
        if (mode === 'public')
          result = await callRaw(
            governance,
            'POST',
            `${path}:restore`,
            { reason: 'Restore test visibility' },
            requestKey(),
          );
        else if (mode === 'private')
          result = await callRaw(
            governance,
            'POST',
            `${path}:hide`,
            { reason: 'Private visibility test' },
            requestKey(),
          );
        else
          result = await callRaw(
            governance,
            'POST',
            `${path}:takedown`,
            {
              notice: {
                complaint: 'Test visibility takedown',
                received_at: '2030-01-02T00:00:00.000Z',
                scope: 'Imported cover fixture',
              },
            },
            requestKey(),
          );
        if (result.status !== 200)
          throw new Error(`Native subject visibility API failed (${result.status}): ${JSON.stringify(result.body)}`);
      },
      async rightsTakedown(mediaId, tuple) {
        const media = await readMedia(mediaId);
        const taken = await callRaw(
          governance,
          'POST',
          `/v1/media/${mediaId}:takeDown`,
          { reason: 'Rights holder complaint' },
          requestKey(),
        );
        if (taken.status !== 200) throw new Error(`Native media takedown failed (${taken.status})`);
        const fence = await this.fence('governance', tuple, requestKey());
        if (fence.status !== 200) throw new Error(`Native tuple source fence failed (${fence.status})`);
        if (!store!.objects.has(`m/${mediaId}/original`) && media.bytes.length > 0)
          throw new Error('Media takedown discarded appeal bytes');
      },
      async failNextPurge() {
        store!.failNextList();
      },
      async completeAsImporter(mediaId) {
        const result = await callRaw(
          importer,
          'POST',
          `/v1/media/${mediaId}:complete`,
          {
            containerId: subjectId,
            reservationRequestId: [...mediaByKey.entries()].find(([, value]) => value === mediaId)?.[0] ?? 'importer',
            byteCount: 1,
            sha256: '0'.repeat(64),
          },
          requestKey(),
        );
        return { status: result.status, body: result.body };
      },
      async checkGrowth(input) {
        const scales = input.scales;
        if (scales.join(',') !== '32,256,2048') throw new Error('Imported-field growth scales changed');
        const document = fromPlainText(
          'Full source summary: first paragraph.\nSecond paragraph, including the ending.',
        );
        const documentBuffer = Buffer.from(serializeDocument(document));
        if (documentBuffer.byteLength !== input.documentBytes)
          throw new Error('Growth document bytes do not match the frozen source document');
        const template: Field = {
          source: 'bangumi',
          externalId: '42',
          fieldGroup: 'summary',
          subjectId,
          document,
          recordRevision: 'unversioned',
          digest: HASH(documentBuffer),
          converterRevision: 'summary-v1',
          references: ['https://bgm.tv/subject/42'],
          rights: {
            spdx: 'CC-BY-SA-3.0',
            obligations: ['cc:Attribution', 'cc:ShareAlike'],
            attribution: 'via Bangumi',
          },
        };
        const growthField = (source: string, externalId: string): Field => ({ ...template, source, externalId });
        const transformed = await transformImage(sources!.validBytes);
        const webp320 = transformed.variants.find((variant) => variant.format === 'webp' && variant.width === 320);
        if (!webp320) throw new Error('The shared Sharp pipeline produced no 320px WebP growth variant');
        const imageBytes = transformed.variants.reduce((total, variant) => total + variant.bytes.byteLength, 0);
        if (imageBytes <= 0) throw new Error('The shared Sharp pipeline produced no growth image bytes');

        const databaseUrl = native.database.pool.options.connectionString;
        if (typeof databaseUrl !== 'string') throw new Error('Native application pool has no clone database URL');
        const growth = await openGrowthDatabase(databaseUrl);
        const appPool = native.database.pool;
        const queryDescriptor = Object.getOwnPropertyDescriptor(appPool, 'query');
        const connectDescriptor = Object.getOwnPropertyDescriptor(appPool, 'connect');
        const sampleRows: {
          scale: number;
          changedRows: number;
          operation: 'hook' | 'fence' | 'reference' | 'import' | 'job';
          rows: number;
          statements: number;
          buffers: number;
          documentBytes: number;
          imageBytes: number;
          samePartition: boolean;
        }[] = [];
        const seededScales = new Set<number>();
        const tuplePartition = container.partition;
        const unresolvedAccountRoute = routeOf(importer.actor.accountId);
        if (unresolvedAccountRoute === null) throw new Error('Importer account has no routable Access partition');
        const accountRoute = unresolvedAccountRoute;
        const bodyDigest = createHash('sha256').update(documentBuffer).digest();
        const bodyHex = bodyDigest.toString('hex');
        const imageDigest = HASH(sources!.validBytes);

        const existingCheckpoints = await growth.admin.query<{ partition_no: number; consumer: string }>(
          'SELECT partition_no, consumer FROM core.consumer_checkpoint',
        );
        const checkpointKeys = new Set(
          existingCheckpoints.rows.map(({ partition_no, consumer }) => `${partition_no}:${consumer}`),
        );
        const checkpointRows: { partition_no: number; consumer: string; epoch: null; position: number }[] = [];
        if (existingCheckpoints.rows.length < 512) {
          const consumers = ['effects', 'semantic_links', 'content_reaction_count'];
          const quietPartitions = await growth.admin.query<{ partition_no: number }>(
            `SELECT p.partition_no FROM core.partition p
             WHERE p.partition_no NOT IN (0, $1)
               AND NOT EXISTS (SELECT 1 FROM core.outbox o WHERE o.partition_no=p.partition_no)
             ORDER BY p.partition_no DESC`,
            [tuplePartition],
          );
          for (const { partition_no: partition } of quietPartitions.rows) {
            if (existingCheckpoints.rows.length + checkpointRows.length >= 544) break;
            for (const consumer of consumers) {
              const key = `${partition}:${consumer}`;
              if (checkpointKeys.has(key)) continue;
              checkpointKeys.add(key);
              checkpointRows.push({ partition_no: partition, consumer, epoch: null, position: 0 });
              if (existingCheckpoints.rows.length + checkpointRows.length >= 544) break;
            }
          }
        }

        const populationOffsets = new Map<string, number>();
        const seededFenceSources = new Set<string>();
        function population(
          source: string,
          externalIds: readonly string[],
          addCheckpoints: boolean,
          populationKey: string,
        ): Population {
          let positionBase = populationOffsets.get(populationKey);
          if (positionBase === undefined) {
            positionBase = 1_000_000 + populationOffsets.size * 10_000;
            populationOffsets.set(populationKey, positionBase);
          }
          const includeSourceFences = !seededFenceSources.has(source);
          seededFenceSources.add(source);
          return {
            name: `imported-field-growth-${populationKey}`,
            hotPartition: tuplePartition,
            hotShare: 1,
            rows: ({ ordinal }) => {
              const externalId = externalIds[ordinal];
              if (!externalId) throw new Error(`Growth source range exceeded its anchors for ${source}`);
              const route = container.route;
              const fenceRoute = tupleRoute(native.routeKey, source, externalId);
              if (fenceRoute === null || partitionOf(fenceRoute) !== tuplePartition)
                throw new Error('Growth source fixture escaped its anchored partition');
              const subjectId = newId(route);
              const candidateId = newId(route);
              const documentId = newId(route);
              const transactionId = newId(route);
              const mediaId = newId(route);
              const accountId = newId(accountRoute);
              const revisionSource = {
                source,
                external_id: externalId,
                record_revision: 'growth-native-revision',
                digest: bodyHex,
                converter_revision: 'growth-summary-v1',
                field_group: 'summary',
                references: [
                  {
                    parts: [
                      {
                        property: { id: 'schema:url' },
                        value: { type: 'value', content: 'https://bgm.tv/subject/42' },
                      },
                    ],
                  },
                ],
              };
              const rights = {
                license: 'CC-BY-SA-3.0',
                obligations: ['cc:Attribution', 'cc:ShareAlike'],
                attribution: 'Growth fixture source',
              };
              const statement = {
                property: { id: 'schema:description' },
                value: { type: 'value', content: { document: documentId, digest: bodyHex, language: 'en' } },
              };
              const seedTransaction = transactionId;
              const mediaByteCount = sources!.validBytes.byteLength;
              const filler: Record<string, readonly Record<string, unknown>[]> = {
                'semantic.subject': [
                  {
                    route,
                    subject_id: subjectId,
                    type: 'schema:Book',
                    recorded_transaction_id: seedTransaction,
                    current_release: bundledDigest,
                  },
                ],
                'semantic.revision': [
                  {
                    route,
                    subject_id: subjectId,
                    revision: 1,
                    kind: 'propose',
                    release: bundledDigest,
                    recorded_transaction_id: seedTransaction,
                    source: revisionSource,
                  },
                ],
                'semantic.candidate': [
                  {
                    route,
                    subject_id: subjectId,
                    candidate_id: candidateId,
                    slot_id: slotId(subjectId, 'schema:description'),
                    property: 'schema:description',
                    rank: 'normal',
                    statement,
                    release: bundledDigest,
                    revision: 1,
                    origin: 'proposal',
                  },
                ],
                'semantic.source_candidate': [
                  {
                    route,
                    subject_id: subjectId,
                    source,
                    external_id: externalId,
                    field_group: 'summary',
                    statement_digest: bodyHex,
                    candidate_id: candidateId,
                  },
                ],
                'semantic.context': [
                  {
                    route: 0,
                    context_id: newId(0),
                    kind: 'community',
                    labels: { en: 'Growth fixture context' },
                    recorded_transaction_id: newId(0),
                    defaults: {},
                  },
                ],
                'content.imported_field': [
                  {
                    route,
                    id: documentId,
                    subject: subjectId,
                    candidate: candidateId,
                    revision: 1,
                    body: documentBuffer,
                    body_sha256: bodyDigest,
                    source: revisionSource,
                    rights,
                    language: 'en',
                    availability: 'available',
                  },
                ],
                'content.media': [
                  {
                    route,
                    media_id: mediaId,
                    container_id: container.id,
                    uploader_id: importer.actor.accountId,
                    reservation_request_id: `growth-${populationKey}-${ordinal}`,
                    purpose: 'post-image',
                    media_type: 'image/jpeg',
                    byte_count: mediaByteCount,
                    declared_sha256: imageDigest,
                    actual_byte_count: mediaByteCount,
                    sha256: imageDigest,
                    state: 'available',
                    decision: null,
                    key: `m/${mediaId}/original`,
                    claimed_at: null,
                    transaction_id: seedTransaction,
                  },
                ],
                'content.media_variant': [
                  {
                    route,
                    media_id: mediaId,
                    format: webp320.format,
                    width: webp320.width,
                    height: webp320.height,
                    media_type: webp320.mediaType,
                    byte_count: webp320.byteCount,
                    sha256: webp320.sha256,
                    key: `m/${mediaId}/${webp320.format}-${webp320.width}`,
                    transaction_id: seedTransaction,
                  },
                ],
                'access.account': [
                  {
                    route: accountRoute,
                    account_id: accountId,
                    kind: 'actor',
                    state: 'active',
                    transaction_id: accountId,
                    membership_inverse_complete: true,
                  },
                ],
                'access.membership_inverse': [
                  {
                    route: accountRoute,
                    account_id: accountId,
                    kind: 'organization',
                    group_id: newId(accountRoute),
                    reservation_id: newId(accountRoute),
                    transaction_id: newId(accountRoute),
                  },
                ],
                'access.resource_grant': [
                  {
                    route: 0,
                    resource_id: newId(0),
                    subject_id: importer.actor.accountId,
                    subject_role: '',
                    action: 'source_fence:read',
                    valid: '(,)',
                    transaction_id: newId(0),
                    subject_kind: 'identity',
                  },
                ],
                'access.resource_denial': [
                  {
                    route: 0,
                    resource_id: newId(0),
                    subject_id: importer.actor.accountId,
                    subject_role: '',
                    action: 'source_fence:read',
                    reason: 'resource',
                    valid: '(,)',
                    transaction_id: newId(0),
                  },
                ],
                'access.resource_role_grant': [
                  {
                    route: 0,
                    resource_id: newId(0),
                    subject_kind: 'identity',
                    subject_id: importer.actor.accountId,
                    subject_role: '',
                    grant_role: 'content.media.owner',
                    valid: '(,)',
                    transaction_id: newId(0),
                  },
                ],
                'core.receipt': [
                  {
                    partition_no: tuplePartition,
                    principal_kind: 'account',
                    principal_id: importer.actor.accountId,
                    command_kind: 'content.growth-seed',
                    idempotency_key: `${populationKey}-${ordinal}`,
                    request_digest: Buffer.alloc(32, 1),
                    epoch: 1,
                    position: positionBase + ordinal,
                    transaction_id: seedTransaction,
                    response: {},
                  },
                ],
                'editorial.write_basis': [
                  {
                    partition_no: tuplePartition,
                    transaction_id: seedTransaction,
                    epoch: 1,
                    position: positionBase + ordinal,
                    principal_id: importer.actor.accountId,
                    client_id: importer.actor.clientId,
                    requested_by: null,
                    principal_kind: 'account',
                  },
                ],
              };
              const checkpoint = addCheckpoints ? checkpointRows[ordinal] : undefined;
              if (checkpoint) filler['core.consumer_checkpoint'] = [checkpoint];
              if (includeSourceFences)
                filler['content.source_fences'] = [
                  {
                    route: fenceRoute,
                    source,
                    external_id: externalId,
                    field_group: 'summary',
                    taken_down: false,
                    security_revision: 1,
                  },
                  {
                    route: fenceRoute,
                    source,
                    external_id: externalId,
                    field_group: 'cover',
                    taken_down: false,
                    security_revision: 1,
                  },
                ];
              return filler;
            },
          };
        }

        const growthOperations = ['hook', 'fence', 'reference', 'import', 'job'] as const;
        const groups: {
          changedRows: number;
          operation: (typeof growthOperations)[number];
          source: string;
          externalIds: string[];
          operationIds: string[];
          population: Population;
          referenceDocument?: { id: string; revision: string };
        }[] = [];
        let addCheckpoints = true;
        const growthSource = 'growth_fixture';
        const growthExternalIdList = growthExternalIds(native.routeKey, growthSource, tuplePartition, 2_610);
        for (const changedRows of input.changedRows) {
          for (const operation of growthOperations) {
            const source = growthSource;
            const externalIds = growthExternalIdList;
            const operationIndex = growthOperations.indexOf(operation);
            const populationKey = `${changedRows}-${operation}`;
            const populationRows = population(source, externalIds, addCheckpoints, populationKey);
            addCheckpoints = false;
            const changedRowsIndex = input.changedRows.indexOf(changedRows);
            const operationStart = 2_560 + changedRowsIndex * 25 + operationIndex * 5;
            const operationIds = externalIds.slice(operationStart, operationStart + changedRows);
            const group: (typeof groups)[number] = {
              changedRows,
              operation,
              source,
              externalIds,
              operationIds,
              population: populationRows,
            };
            if (operation === 'reference') {
              const key = requestKey();
              const reply = await this.refresh('importer', growthField(source, operationIds[0]!), key);
              if (reply.status < 200 || reply.status >= 300)
                throw new Error(`Growth reference anchor failed (${reply.status}): ${JSON.stringify(reply.body)}`);
              const contribution = await this.contribution(key);
              group.referenceDocument = { id: contribution.documentId, revision: contribution.revision };
            }
            groups.push(group);
          }
        }

        const growthPopulation = groups[0]?.population;
        if (!growthPopulation) throw new Error('Imported-field growth has no anchored population');

        const measuredCosts = new Map<string, Cost[]>();
        const groupKey = (group: (typeof groups)[number]) => `${group.changedRows}:${group.operation}`;
        const waitForImports = async (ids: readonly string[]) => {
          const deadline = Date.now() + 60_000;
          let terminal = false;
          while (!terminal && Date.now() < deadline) {
            const states = await Promise.all(
              ids.map(async (id) => {
                const result = await callRaw(importer, 'GET', `/v1/media/${id}:importStatus`);
                if (result.status !== 200)
                  throw new Error(
                    `Growth native import poll failed (${result.status}): ${JSON.stringify(result.body)}`,
                  );
                return String(decodeJson(decodeJson(result.body).media).state ?? 'missing');
              }),
            );
            terminal = states.every((state) => state === 'available' || state === 'rejected');
            if (!terminal) await Bun.sleep(25);
          }
          if (!terminal)
            throw new Error(`Native DBOS growth jobs timed out; ${worker?.diagnostics() ?? 'worker stopped'}`);
        };
        try {
          appPool.query = growth.pool.query.bind(growth.pool) as typeof appPool.query;
          appPool.connect = growth.pool.connect.bind(growth.pool) as typeof appPool.connect;
          let previous = 0;
          for (const scale of scales) {
            const from = previous === 0 ? 0 : 512 + previous;
            await seed({ pool: growth.pool, admin: growth.admin }, growthPopulation, { from, to: 512 + scale });
            seededScales.add(scale);
            previous = scale;

            for (const group of groups) {
              const { changedRows, operation, source, operationIds } = group;
              const usedIds = operationIds.slice(0, changedRows);
              const samePartition = usedIds.every(
                (externalId) => partitionOf(tupleRoute(native.routeKey, source, externalId)) === tuplePartition,
              );
              if (!samePartition) throw new Error(`Growth ${operation} escaped its native partition`);

              const runImports = async (): Promise<{ keys: string[]; ids: string[] }> => {
                return Promise.all(
                  usedIds.map(async (externalId) => {
                    const key = requestKey();
                    const fixture = await this.fetchFixture('valid');
                    const cover: ImageInput = {
                      ...fixture,
                      provenance: { ...fixture.provenance, source, externalId, fieldGroup: 'cover' },
                    };
                    const reply = await this.importUrl('importer', cover, key);
                    if (reply.status < 200 || reply.status >= 300)
                      throw new Error(`Growth media import failed (${reply.status}): ${JSON.stringify(reply.body)}`);
                    const mediaId = String(decodeJson(decodeJson(reply.body).media).id ?? '');
                    if (!mediaId) throw new Error('Native import response did not return the reserved media id');
                    return { key, mediaId };
                  }),
                ).then((imports) => ({
                  keys: imports.map(({ key }) => key),
                  ids: imports.map(({ mediaId }) => mediaId),
                }));
              };

              let workerCost: Cost | undefined;
              let capturedWorker: WorkerProcess | undefined;
              if (operation === 'job') {
                await ensureWorker();
                capturedWorker = worker;
                await capturedWorker!.beginCapture();
              }
              let measured: { value: unknown; cost: Cost };
              try {
                measured = await measure(growth, async () => {
                  if (operation === 'hook') {
                    const commands = usedIds.map((externalId) => {
                      const field = growthField(source, externalId);
                      return {
                        op: 'propose',
                        key: requestKey(),
                        source: sourceRecord(field),
                        subject: field.subjectId,
                        statement: {
                          property: { id: 'schema:abstract' },
                          value: { type: 'value', content: { language: 'en', document: field.document } },
                          references: field.references.map(urlReference),
                        },
                        rights: {
                          license: field.rights.spdx,
                          obligations: field.rights.obligations,
                          attribution: field.rights.attribution,
                        },
                      };
                    });
                    const reply = await batch(importer, commands);
                    const outcomes = Array.isArray(reply.body.results) ? reply.body.results.map(decodeJson) : [];
                    if (reply.status < 200 || reply.status >= 300 || outcomes.length !== changedRows)
                      throw new Error(`Growth hook batch failed (${reply.status}): ${JSON.stringify(reply.body)}`);
                    for (const outcome of outcomes) {
                      const status = Number(outcome.status ?? reply.status);
                      if (status < 200 || status >= 300)
                        throw new Error(`Growth hook command failed (${status}): ${JSON.stringify(outcome)}`);
                    }
                    return undefined;
                  }
                  if (operation === 'fence') {
                    await Promise.all(
                      usedIds.map(async (externalId) => {
                        const reply = await this.fence(
                          'governance',
                          { source, externalId, fieldGroup: 'summary' },
                          requestKey(),
                        );
                        if (reply.status < 200 || reply.status >= 300)
                          throw new Error(`Growth fence failed (${reply.status}): ${JSON.stringify(reply.body)}`);
                      }),
                    );
                    return undefined;
                  }
                  if (operation === 'reference') {
                    const referenceDocument = group.referenceDocument;
                    if (!referenceDocument) throw new Error('Growth reference document was not anchored');
                    await Promise.all(
                      Array.from({ length: changedRows }, async () => {
                        const reply = await this.exact('importer', referenceDocument.id, referenceDocument.revision);
                        if (reply.status < 200 || reply.status >= 300)
                          throw new Error(
                            `Growth reference read failed (${reply.status}): ${JSON.stringify(reply.body)}`,
                          );
                      }),
                    );
                    return undefined;
                  }

                  const imported = await runImports();
                  if (operation === 'import') return imported;
                  await waitForImports(imported.ids);
                  const states = await Promise.all(imported.keys.map(async (key) => (await this.media(key)).state));
                  if (states.some((state) => state !== 'available'))
                    throw new Error(`Native DBOS growth jobs did not publish valid images: ${states.join(',')}`);
                  return undefined;
                });
              } finally {
                if (operation === 'job' && capturedWorker) workerCost = await capturedWorker.endCapture();
              }

              if (operation === 'import') {
                const imported = measured.value as { keys: string[]; ids: string[] };
                await ensureWorker();
                await waitForImports(imported.ids);
                for (const key of imported.keys)
                  if ((await this.media(key)).state !== 'available')
                    throw new Error('The native import worker did not make a valid growth image available');
              }

              const relations: Record<string, Cost['relations'][string]> = {
                ...(measured.cost.relations ?? {}),
              };
              for (const [relation, cost] of Object.entries(workerCost?.relations ?? {})) {
                const prior = relations[relation];
                relations[relation] = {
                  rows: (prior?.rows ?? 0) + cost.rows,
                  blocks: (prior?.blocks ?? 0) + cost.blocks,
                  nodes: (prior?.nodes ?? 0) + cost.nodes,
                  sequentialScans: (prior?.sequentialScans ?? 0) + cost.sequentialScans,
                };
              }
              const cost: Cost = {
                rows: measured.cost.rows + (workerCost?.rows ?? 0),
                statements: measured.cost.statements + (workerCost?.statements ?? 0),
                controlStatements: measured.cost.controlStatements + (workerCost?.controlStatements ?? 0),
                catalogStatements: measured.cost.catalogStatements + (workerCost?.catalogStatements ?? 0),
                plans: measured.cost.plans + (workerCost?.plans ?? 0),
                blocks: measured.cost.blocks + (workerCost?.blocks ?? 0),
                sharedHit: measured.cost.sharedHit + (workerCost?.sharedHit ?? 0),
                sharedRead: measured.cost.sharedRead + (workerCost?.sharedRead ?? 0),
                relations,
              };
              const costs = measuredCosts.get(groupKey(group)) ?? [];
              costs.push(cost);
              measuredCosts.set(groupKey(group), costs);
            }
          }

          for (const group of groups) {
            const operation = group.operation;
            const combined = (measuredCosts.get(groupKey(group)) ?? []).map((cost, index) => ({
              scale: scales[index]!,
              cost,
            }));
            assertGrowth(combined, { rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
            for (const sample of combined) {
              for (const [relation, relationCost] of Object.entries(sample.cost.relations ?? {}))
                if (relation.startsWith('content.') && (relationCost.sequentialScans ?? 0) > 0)
                  throw new Error(`Growth ${operation} used a content sequential scan on ${relation}`);
              if (!(sample.cost.rows > 0 && sample.cost.statements > 0 && sample.cost.blocks > 0))
                throw new Error(`Growth ${operation} did not observe native SQL rows, statements and buffers`);
              sampleRows.push({
                scale: sample.scale,
                changedRows: group.changedRows,
                operation,
                rows: sample.cost.rows,
                statements: sample.cost.statements,
                buffers: sample.cost.blocks,
                documentBytes: input.documentBytes,
                imageBytes,
                samePartition: tuplePartition === container.partition,
              });
            }
          }
        } finally {
          if (queryDescriptor) Object.defineProperty(appPool, 'query', queryDescriptor);
          else Reflect.deleteProperty(appPool, 'query');
          if (connectDescriptor) Object.defineProperty(appPool, 'connect', connectDescriptor);
          else Reflect.deleteProperty(appPool, 'connect');
          await growth.close();
        }
        sampleRows.sort((left, right) => {
          const operationOrder =
            ['hook', 'fence', 'reference', 'import', 'job'].indexOf(left.operation) -
            ['hook', 'fence', 'reference', 'import', 'job'].indexOf(right.operation);
          return left.changedRows - right.changedRows || operationOrder || left.scale - right.scale;
        });
        return {
          harness: 'checkGrowth',
          seedCalls: [...seededScales].sort((left, right) => left - right),
          passed: seededScales.size === scales.length && sampleRows.length === 30,
          samples: sampleRows,
        };
      },
      close,
    };

    async function readMedia(mediaId: string): Promise<Media> {
      const route = routeOf(mediaId);
      if (route === null) throw new Error('Media id is not routable');
      const row = await pool.query<{
        media_id: string;
        uploader_id: string;
        state: string;
        claimed_at: string | null;
        purpose: string;
        credit: unknown;
        source_url: string;
        provenance: unknown;
        transaction_id: string;
        partition_no: number;
      }>(
        `SELECT media_id::text, uploader_id::text, state, claimed_at::text, purpose, credit, source_url, provenance,
                transaction_id::text, route >> 4 AS partition_no
         FROM content.media WHERE route=$1 AND media_id=$2`,
        [route, mediaId],
      );
      const item = row.rows[0];
      if (!item) throw new Error(`Native media row ${mediaId} is missing`);
      const original = store!.objects.get(`m/${mediaId}/original`) ?? new Uint8Array();
      const credit = decodeJson(item.credit);
      const via = decodeJson(credit.via);
      const events = await pool.query<{ type: string }>(
        `SELECT type FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY position,event_seq`,
        [item.partition_no, mediaId],
      );
      const transitions: string[] = [];
      for (const event of events.rows) {
        if (
          event.type === 'com.rezics.content.media.reserved.v1' ||
          event.type === 'com.rezics.content.media.import-requested.v1'
        )
          transitions.push('reserved');
        if (event.type === 'com.rezics.content.media.uploaded.v1') transitions.push('uploaded');
        if (event.type === 'com.rezics.content.media.available.v1') transitions.push('available');
        if (event.type === 'com.rezics.content.media.rejected.v1') transitions.push('rejected');
      }
      const variants = await pool.query<{ key: string }>(
        'SELECT key FROM content.media_variant WHERE route=$1 AND media_id=$2',
        [route, mediaId],
      );
      const storedKeys = [
        ...new Set([...store!.keys(`m/${mediaId}/`), ...variants.rows.map((variant) => variant.key)]),
      ].sort();
      const references = decodeJson(item.provenance);
      return {
        id: mediaId,
        uploaderId: item.uploader_id,
        partition: item.partition_no,
        state: item.state === 'available' ? 'available' : 'rejected',
        transitions,
        bytes: Uint8Array.from(original),
        storedKeys,
        claimedAt: item.claimed_at,
        role:
          item.purpose === 'cover'
            ? 'cover'
            : (() => {
                throw new Error(`Imported media ${mediaId} has purpose ${item.purpose}`);
              })(),
        credit: `(c) ${String(credit.rightsHolder)}; via ${String(via.name)} (${String(via.url)})`,
        sourceLink: String(via.url ?? parseReferences(references.references)[0] ?? ''),
        imageLicence: credit.license === 'LicenseRef-unknown' ? null : String(credit.license ?? ''),
      };
    }

    return importedDriver;
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Driver setup and cleanup failed');
    }
    throw error;
  }
}
