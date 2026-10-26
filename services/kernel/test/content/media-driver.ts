import { mock } from 'bun:test';
import { Pool } from 'pg';
import sharp, { type SharpInput, type SharpOptions } from 'sharp';
import type {
  ContentMediaDriver,
  Media,
  Outcome,
  Persona,
  ReferenceCommand,
  CollectionRun,
} from '../../../../specs/content-media-driver.ts';
import permissionRead from '../../src/access/permission-check.sql';
import { CommandUnavailableError } from '../../src/command/command.ts';
import commandFence from '../../src/command/fence.sql';
import claimMedia from '../../src/content/claim-media.sql';
import fenceCollection from '../../src/content/fence-collection.sql';
import selectCandidates from '../../src/content/select-collectable-media.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createContentSystem, type ContentCredential } from './support/system.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import { digest, embeddedMetadata, imageSource, provisionMediaContainers } from './support/media-fixtures.ts';
import { createMediaStorage, StorageDeleteFailure } from './support/storage.ts';

const realSharp = sharp;
let observeSharp: ((options: SharpOptions | undefined) => void) | undefined;
// A forwarding dependency observer: native Sharp still constructs, decodes and encodes every image.
mock.module('sharp', () => ({
  default: Object.assign((input: SharpInput, options?: SharpOptions) => {
    observeSharp?.(options);
    return realSharp(input, options);
  }, realSharp),
}));
const { createImageJob } = await import('../../src/content/image-job.ts');
const { createCollectionJob } = await import('../../src/content/collection-job.ts');
const { createErasureJob } = await import('../../src/content/erasure-job.ts');

function outcome(response: Response, invalid = false): Outcome {
  if (response.ok) return 'permitted';
  if (invalid && (response.status === 400 || response.status === 422)) return 'invalid';
  return 'denied';
}
function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new TypeError('Expected a stored timestamp');
}
function parameter(record: SqlExecution, names: readonly string[], name: string): unknown {
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`Missing SQL parameter ${name}`);
  return record.parameters[index];
}

export async function createContentMediaDriver(): Promise<ContentMediaDriver> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated application template');
  const system = await createContentSystem({ databaseUrl });
  const pool = system.database.pool;
  const observer = observeSql(pool);
  // The API and trusted worker run in separate hosts. Separate real pools also
  // keep their process-local command gates independent during PostgreSQL races.
  const jobPool = new Pool({ ...pool.options, max: 4 });
  const jobObserver = observeSql(jobPool);
  const bytes = createMediaStorage();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      observeSharp = undefined;
      await jobObserver.close();
      await jobPool.end();
      await observer.close();
      bytes.close();
      await system.close();
    })());
  try {
    const { containers, posts } = await provisionMediaContainers(system);
    const baseline = await pool.query<{ transaction_id: string }>('SELECT transaction_id::text FROM core.receipt');
    const setupTransactions = baseline.rows.map((row) => row.transaction_id);
    const credentials: Record<Exclude<Persona, 'anonymous' | 'job'>, ContentCredential> = {
      author: system.actors.author,
      other: system.actors.other,
      moderator: system.actors.moderator,
      suspended: system.actors.suspended,
      worker: system.actors.worker,
      'other-worker': system.actors.otherWorker,
    };
    const verified = new Map<string, AccountActor>();
    const authenticate = system.access.authenticate.bind(system.access);
    system.access.authenticate = async (bearer, context) => {
      const actor = await authenticate(bearer, context);
      if (bearer && actor.kind === 'account') verified.set(bearer, actor);
      return actor;
    };
    const authEvidence = new Map<string, AccountActor>();
    const reservationTraces = new Map<string, readonly SqlExecution[]>();
    const completionTargets = new Map<string, string>();
    const references = new Map<string, { body: Record<string, unknown>; path: string; match?: string }>();
    const processing = new Map<string, SharpOptions[]>();
    let now: string | undefined;
    const collection = createCollectionJob(jobPool, bytes.storage, { clock: () => new Date(now ?? Date.now()) });
    const image = createImageJob(jobPool, bytes.storage);
    const erasure = createErasureJob(jobPool, bytes.storage);
    // Service capabilities are closed over here. HTTP personas have credentials,
    // never an image/collection capability; their denial does not inspect account names.
    const jobCapabilities = new Map<Persona, { image: typeof image; collection: typeof collection }>([
      ['job', { image, collection }],
    ]);

    async function send(
      as: Persona,
      method: string,
      path: string,
      requestId?: string,
      body?: Record<string, unknown>,
      extra?: Record<string, string>,
    ): Promise<Response> {
      const credential = as === 'anonymous' || as === 'job' ? undefined : credentials[as];
      const headers = new Headers(extra);
      if (credential) headers.set('authorization', `Bearer ${credential.bearer}`);
      if (requestId) headers.set('idempotency-key', JSON.stringify(requestId));
      if (body) headers.set('content-type', 'application/json');
      const { response } = await system.transport.capture(
        new Request(`https://content.test${path}`, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      if (credential && requestId) {
        const actor = verified.get(credential.bearer);
        if (actor) authEvidence.set(`${as}:${requestId}`, actor);
      }
      if (response.status >= 500 && response.status !== 503)
        throw new Error(`Kernel ${method} ${path} failed (${response.status}): ${await response.clone().text()}`);
      if (!response.ok) {
        const problem = await response.clone().json();
        const expected = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'not_applicable' : 'not_applied';
        if (problem.effect_status !== expected)
          throw new Error(`Kernel ${method} ${path} returned an inconsistent problem effect status`);
      }
      return response;
    }

    async function mediaRows(): Promise<Media[]> {
      const result = await pool.query(`SELECT media_id::text AS id,key,container_id::text AS "containerId",
        uploader_id::text AS "uploaderId",route,purpose,media_type AS type,byte_count,
        COALESCE(sha256,declared_sha256) AS sha256,state,erased,created_at,claimed_at,decision
        FROM content.media ORDER BY media_id`);
      return result.rows.map((row) => ({
        id: row.id,
        key: row.key,
        containerId: row.containerId,
        uploaderId: row.uploaderId,
        route: row.route,
        partition: partitionOf(row.route),
        purpose: row.purpose,
        type: row.type,
        length: Number(row.byte_count),
        sha256: row.sha256,
        state: row.state,
        erased: row.erased,
        createdAt: instant(row.created_at),
        claimedAt: row.claimed_at === null ? null : instant(row.claimed_at),
        decision: row.decision,
      }));
    }
    function routed(id: string, fallback = containers.thread.route): string {
      return routeOf(id) === null ? newId(fallback) : id;
    }
    async function deny(resourceId: string, action: string) {
      await pool.query(
        `INSERT INTO access.resource_denial
          (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
          VALUES ($1,$2,$3,'',$4,'resource',tstzrange($5::timestamptz,NULL,'[)'),$6)`,
        [routeOf(resourceId), resourceId, credentials.author.actor.accountId, action, now, crypto.randomUUID()],
      );
    }
    async function reference(as: Persona, input: ReferenceCommand): Promise<Outcome> {
      let captured = references.get(input.requestId);
      if (!captured) {
        const containerId = routed(input.containerId);
        const post = posts.get(containerId);
        captured = {
          path:
            input.kind === 'post'
              ? `/v1/threads/${containerId}/posts`
              : `/v1/posts/${post?.id ?? newId(routeOf(containerId)!)}/revisions`,
          body: { body: input.document, licence: 'MIT', mediaIds: input.mediaIds, ...input.untrusted },
          ...(input.kind === 'revision' && post ? { match: JSON.stringify(post.revisionId) } : {}),
        };
        references.set(input.requestId, captured);
      }
      return outcome(
        await send(
          as,
          'POST',
          captured.path,
          input.requestId,
          captured.body,
          captured.match ? { 'if-match': captured.match } : undefined,
        ),
      );
    }
    async function collect(as: Persona, partition: number): Promise<CollectionRun> {
      const capability = jobCapabilities.get(as);
      if (!capability) return { outcome: 'denied', selections: [] };
      const start = jobObserver.records.length;
      let result: Outcome = 'permitted';
      try {
        await capability.collection.collectPartition(partition, 100);
      } catch (error) {
        if (!(error instanceof StorageDeleteFailure)) throw error;
        result = 'denied';
      }
      const selections = jobObserver.records
        .slice(start)
        .filter((record) => record.statement === selectCandidates.sql)
        .map((record) => {
          const route = Number(parameter(record, selectCandidates.params, 'route'));
          const pendingRoute = Number(parameter(record, selectCandidates.params, 'pending_route'));
          return {
            partition: partitionOf(route),
            bound: Number.isInteger(route) && route === pendingRoute,
            globalScan: !/WHERE route = \$\d+::integer/.test(record.statement),
          };
        });
      return { outcome: result, selections };
    }

    const driver: ContentMediaDriver = {
      authorId: system.actors.author.actor.accountId,
      containers,
      close,
      async reserve(as, input) {
        const mark = observer.records.length;
        const response = await send(as, 'POST', '/v1/media', input.requestId, {
          containerId: routed(input.containerId),
          purpose: input.purpose,
          mediaType: input.type,
          byteCount: input.length,
          ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
        });
        reservationTraces.set(input.requestId, observer.records.slice(mark));
        const result = outcome(response, true);
        if (result !== 'permitted') return { outcome: result };
        const { media: reservation } = await response.json();
        completionTargets.set(`${input.containerId}:${input.requestId}`, reservation.id);
        // The uploader-only reservation read is itself a real HTTP operation.
        const read = await send(as, 'GET', `/v1/media/${reservation.id}`);
        if (read.status !== 200)
          throw new Error(`Uploader reservation GET failed (${read.status}): ${await read.text()}`);
        const view = (await read.json()).media;
        const media = (await mediaRows()).find((row) => row.id === view.id);
        if (!media) throw new Error('Committed reservation is absent from PostgreSQL');
        return { outcome: 'permitted', media };
      },
      async reservationEvidence(requestId) {
        const records = reservationTraces.get(requestId);
        const check = records?.find(
          (record) =>
            record.statement === permissionRead.sql &&
            parameter(record, permissionRead.params, 'action') === 'media:create',
        );
        if (!check || !records) throw new Error('No executed media:create permission check');
        const route = Number(parameter(check, permissionRead.params, 'route'));
        const anchorId = String(parameter(check, permissionRead.params, 'resource_id'));
        const account = String(parameter(check, permissionRead.params, 'actor_id'));
        const authoritativeTime = instant(parameter(check, permissionRead.params, 'at'));
        const permissionIds = records
          .filter(
            (record) =>
              record.statement === permissionRead.sql &&
              parameter(record, permissionRead.params, 'action') === 'media:create',
          )
          .map((record) => String(parameter(record, permissionRead.params, 'resource_id')));
        const reserved = (
          await pool.query<{ media_id: string }>(
            `SELECT media_id::text FROM content.media
          WHERE route=$1 AND uploader_id=$2 AND reservation_request_id=$3`,
            [route, account, requestId],
          )
        ).rows[0];
        return {
          action: String(parameter(check, permissionRead.params, 'action')),
          anchorId,
          partition: partitionOf(route),
          anchored: records.some(
            (record) => /FROM core.partition/.test(record.statement) && record.parameters.includes(partitionOf(route)),
          ),
          authoritativeTime,
          newObjectGrant: !!reserved && permissionIds.includes(reserved.media_id),
        };
      },
      async complete(as, input) {
        const container = routed(input.containerId);
        const target =
          completionTargets.get(`${input.containerId}:${input.reservationRequestId}`) ?? newId(routeOf(container)!);
        // The HTTP schema takes uploader identity and completion scope only from the bearer token.
        return outcome(
          await send(as, 'POST', `/v1/media/${target}:complete`, input.requestId, {
            containerId: container,
            reservationRequestId: input.reservationRequestId,
            byteCount: input.byteCount,
            sha256: input.sha256,
          }),
        );
      },
      async authenticationEvidence(as, requestId) {
        const actor = authEvidence.get(`${as}:${requestId}`);
        if (!actor) throw new Error(`No verifier output for ${as} request ${requestId}`);
        return {
          sub: actor.accountId,
          clientId: actor.clientId,
          scopes: [...actor.scopes],
          registeredWebsiteClientId: system.auth.websiteClient.id,
        };
      },
      async process(as, objectId) {
        const capability = jobCapabilities.get(as);
        if (!capability) return 'denied';
        const invocations: SharpOptions[] = [];
        observeSharp = (options) => {
          if (options) invocations.push(structuredClone(options));
        };
        try {
          await capability.image.process(objectId);
          if (invocations.length) processing.set(objectId, invocations);
          return 'permitted';
        } catch (error) {
          if (error instanceof Error && error.message === 'Image has not been uploaded') return 'denied';
          throw error;
        } finally {
          observeSharp = undefined;
        }
      },
      reference,
      async download(as, objectId, representation, conditional) {
        const route = routeOf(objectId);
        if (route === null) throw new Error('Download requires an actual routed ID');
        const variant =
          representation === 'original'
            ? 'original'
            : ((
                await pool.query<{ variant: string }>(
                  `SELECT format||'-'||width AS variant FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width LIMIT 1`,
                  [route, objectId],
                )
              ).rows[0]?.variant ?? 'webp-320');
        const response = await send(
          as,
          'GET',
          `/v1/media/${objectId}:authorizeDownload?variant=${variant}`,
          undefined,
          undefined,
          conditional ? { 'if-none-match': JSON.stringify(conditional.ifNoneMatch) } : undefined,
        );
        if (!response.ok) {
          if (response.status !== 404 && response.status !== 401)
            throw new Error(`Download denied with unexpected status ${response.status}`);
          const problem = await response.json();
          if ('key' in problem) throw new Error('Denied download disclosed a storage key');
          return { outcome: 'denied' };
        }
        const decision = await response.json();
        if (
          decision.publicCache !== false ||
          !decision.cacheControl.startsWith('private, ') ||
          response.headers.get('cache-control') !== decision.cacheControl
        )
          throw new Error('Download bypassed private revalidation');
        const output = await bytes.storage.get(decision.key);
        if (!output || decision.byteCount !== output.byteLength || decision.sha256 !== digest(output))
          throw new Error('Download decision does not match the external storage bytes');
        return { outcome: 'permitted', key: decision.key, representation, sha256: decision.sha256 };
      },
      collect,
      async inspect() {
        const client = await pool.connect();
        try {
          const receipts = await client.query<{ requestId: string; effects: string }>(
            `SELECT r.idempotency_key AS "requestId",
            (SELECT count(*) FROM core.outbox o WHERE o.partition_no=r.partition_no AND o.position=r.position)::text AS effects
            FROM core.receipt r WHERE NOT (r.transaction_id=ANY($1::uuid[])) ORDER BY r.idempotency_key`,
            [setupTransactions],
          );
          const refs = await client.query<{ commandId: string; mediaIds: string[]; partition: number }>(
            `SELECT c.idempotency_key AS "commandId",
            r.media_ids AS "mediaIds",c.partition_no AS partition FROM core.receipt c
            JOIN content.revision r ON r.recorded_transaction_id=c.transaction_id
            WHERE c.command_kind IN ('content.post.create','content.post.revise') AND NOT (c.transaction_id=ANY($1::uuid[]))
            ORDER BY c.idempotency_key`,
            [setupTransactions],
          );
          return {
            media: await mediaRows(),
            references: refs.rows,
            receipts: receipts.rows.map((row) => ({ requestId: row.requestId, effects: Number(row.effects) })),
            storage: bytes.inspect(),
          };
        } finally {
          client.release();
        }
      },
      async derivatives(objectId) {
        const rows = await pool.query<{ key: string }>(
          'SELECT key FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width',
          [routeOf(objectId), objectId],
        );
        return Promise.all(
          rows.rows.map(async ({ key }) => {
            const output = await bytes.storage.get(key);
            if (!output) throw new Error(`Missing derivative bytes at ${key}`);
            return { key, bytes: output };
          }),
        );
      },
      async decode(input) {
        const metadata = await realSharp(input).metadata();
        await realSharp(input, { failOn: 'warning' }).raw().toBuffer();
        const format = metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format;
        if (format !== 'avif' && format !== 'webp') throw new Error(`Unexpected derivative format ${format}`);
        return { format, width: metadata.width, height: metadata.height, metadata: embeddedMetadata(metadata) };
      },
      async processingEvidence(objectId) {
        const calls = processing.get(objectId);
        const decode = calls?.find((options) => !options.raw);
        if (
          !decode ||
          calls?.some(
            (options) => options.limitInputPixels !== decode.limitInputPixels || options.failOn !== decode.failOn,
          )
        )
          throw new Error('Missing or inconsistent actual Sharp invocation options');
        if (typeof decode.limitInputPixels !== 'number' || typeof decode.failOn !== 'string')
          throw new Error('Missing native decoder limits');
        return {
          sharpVersion: realSharp.versions.sharp,
          limitInputPixels: decode.limitInputPixels,
          failOn: decode.failOn,
          autoOrient: decode.autoOrient === true,
        };
      },
      source: imageSource,
      async placeOriginal(objectId, input) {
        const result = await pool.query<{ key: string; media_type: string }>(
          'SELECT key,media_type FROM content.media WHERE route=$1 AND media_id=$2',
          [routeOf(objectId), objectId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Cannot place bytes without a real reservation');
        await bytes.storage.put(row.key, input, { mediaType: row.media_type });
      },
      async setTime(value) {
        await system.clock.setCommandTime(value);
        now = value;
      },
      async setCreatedAt(objectId, value) {
        await pool.query('UPDATE content.media SET created_at=$3 WHERE route=$1 AND media_id=$2', [
          routeOf(objectId),
          objectId,
          value,
        ]);
      },
      async grantParent() {
        // content.thread.standing already permits every active account to post and reserve media.
      },
      async revokeMediaCreate(containerId) {
        await deny(containerId, 'media:create');
      },
      async removeWebsiteCompletionScope() {
        credentials.worker = await system.auth.issue({
          accountId: credentials.worker.actor.accountId,
          clientId: system.auth.websiteClient.id,
          scopes: credentials.worker.actor.scopes.filter((scope) => scope !== 'media:complete'),
        });
      },
      async revokeReferenceAuthority(containerId, kind) {
        await deny(
          kind === 'post' ? containerId : posts.get(containerId)!.id,
          kind === 'post' ? 'post:create' : 'post:revise',
        );
      },
      async setParentVisibility(value) {
        await pool.query(
          'UPDATE content.thread SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2',
          [containers.thread.route, containers.thread.id, value === 'private' ? 'protected' : 'taken_down'],
        );
      },
      async erase(objectId) {
        const response = await send('author', 'DELETE', `/v1/media/${objectId}`, crypto.randomUUID());
        if (response.status !== 204)
          throw new Error(`Media erasure failed (${response.status}): ${await response.text()}`);
        await erasure.purgeObject(objectId);
      },
      async failReferenceCommit() {
        observer.armFault({
          match: { statement: commandFence.sql },
          boundary: 'before',
          error: new CommandUnavailableError('overloaded', containers.thread.partition),
        });
      },
      async failNextStorageDelete(key) {
        bytes.failDelete(key);
      },
      async raceClaimCollection(input, objectId, first) {
        const partition = partitionOf(routeOf(objectId)!);
        if (first === 'claim') {
          const claimLocked = observer.hold({ statement: claimMedia.sql }, 'after');
          const claim = reference('author', input);
          await claimLocked.entered;
          const collectionFence = jobObserver.hold({ statement: fenceCollection.sql }, 'before');
          const collecting = collect('job', partition);
          await collectionFence.entered;
          collectionFence.release();
          claimLocked.release();
          const [claimResult, collectionResult] = await Promise.all([claim, collecting]);
          return { claim: claimResult, collection: collectionResult };
        }
        const collectionLocked = jobObserver.hold({ statement: fenceCollection.sql }, 'after');
        const collecting = collect('job', partition);
        await collectionLocked.entered;
        const claimStarted = observer.hold({ statement: claimMedia.sql }, 'before');
        const claim = reference('author', input);
        await claimStarted.entered;
        claimStarted.release();
        collectionLocked.release();
        const [claimResult, collectionResult] = await Promise.all([claim, collecting]);
        return { claim: claimResult, collection: collectionResult };
      },
    };
    return driver;
  } catch (error) {
    await close();
    throw error;
  }
}
