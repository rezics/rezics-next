import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import sharp from 'sharp';
import canonicalize from 'canonicalize';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  initializeResourceGrants,
  parentCreationAuthorization,
  resourceAuthorization,
} from '../../src/access/index.ts';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount, type Account } from '../../src/access/account-data.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readPartition } from '../../src/partition/partition.ts';
import {
  claimMedia,
  completeMedia,
  readCollectionFence,
  readMediaState,
  readReservation,
  reserveMedia,
} from '../../src/content/media.ts';
import { checkMediaObject, claimCoverMedia } from '../../src/content/cover-reference.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { transformImage, type ImageVariant } from '../../src/content/image-transform.ts';
import { createCollectionJob } from '../../src/content/collection-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { readFences } from '../../src/content/source-fences.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import readContext from '../../src/semantic/read-context.sql';
import subjectExists from '../../src/semantic/subject-exists.sql';
import { takedownSourceFence } from '../../src/content/source-fence-command.ts';
import reserveImportedMedia from '../../src/content/reserve-import-media.sql';
import readImportedMediaStatus from '../../src/content/read-media-import-status.sql';
import readTime from '../../src/command/time.sql';
import selectCandidates from '../../src/content/select-collectable-media.sql';
import insertPost from '../../src/content/insert-post.sql';
import insertRevision from '../../src/content/insert-revision.sql';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [1, 8, 64] as const,
  ordinalsPerScale = 100;
const routeKey = new Uint8Array(32).fill(7);
const platform = '00000000-0000-8000-8000-000000000000';
let hash = 'a'.repeat(64);
const body = Buffer.from('{}');
const bodyHash = createHash('sha256').update(body).digest();
const digest = Buffer.alloc(32, 7);
const coverCredit = {
  rightsHolder: 'Growth test artist',
  via: { name: 'Growth catalogue', url: 'https://catalogue.example.test/record' },
  license: 'LicenseRef-unknown',
  obligations: [],
};

// prettier-ignore
const seedColumns = {
  sourceFence: 'route,source,external_id,field_group,taken_down,security_revision', account: 'route,account_id,kind,state,transaction_id,handle,membership_inverse_complete',
  thread: 'route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id',
  post: 'route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id',
  revision: 'route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id',
  media: 'route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,declared_sha256,actual_byte_count,sha256,state,key,transaction_id',
  variant: 'route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id',
  initialization: 'route,resource_id,resource_type,creator_id,initialized_at', roleGrant: 'route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id',
  resourceGrant: 'route,resource_id,subject_kind,subject_id,subject_role,action,valid,transaction_id', denial: 'route,resource_id,subject_id,action,reason,valid,transaction_id',
  outbox: 'partition_no,position,epoch,event_seq,event_count,id,type,subject,data',
  writeBasis: 'partition_no,position,epoch,transaction_id,principal_kind,principal_id,client_id,requested_by',
  receipt: 'partition_no,position,epoch,principal_kind,principal_id,command_kind,idempotency_key,request_digest,transaction_id,response',
} as const;

function seedRow(kind: keyof typeof seedColumns, values: readonly unknown[]): Record<string, unknown> {
  const columns = seedColumns[kind].split(',');
  if (columns.length !== values.length) throw new Error(`Invalid ${kind} seed row`);
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

// prettier-ignore
type Fixture = { tag: string; prefix: string; seedClient: string; seedSource: string; sourceExternalId: string; sourceRoute: number;
  sourcePartition: number; partition: number; route: number; actor: AccountActor; boardId: string; threadId: string; postId: string;
  revisionId: string; accounts: Map<string, Account>; access: ReturnType<typeof createAccess>; storage: Storage; basePosition: bigint; baseOrdinal: number };

let db: GrowthDatabase | undefined;
let imageBytes = new Uint8Array();
let imageVariants: ImageVariant[] = [];
let fetchSpy: ReturnType<typeof spyOn> | undefined;
const partitions = new Set<number>();

// prettier-ignore
class Storage implements MediaStorage {
  readonly keys = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | null> { return this.keys.get(key) ?? null; }
  async put(key: string, bytes: Uint8Array): Promise<void> { this.keys.set(key, new Uint8Array(bytes)); }
  async deletePrefix(prefix: string): Promise<void> { for (const key of this.keys.keys()) if (key.startsWith(prefix)) this.keys.delete(key); }
}

function context() {
  return { idempotencyKey: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 120_000 };
}

// prettier-ignore
function newPartition(): number { let selected: number; do selected = 64 + Math.floor(Math.random() * 3968); while (partitions.has(selected)); partitions.add(selected); return selected; }

function sourceNeighbours(fixture: Fixture): string[] {
  const ids: string[] = [];
  for (let candidate = 0; ids.length < ordinalsPerScale * scales[2]; candidate++) {
    const externalId = `neighbour-${candidate}`;
    if (partitionOf(tupleRoute(routeKey, fixture.seedSource, externalId)) === fixture.sourcePartition)
      ids.push(externalId);
  }
  return ids;
}

// prettier-ignore
async function grant(fixture: Pick<Fixture, 'actor'>, resource: string, action: string, subject = fixture.actor.accountId) {
  const route = routeOf(resource);
  if (route === null) throw new Error('Fixture resource is not routable');
  await db!.admin.query(`INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$5) ON CONFLICT DO NOTHING`, [route, resource, subject, action, newId(route)]);
}

// prettier-ignore
async function insertAccount(accountId: string, handle: string): Promise<Account> {
  const route = routeOf(accountId);
  if (route === null) throw new Error('Fixture account is not routable');
  await db!.admin.query(`INSERT INTO access.account(route,account_id,kind,state,transaction_id,handle,membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,$3,true) ON CONFLICT (route,account_id) DO NOTHING`, [route, accountId, handle]);
  const account = await readAccount(db!.admin, route, accountId);
  if (!account) throw new Error('Fixture account could not be read');
  return account;
}

// prettier-ignore
async function makeAnchor(options: { partition?: number; tag?: string } = {}): Promise<Fixture> {
  const tag = options.tag ?? randomUUID().replaceAll('-', '').slice(0, 12), seedSource = `growth_${tag}`;
  const sourceExternalId = `anchor-${tag}`, sourceRoute = tupleRoute(routeKey, seedSource, sourceExternalId);
  const sourcePartition = partitionOf(sourceRoute), partition = options.partition ?? newPartition();
  partitions.add(partition);
  const route = partition * 16 + Math.floor(Math.random() * 16), actorId = newId(route), otherId = newId(route);
  const boardId = newId(route), threadId = newId(route), postId = newId(route), revisionId = newId(route);
  const actor: AccountActor = { kind: 'account', accountId: actorId, clientId: 'rezics-website', scopes: [
    'media:create', 'media:complete', 'media:read_reservation', 'media:import_from_url', 'media:erase', 'media:read',
    'post:create', 'source_fence:read', 'source_fence:takedown',
  ], requestedBy: null, authnEpoch: 1 };
  const accounts = new Map<string, Account>([
    [actorId, await insertAccount(actorId, `gma_${tag}`)], [otherId, await insertAccount(otherId, `gmo_${tag}`)],
  ]);
  // This fixed 1,000-row actor inverse exercises the bounded Access admission lookup.
  await db!.admin.query(`INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
    SELECT $1,$2,'organization',g,g,$3 FROM unnest($4::uuid[]) g`,
    [route, actorId, newId(route), Array.from({ length: 1000 }, () => newId(route))]);
  await db!.admin.query(`INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Growth media board','published',1,$4)`, [route, boardId, actorId, newId(route)]);
  await db!.admin.query(`INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Growth media thread','published',1,$5)`, [route, threadId, actorId, boardId, newId(route)]);
  await db!.admin.query(`INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_release)
    VALUES ($1,$2,'schema:Book',$3,'seed') ON CONFLICT (route,subject_id) DO NOTHING`, [route, threadId, newId(route)]);
  for (const [resource, action] of [[threadId, 'media:create'], [threadId, 'post:create'], [boardId, 'board:read'],
    [platform, 'media:import_from_url'], [platform, 'source_fence:read'], [platform, 'source_fence:takedown']] as const)
    await grant({ actor }, resource, action);
  const access = createAccess({ actions: new Map(actor.scopes.map(action => [action, { anonymous: false, ...(action === 'media:create' || action === 'media:import_from_url'
  ? { 'x-resource-types': ['content.media'] as const }
  : action === 'post:create'
    ? { 'x-resource-types': ['content.post'] as const }
    : {}) }])),
    accountEvidence: candidate => accounts.get(candidate.accountId) });
  const position = await db!.admin.query<{ position: string }>(
    'SELECT COALESCE(max(position),0)::text AS position FROM core.outbox WHERE partition_no=$1', [partition]);
  const fixture: Fixture = { tag, prefix: `growth-media:${tag}:`, seedClient: 'rezics-website',
    seedSource, sourceExternalId, sourceRoute, sourcePartition,
    partition, route, actor, boardId, threadId, postId, revisionId, accounts, access, storage: new Storage(),
    basePosition: BigInt(position.rows[0]!.position) + 1n, baseOrdinal: 0 };
  await createPostAnchor(fixture);
  return fixture;
}

function dependencies(fixture: Fixture) {
  return { pool: db!.pool, access: fixture.access };
}

type MediaAnchor = { id: string; request: ReturnType<typeof context> };
type MediaAnchorState = 'reserved' | 'uploaded' | 'available' | 'imported';

function importRequest(fixture: Fixture): MediaImportRequest {
  const sourceUrl = 'https://images.example.test/original.png';
  return {
    containerId: fixture.threadId,
    sourceUrl,
    credit: coverCredit,
    provenance: {
      source: fixture.seedSource,
      external_id: fixture.sourceExternalId,
      record_revision: '1',
      digest: hash,
      converter_revision: '1',
      field_group: 'cover',
      references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }] }],
    },
  };
}

// This setup command uses the production import SQL and grant initializer for a source-backed anchor.
// prettier-ignore
async function importedMediaAnchor(fixture: Fixture): Promise<MediaAnchor> {
  const request = context(), input = importRequest(fixture), route = routeOf(input.containerId);
  if (route === null) throw new Error('Fixture import container is not routable');
  const mediaId = newId(route), resource = { route, id: mediaId }, root = { route: 0, id: platform };
  const kind = 'content.media.importFromUrl', identity = principalCommandIdentity(fixture.actor);
  const tuple = { route: tupleRoute(routeKey, input.provenance.source, input.provenance.external_id), ...input.provenance };
  let inserted: { tx: CommandTransaction; transactionId: string } | undefined;
  const rootAnchor = { resource: root, async validate(client: PoolClient) {
    return Boolean(await readPartition(client, 0)) && (await readContext.run(client, { route: 0, context_id: platform }))?.kind === 'global';
  } };
  const boundary = { pool: db!.pool, deadline: request.deadline };
  const creation = parentCreationAuthorization({ access: fixture.access, actor: fixture.actor, action: 'media:import_from_url',
    parent: rootAnchor, context: { ...boundary, resource, creation: { async validate(tx, target, time) {
      if (inserted?.tx !== tx) return false;
      const [row] = await readImportedMediaStatus.run(tx, { route: target.route, media_id: target.id });
      return row?.inserted_here === true && row.transaction_id === inserted.transactionId && row.uploader_id === fixture.actor.accountId &&
        row.container_id === input.containerId && row.reservation_request_id === request.idempotencyKey && row.purpose === 'cover' &&
        row.state === 'reserved' && row.created_at !== null && Date.parse(row.created_at) === Date.parse(authoritativeTimeValue(time));
    } } } });
  const sourceAccess = resourceAuthorization({ access: fixture.access, actor: fixture.actor, action: 'source_fence:read',
    anchor: rootAnchor, context: { ...boundary, partition: partitionOf(route) } });
  const readFence = () => withConnection(db!.pool, async client => {
    if (!(await readPartition(client, partitionOf(tuple.route)))) throw new Error('Missing source partition');
    return (await readFences(client, [tuple]))[0]!;
  });
  const authorization: CommandAuthorization = {
    ...creation,
    async prepare(attempt: CommandAttempt) {
      const before = await readFence(); if (before.takenDown) throw new GrantDeniedError();
      const sourceProof = await sourceAccess.prepare!(attempt), creationProof = await creation.prepare!(attempt);
      const current = await readFence();
      if (current.takenDown || current.securityRevision !== before.securityRevision) throw new GrantDeniedError();
      return { sourceProof, creationProof };
    },
    async authorize(tx, attempt, evidence) {
      const proof = evidence as { sourceProof: unknown; creationProof: unknown };
      await sourceAccess.authorize(tx, attempt, proof.sourceProof); await creation.authorize(tx, attempt, proof.creationProof);
      if (!(await subjectExists.run(tx, { route, subject_id: input.containerId }))) throw new GrantDeniedError();
      return 'execute';
    },
    async finalize(tx, attempt, evidence) {
      await creation.finalize?.(tx, attempt, (evidence as { creationProof: unknown }).creationProof);
    },
  };
  const digest = createHash('sha256').update(canonicalize([identity, kind, input])!).digest();
  await runCommand(db!.pool, { ...identity, partition: partitionOf(route), deadline: request.deadline,
    clock: () => new Date(), authorization, receipt: { kind, key: request.idempotencyKey, digest } }, async (tx, command) => {
    const row = await reserveImportedMedia.run(tx, { route, media_id: mediaId, container_id: input.containerId,
      uploader_id: fixture.actor.accountId, reservation_request_id: request.idempotencyKey, key: `m/${mediaId}/original`,
      source_url: input.sourceUrl, credit: input.credit, provenance: input.provenance,
      at: authoritativeTimeValue(command.time), transaction_id: command.transactionId });
    if (row.media_id !== mediaId) throw new GrantDeniedError();
    inserted = { tx, transactionId: command.transactionId };
    await initializeResourceGrants(tx, { resource, type: 'content.media', creator: fixture.actor.accountId });
    return { value: { mediaId }, events: [{ type: 'com.rezics.content.media.import-requested.v1', subject: mediaId, data: { mediaId } }] };
  });
  return { id: mediaId, request };
}

// prettier-ignore
async function mediaAnchor(fixture: Fixture, state: MediaAnchorState = 'reserved'): Promise<MediaAnchor> {
  const request = context();
  if (state === 'imported') return importedMediaAnchor(fixture);
  const result = await reserveMedia(dependencies(fixture), fixture.actor, {
    containerId: fixture.threadId, purpose: 'post-image', mediaType: 'image/png', byteCount: imageBytes.byteLength, sha256: hash,
  }, request);
  const media = { id: result.value.mediaId, request };
  if (state === 'reserved') return media;
  await completeMedia(dependencies(fixture), fixture.actor, media.id, { containerId: fixture.threadId,
    reservationRequestId: request.idempotencyKey, byteCount: imageBytes.byteLength, sha256: hash }, context());
  fixture.storage.keys.set(`m/${media.id}/original`, imageBytes);
  if (state === 'uploaded') return media;
  await createImageJob(db!.pool, fixture.storage).process(media.id);
  return media;
}

// prettier-ignore
async function completeReservedMedia(fixture: Fixture, media: MediaAnchor) {
  return completeMedia(dependencies(fixture), fixture.actor, media.id, { containerId: fixture.threadId,
    reservationRequestId: media.request.idempotencyKey, byteCount: imageBytes.byteLength, sha256: hash }, context());
}

// prettier-ignore
async function mediaAnchors(fixture: Fixture, state: MediaAnchorState, count: number): Promise<MediaAnchor[]> {
  const anchors: MediaAnchor[] = [];
  for (let index = 0; index < count; index++) anchors.push(await mediaAnchor(fixture, state));
  return anchors;
}

// prettier-ignore
async function ageMedia(media: readonly MediaAnchor[]) {
  await db!.admin.query("UPDATE content.media SET created_at='2020-01-01T00:00:00.000Z' WHERE media_id=ANY($1::uuid[])", [media.map(({ id }) => id)]);
}

async function growthPopulation(
  fixture: Fixture,
  options: { sourceOnly?: boolean; includeSourceNeighbours?: boolean } = {},
): Promise<Population> {
  const sourceIds = options.sourceOnly || options.includeSourceNeighbours ? sourceNeighbours(fixture) : [];
  // These populations use production account/content/media/Access/envelope shapes and source-fence tuple keys with valid groups and revisions.
  // prettier-ignore
  const population: Population = {
    name: `growth-media:${fixture.tag}${options.sourceOnly ? '-source' : ''}`,
    hotPartition: options.sourceOnly ? fixture.sourcePartition : fixture.partition,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const externalId = sourceIds[ordinal];
      const sourceRows = externalId === undefined ? {} : { 'content.source_fences': [seedRow('sourceFence',
        [tupleRoute(routeKey, fixture.seedSource, externalId), fixture.seedSource, externalId, 'cover', true, 1])] };
      if (options.sourceOnly) return sourceRows;
      const route = fixture.route, mediaId = newId(route), containerId = newId(route), postId = newId(route), revisionId = newId(route);
      const otherUploader = newId(route), uploaderId = ordinal % 2 === 0 ? fixture.actor.accountId : otherUploader;
      const reserveTx = newId(route), contentTx = newId(route), position = fixture.basePosition + BigInt(ordinal - fixture.baseOrdinal);
      const requestKey = `${fixture.prefix}${ordinal}`;
      const deniedSubject = uploaderId === fixture.actor.accountId ? otherUploader : fixture.actor.accountId;
      const identity = { principal: { kind: 'account' as const, id: uploaderId }, basis: { clientId: fixture.seedClient, requestedBy: null } };
      const requestBody = { containerId, purpose: 'post-image', mediaType: 'image/png', byteCount: imageBytes.byteLength, sha256: hash };
      const requestDigest = createHash('sha256').update(canonicalize([identity, 'content.media.reserve', requestBody])!).digest();
      const variants = imageVariants.map(v => seedRow('variant', [route, mediaId, v.format, v.width, v.height, v.mediaType, v.byteCount, v.sha256, `m/${mediaId}/${v.format}-${v.width}`, contentTx]));
      const revision = (thread: string, post: string, id: string) => seedRow('revision', [route, thread, post, id, body, bodyHash, '', 'CC0-1.0', [], fixture.boardId, 'available', contentTx]);
      const envelope = { partition_no: fixture.partition, position, epoch: 1 };
      return {
        'access.account': [seedRow('account', [route, otherUploader, 'actor', 'active', reserveTx, `gm_${fixture.tag}_${ordinal}`, true])],
        'content.thread': [seedRow('thread', [route, containerId, uploaderId, fixture.boardId, 'Growth media thread', 'published', 1, contentTx])],
        'content.post': [seedRow('post', [route, containerId, postId, null, uploaderId, revisionId, 'published', 1, contentTx])],
        'content.revision': [revision(containerId, postId, revisionId)],
        'content.media': [seedRow('media', [route, mediaId, containerId, uploaderId, requestKey, 'post-image', 'image/png', imageBytes.byteLength, hash, imageBytes.byteLength, hash, 'available', `m/${mediaId}/original`, contentTx])],
        'content.media_variant': variants,
        'access.resource_initialization': [seedRow('initialization', [route, mediaId, 'content.media', uploaderId, '2020-01-01T00:00:00.000Z'])],
        'access.resource_role_grant': [seedRow('roleGrant', [route, mediaId, 'identity', uploaderId, '', 'content.media.owner', '[2020-01-01 00:00:00+00,)', reserveTx])],
        'access.resource_grant': [seedRow('resourceGrant', [route, containerId, 'identity', uploaderId, '', 'media:create', '(,)', contentTx])],
        'access.resource_denial': [seedRow('denial', [route, mediaId, deniedSubject, 'media:complete', 'resource', '(,)', contentTx])],
        'core.outbox': [{ ...envelope, ...seedRow('outbox', [fixture.partition, position, 1, 0, 1, newId(route),
          'com.rezics.content.media.reserved.v1', mediaId, { mediaId, containerId, actorId: uploaderId }]) }],
        'editorial.write_basis': [{ ...envelope, ...seedRow('writeBasis', [fixture.partition, position, 1, reserveTx, 'account', uploaderId, fixture.seedClient, null]) }],
        'core.receipt': [{ ...envelope, ...seedRow('receipt', [fixture.partition, position, 1, 'account', uploaderId, 'content.media.reserve', requestKey, requestDigest, reserveTx, { mediaId }]) }],
        ...(options.includeSourceNeighbours ? sourceRows : {}),
      };
    },
  };
  if (options.sourceOnly) return population;
  return {
    ...population,
    finish: async (admin, range) => {
      await admin.query(
        `UPDATE core.partition p SET position = GREATEST(p.position, v.position)
         FROM (SELECT partition_no, max(position)::bigint AS position FROM core.outbox
               WHERE partition_no = $3 AND position >= $1 AND position < $2 GROUP BY partition_no) v
         WHERE p.partition_no = v.partition_no`,
        [
          fixture.basePosition.toString(),
          (fixture.basePosition + BigInt(range.to - range.from)).toString(),
          fixture.partition,
        ],
      );
    },
  };
}

// prettier-ignore
async function runMediaGrowth(fixture: Fixture, name: string,
  operation: (database: GrowthDatabase, scale: number, repetition: number) => Promise<unknown>,
  options: { includeSourceNeighbours?: boolean } = {}) {
  const population = await growthPopulation(fixture, options);
  return checkGrowth(db!, {
    name,
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 0,
    grow: async (database, scale, previous) => {
      const position = await database.admin.query<{ position: string }>(
        'SELECT COALESCE(max(position),0)::text AS position FROM core.outbox WHERE partition_no=$1', [fixture.partition]);
      fixture.basePosition = BigInt(position.rows[0]!.position) + 1n;
      fixture.baseOrdinal = previous * ordinalsPerScale;
      await seed({ pool: database.pool, admin: database.admin }, population,
        { from: previous * ordinalsPerScale, to: scale * ordinalsPerScale });
    },
    operation,
  });
}

// prettier-ignore
async function commandOptions(fixture: Fixture, kind: string, action?: string) {
  const request = context();
  const authorization = action ? await accessCommandAuthorization(fixture.access, fixture.actor, action,
    { route: fixture.route, id: fixture.threadId }, { pool: db!.pool, deadline: request.deadline },
    () => new Error(`Growth ${action} was denied`)) : undefined;
  return { request, options: { ...principalCommandIdentity(fixture.actor), partition: fixture.partition,
    deadline: request.deadline, ...(authorization ? { authorization } : {}),
    receipt: { kind, key: request.idempotencyKey, digest } } };
}

// prettier-ignore
function postEvent(fixture: Fixture, postId: string, revisionId: string) {
  return { type: 'com.rezics.content.post.created.v1', subject: postId,
    data: { threadId: fixture.threadId, itemId: postId, revisionId, actorId: fixture.actor.accountId } };
}

// prettier-ignore
async function createPostAnchor(fixture: Fixture): Promise<void> {
  const { postId, revisionId } = fixture;
  const { options } = await commandOptions(fixture, 'content.post.create.growth-anchor', 'post:create');
  await runCommand(db!.pool, options, async (tx, command) => {
    await insertPost.run(tx, { route: fixture.route, thread_id: fixture.threadId, post_id: postId, reply_to_post_id: null,
      author_account_id: fixture.actor.accountId, head_revision_id: revisionId, visibility: 'published', security_revision: 1,
      transaction_id: command.transactionId });
    await insertRevision.run(tx, { route: fixture.route, thread_id: fixture.threadId, post_id: postId, revision_id: revisionId,
      body, body_sha256: bodyHash, search_text: '', licence: 'CC0-1.0', subject_ids: [], board_id: fixture.boardId,
      availability: 'available', transaction_id: command.transactionId });
    return { value: null, events: [postEvent(fixture, postId, revisionId)] };
  });
}

// prettier-ignore
async function claimPostMedia(fixture: Fixture, mediaId: string, postId: string, revisionId: string): Promise<void> {
  const { options } = await commandOptions(fixture, 'content.post.media-claim', 'post:create');
  await runCommand(db!.pool, options, async (tx) => {
    await claimMedia(tx, { mediaIds: [mediaId], containerId: fixture.threadId, author: fixture.actor, itemId: postId, revisionId });
    return { value: null, events: [postEvent(fixture, postId, revisionId)] };
  });
}

function importDependencies(fixture: Fixture) {
  return {
    pool: db!.pool,
    access: fixture.access,
    routeKey,
    clock: () => new Date(),
    fetchConfig: { allowedHosts: ['images.example.test'] },
    storage: fixture.storage,
  };
}

// prettier-ignore
async function coverClaim(fixture: Fixture, mediaId: string): Promise<void> {
  const { options } = await commandOptions(fixture, 'content.cover.media-claim');
  const input = {
    mediaIds: [mediaId],
    containerId: fixture.threadId,
    author: fixture.actor,
    reference: { kind: 'semantic_candidate' as const, subjectId: fixture.threadId, candidateId: newId(fixture.route), revision: 1 },
  };
  await runCommand(db!.pool, options, async (tx) => {
    await claimCoverMedia(tx, input);
    return { value: null, events: [{ type: 'com.rezics.test.cover_claimed.v1', subject: mediaId, data: {} }] };
  });
}

// prettier-ignore
async function selectCollectable(pool: GrowthDatabase['pool'], partition: number, batch: number) {
  return withConnection(pool, async (client) => {
    const time = await readTime.run(client, { at: '' });
    if (!time) throw new Error('Collection test could not read authoritative time');
    const candidates: Awaited<ReturnType<typeof selectCandidates.run>> = [];
    for (let offset = 0; offset < 16; offset++) {
      const route = partition * 16 + offset;
      candidates.push(...await selectCandidates.run(client, { route, pending_route: route, at: time.at, batch, pending_batch: batch }));
    }
    return candidates.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.mediaId.localeCompare(b.mediaId)).slice(0, batch);
  });
}

// prettier-ignore
async function resetGrowthData(): Promise<void> {
  // The disposable database holds only these fixtures; truncate rows and checkpoint to recycle its WAL between checks.
  await db!.admin.query(`TRUNCATE TABLE access.account, access.membership_inverse, access.resource_grant, access.resource_role_grant,
    access.resource_initialization, access.resource_denial, content.board, content.thread, content.post, content.revision,
    content.media, content.media_variant, content.source_fences, core.receipt, core.outbox, editorial.write_basis CASCADE`);
  await db!.admin.query('UPDATE core.partition SET position=0');
  partitions.clear();
  await db!.admin.query('CHECKPOINT');
}

// prettier-ignore
beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`INSERT INTO semantic.context(route,context_id,kind,labels,recorded_transaction_id)
    VALUES (0,$1,'global','{"en":"Global"}'::jsonb,$2) ON CONFLICT (route,context_id) DO NOTHING`, [platform, newId(0)]);
  imageBytes = new Uint8Array(await sharp({ create: { width: 32, height: 24, channels: 3, background: '#a02476' } }).png().toBuffer());
  hash = createHash('sha256').update(imageBytes).digest('hex');
  imageVariants = (await transformImage(imageBytes)).variants;
  fetchSpy = spyOn(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }, 'fetch')
    .mockImplementation(async () => new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/png' } }));
});

afterAll(async () => {
  try {
    fetchSpy?.mockRestore();
  } finally {
    await db?.close();
  }
});

afterEach(async () => {
  await resetGrowthData();
});

// prettier-ignore
function growthTest(name: string, run: () => Promise<{ samples: readonly { scale: number }[] }>) {
  test(name, async () => expect((await run()).samples.map(({ scale }) => scale)).toEqual([...scales]), 90_000);
}

// prettier-ignore
growthTest('Media reserve stays within its bound as u grows', async () => {
  const f = await makeAnchor(); return runMediaGrowth(f, 'Media reserve', async () => mediaAnchor(f));
});
// prettier-ignore
growthTest('Media complete stays within its bound as u grows', async () => {
  const f = await makeAnchor(), targets = await mediaAnchors(f, 'reserved', 3);
  return runMediaGrowth(f, 'Media complete', (_db, _scale, index) => completeReservedMedia(f, targets[index]!));
});
// prettier-ignore
growthTest('Media reservation and state reads stays within its bound as u grows', async () => {
  const f = await makeAnchor(), media = await mediaAnchor(f);
  return runMediaGrowth(f, 'Media reservation and state reads', async () => ({
    reservation: await readReservation(dependencies(f), media.id, { actor: f.actor, deadline: Date.now() + 20_000 }),
    state: await readMediaState(db!.pool, media.id), pending: await readCollectionFence(db!.pool, media.id),
  }));
});
// prettier-ignore
growthTest('Post media claim stays within its bound as r grows', async () => {
  const f = await makeAnchor(), media = await mediaAnchors(f, 'available', 3);
  return runMediaGrowth(f, 'Post media claim', (_db, _scale, i) => claimPostMedia(f, media[i]!.id, f.postId, f.revisionId));
});
// prettier-ignore
growthTest('Cover reference read and claim stays within its bound as u grows', async () => {
  const f = await makeAnchor(), media = await mediaAnchors(f, 'imported', 3), deps = importDependencies(f);
  const job = createImageJob(db!.pool, f.storage);
  for (const item of media) { await processImportedMedia(deps, item.id); await job.process(item.id); }
  return runMediaGrowth(f, 'Cover reference read and claim', async (_db, _scale, i) => {
    const ref = await withConnection(db!.pool, client => checkMediaObject(client, media[i]!.id, 'cover'));
    if (!ref) throw new Error('Fixed cover reference was not available'); await coverClaim(f, media[i]!.id); return ref;
  });
});
// prettier-ignore
growthTest('Image publication stays within its bound as u grows', async () => {
  const f = await makeAnchor(), media = await mediaAnchors(f, 'uploaded', 3), job = createImageJob(db!.pool, f.storage);
  return runMediaGrowth(f, 'Image publication', (_db, _scale, i) => job.process(media[i]!.id));
});
// prettier-ignore
growthTest('Collection selection stays within its bound as P grows', async () => {
  const f = await makeAnchor(), media = await mediaAnchors(f, 'available', 2);
  await ageMedia(media);
  return runMediaGrowth(f, 'Collection selection', async db => {
    const selected = await selectCollectable(db.pool, f.partition, 32);
    if (selected.length !== media.length) throw new Error('Collection selection changed its fixed old neighbourhood'); return selected;
  });
});
// prettier-ignore
growthTest('Collection per object stays within its bound as u grows', async () => {
  const f = await makeAnchor(), media = await mediaAnchors(f, 'available', 3);
  await ageMedia(media);
  const job = createCollectionJob(db!.pool, f.storage);
  return runMediaGrowth(f, 'Collection per object', async () => {
    const result = await job.collectPartition(f.partition, 1);
    if (result.examined !== 1 || result.collected !== 1) throw new Error('Collection did not process its fixed object'); return result;
  });
});
// prettier-ignore
growthTest('Imported image processing stays within its bound as u grows', async () => {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12), source = `growth_${tag}`, externalId = `anchor-${tag}`;
  const sourcePartition = partitionOf(tupleRoute(routeKey, source, externalId));
  const f = await makeAnchor({ tag, partition: (sourcePartition + 1) % 4096 });
  const media = await mediaAnchors(f, 'imported', 3), deps = importDependencies(f);
  return runMediaGrowth(f, 'Imported image processing', (_db, _scale, i) => processImportedMedia(deps, media[i]!.id),
    { includeSourceNeighbours: true });
});
// prettier-ignore
growthTest('Source fence check stays within its bound as P grows', async () => {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12), source = `growth_${tag}`, externalId = `anchor-${tag}`;
  const partition = partitionOf(tupleRoute(routeKey, source, externalId)), f = await makeAnchor({ partition, tag });
  await takedownSourceFence({ pool: db!.pool, access: f.access, routeKey, clock: () => new Date() }, f.actor,
    { source, external_id: externalId, field_group: 'cover', reason: 'Growth lookup anchor' }, context());
  const population = await growthPopulation(f, { sourceOnly: true });
  return checkGrowth(db!, { name: 'Source fence check', scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' }, repetitions: 1, warmups: 0,
    grow: async (db, scale, previous) => seed({ pool: db.pool, admin: db.admin }, population,
      { from: previous * ordinalsPerScale, to: scale * ordinalsPerScale }),
    operation: db => withConnection(db.pool, (client: PoolClient) => readFences(client,
      [{ route: f.sourceRoute, source, external_id: externalId, field_group: 'cover' }])) });
});
