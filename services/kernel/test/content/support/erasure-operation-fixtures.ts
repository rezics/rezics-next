import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { threadTarget } from '../../../src/content/commands.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { createNativeContentSystem, type NativeContentSystem } from './native-system.ts';

export type DriverPersona = 'anonymous' | 'author' | 'legal' | 'unrelated' | 'suspended' | 'revoked' | 'governance';

export type FixtureResources = {
  system: NativeContentSystem;
  pool: Pool;
  appUrl: string;
  kernel: NativeContentSystem['kernel'];
  governanceBearer: string;
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
  const response = await resources.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
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

export async function createFixtureResources(databaseUrl: string): Promise<FixtureResources> {
  const system = await createNativeContentSystem({ databaseUrl });
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
    const result = spawnSync('bun', [commandPath, '--account', governanceId], {
      env: { ...process.env, DATABASE_URL: appUrl },
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Native governance bootstrap command failed: ${result.stdout}${result.stderr}`);
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
      accountIds,
      bearer: (persona) => bearers.get(persona),
      updateBearer(persona, bearer) {
        bearers.set(persona, bearer);
      },
    };
    await bootstrapRelease(pool, bundledRelease);

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
    return resources;
  } catch (error) {
    await system.close();
    throw error;
  }
}

export async function buildBoardAndThreads(
  resources: FixtureResources,
  posts: number,
  revisions: number,
  marker: string,
  targetPartition?: number,
) {
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

  const targeted: { id: string; revisions: { id: string; digest: string; body: string }[] }[] = new Array(posts);
  await runInBatches(posts, 24, async (postIndex) => {
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

  // Preserve exact-history reads independently of the creator role. Give the
  // workflow initiator its own post:read grants and let Governance hold the old
  // role actions so ordinary role-revocation commands can remove only authorship.
  const governorId = (
    await resources.pool.query<{ account_id: string }>(
      'SELECT account_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2',
      [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id],
    )
  ).rows[0]!.account_id;
  await runInBatches(targeted.length, 24, async (index) => {
    const post = targeted[index]!;
    const target = { route, id: post.id };
    await grant(resources, 'governance', {
      resource: target,
      subject: { kind: 'account', id: authorId },
      actions: ['access:grant'],
    });
    await setupRequest(resources, 'author', 'POST', '/v1/grants', {
      resource: target,
      subject: { kind: 'account', id: authorId },
      actions: ['post:read'],
      valid: '(,)',
    });
    await setupRequest(resources, 'author', 'POST', '/v1/grants', {
      resource: target,
      subject: { kind: 'account', id: governorId },
      actions: ['post:read', 'post:revise', 'media:create'],
      valid: '(,)',
    });
  });
  for (const accountId of [authorId, otherId]) {
    const grants = await resources.pool.query<{ valid: string }>(
      `SELECT valid::text FROM access.resource_grant
       WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
         AND subject_role='' AND action='access:grant' AND upper_inf(valid)`,
      [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, accountId],
    );
    for (const row of grants.rows)
      await revokeGrant(resources, 'governance', {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: accountId },
        actions: ['access:grant'],
        valid: row.valid,
      });
  }

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
