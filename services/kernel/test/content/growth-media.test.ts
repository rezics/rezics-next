import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import sharp from 'sharp';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount, type Account } from '../../src/access/account-data.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
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
import { createCollectionJob } from '../../src/content/collection-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { readFences } from '../../src/content/source-fences.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { takedownSourceFence } from '../../src/content/source-fence-command.ts';
import readTime from '../../src/command/time.sql';
import selectCandidates from '../../src/content/select-collectable-media.sql';
import insertPost from '../../src/content/insert-post.sql';
import insertRevision from '../../src/content/insert-revision.sql';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [1, 8, 64] as const;
const ordinalsPerScale = 500;
const routeKey = new Uint8Array(32).fill(7);
const platform = '00000000-0000-8000-8000-000000000000';
const hash = 'a'.repeat(64);
const variantHash = 'b'.repeat(64);
const body = Buffer.from('{}');
const bodyHash = createHash('sha256').update(body).digest();
const digest = Buffer.alloc(32, 7);
const coverCredit = {
  rightsHolder: 'Growth test artist',
  via: { name: 'Growth catalogue', url: 'https://catalogue.example.test/record' },
  license: 'LicenseRef-unknown',
  obligations: [],
};

type Fixture = {
  tag: string;
  prefix: string;
  seedClient: string;
  seedEventType: string;
  seedSource: string;
  sourceExternalId: string;
  sourceRoute: number;
  sourcePartition: number;
  partition: number;
  route: number;
  actor: AccountActor;
  otherAccountId: string;
  boardId: string;
  threadId: string;
  accounts: Map<string, Account>;
  access: ReturnType<typeof createAccess>;
  routeKey: Uint8Array;
  mediaIds: Set<string>;
  contentIds: Set<string>;
  storage: Storage;
  basePosition: bigint;
};

let db: GrowthDatabase | undefined;
let imageBytes = new Uint8Array();
let fetchSpy: ReturnType<typeof spyOn> | undefined;
const fixtures: Fixture[] = [];

class Storage implements MediaStorage {
  readonly keys = new Map<string, Uint8Array>();
  readonly deletions: string[] = [];

  async get(key: string): Promise<Uint8Array | null> {
    return this.keys.get(key) ?? null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.keys.set(key, new Uint8Array(bytes));
  }

  async deletePrefix(prefix: string): Promise<void> {
    this.deletions.push(prefix);
    for (const key of this.keys.keys()) if (key.startsWith(prefix)) this.keys.delete(key);
  }
}

function token(): string {
  return randomUUID();
}

function context() {
  return { idempotencyKey: token(), requestId: token(), deadline: Date.now() + 120_000 };
}

function newPartition(): number {
  for (;;) {
    const selected = 64 + Math.floor(Math.random() * 3968);
    if (!fixtures.some((fixture) => fixture.partition === selected)) return selected;
  }
}

function sourceName(tag: string): string {
  return `growth_${tag}`;
}

async function grant(
  fixture: Pick<Fixture, 'actor'>,
  resource: string,
  action: string,
  subject = fixture.actor.accountId,
) {
  const route = routeOf(resource);
  if (route === null) throw new Error('Fixture resource is not routable');
  await db!.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$5) ON CONFLICT DO NOTHING`,
    [route, resource, subject, action, newId(route)],
  );
}

async function insertAccount(accountId: string, handle: string): Promise<Account> {
  const route = routeOf(accountId);
  if (route === null) throw new Error('Fixture account is not routable');
  await db!.admin.query(
    `INSERT INTO access.account
       (route,account_id,kind,state,transaction_id,handle,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,$3,true) ON CONFLICT (route,account_id) DO NOTHING`,
    [route, accountId, handle],
  );
  const account = await readAccount(db!.admin, route, accountId);
  if (!account) throw new Error('Fixture account could not be read');
  return account;
}

async function makeFixture(options: { partition?: number; tag?: string } = {}): Promise<Fixture> {
  const tag = options.tag ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const seedSource = sourceName(tag);
  const sourceExternalId = `anchor-${tag}`;
  const sourceRoute = tupleRoute(routeKey, seedSource, sourceExternalId);
  const sourcePartition = partitionOf(sourceRoute);
  const partition = options.partition ?? newPartition();
  const route = partition * 16 + Math.floor(Math.random() * 16);
  const actorId = newId(route);
  const otherAccountId = newId(route);
  const boardId = newId(route);
  const threadId = newId(route);
  const actor: AccountActor = {
    kind: 'account',
    accountId: actorId,
    clientId: 'rezics-website',
    scopes: ['media:create', 'media:complete', 'media:read_reservation', 'post:create', 'source_fence:takedown'],
    requestedBy: null,
    authnEpoch: 1,
  };
  const accounts = new Map<string, Account>();
  accounts.set(actorId, await insertAccount(actorId, `gma_${tag}`));
  accounts.set(otherAccountId, await insertAccount(otherAccountId, `gmo_${tag}`));

  await db!.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Growth media board','published',1,$4)`,
    [route, boardId, actorId, newId(route)],
  );
  await db!.admin.query(
    `INSERT INTO content.thread
       (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Growth media thread','published',1,$5)`,
    [route, threadId, actorId, boardId, newId(route)],
  );
  const platformGrantResource = platform;
  for (const [resource, action] of [
    [threadId, 'media:create'],
    [threadId, 'post:create'],
    [boardId, 'board:read'],
    [platformGrantResource, 'source_fence:takedown'],
  ] as const)
    await grant({ actor } as Fixture, resource, action);

  const access = createAccess({
    actions: new Map([...actor.scopes, 'media:read', 'media:erase'].map((action) => [action, { anonymous: false }])),
    accountEvidence: (candidate) => accounts.get(candidate.accountId),
  });
  const position = await db!.admin.query<{ position: string }>(
    'SELECT COALESCE(max(position),0)::text AS position FROM core.outbox WHERE partition_no=$1',
    [partition],
  );
  const fixture: Fixture = {
    tag,
    prefix: `growth-media:${tag}:`,
    seedClient: `growth-media-seed-${tag}`,
    seedEventType: `com.rezics.growth.media.seed.${tag}.v1`,
    seedSource,
    sourceExternalId,
    sourceRoute,
    sourcePartition,
    partition,
    route,
    actor,
    otherAccountId,
    boardId,
    threadId,
    accounts,
    access,
    routeKey,
    mediaIds: new Set(),
    contentIds: new Set([boardId, threadId]),
    storage: new Storage(),
    basePosition: BigInt(position.rows[0]!.position) + 100n,
  };
  fixtures.push(fixture);
  return fixture;
}

function dependencies(fixture: Fixture) {
  return { pool: db!.pool, access: fixture.access };
}

async function reserved(fixture: Fixture) {
  const request = context();
  const result = await reserveMedia(
    dependencies(fixture),
    fixture.actor,
    {
      containerId: fixture.threadId,
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: imageBytes.byteLength,
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
    },
    request,
  );
  fixture.mediaIds.add(result.value.mediaId);
  return { id: result.value.mediaId, request };
}

async function uploaded(fixture: Fixture) {
  const media = await reserved(fixture);
  await completeMedia(
    dependencies(fixture),
    fixture.actor,
    media.id,
    {
      containerId: fixture.threadId,
      reservationRequestId: media.request.idempotencyKey,
      byteCount: imageBytes.byteLength,
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
    },
    context(),
  );
  fixture.storage.keys.set(`m/${media.id}/original`, imageBytes);
  return media;
}

async function available(fixture: Fixture) {
  const media = await uploaded(fixture);
  await createImageJob(db!.pool, fixture.storage).process(media.id);
  return media;
}

async function growthPopulation(fixture: Fixture, includeSourceNeighbours = false): Promise<Population> {
  const position = await db!.admin.query<{ position: string }>(
    'SELECT COALESCE(max(position),0)::text AS position FROM core.outbox WHERE partition_no=$1',
    [fixture.partition],
  );
  fixture.basePosition = BigInt(position.rows[0]!.position) + 100n;
  // This population matches the routed account/thread/post/revision, completed media and variant rows, owner initialization/grant, and command envelope shapes written by the content SQL paths; half its media belong to the measured uploader and half to distinct other uploaders.
  return {
    name: fixture.seedClient,
    hotPartition: fixture.partition,
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const mediaId = newId(route);
      const containerId = newId(route);
      const postId = newId(route);
      const revisionId = newId(route);
      const otherUploader = newId(route);
      const uploaderId = ordinal % 2 === 0 ? fixture.actor.accountId : otherUploader;
      const reserveTransaction = newId(route);
      const contentTransaction = newId(route);
      const position = fixture.basePosition + BigInt(ordinal) * 64n;
      const requestKey = `${fixture.prefix}${ordinal}`;
      const deniedSubject = uploaderId === fixture.actor.accountId ? otherUploader : fixture.actor.accountId;
      const sourceRows = includeSourceNeighbours
        ? {
            'content.source_fences': [
              {
                route: fixture.sourceRoute,
                source: fixture.seedSource,
                external_id: `neighbour-${ordinal}`,
                field_group: 'cover',
                taken_down: false,
                security_revision: 1,
              },
            ],
          }
        : {};
      return {
        'access.account': [
          {
            route,
            account_id: otherUploader,
            kind: 'actor',
            state: 'active',
            handle: `gm_${fixture.tag}_${ordinal}`,
            content_preferences: {},
            minimum_authn_epoch: 1,
            membership_inverse_complete: true,
            transaction_id: reserveTransaction,
          },
        ],
        'content.thread': [
          {
            route,
            thread_id: containerId,
            author_account_id: uploaderId,
            board_id: fixture.boardId,
            title: 'Growth media thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: contentTransaction,
            first_post_id: postId,
            availability: 'available',
          },
        ],
        'content.post': [
          {
            route,
            thread_id: containerId,
            post_id: postId,
            reply_to_post_id: null,
            author_account_id: uploaderId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: contentTransaction,
          },
        ],
        'content.revision': [
          {
            route,
            thread_id: containerId,
            post_id: postId,
            revision_id: revisionId,
            body,
            body_sha256: bodyHash,
            search_text: '',
            licence: 'CC0-1.0',
            subject_ids: [],
            board_id: fixture.boardId,
            availability: 'available',
            recorded_transaction_id: contentTransaction,
          },
        ],
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: containerId,
            uploader_id: uploaderId,
            reservation_request_id: requestKey,
            purpose: 'post-image',
            media_type: 'image/png',
            byte_count: imageBytes.byteLength,
            declared_sha256: hash,
            actual_byte_count: imageBytes.byteLength,
            sha256: hash,
            state: 'available',
            decision: null,
            key: `m/${mediaId}/original`,
            claimed_at: null,
            transaction_id: contentTransaction,
            erased: false,
            collection_pending: false,
            taken_down: false,
            security_revision: 0,
          },
        ],
        'content.media_variant': [
          {
            route,
            media_id: mediaId,
            format: 'avif',
            width: 320,
            height: 160,
            media_type: 'image/avif',
            byte_count: 80,
            sha256: variantHash,
            key: `m/${mediaId}/avif-320`,
            transaction_id: contentTransaction,
          },
          {
            route,
            media_id: mediaId,
            format: 'webp',
            width: 320,
            height: 160,
            media_type: 'image/webp',
            byte_count: 80,
            sha256: variantHash,
            key: `m/${mediaId}/webp-320`,
            transaction_id: contentTransaction,
          },
        ],
        'access.resource_initialization': [
          {
            route,
            resource_id: mediaId,
            resource_type: 'content.media',
            creator_id: uploaderId,
            initialized_at: '2020-01-01T00:00:00.000Z',
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: mediaId,
            subject_kind: 'identity',
            subject_id: uploaderId,
            subject_role: '',
            grant_role: 'content.media.owner',
            valid: '[2020-01-01 00:00:00+00,)',
            transaction_id: reserveTransaction,
          },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: containerId,
            subject_kind: 'identity',
            subject_id: uploaderId,
            subject_role: '',
            action: 'media:create',
            valid: '(,)',
            transaction_id: contentTransaction,
          },
        ],
        'access.resource_denial': [
          {
            route,
            resource_id: mediaId,
            subject_id: deniedSubject,
            subject_role: '',
            action: 'media:complete',
            reason: 'resource',
            valid: '(,)',
            transaction_id: contentTransaction,
          },
        ],
        'core.outbox': [
          {
            partition_no: fixture.partition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(route),
            type: fixture.seedEventType,
            subject: mediaId,
            data: { mediaId, containerId, actorId: uploaderId },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: fixture.partition,
            transaction_id: reserveTransaction,
            epoch: 1,
            position,
            actor_account_id: uploaderId,
            client_id: fixture.seedClient,
            requested_by: null,
          },
        ],
        'core.receipt': [
          {
            partition_no: fixture.partition,
            actor_account_id: uploaderId,
            command_kind: 'content.media.reserve',
            idempotency_key: requestKey,
            request_digest: digest,
            epoch: 1,
            position,
            transaction_id: reserveTransaction,
            response: { mediaId },
          },
        ],
        ...sourceRows,
      };
    },
    finish: async (admin, range) => {
      await admin.query(
        `UPDATE core.partition p SET position = GREATEST(p.position, v.position)
         FROM (SELECT partition_no, max(position)::bigint AS position FROM core.outbox
               WHERE partition_no = $3 AND position >= $1 AND position < $2 GROUP BY partition_no) v
         WHERE p.partition_no = v.partition_no`,
        [
          (fixture.basePosition + BigInt(range.from) * 64n).toString(),
          (fixture.basePosition + BigInt(range.to) * 64n).toString(),
          fixture.partition,
        ],
      );
    },
  };
}

async function runMediaGrowth(
  fixture: Fixture,
  name: string,
  operation: (database: GrowthDatabase, scale: number, repetition: number) => Promise<unknown>,
  includeSourceNeighbours = false,
) {
  const population = await growthPopulation(fixture, includeSourceNeighbours);
  return checkGrowth(db!, {
    name,
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 0,
    grow: async (database, scale, previous) => {
      await seed({ pool: database.pool, admin: database.admin }, population, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
    },
    operation,
  });
}

async function createPostAnchor(fixture: Fixture): Promise<{ postId: string; revisionId: string }> {
  const postId = newId(fixture.route);
  const revisionId = newId(fixture.route);
  fixture.contentIds.add(postId);
  fixture.contentIds.add(revisionId);
  const request = context();
  const authorization = await accessCommandAuthorization(
    fixture.access,
    fixture.actor,
    'post:create',
    { route: fixture.route, id: fixture.threadId },
    { pool: db!.pool, deadline: request.deadline },
    () => new Error('Growth post anchor was denied'),
  );
  await runCommand(
    db!.pool,
    {
      ...principalCommandIdentity(fixture.actor),
      partition: fixture.partition,
      deadline: request.deadline,
      authorization,
      receipt: {
        kind: 'content.post.create.growth-anchor',
        key: request.idempotencyKey,
        digest,
      },
    },
    async (tx, command) => {
      await insertPost.run(tx, {
        route: fixture.route,
        thread_id: fixture.threadId,
        post_id: postId,
        reply_to_post_id: null,
        author_account_id: fixture.actor.accountId,
        head_revision_id: revisionId,
        visibility: 'published',
        security_revision: 1,
        transaction_id: command.transactionId,
      });
      await insertRevision.run(tx, {
        route: fixture.route,
        thread_id: fixture.threadId,
        post_id: postId,
        revision_id: revisionId,
        body,
        body_sha256: bodyHash,
        search_text: '',
        licence: 'CC0-1.0',
        subject_ids: [],
        board_id: fixture.boardId,
        availability: 'available',
        transaction_id: command.transactionId,
      });
      return {
        value: { postId, revisionId },
        events: [
          {
            type: 'com.rezics.content.post.created.v1',
            subject: postId,
            data: { threadId: fixture.threadId, itemId: postId, revisionId, actorId: fixture.actor.accountId },
          },
        ],
      };
    },
  );
  return { postId, revisionId };
}

async function claimPostMedia(fixture: Fixture, mediaId: string, postId: string, revisionId: string): Promise<void> {
  const request = context();
  const authorization = await accessCommandAuthorization(
    fixture.access,
    fixture.actor,
    'post:create',
    { route: fixture.route, id: fixture.threadId },
    { pool: db!.pool, deadline: request.deadline },
    () => new Error('Growth post claim was denied'),
  );
  await runCommand(
    db!.pool,
    {
      ...principalCommandIdentity(fixture.actor),
      partition: fixture.partition,
      deadline: request.deadline,
      authorization,
      receipt: {
        kind: 'content.post.media-claim',
        key: request.idempotencyKey,
        digest,
      },
    },
    async (tx) => {
      await claimMedia(tx, {
        mediaIds: [mediaId],
        containerId: fixture.threadId,
        author: fixture.actor,
        itemId: postId,
        revisionId,
      });
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.content.post.created.v1',
            subject: postId,
            data: { threadId: fixture.threadId, itemId: postId, revisionId, actorId: fixture.actor.accountId },
          },
        ],
      };
    },
  );
}

async function importedMedia(fixture: Fixture, externalId: string) {
  const mediaId = newId(fixture.route);
  fixture.mediaIds.add(mediaId);
  const sourceUrl = 'https://images.example.test/original.png';
  const provenance = {
    source: fixture.seedSource,
    external_id: externalId,
    record_revision: '1',
    digest: hash,
    converter_revision: '1',
    field_group: 'cover',
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }],
      },
    ],
  };
  await db!.admin.query(
    `INSERT INTO content.media
       (route,media_id,container_id,uploader_id,reservation_request_id,purpose,state,key,
        transaction_id,source_url,credit,provenance)
     VALUES ($1,$2,$3,$4,$5,'cover','reserved',$6,$7,$8,$9,$10)`,
    [
      fixture.route,
      mediaId,
      fixture.threadId,
      fixture.actor.accountId,
      `${fixture.prefix}import:${externalId}`,
      `m/${mediaId}/original`,
      newId(fixture.route),
      sourceUrl,
      coverCredit,
      provenance,
    ],
  );
  return mediaId;
}

async function importDependencies(fixture: Fixture) {
  return {
    pool: db!.pool,
    access: fixture.access,
    routeKey: fixture.routeKey,
    clock: () => new Date(),
    fetchConfig: { allowedHosts: ['images.example.test'] },
    storage: fixture.storage,
  };
}

async function coverClaim(fixture: Fixture, mediaId: string): Promise<void> {
  const request = context();
  const input = {
    mediaIds: [mediaId],
    containerId: fixture.threadId,
    author: fixture.actor,
    reference: {
      kind: 'semantic_candidate' as const,
      subjectId: fixture.threadId,
      candidateId: newId(fixture.route),
      revision: 1,
    },
  };
  const { actor } = fixture;
  const id = token();
  await runCommand(
    db!.pool,
    {
      partition: fixture.partition,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      receipt: { actorAccountId: actor.accountId, kind: 'content.cover.media-claim', key: id, digest },
      deadline: request.deadline,
    },
    async (tx) => {
      await claimCoverMedia(tx, input);
      return {
        value: null,
        events: [{ type: 'com.rezics.test.cover_claimed.v1', subject: mediaId, data: {} }],
      };
    },
  );
}

async function selectCollectable(pool: GrowthDatabase['pool'], partition: number, batch: number) {
  return withConnection(pool, async (client) => {
    const time = await readTime.run(client, { at: '' });
    if (!time) throw new Error('Collection test could not read authoritative time');
    const candidates = [];
    for (let offset = 0; offset < 16; offset++) {
      const route = partition * 16 + offset;
      candidates.push(
        ...(await selectCandidates.run(client, {
          route,
          pending_route: route,
          at: time.at,
          batch,
          pending_batch: batch,
        })),
      );
    }
    return candidates
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.mediaId.localeCompare(right.mediaId),
      )
      .slice(0, batch);
  });
}

async function sourcePopulation(fixture: Fixture): Promise<Population> {
  // This population matches the source-fence upsert SQL row shape and keeps same-source neighbours on the measured source route.
  return {
    name: `${fixture.seedClient}-source`,
    hotPartition: fixture.sourcePartition,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'content.source_fences': [
        {
          route: fixture.sourceRoute,
          source: fixture.seedSource,
          external_id: `neighbour-${ordinal}`,
          field_group: 'cover',
          taken_down: false,
          security_revision: 1,
        },
      ],
    }),
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  const rows = await db!.admin.query<{ media_id: string; route: number; container_id: string }>(
    `SELECT media_id::text, route, container_id::text FROM content.media WHERE reservation_request_id LIKE $1`,
    [`${fixture.prefix}%`],
  );
  const mediaIds = [...new Set([...fixture.mediaIds, ...rows.rows.map((row) => row.media_id)])];
  const containers = [...new Set([...rows.rows.map((row) => row.container_id), fixture.threadId])];
  const resources = [...new Set([...mediaIds, ...containers, fixture.boardId, platform])];
  if (mediaIds.length) {
    await db!.admin.query('DELETE FROM access.resource_role_grant WHERE resource_id = ANY($1::uuid[])', [mediaIds]);
    await db!.admin.query('DELETE FROM access.resource_initialization WHERE resource_id = ANY($1::uuid[])', [mediaIds]);
    await db!.admin.query('DELETE FROM access.resource_denial WHERE resource_id = ANY($1::uuid[])', [mediaIds]);
    await db!.admin.query('DELETE FROM access.resource_grant WHERE resource_id = ANY($1::uuid[])', [mediaIds]);
    await db!.admin.query(
      'DELETE FROM content.media WHERE reservation_request_id LIKE $1 OR media_id = ANY($2::uuid[])',
      [`${fixture.prefix}%`, mediaIds],
    );
  }
  await db!.admin.query('DELETE FROM access.resource_grant WHERE resource_id = ANY($1::uuid[])', [resources]);
  await db!.admin.query(
    'DELETE FROM core.receipt WHERE command_kind = $1 OR idempotency_key LIKE $2 OR actor_account_id = $3',
    [`content.media.seed.${fixture.tag}`, `${fixture.prefix}%`, fixture.actor.accountId],
  );
  await db!.admin.query('DELETE FROM editorial.write_basis WHERE client_id = $1 OR actor_account_id = $2', [
    fixture.seedClient,
    fixture.actor.accountId,
  ]);
  await db!.admin.query('DELETE FROM core.outbox WHERE type = $1 OR subject = ANY($2::text[])', [
    fixture.seedEventType,
    [...mediaIds, ...fixture.contentIds],
  ]);
  await db!.admin.query(
    `UPDATE core.partition p SET position = COALESCE((
       SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no
     ), 0) WHERE p.partition_no = ANY($1::integer[])`,
    [[...new Set([fixture.partition, fixture.sourcePartition])]],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  imageBytes = new Uint8Array(
    await sharp({ create: { width: 32, height: 24, channels: 3, background: '#a02476' } })
      .png()
      .toBuffer(),
  );
  fetchSpy = spyOn(
    globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
    'fetch',
  ).mockImplementation(async () => new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/png' } }));
});

afterAll(async () => {
  try {
    for (const fixture of fixtures) await cleanupFixture(fixture);
  } finally {
    fetchSpy?.mockRestore();
    await db?.close();
  }
});

test('Media reserve stays within its bound as u grows', async () => {
  const fixture = await makeFixture();
  const report = await runMediaGrowth(fixture, 'Media reserve', async () => reserved(fixture));
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Media complete stays within its bound as u grows', async () => {
  const fixture = await makeFixture();
  const targets = await Promise.all(Array.from({ length: 3 }, () => reserved(fixture)));
  const report = await runMediaGrowth(fixture, 'Media complete', async (_database, _scale, repetition) => {
    const media = targets[repetition];
    if (!media) throw new Error('Missing fixed completion target');
    return completeMedia(
      dependencies(fixture),
      fixture.actor,
      media.id,
      {
        containerId: fixture.threadId,
        reservationRequestId: media.request.idempotencyKey,
        byteCount: imageBytes.byteLength,
        sha256: createHash('sha256').update(imageBytes).digest('hex'),
      },
      context(),
    );
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Media reservation and state reads stays within its bound as u grows', async () => {
  const fixture = await makeFixture();
  const anchor = await reserved(fixture);
  const report = await runMediaGrowth(fixture, 'Media reservation and state reads', async () => {
    const reservation = await readReservation(dependencies(fixture), anchor.id, {
      actor: fixture.actor,
      deadline: Date.now() + 20_000,
    });
    const state = await readMediaState(db!.pool, anchor.id);
    const pending = await readCollectionFence(db!.pool, anchor.id);
    return { reservation, state, pending };
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.every(({ cost }) => cost.statements > 0)).toBe(true);
}, 90_000);

test('Post media claim stays within its bound as r grows', async () => {
  const fixture = await makeFixture();
  const media = await available(fixture);
  const post = await createPostAnchor(fixture);
  const report = await runMediaGrowth(fixture, 'Post media claim', async () => {
    await claimPostMedia(fixture, media.id, post.postId, post.revisionId);
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Cover reference read and claim stays within its bound as u grows', async () => {
  const fixture = await makeFixture();
  const mediaId = await importedMedia(fixture, 'cover-reference-anchor');
  await processImportedMedia(await importDependencies(fixture), mediaId);
  await createImageJob(db!.pool, fixture.storage).process(mediaId);
  const report = await runMediaGrowth(
    fixture,
    'Cover reference read and claim',
    async () => {
      const reference = await withConnection(db!.pool, (client) => checkMediaObject(client, mediaId, 'cover'));
      if (!reference) throw new Error('Fixed cover reference was not available');
      await coverClaim(fixture, mediaId);
      return reference;
    },
    true,
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Image publication stays within its bound as u grows', async () => {
  const fixture = await makeFixture();
  const targets = await Promise.all(Array.from({ length: 3 }, () => uploaded(fixture)));
  const job = createImageJob(db!.pool, fixture.storage);
  const report = await runMediaGrowth(fixture, 'Image publication', async (_database, _scale, repetition) => {
    const media = targets[repetition];
    if (!media) throw new Error('Missing fixed image publication target');
    return job.process(media.id);
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Collection selection stays within its bound as P grows', async () => {
  const fixture = await makeFixture();
  const targets = await Promise.all([available(fixture), available(fixture)]);
  for (const media of targets) {
    await db!.admin.query(
      "UPDATE content.media SET created_at='2020-01-01T00:00:00.000Z' WHERE route=$1 AND media_id=$2",
      [fixture.route, media.id],
    );
  }
  const report = await runMediaGrowth(fixture, 'Collection selection', async (database) => {
    const selected = await selectCollectable(database.pool, fixture.partition, 32);
    if (selected.length !== targets.length) throw new Error('Collection selection changed its fixed old neighbourhood');
    return selected;
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Collection per object stays within its bound as u grows', async () => {
  const fixture = await makeFixture();
  const targets = await Promise.all(Array.from({ length: 3 }, () => available(fixture)));
  for (const media of targets) {
    await db!.admin.query(
      "UPDATE content.media SET created_at='2020-01-01T00:00:00.000Z' WHERE route=$1 AND media_id=$2",
      [fixture.route, media.id],
    );
  }
  const job = createCollectionJob(db!.pool, fixture.storage);
  const report = await runMediaGrowth(fixture, 'Collection per object', async () => {
    const outcome = await job.collectPartition(fixture.partition, 1);
    if (outcome.examined !== 1 || outcome.collected !== 1)
      throw new Error('Collection did not process its fixed object');
    return outcome;
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Imported image processing stays within its bound as u grows', async () => {
  const initialTag = randomUUID().replaceAll('-', '').slice(0, 12);
  const source = sourceName(initialTag);
  const sourcePartition = partitionOf(tupleRoute(routeKey, source, `anchor-${initialTag}`));
  let mediaPartition = newPartition();
  while (mediaPartition === sourcePartition) mediaPartition = newPartition();
  const fixture = await makeFixture({ partition: mediaPartition, tag: initialTag });
  const targets = await Promise.all(
    Array.from({ length: 3 }, (_, index) => importedMedia(fixture, `imported-anchor-${index}`)),
  );
  const deps = await importDependencies(fixture);
  const report = await runMediaGrowth(
    fixture,
    'Imported image processing',
    async (_database, _scale, repetition) => {
      const mediaId = targets[repetition];
      if (!mediaId) throw new Error('Missing fixed imported-media target');
      return processImportedMedia(deps, mediaId);
    },
    true,
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Source fence check stays within its bound as P grows', async () => {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const source = sourceName(tag);
  const externalId = `anchor-${tag}`;
  const sourcePartition = partitionOf(tupleRoute(routeKey, source, externalId));
  const fixture = await makeFixture({ partition: sourcePartition, tag });
  await db!.admin.query(
    `INSERT INTO semantic.context(route,context_id,kind,labels,recorded_transaction_id)
     VALUES (0,$1,'global','{"en":"Global"}'::jsonb,$2) ON CONFLICT (route,context_id) DO NOTHING`,
    [platform, newId(0)],
  );
  await takedownSourceFence(
    { pool: db!.pool, access: fixture.access, routeKey, clock: () => new Date() },
    fixture.actor,
    { source, external_id: externalId, field_group: 'cover', reason: 'Growth lookup anchor' },
    context(),
  );
  const population = await sourcePopulation(fixture);
  const report = await checkGrowth(db!, {
    name: 'Source fence check',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 0,
    grow: async (database, scale, previous) => {
      await seed({ pool: database.pool, admin: database.admin }, population, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
    },
    operation: async (database) =>
      withConnection(database.pool, async (client: PoolClient) =>
        readFences(client, [{ route: fixture.sourceRoute, source, external_id: externalId, field_group: 'cover' }]),
      ),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);
