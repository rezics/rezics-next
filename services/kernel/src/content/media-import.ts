import {
  checkMediaImportRequest,
  checkMediaImportStatus,
  type MediaImportRequest,
  type MediaImportStatus,
} from '@rezics/definitions/media-import';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { initializeResourceGrants, parentCreationAuthorization, resourceAuthorization } from '../access/index.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  principalCommandIdentity,
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import readContext from '../semantic/read-context.sql';
import subjectExists from '../semantic/subject-exists.sql';
import { tupleRoute } from './imported-contract.ts';
import { readFences, type SourceFenceTuple } from './source-fences.ts';
import reserve from './reserve-import-media.sql';
import readStatus from './read-media-import-status.sql';

/** Trusted host configuration, never accepted as caller JSON. Runtime must
 * revalidate exact HTTPS hosts on every redirect and enforce fetch bounds.
 */
export type MediaImportFetchConfig = Readonly<{ allowedHosts: readonly string[] }>;
export interface MediaImportDependencies {
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  clock: () => Date;
  fetchConfig: MediaImportFetchConfig;
}
export type MediaImportContext = Readonly<{ deadline: number; idempotencyKey: string; requestId: string }>;

const platform = Object.freeze({ route: 0, id: '00000000-0000-8000-8000-000000000000' });
const action = 'media:import_from_url';
const kind = 'content.media.importFromUrl';

export type MediaCropTuple = [left: number, top: number, width: number, height: number];

export function mediaCropTuple(fragment?: string): MediaCropTuple | null {
  if (fragment === undefined) return null;
  const match = /^xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(fragment);
  if (!match) throw new TypeError('Invalid media import request');
  const values = match.slice(1).map(Number);
  if (
    values.some((number) => !Number.isSafeInteger(number) || number > 2_147_483_647) ||
    values[2]! < 1 ||
    values[3]! < 1
  )
    throw new TypeError('Invalid media import request');
  return values as unknown as MediaCropTuple;
}

export function mediaCropFragment(crop: readonly (number | null)[] | null): string | undefined {
  if (crop === null) return undefined;
  if (
    crop.length !== 4 ||
    crop.some((number) => number === null || !Number.isSafeInteger(number) || number < 0 || number > 2_147_483_647)
  )
    throw new TypeError('Invalid stored media crop');
  const values = crop as readonly number[];
  if (values[2]! < 1 || values[3]! < 1) throw new TypeError('Invalid stored media crop');
  return `xywh=${values.join(',')}`;
}

export class MediaImportConflictError extends Error {
  constructor() {
    super('The imported source is fenced or changed during preparation');
    this.name = 'MediaImportConflictError';
  }
}

async function validatePlatform(client: AccessClient): Promise<boolean> {
  if (!(await readPartition(client, partitionOf(platform.route)))) return false;
  const row = await readContext.run(client, { route: platform.route, context_id: platform.id });
  return row?.kind === 'global';
}

function allowedDomain(host: string): boolean {
  return (
    host.length <= 253 &&
    host === host.toLowerCase() &&
    !isIP(host) &&
    host.split('.').length >= 2 &&
    host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

/** Pure admission check. The worker separately enforces the policy on every redirect. */
function validateUrl(input: string, config: MediaImportFetchConfig): void {
  const hosts = config.allowedHosts;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 100 || !hosts.every(allowedDomain))
    throw new TypeError('Invalid media import allowlist');
  if (/[\s\\\u0000-\u001f\u007f]/u.test(input)) throw new TypeError('Invalid source URL');
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !allowedDomain(url.hostname) ||
    !hosts.includes(url.hostname)
  )
    throw new TypeError('Invalid source URL');
}

/** Each fact read owns one partition snapshot and releases it before the next anchor. */
async function anchoredRead<T>(
  deps: MediaImportDependencies,
  route: number,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(deps.pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        if (!(await readPartition(bounded, partitionOf(route)))) throw new Error('Missing import partition');
        const result = await read(bounded);
        await bounded.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }),
  );
}

function fenceTuple(deps: MediaImportDependencies, input: MediaImportRequest): SourceFenceTuple {
  const { source, external_id, field_group } = input.provenance;
  // The durable reference is the exact source/external_id/field_group in provenance.
  // Its home is derived with the same stable server key used by source governance.
  return { route: tupleRoute(deps.routeKey, source, external_id), source, external_id, field_group };
}

async function fence(deps: MediaImportDependencies, tuple: SourceFenceTuple, deadline: number) {
  return anchoredRead(deps, tuple.route, deadline, async (client) => (await readFences(client, [tuple]))[0]!);
}

/** Reserve in the command transaction. Cover claims remain in their caller's
 * command transaction; this port grants no publication permission.
 */
export async function importMediaFromUrl(
  deps: MediaImportDependencies,
  actor: Actor,
  input: MediaImportRequest,
  context: MediaImportContext,
): Promise<CommandOutcome<{ mediaId: string }>> {
  context = { ...context };
  if (actor.kind !== 'account') throw new GrantDeniedError();
  if (checkMediaImportRequest(input).length > 0) throw new TypeError('Invalid media import request');
  const body = structuredClone(input);
  validateUrl(body.sourceUrl, deps.fetchConfig);
  const route = routeOf(body.containerId);
  if (route === null) throw new TypeError('Invalid placement subject');
  if (!context.idempotencyKey || context.idempotencyKey.length > 255)
    throw new TypeError('Invalid media request identifier');
  const tuple = fenceTuple(deps, body);
  const resource = Object.freeze({ route, id: newId(route) });
  let inserted: { tx: CommandTransaction; transactionId: string } | undefined;
  const boundary = { pool: deps.pool, deadline: context.deadline };
  const base = parentCreationAuthorization({
    access: deps.access,
    actor,
    action,
    parent: { resource: platform, validate: validatePlatform },
    context: {
      ...boundary,
      resource,
      creation: {
        async validate(tx, target, time) {
          if (inserted?.tx !== tx) return false;
          const [row] = await readStatus.run(tx, { route: target.route, media_id: target.id });
          return (
            row !== undefined &&
            row.inserted_here === true &&
            row.transaction_id === inserted.transactionId &&
            row.uploader_id === actor.accountId &&
            row.container_id === body.containerId &&
            row.reservation_request_id === context.idempotencyKey &&
            row.purpose === 'cover' &&
            row.state === 'reserved' &&
            row.created_at !== null &&
            Date.parse(row.created_at) === Date.parse(authoritativeTimeValue(time))
          );
        },
      },
    },
  });
  const sourceAuthority = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'source_fence:read',
    anchor: { resource: platform, validate: validatePlatform },
    context: { ...boundary, partition: partitionOf(route) },
  });
  const proofs = new WeakMap<
    object,
    { attempt: CommandAttempt; sourceProof: unknown; creationProof: unknown; tx?: CommandTransaction }
  >();
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const sourceProof = await sourceAuthority.prepare!(attempt);
      const creationProof = await base.prepare!(attempt);
      // Establish both current permissions before disclosing a source state conflict.
      const before = await fence(deps, tuple, context.deadline);
      if (before.takenDown) throw new MediaImportConflictError();
      // Trusted source reference recheck immediately before target checkout.
      // A later governance change remains effective at every final disclosure.
      const current = await fence(deps, tuple, context.deadline);
      if (current.takenDown || current.securityRevision !== before.securityRevision)
        throw new MediaImportConflictError();
      // Keep both native proofs private and bind their composite to this attempt.
      const proof = Object.freeze({});
      proofs.set(proof, { attempt, sourceProof, creationProof });
      return proof;
    },
    async authorize(tx, attempt, evidence) {
      const proof = typeof evidence === 'object' && evidence !== null ? proofs.get(evidence) : undefined;
      if (!proof || proof.attempt !== attempt || proof.tx) throw new GrantDeniedError();
      proofs.delete(evidence as object);
      await sourceAuthority.authorize(tx, attempt, proof.sourceProof);
      await base.authorize(tx, attempt, proof.creationProof);
      // Placement is an actual resolved subject, checked in its own partition
      // before any receipt can be disclosed. It confers no creation authority.
      if (!(await subjectExists.run(tx, { route, subject_id: body.containerId }))) throw new GrantDeniedError();
      proofs.set(evidence as object, { ...proof, tx });
      return 'execute';
    },
    async finalize(tx, attempt, evidence) {
      const proof = typeof evidence === 'object' && evidence !== null ? proofs.get(evidence) : undefined;
      if (!proof || proof.attempt !== attempt || proof.tx !== tx) throw new GrantDeniedError();
      // Consume before delegating: finalization cannot reuse or replace either proof.
      proofs.delete(evidence as object);
      await base.finalize!(tx, attempt, proof.creationProof);
      await sourceAuthority.finalize?.(tx, attempt, proof.sourceProof);
    },
  };
  const identity = principalCommandIdentity(actor);
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, kind, body])!)
          .digest(),
      },
    },
    async (tx, command) => {
      const row = await reserve.run(tx, {
        route,
        media_id: resource.id,
        container_id: body.containerId,
        uploader_id: actor.accountId,
        reservation_request_id: context.idempotencyKey,
        key: `m/${resource.id}/original`,
        source_url: body.sourceUrl,
        credit: body.credit,
        provenance: body.provenance,
        crop: mediaCropTuple(body.crop),
        focal_x: body.focalPoint?.x ?? null,
        focal_y: body.focalPoint?.y ?? null,
        at: authoritativeTimeValue(command.time),
        transaction_id: command.transactionId,
      });
      if (row.media_id !== resource.id) throw new GrantDeniedError();
      inserted = { tx, transactionId: command.transactionId };
      await initializeResourceGrants(tx, { resource, type: 'content.media', creator: actor.accountId });
      return {
        value: { mediaId: resource.id },
        events: [
          {
            type: 'com.rezics.content.media.import-requested.v1',
            subject: resource.id,
            data: { mediaId: resource.id },
          },
        ],
      };
    },
  );
}

/** GET media/{id}:importStatus must use media:read_reservation, the current
 * uploader formula and denials, with no anonymous fallback. Hidden/unknown
 * objects have the same null result. This port exposes no HTTP handler.
 */
export async function readMediaImportStatus(
  deps: MediaImportDependencies,
  actor: Actor,
  id: string,
  context: Readonly<{ deadline: number }>,
): Promise<MediaImportStatus | null> {
  const route = routeOf(id);
  if (actor.kind !== 'account' || route === null || Date.now() >= context.deadline) return null;
  const check = await accessCheck(
    deps.access,
    actor,
    'media:read_reservation',
    { route, id },
    {
      pool: deps.pool,
      deadline: context.deadline,
    },
  );
  const row = await anchoredRead(deps, route, context.deadline, async (client) => {
    const time = await mintReadTime(client, deps.clock);
    if (!(await check(client, time))) return null;
    const [current] = await readStatus.run(client, { route, media_id: id });
    return current ?? null;
  });
  if (
    !row ||
    row.uploader_id !== actor.accountId ||
    row.purpose !== 'cover' ||
    row.erased ||
    row.taken_down ||
    (row.collection_pending && row.state !== 'rejected') ||
    routeOf(row.container_id) !== route
  )
    return null;
  const source = {
    containerId: row.container_id,
    sourceUrl: row.source_url,
    credit: row.credit,
    provenance: row.provenance,
    ...(row.crop === null ? {} : { crop: mediaCropFragment(row.crop) }),
    ...(row.focal_x === null || row.focal_y === null ? {} : { focalPoint: { x: row.focal_x, y: row.focal_y } }),
  };
  if (checkMediaImportRequest(source).length > 0) return null;
  const input = source as MediaImportRequest;
  const measured = row.state === 'uploaded' || row.state === 'available';
  if (
    measured &&
    (row.actual_byte_count === null || row.actual_byte_count !== row.byte_count || !row.sha256 || !row.media_type)
  )
    return null;
  if (row.state === 'available' && !row.has_variants) return null;
  const result = {
    media: {
      id,
      containerId: row.container_id,
      purpose: 'cover',
      state: row.state,
      byteCount: row.actual_byte_count === null ? null : Number(row.actual_byte_count),
      mediaType: row.media_type,
      sha256: row.sha256,
      credit: input.credit,
      provenance: input.provenance,
      ...(input.crop === undefined ? {} : { crop: input.crop }),
      ...(input.focalPoint === undefined ? {} : { focalPoint: input.focalPoint }),
      ...(row.state === 'rejected' ? { rejection: { code: rejectionCode(row.decision) } } : {}),
    },
  };
  if (checkMediaImportStatus(result).length > 0) return null;
  // Never infer restoration from reservation/processing success. Check governance
  // at the source tuple's current authoritative home after releasing the media read.
  if ((await fence(deps, fenceTuple(deps, input), context.deadline)).takenDown) return null;
  if (Date.now() >= context.deadline) return null;
  return result as MediaImportStatus;
}

function rejectionCode(decision: string | null): string {
  const code = decision?.split(':', 1)[0];
  return code === 'crop_out_of_bounds' ||
    (code && /^source-(?:url|bytes|headers|network|redirect|timeout|evidence|fenced|format|integrity)$/.test(code))
    ? code
    : 'image-rejected';
}
