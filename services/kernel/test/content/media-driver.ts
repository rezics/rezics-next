import { afterAll, mock } from 'bun:test';
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
import { checkStatement } from '../support/partition-binding.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createContentSystem, type ContentCredential, type ContentSystem } from './support/system.ts';
import { observeSql, permissionResourceId, type SqlExecution } from './support/sql-observer.ts';
import { digest, embeddedMetadata, imageSource, provisionMediaContainers } from './support/media-fixtures.ts';
import { createMediaStorage, StorageDeleteFailure } from './support/storage.ts';

const realSharp = sharp;
type OpenApiResponse = {
  content?: Record<string, { schema?: { properties?: { code?: { const?: unknown; enum?: unknown[] } } } }>;
};
type OpenApiOperation = { responses?: Record<string, OpenApiResponse> };
type OpenApiPaths = Record<string, Record<string, unknown>>;
const openApiDocument = (await Bun.file(new URL('../../../../contracts/openapi.json', import.meta.url)).json()) as {
  paths: OpenApiPaths;
};
const documentedOutcomeRoutes = Object.entries(openApiDocument.paths).flatMap(([path, operations]) =>
  Object.entries(operations).flatMap(([method, candidate]) => {
    if (!candidate || typeof candidate !== 'object' || !('responses' in candidate)) return [];
    const responses = candidate.responses as OpenApiOperation['responses'];
    if (!responses || typeof responses !== 'object') return [];
    const routePattern = new RegExp(
      `^${path
        .split(/(\{[^}]+\})/g)
        .map((part) =>
          part.startsWith('{') && part.endsWith('}') ? '[^/:]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('')}$`,
    );
    const refusalCodes = new Map<string, Set<string>>();
    for (const [status, response] of Object.entries(responses)) {
      if (!['401', '403', '404', '409'].includes(status)) continue;
      const code = response.content?.['application/problem+json']?.schema?.properties?.code;
      const documentedCodes = [code?.const, ...(code?.enum ?? [])].map(String);
      const refusals = new Set(
        documentedCodes.filter((value) =>
          ['authentication_required', 'invalid_credentials', 'forbidden', 'not_found', 'media_unavailable'].includes(
            value,
          ),
        ),
      );
      if (refusals.size > 0) refusalCodes.set(status, refusals);
    }
    return [{ method: method.toUpperCase(), routePattern, statuses: new Set(Object.keys(responses)), refusalCodes }];
  }),
);

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

type MediaScenario = { system: ContentSystem; anchors: Awaited<ReturnType<typeof provisionMediaContainers>> };
let scenario: MediaScenario | undefined;

type SharedContentSystem = {
  databaseUrl: string;
  system: ContentSystem;
  jobPool: Pool;
  collectionBinding: Awaited<ReturnType<typeof checkStatement>>;
  onAuthentication: ((bearer: string, actor: AccountActor) => void) | undefined;
  closing?: Promise<void>;
};

let sharedSystemPromise: Promise<SharedContentSystem> | undefined;
let activeDrivers = 0;

function createSharedContentSystem(databaseUrl: string): Promise<SharedContentSystem> {
  let pending: Promise<SharedContentSystem>;
  pending = (async () => {
    const system = await createContentSystem({ databaseUrl });
    const jobPool = new Pool({ ...system.database.pool.options, max: 4 });
    try {
      const collectionBinding = await checkStatement(jobPool, {
        sql: selectCandidates.sql,
        params: [...selectCandidates.params],
      });
      const shared: SharedContentSystem = {
        databaseUrl,
        system,
        jobPool,
        collectionBinding,
        onAuthentication: undefined,
      };
      const authenticate = system.access.authenticate.bind(system.access);
      system.access.authenticate = async (bearer, context) => {
        const actor = await authenticate(bearer, context);
        if (bearer) shared.onAuthentication?.(bearer, actor);
        return actor;
      };
      return shared;
    } catch (error) {
      try {
        await jobPool.end();
        await system.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Shared content fixture construction and cleanup failed');
      }
      throw error;
    }
  })().catch((error) => {
    if (sharedSystemPromise === pending) sharedSystemPromise = undefined;
    throw error;
  });
  sharedSystemPromise = pending;
  return pending;
}

async function acquireSharedContentSystem(databaseUrl: string): Promise<SharedContentSystem> {
  const shared = await (sharedSystemPromise ?? createSharedContentSystem(databaseUrl));
  if (shared.databaseUrl !== databaseUrl) throw new Error('A media test process cannot switch database templates');
  if (shared.closing) throw new Error('The shared content fixture is already closing');
  activeDrivers++;
  return shared;
}

async function releaseSharedContentSystem(): Promise<void> {
  if (activeDrivers < 1) throw new Error('Shared content driver reference count underflow');
  activeDrivers--;
}

async function closeSharedContentSystem(): Promise<void> {
  const pending = sharedSystemPromise;
  if (!pending) return;
  const shared = await pending;
  if (shared.closing) return shared.closing;
  shared.closing = (async () => {
    const errors: unknown[] = [];
    try {
      await shared.jobPool.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await shared.system.close();
    } catch (error) {
      errors.push(error);
    }
    shared.onAuthentication = undefined;
    if (scenario?.system === shared.system) scenario = undefined;
    if (sharedSystemPromise === pending) sharedSystemPromise = undefined;
    if (errors.length) throw new AggregateError(errors, 'Shared content fixture cleanup failed');
  })();
  return shared.closing;
}

afterAll(closeSharedContentSystem);
process.once('beforeExit', () => void closeSharedContentSystem());

/** The focused growth test shares the unchanged suite's ordinary beforeEach fixture. */
export function currentMediaScenario() {
  if (!scenario) throw new Error('The native media scenario has not been opened');
  return scenario;
}

function outcomeRoute(method: string, path: string) {
  let pathname: string;
  try {
    pathname = new URL(path, 'https://content.test').pathname;
  } catch {
    pathname = path.split('?')[0]!;
  }
  return documentedOutcomeRoutes.find(
    (route) => route.method === method.toUpperCase() && route.routePattern.test(pathname),
  );
}

async function problemBody(response: Response): Promise<string> {
  try {
    return await response.clone().text();
  } catch (error) {
    return `[problem body unavailable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

/** Classify a media command response against the route statuses in contracts/openapi.json. */
export async function classifyMediaOutcome(
  response: Response,
  method: string,
  path: string,
  invalid = false,
): Promise<Outcome> {
  const route = outcomeRoute(method, path);
  const documented = route?.statuses.has(String(response.status)) ?? false;
  const succeeds = documented && response.status >= 200 && response.status < 300;
  const validation = documented && (response.status === 400 || response.status === 422);
  if (succeeds) return 'permitted';
  if (invalid && validation) return 'invalid';
  if (['401', '403', '404'].includes(String(response.status)) && documented) return 'denied';
  if (response.status === 409 && route?.refusalCodes.get('409')?.size) {
    let code: unknown;
    try {
      code = ((await response.clone().json()) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }
    if (typeof code === 'string' && route.refusalCodes.get('409')?.has(code)) return 'denied';
  }
  throw new Error(`Kernel ${method} ${path} (${response.status}): ${await problemBody(response)}`);
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
  const shared = await acquireSharedContentSystem(databaseUrl);
  const system = shared.system;
  const pool = system.database.pool;
  const observer = observeSql(pool);
  const jobObserver = observeSql(shared.jobPool);
  const bytes = createMediaStorage();
  const namespace = crypto.randomUUID();
  const mediaIds = new Set<string>();
  const requestIdToWire = new Map<string, string>();
  const wireToRequestId = new Map<string, string>();
  const wireRequestId = (requestId: string) => {
    let wire = requestIdToWire.get(requestId);
    if (!wire) {
      wire = `${namespace}:${requestId}`;
      requestIdToWire.set(requestId, wire);
      wireToRequestId.set(wire, requestId);
    }
    return wire;
  };
  const visibleRequestId = (requestId: string) => wireToRequestId.get(requestId) ?? requestId;
  const verified = new Map<string, AccountActor>();
  const captureAuthentication = (bearer: string, actor: AccountActor) => verified.set(bearer, actor);
  shared.onAuthentication = captureAuthentication;
  let mediaScenario: MediaScenario | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      if (scenario === mediaScenario) scenario = undefined;
      observeSharp = undefined;
      if (shared.onAuthentication === captureAuthentication) shared.onAuthentication = undefined;
      for (const release of [
        () => jobObserver.close(),
        () => observer.close(),
        () => bytes.close(),
        releaseSharedContentSystem,
      ]) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Media driver cleanup failed');
    })());
  try {
    await pool.query('TRUNCATE access.write_rate_counter');
    // A fresh native system starts with its wall clock unset. Reproduce that
    // fixture boundary before creating resources so later tests can move the
    // command clock to an earlier fixed instant without predating their grants.
    await system.clock.setCommandTime(new Date().toISOString());
    const { containers, posts } = await provisionMediaContainers(system, { namespace });
    const baseline = await pool.query<{ transaction_id: string }>('SELECT transaction_id::text FROM core.receipt');
    const setupTransactions = baseline.rows.map((row) => row.transaction_id);
    const issueFresh = (original: ContentCredential) =>
      system.auth.issue({
        accountId: original.actor.accountId,
        clientId: original.actor.clientId,
        scopes: [...original.actor.scopes],
        ...(original.actor.requestedBy === null ? {} : { requestedBy: original.actor.requestedBy }),
      });
    const credentials: Record<Exclude<Persona, 'anonymous' | 'job'>, ContentCredential> = {
      author: await issueFresh(system.actors.author),
      other: await issueFresh(system.actors.other),
      moderator: await issueFresh(system.actors.moderator),
      suspended: { ...system.actors.suspended, actor: { ...system.actors.suspended.actor } },
      worker: await issueFresh(system.actors.worker),
      'other-worker': await issueFresh(system.actors.otherWorker),
    };
    const authEvidence = new Map<string, AccountActor>();
    const reservationTraces = new Map<string, readonly SqlExecution[]>();
    const completionTargets = new Map<string, string>();
    const references = new Map<string, { body: Record<string, unknown>; path: string; match?: string }>();
    const processing = new Map<string, SharpOptions[]>();
    let now: string | undefined;
    const collection = createCollectionJob(shared.jobPool, bytes.storage, { clock: () => new Date(now ?? Date.now()) });
    const image = createImageJob(shared.jobPool, bytes.storage);
    const erasure = createErasureJob(shared.jobPool, bytes.storage);
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
      if (requestId) headers.set('idempotency-key', JSON.stringify(wireRequestId(requestId)));
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
      if (!response.ok) {
        const bodyText = await response.clone().text();
        let problem: Record<string, unknown>;
        try {
          problem = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          throw new Error(`Kernel ${method} ${path} (${response.status}): ${bodyText}`);
        }
        const expected = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'not_applicable' : 'not_applied';
        if (problem.effect_status !== expected)
          throw new Error(`Kernel ${method} ${path} (${response.status}): ${bodyText}`);
      }
      return response;
    }

    async function mediaRows(): Promise<Media[]> {
      const result = await pool.query(
        `SELECT media_id::text AS id,key,container_id::text AS "containerId",
        uploader_id::text AS "uploaderId",route,purpose,media_type AS type,byte_count,
        COALESCE(sha256,declared_sha256) AS sha256,state,erased,created_at,claimed_at,decision
        FROM content.media WHERE media_id::text=ANY($1::text[]) ORDER BY media_id`,
        [[...mediaIds]],
      );
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
      return classifyMediaOutcome(
        await send(
          as,
          'POST',
          captured.path,
          input.requestId,
          captured.body,
          captured.match ? { 'if-match': captured.match } : undefined,
        ),
        'POST',
        captured.path,
        true,
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
          const hasRouteCondition = shared.collectionBinding.bound && shared.collectionBinding.parameter === 'route';
          return {
            partition: partitionOf(route),
            bound: hasRouteCondition && Number.isInteger(route) && partitionOf(route) === partition,
            globalScan: !hasRouteCondition,
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
        const result = await classifyMediaOutcome(response, 'POST', '/v1/media', true);
        if (result !== 'permitted') return { outcome: result };
        const { media: reservation } = await response.json();
        mediaIds.add(reservation.id);
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
        const anchorId = permissionResourceId(check, permissionRead.params);
        const account = String(parameter(check, permissionRead.params, 'actor_id'));
        const authoritativeTime = instant(parameter(check, permissionRead.params, 'at'));
        const permissionIds = records
          .filter(
            (record) =>
              record.statement === permissionRead.sql &&
              parameter(record, permissionRead.params, 'action') === 'media:create',
          )
          .map((record) => permissionResourceId(record, permissionRead.params));
        const reserved = (
          await pool.query<{ media_id: string }>(
            `SELECT media_id::text FROM content.media
          WHERE route=$1 AND uploader_id=$2 AND reservation_request_id=$3`,
            [route, account, wireRequestId(requestId)],
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
        const path = `/v1/media/${target}:complete`;
        return classifyMediaOutcome(
          await send(as, 'POST', path, input.requestId, {
            containerId: container,
            reservationRequestId: wireRequestId(input.reservationRequestId),
            byteCount: input.byteCount,
            sha256: input.sha256,
          }),
          'POST',
          path,
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
        const path = `/v1/media/${objectId}:authorizeDownload?variant=${variant}`;
        const response = await send(
          as,
          'GET',
          path,
          undefined,
          undefined,
          conditional ? { 'if-none-match': JSON.stringify(conditional.ifNoneMatch) } : undefined,
        );
        if (!response.ok) {
          const result = await classifyMediaOutcome(response, 'GET', path);
          if (result !== 'denied') throw new Error(`Download returned an unexpected ${result} outcome`);
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
            references: refs.rows.map((row) => ({ ...row, commandId: visibleRequestId(row.commandId) })),
            receipts: receipts.rows.map((row) => ({
              requestId: visibleRequestId(row.requestId),
              effects: Number(row.effects),
            })),
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
    mediaScenario = { system, anchors: { containers, posts } };
    scenario = mediaScenario;
    return driver;
  } catch (error) {
    await close();
    throw error;
  }
}
