import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import {
  createResourceCreationManifest,
  initializeResourceGrants,
  parentCreationAuthorization,
} from '../../../src/access/index.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import {
  authoritativeTimeValue,
  runCommand,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../../../src/command/command.ts';
import { threadTarget } from '../../../src/content/commands.ts';
import { validateContentDocument } from '../../../src/content/document.ts';
import readPost from '../../../src/content/read-post.sql';
import readThread from '../../../src/content/read-thread.sql';
import { createKernel } from '../../../src/http/kernel.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createNativeContentSystem, type NativeContentSystem } from './native-system.ts';

const phaseLog = fileURLToPath(new URL('../../../../../.temp/erasure-phases.log', import.meta.url));
mkdirSync(dirname(phaseLog), { recursive: true });
function mark(phase: string): void {
  appendFileSync(phaseLog, `${Date.now()} ${phase}\n`);
}

export type DriverPersona = 'anonymous' | 'author' | 'legal' | 'unrelated' | 'suspended' | 'revoked' | 'governance';

export type FixtureResources = {
  system: NativeContentSystem;
  pool: Pool;
  appUrl: string;
  kernel: NativeContentSystem['kernel'];
  governanceBearer: string;
  /** The operator bootstrap command, overlapped with publishing. */
  bootstrap: Promise<void>;
  stopBootstrap(): void;
  accountIds: Record<'author' | 'legal' | 'unrelated' | 'suspended', string>;
  bearer(persona: DriverPersona): string | undefined;
  updateBearer(persona: DriverPersona, bearer: string): void;
};

async function runInBatches(count: number, size: number, operation: (index: number) => Promise<void>): Promise<void> {
  for (let start = 0; start < count; start += size) {
    await Promise.all(Array.from({ length: Math.min(size, count - start) }, (_, offset) => operation(start + offset)));
  }
}

export function responseValue<T>(response: Response): Promise<T> {
  return response.clone().json() as Promise<T>;
}

export async function request(
  resources: FixtureResources,
  persona: DriverPersona,
  method: string,
  path: string,
  body?: unknown,
  key: string = randomUUID(),
): Promise<Response> {
  const bearer = resources.bearer(persona);
  return resources.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

export async function setupRequest<T>(
  resources: FixtureResources,
  persona: DriverPersona,
  method: string,
  path: string,
  body?: unknown,
  status = 201,
  key: string = randomUUID(),
  headers: Record<string, string> = {},
): Promise<T> {
  const bearer = resources.bearer(persona);
  const send = (idempotencyKey: string) =>
    resources.kernel.handle(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(idempotencyKey) }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const response = await send(key);
  const wire = await response.text();
  if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${wire}`);
  if (!wire) return undefined as T;
  return JSON.parse(wire) as T;
}

export async function grant(
  resources: FixtureResources,
  grantor: DriverPersona,
  input: {
    resource: { route: number; id: string };
    subject: { kind: 'account'; id: string };
    actions: readonly string[];
    valid?: string;
  },
): Promise<void> {
  await setupRequest(resources, grantor, 'POST', '/v1/grants', { ...input, valid: input.valid ?? '(,)' });
}

/** Global access:grant lets the author administer explicit post:read during setup only. */
export async function ensureAuthorAccessGrant(resources: FixtureResources): Promise<void> {
  const authorId = resources.accountIds.author;
  const open = await resources.pool.query(
    `SELECT 1 FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
       AND subject_role='' AND action='access:grant' AND upper_inf(valid)`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, authorId],
  );
  if (open.rows.length > 0) return;
  const now = await resources.pool.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
  const at = now.rows[0]?.at;
  if (!at) throw new Error('Author access:grant restoration has no database time');
  await grant(resources, 'governance', {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: authorId },
    actions: ['access:grant'],
    valid: `[${at},)`,
  });
}

/** Drop the setup administration grant before any scenario observes the author. */
export async function revokeAuthorAccessGrant(resources: FixtureResources): Promise<void> {
  const authorId = resources.accountIds.author;
  const open = await resources.pool.query<{ valid: string }>(
    `SELECT valid::text FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
       AND subject_role='' AND action='access:grant' AND upper_inf(valid)`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, authorId],
  );
  for (const row of open.rows)
    await revokeGrant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: authorId },
      actions: ['access:grant'],
      valid: row.valid,
    });
}

export async function revokeGrant(
  resources: FixtureResources,
  grantor: DriverPersona,
  input: {
    resource: { route: number; id: string };
    subject: { kind: 'account'; id: string };
    actions: readonly string[];
    valid?: string;
  },
): Promise<void> {
  await setupRequest(resources, grantor, 'POST', '/v1/grants:revoke', { ...input, valid: input.valid ?? '(,)' }, 200);
}

export async function createFixtureResources(
  databaseUrl: string,
  duringSetup?: (system: NativeContentSystem) => Promise<void>,
  stopSetupWorker?: () => Promise<void>,
): Promise<FixtureResources> {
  const started = performance.now();
  const system = await createNativeContentSystem({ databaseUrl });
  let cursor = phase('native-system', started);
  const overlapped = duringSetup?.(system) ?? Promise.resolve();
  let bootstrapProcess: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const pool = system.database.pool;
    const appUrl = pool.options.connectionString;
    if (!appUrl) throw new Error('Native content pool has no connection URL');
    const accountIds = {
      author: system.actors.author.actor.accountId,
      legal: system.actors.moderator.actor.accountId,
      unrelated: system.actors.other.actor.accountId,
      suspended: system.actors.suspended.actor.accountId,
    };
    const govRow = await pool.query<{ account_id: string }>(
      'SELECT account_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2',
      [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id],
    );
    const governanceId = govRow.rows[0]?.account_id;
    if (!governanceId) throw new Error('Native governance bootstrap did not return its account');
    const commandPath = fileURLToPath(new URL('../../../../kernel/scripts/bootstrap-governance.ts', import.meta.url));
    // The account is already bootstrapped. Run the operator command beside publishing;
    // waiting for its process import first spends the hook budget before any post exists.
    bootstrapProcess = Bun.spawn([process.execPath, commandPath, '--account', governanceId], {
      env: { ...process.env, DATABASE_URL: appUrl },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const piped = (output: NonNullable<typeof bootstrapProcess>['stdout']): ReadableStream<Uint8Array> => {
      if (typeof output === 'number' || output === undefined)
        throw new Error('Governance bootstrap command did not pipe its output');
      return output;
    };
    const bootstrap = Promise.all([
      new Response(piped(bootstrapProcess.stdout)).text(),
      new Response(piped(bootstrapProcess.stderr)).text(),
      bootstrapProcess.exited,
    ]).then(([stdout, stderr, status]) => {
      if (status !== 0) throw new Error(`Native governance bootstrap command failed: ${stdout}${stderr}`);
    });
    const governance = await system.auth.issue({
      accountId: governanceId,
      clientId: system.auth.ordinaryClient.id,
      scopes: [...system.actions.keys()].filter((action) => action !== 'media:complete').sort(),
    });

    const bearers = new Map<DriverPersona, string | undefined>([
      ['anonymous', undefined],
      ['author', system.actors.author.bearer],
      ['legal', system.actors.moderator.bearer],
      ['unrelated', system.actors.other.bearer],
      ['suspended', system.actors.suspended.bearer],
      ['revoked', system.actors.other.bearer],
      ['governance', governance.bearer],
    ]);
    const kernel = createKernel({
      pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      clock: () => new Date(),
      content: { cursorNow: () => Date.now() },
      access: () => system.access,
      writeRate: createWriteRateLimiter({
        secret: `erasure-fixture-${randomUUID()}-${randomUUID()}`,
        overrides: '{"new-account":{"write":{"maximum":100000,"seconds":60}}}',
      }),
      ratePeer: () => '127.0.0.1',
    });
    const resources: FixtureResources = {
      system,
      pool,
      appUrl,
      kernel,
      governanceBearer: governance.bearer,
      bootstrap,
      stopBootstrap() {
        try {
          bootstrapProcess?.kill();
        } catch {
          // The operator process has already exited.
        }
      },
      accountIds,
      bearer: (persona) => bearers.get(persona),
      updateBearer(persona, bearer) {
        bearers.set(persona, bearer);
      },
    };
    cursor = phase('governance-credential', cursor);
    await bootstrapRelease(pool, bundledRelease);
    cursor = phase('semantic-release', cursor);

    // Ordinary API credentials install grants needed to construct a public board.
    // The temporary management grants are revoked before the fixture is returned.
    await grant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountIds.legal },
      actions: ['access:grant'],
    });
    await grant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountIds.unrelated },
      actions: ['access:grant'],
    });
    await grant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountIds.author },
      actions: ['access:grant'],
    });
    await grant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountIds.unrelated },
      actions: ['post:erase'],
    });
    await revokeGrant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountIds.unrelated },
      actions: ['post:erase'],
    });
    await grant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountIds.suspended },
      actions: ['post:erase'],
    });
    await grant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountIds.legal },
      actions: ['post:erase', 'moderation:takedown'],
    });
    cursor = phase('governance-grants', cursor);
    await overlapped;
    phase('worker-ready-wait', cursor);
    return resources;
  } catch (error) {
    bootstrapProcess?.kill();
    await bootstrapProcess?.exited;
    await overlapped.catch(() => undefined);
    const failures: unknown[] = [];
    // The overlapped worker owns native connections to these databases. Retire
    // it before the system drops either database, including failed setup.
    for (const close of [() => stopSetupWorker?.(), () => system.close()]) {
      try {
        await close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Native fixture setup and cleanup failed');
    throw error;
  }
}

export type SeededBoard = Awaited<ReturnType<typeof buildBoardAndThreads>>;

const BULK_POSTS = 16;
type TargetedPost = { id: string; revisions: { id: string; digest: string; body: string }[] };

function phase(name: string, started: number): number {
  const elapsed = Math.round(performance.now() - started);
  console.log(`erasure-setup ${name} ${elapsed}ms`);
  mark(`setup ${name} ${elapsed}ms`);
  return performance.now();
}

/** Direct post:read, the explicit holder an erased revision discloses to. Batches stay within the creation bound. */
async function grantExplicitPostRead(
  resources: FixtureResources,
  route: number,
  postIds: readonly string[],
  authorId: string,
): Promise<void> {
  if (postIds.length === 0) return;
  const bearer = resources.bearer('author');
  if (!bearer) throw new Error('Author bearer is missing');
  const deadline = Date.now() + 30_000;
  const authenticated = await resources.system.access.authenticate(bearer, { pool: resources.pool, deadline });
  if (authenticated.kind !== 'account') throw new Error('Author bearer did not authenticate an account');
  const commands = createGrantCommands({
    pool: resources.pool,
    access: resources.system.access,
    managementAction: 'access:grant',
  });
  for (let start = 0; start < postIds.length; start += BULK_POSTS) {
    const batch = postIds.slice(start, start + BULK_POSTS);
    await Promise.all(
      batch.map((postId) =>
        commands.create(
          { pool: resources.pool, actor: authenticated, deadline: Date.now() + 30_000 },
          {
            resource: { route, id: postId },
            subject: { kind: 'account', id: authorId },
            actions: ['post:read'],
            valid: '(,)',
            key: randomUUID(),
          },
        ),
      ),
    );
  }
}

/** One bulk post and one API post must present the same rows erasure reads. */
async function assertSameErasureShape(pool: Pool, route: number, apiPostId: string, bulkPostId: string): Promise<void> {
  const shape = async (postId: string) => {
    const post = await pool.query(
      `SELECT thread_id::text, reply_to_post_id::text AS parent_id, author_account_id::text AS author_id,
              visibility, availability, security_revision::text AS security_revision,
              head_revision_id IS NOT NULL AS has_head,
              created_at IS NOT NULL AS has_created,
              recorded_transaction_id IS NOT NULL AS has_transaction
       FROM content.post WHERE route=$1 AND post_id=$2`,
      [route, postId],
    );
    const revisions = await pool.query(
      `SELECT count(*)::int AS count,
              bool_and(body IS NOT NULL) AS bodies,
              bool_and(search_text IS NOT NULL) AS search,
              bool_and(body_sha256 IS NOT NULL) AS digests,
              bool_and(availability = 'available') AS available,
              min(licence::text) AS licence,
              min(board_id::text) AS board_id,
              bool_and(cardinality(subject_ids) = 0) AS empty_subjects,
              bool_and(cardinality(media_ids) = 0) AS empty_media,
              bool_and(recorded_at IS NOT NULL AND recorded_transaction_id IS NOT NULL) AS recorded
       FROM content.revision WHERE route=$1 AND post_id=$2`,
      [route, postId],
    );
    const roles = await pool.query(
      `SELECT grant_role, subject_kind, subject_id::text, subject_role, upper_inf(valid) AS open
       FROM access.resource_role_grant
       WHERE route=$1 AND resource_id=$2
       ORDER BY grant_role, subject_kind, subject_id, subject_role`,
      [route, postId],
    );
    const initialized = await pool.query(
      `SELECT resource_type, creator_id::text FROM access.resource_initialization
       WHERE route=$1 AND resource_id=$2 ORDER BY resource_type`,
      [route, postId],
    );
    const actions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM access.resource_grant WHERE route=$1 AND resource_id=$2`,
      [route, postId],
    );
    const events = await pool.query(
      `SELECT e.data->>'placeId' AS place_id, e.data->>'kind' AS kind,
              e.data->'subjectIds' AS subject_ids, e.data->>'actorId' AS actor_id,
              (e.data->>'activityAt')::timestamptz = p.created_at AS at_creation,
              e.data->>'threadId' = p.thread_id::text AS same_thread,
              EXISTS (SELECT 1 FROM content.revision r
                      WHERE r.route=p.route AND r.post_id=p.post_id
                        AND r.revision_id=(e.data->>'revisionId')::uuid) AS has_revision
       FROM core.outbox e
       JOIN content.post p ON p.route=$1 AND p.post_id=$2
       WHERE e.partition_no=$3 AND e.type='com.rezics.content.post.created.v1'
         AND e.subject=$2::text AND e.data->>'itemId'=$2::text`,
      [route, postId, partitionOf(route)],
    );
    if (events.rows.length !== 1) throw new Error('Seeded post must have exactly one native creation event');
    return {
      post: post.rows[0],
      revisions: revisions.rows[0],
      roles: roles.rows,
      initialized: initialized.rows,
      actionGrants: actions.rows[0]?.count ?? 0,
      events: events.rows,
    };
  };
  const api = await shape(apiPostId);
  const bulk = await shape(bulkPostId);
  if (JSON.stringify(api) !== JSON.stringify(bulk))
    throw new Error(`Bulk post row shape differs from the published post: ${JSON.stringify({ api, bulk })}`);
}

async function writeBulkPosts(
  resources: FixtureResources,
  input: {
    route: number;
    threadId: string;
    parentId: string;
    boardId: string;
    placeId: string;
    authorId: string;
    marker: string;
    revisions: number;
    startIndex: number;
    count: number;
  },
): Promise<TargetedPost[]> {
  if (input.count < 1 || input.count > BULK_POSTS) throw new RangeError('A bulk history command creates 1 to 16 posts');
  const bearer = resources.bearer('author');
  if (!bearer) throw new Error('Author bearer is missing');
  const deadline = Date.now() + 10_000;
  // The stored actor is bound to the system pool. Reply creation authenticates
  // the same bearer on the kernel pool, and the command must use that observation.
  const authenticated = await resources.system.access.authenticate(bearer, { pool: resources.pool, deadline });
  if (authenticated.kind !== 'account') throw new Error('Author bearer did not authenticate an account');
  const actor = authenticated;
  const posts = Array.from({ length: input.count }, (_, offset) => {
    const index = input.startIndex + offset;
    const history = Array.from({ length: input.revisions }, (__, revisionIndex) => {
      const body = `${input.marker} post-${index} revision-${revisionIndex}`;
      const validated = validateContentDocument({
        body: fromPlainText(body),
        licence: 'CC0-1.0',
        subjectIds: [],
      });
      const bytes = Buffer.from(validated.canonicalBytes);
      return {
        id: newId(input.route),
        body,
        search: validated.searchText,
        hex: bytes.toString('hex'),
        digest: createHash('sha256').update(bytes).digest('hex'),
        ordinal: revisionIndex,
      };
    });
    return { id: newId(input.route), history };
  });
  const inserted = new WeakMap<CommandTransaction, string>();
  const creation = {
    async validate(tx: CommandTransaction, resource: { route: number; id: string }, time: AuthoritativeTime) {
      const row = await readPost.run(tx, { route: resource.route, id: resource.id });
      return (
        row !== null &&
        row.inserted_here === true &&
        inserted.get(tx) === row.recorded_transaction_id &&
        row.author_account_id === input.authorId &&
        typeof row.created_at === 'string' &&
        Date.parse(row.created_at) === Date.parse(authoritativeTimeValue(time))
      );
    },
  };
  const entries = posts.map((post) => ({
    resource: { route: input.route, id: post.id },
    type: 'content.post',
    creator: input.authorId,
    creation,
  }));
  const authorization = parentCreationAuthorization({
    access: resources.system.access,
    actor,
    action: 'post:create',
    parent: {
      resource: { route: input.route, id: input.threadId },
      async validate(client) {
        const thread = await readThread.run(client, { route: input.route, id: input.threadId });
        if (!thread || thread.availability !== 'available' || thread.visibility === 'taken_down') return false;
        const parent = await readPost.run(client, { route: input.route, id: input.parentId });
        return (
          parent !== null &&
          parent.thread_id === input.threadId &&
          parent.availability === 'available' &&
          parent.visibility !== 'taken_down'
        );
      },
    },
    context: {
      pool: resources.pool,
      deadline,
      resource: entries[0]!.resource,
      creation,
      manifest: createResourceCreationManifest(entries),
    },
  });
  await runCommand(
    resources.pool,
    {
      partition: partitionOf(input.route),
      deadline,
      authorization,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    },
    async (tx, command) => {
      const at = authoritativeTimeValue(command.time);
      const revisionRows = posts.flatMap((post) => post.history.map((revision) => ({ postId: post.id, ...revision })));
      await tx.query(
        `INSERT INTO content.post
           (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id,
            visibility, security_revision, recorded_transaction_id, created_at, availability)
         SELECT $1, $2, post_id, $3, $4, head_revision_id, 'published', 1, $5, $6::timestamptz, 'available'
         FROM unnest($7::uuid[], $8::uuid[]) AS row(post_id, head_revision_id)`,
        [
          input.route,
          input.threadId,
          input.parentId,
          input.authorId,
          command.transactionId,
          at,
          posts.map((post) => post.id),
          posts.map((post) => post.history.at(-1)!.id),
        ],
      );
      await tx.query(
        `INSERT INTO content.revision
           (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
            subject_ids, board_id, availability, recorded_transaction_id, recorded_at, media_ids)
         SELECT $1, $2, post_id, revision_id, decode(body_hex, 'hex'), decode(digest_hex, 'hex'),
                search_text, 'CC0-1.0', '{}'::uuid[], $3, 'available', $4,
                $5::timestamptz + (ordinal * interval '1 microsecond'), '{}'::uuid[]
         FROM unnest($6::uuid[], $7::uuid[], $8::text[], $9::text[], $10::text[], $11::integer[])
           AS row(post_id, revision_id, body_hex, digest_hex, search_text, ordinal)`,
        [
          input.route,
          input.threadId,
          input.boardId,
          command.transactionId,
          at,
          revisionRows.map((row) => row.postId),
          revisionRows.map((row) => row.id),
          revisionRows.map((row) => row.hex),
          revisionRows.map((row) => row.digest),
          revisionRows.map((row) => row.search),
          revisionRows.map((row) => row.ordinal),
        ],
      );
      inserted.set(tx, command.transactionId);
      for (const post of posts)
        await initializeResourceGrants(tx, {
          resource: { route: input.route, id: post.id },
          type: 'content.post',
          creator: input.authorId,
        });
      // Match publish's thread-index fields and preserve the command's native T.
      const context = await tx.query<{
        kind: 'discussion' | 'review';
        subject_ids: string[];
        activity_at: string;
      }>(
        `SELECT t.kind, r.subject_ids,
                to_char($3::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_at
         FROM content.thread t
         JOIN content.post p ON p.route=t.route AND p.post_id=t.first_post_id
         JOIN content.revision r ON r.route=p.route AND r.revision_id=p.head_revision_id
         WHERE t.route=$1 AND t.thread_id=$2`,
        [input.route, input.threadId, at],
      );
      const index = context.rows[0];
      if (!index) throw new Error('Bulk history has no native thread index context');
      return {
        value: { posts: posts.length },
        events: posts.map((post) => ({
          type: 'com.rezics.content.post.created.v1',
          subject: post.id,
          data: {
            threadId: input.threadId,
            itemId: post.id,
            revisionId: post.history[0]!.id,
            actorId: input.authorId,
            placeId: input.placeId,
            kind: index.kind,
            subjectIds: index.subject_ids,
            activityAt: index.activity_at,
          },
        })),
      };
    },
  );
  return posts.map((post) => ({
    id: post.id,
    revisions: post.history.map((revision) => ({ id: revision.id, digest: revision.digest, body: revision.body })),
  }));
}

export async function buildBoardAndThreads(
  resources: FixtureResources,
  posts: number,
  revisions: number,
  marker: string,
  targetPartition?: number,
) {
  const started = performance.now();
  await ensureAuthorAccessGrant(resources);
  const { system } = resources;
  const otherId = resources.accountIds.unrelated;
  const authorId = resources.accountIds.author;
  const { space } = await setupRequest<{ space: { spaceId: string } }>(resources, 'unrelated', 'POST', '/v1/spaces', {
    title: 'Erasure fixture space',
    summary: '',
  });
  const { realm } = await setupRequest<{ realm: { realmId: string; headRevisionId: string } }>(
    resources,
    'unrelated',
    'POST',
    '/v1/realms',
    {
      spaceId: space.spaceId,
      title: 'Erasure fixture realm',
      summary: '',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
  );
  const { subject: scheme } = await setupRequest<{ subject: { id: string } }>(
    resources,
    'unrelated',
    'POST',
    '/v1/subjects',
    {
      type: 'skos:ConceptScheme',
      labels: { en: 'Erasure fixture scheme' },
    },
  );
  const { subject: concept } = await setupRequest<{ subject: { id: string } }>(
    resources,
    'unrelated',
    'POST',
    '/v1/subjects',
    {
      type: 'skos:Concept',
      labels: { en: 'Erasure fixture board' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    },
  );
  await setupRequest(
    resources,
    'unrelated',
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId: scheme.id },
    200,
    randomUUID(),
    { 'if-match': JSON.stringify(realm.headRevisionId) },
  );
  const { board } = await setupRequest<{ board: { id: string } }>(
    resources,
    'unrelated',
    'POST',
    `/v1/realms/${realm.realmId}/boards`,
    { conceptId: concept.id, title: 'Erasure fixture board', visibility: 'published' },
  );

  let targetKey = randomUUID();
  while (
    partitionOf(threadTarget(system.routeKey, otherId, targetKey).route) === partitionOf(routeOf(authorId)!) ||
    (targetPartition !== undefined &&
      partitionOf(threadTarget(system.routeKey, otherId, targetKey).route) !== targetPartition)
  )
    targetKey = randomUUID();
  const thread = await setupRequest<{
    thread: { id: string; route: number; firstPost: { id: string; revisionId: string } };
  }>(
    resources,
    'unrelated',
    'POST',
    '/v1/threads',
    {
      title: 'Unrelated first post',
      body: fromPlainText('Unrelated opening post'),
      licence: 'CC0-1.0',
      subjectIds: [],
      boardId: board.id,
      visibility: 'published',
    },
    201,
    targetKey,
  );
  const threadId = thread.thread.id;
  const route = routeOf(threadId)!;
  const partition = partitionOf(route);
  const firstPostId = thread.thread.firstPost.id;
  const authorPostCreate = {
    resource: { route, id: threadId },
    subject: { kind: 'account' as const, id: authorId },
    actions: ['post:create'],
  };
  await grant(resources, 'governance', authorPostCreate);
  let cursor = phase('board', started);

  const targeted: TargetedPost[] = new Array(posts);
  // Two real replies prove publish, edit and the creation grants. The partition
  // gate runs one command; a second chain overlaps the account read before it.
  const apiCount = Math.min(2, posts);
  await runInBatches(apiCount, 2, async (postIndex) => {
    const firstBody = `${marker} post-${postIndex} revision-0`;
    const created = await setupRequest<{
      post: { id: string; revisionId: string; sha256: string };
    }>(resources, 'author', 'POST', `/v1/threads/${threadId}/posts`, {
      body: fromPlainText(firstBody),
      licence: 'CC0-1.0',
      subjectIds: [],
      parentId: firstPostId,
    });
    const history = [{ id: created.post.revisionId, digest: created.post.sha256, body: firstBody }];
    let previous = created.post.revisionId;
    for (let revisionIndex = 1; revisionIndex < revisions; revisionIndex++) {
      const body = `${marker} post-${postIndex} revision-${revisionIndex}`;
      const revised = await setupRequest<{ post: { id: string; revisionId: string; sha256: string } }>(
        resources,
        'author',
        'POST',
        `/v1/posts/${created.post.id}/revisions`,
        { body: fromPlainText(body), licence: 'CC0-1.0', subjectIds: [] },
        200,
        randomUUID(),
        { 'if-match': JSON.stringify(previous) },
      );
      history.push({ id: revised.post.revisionId, digest: revised.post.sha256, body });
      previous = revised.post.revisionId;
    }
    targeted[postIndex] = { id: created.post.id, revisions: history };
  });
  for (const post of targeted.slice(0, apiCount))
    await grant(resources, 'author', {
      resource: { route, id: post!.id },
      subject: { kind: 'account', id: authorId },
      actions: ['post:read'],
    });
  cursor = phase('api-posts', cursor);
  for (let start = apiCount; start < posts; start += BULK_POSTS) {
    const written = await writeBulkPosts(resources, {
      route,
      threadId,
      parentId: firstPostId,
      boardId: board.id,
      placeId: realm.realmId,
      authorId,
      marker,
      revisions,
      startIndex: start,
      count: Math.min(BULK_POSTS, posts - start),
    });
    for (let offset = 0; offset < written.length; offset++) targeted[start + offset] = written[offset]!;
  }
  cursor = phase('bulk-posts', cursor);
  await grantExplicitPostRead(
    resources,
    route,
    targeted.slice(apiCount).map((post) => post!.id),
    authorId,
  );
  cursor = phase('explicit-read', cursor);
  if (apiCount > 0 && posts > apiCount)
    await assertSameErasureShape(resources.pool, route, targeted[0]!.id, targeted[apiCount]!.id);
  phase('shape', cursor);

  const unrelatedGrant = await resources.pool.query<{ valid: string }>(
    `SELECT valid::text FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
       AND subject_role='' AND action='access:grant' AND upper_inf(valid)`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, otherId],
  );
  for (const row of unrelatedGrant.rows)
    await revokeGrant(resources, 'governance', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: otherId },
      actions: ['access:grant'],
      valid: row.valid,
    });

  let sentinelKey = randomUUID();
  while (partitionOf(threadTarget(system.routeKey, otherId, sentinelKey).route) === partition)
    sentinelKey = randomUUID();
  const sentinel = await setupRequest<{
    thread: { id: string; firstPost: { id: string; revisionId: string } };
  }>(
    resources,
    'unrelated',
    'POST',
    '/v1/threads',
    {
      title: 'Other partition sentinel',
      body: fromPlainText('Other partition sentinel body'),
      licence: 'CC0-1.0',
      subjectIds: [],
      boardId: board.id,
      visibility: 'published',
    },
    201,
    sentinelKey,
  );

  return {
    board: board.id,
    thread: threadId,
    firstPost: firstPostId,
    sentinelThread: sentinel.thread.id,
    sentinelPost: sentinel.thread.firstPost.id,
    route,
    partition,
    authorId,
    targeted,
    marker,
  };
}
