import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import reylo from 'reylo/esbuild';
import type {
  Board,
  Content,
  ContentDisclosureDriver,
  Item,
  Observation,
  Page,
  Persona,
  Reply,
  Report,
  Revision,
  Target,
} from '../../../../specs/content-disclosure-driver.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createBoardEffect } from '../../src/content/board-projection.ts';
import { createReportEffect } from '../../src/content/report-effect.ts';
import type { Effect } from '../../src/events/effects.ts';
import { projectBatch, type Envelope } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import type { GrowthDatabase } from '../support/growth.ts';
import {
  AUDIENCE,
  BOARD_TITLE,
  createDisclosureTurnstile,
  documentBytes,
  effectKind,
  EFFECT_TYPES,
  hexDigest,
  hexFromBytea,
  HIGH_RATE_OVERRIDES,
  PROJECTION_CONSUMER,
  revisionFromView,
  seedDisclosureDistractors,
  seedGovernanceAuthority,
  seedResourceDenial,
  storedVisibility,
  textFromBytea,
} from './support/disclosure-fixtures.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

const READ_ACTION = { board: 'board:read', thread: 'thread:read', post: 'post:read' } as const;
const OWNER_ROLE = {
  board: 'content.board.owner',
  thread: 'content.thread.owner',
  post: 'content.post.owner',
} as const;
/** Actions the public role-revoke command rechecks. They match the catalogue templates. */
const OWNER_ACTIONS = {
  board: ['board:read', 'thread:create'],
  thread: ['thread:read', 'post:create', 'media:create'],
  post: ['post:read', 'post:revise', 'post:erase', 'media:create'],
} as const;
const MODERATION_ACTIONS = ['moderation:read_reports', 'moderation:takedown'];
const MEASURED_ROUTE = 16;

let preparedWorker: Promise<{ path: string; close(): Promise<void> }> | undefined;

/** Compile real SQL modules once, outside scenario timers, rather than on each worker's cold start. */
export function prepareDisclosureWorker(): Promise<{ path: string; close(): Promise<void> }> {
  return (preparedWorker ??= (async () => {
    const temporaryRoot = fileURLToPath(new URL('../../../../.temp/', import.meta.url));
    await mkdir(temporaryRoot, { recursive: true });
    const directory = await mkdtemp(`${temporaryRoot}disclosure-worker-`);
    try {
      await symlink(fileURLToPath(new URL('../../node_modules/', import.meta.url)), `${directory}/node_modules`);
      const build = await Bun.build({
        entrypoints: [fileURLToPath(new URL('./support/disclosure-fixtures.ts', import.meta.url))],
        outdir: directory,
        naming: 'worker.mjs',
        target: 'bun',
        packages: 'external',
        plugins: [
          reylo(),
          {
            name: 'preserve-source-locations',
            setup(builder) {
              // Production modules resolve non-code assets relative to their source URL.
              builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({
                loader: 'ts',
                contents: (await readFile(path, 'utf8')).replaceAll(
                  'import.meta.url',
                  JSON.stringify(pathToFileURL(path).href),
                ),
              }));
            },
          },
        ],
      });
      if (!build.success) throw new AggregateError(build.logs, 'Disclosure worker build failed');
      return { path: `${directory}/worker.mjs`, close: () => rm(directory, { recursive: true, force: true }) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  })());
}

type RecordedRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
};

type CommandReference = {
  partition: number;
  principalKind: 'account' | 'anonymous';
  principalId: string;
  commandKind: string;
  key: string;
};

type HttpCall = {
  method: string;
  path: string;
  persona: Persona;
  body?: unknown;
  key?: string;
  extraHeaders?: Record<string, string>;
  bearer?: string;
  recordKey?: string;
};

const suiteDrivers = new Set<ContentDisclosureDriver>();

async function releaseSuiteDrivers(): Promise<void> {
  await Promise.all([...suiteDrivers].map((driver) => driver.close()));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is missing`);
  return value as Record<string, unknown>;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is missing`);
  return value;
}

function requiredRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new Error(`Content id ${id} is not routed`);
  return route;
}

function databaseName(prefix: string): string {
  const name = `${prefix}${randomUUID().replaceAll('-', '')}`;
  if (!/^[a-z][a-z0-9]+$/.test(name)) throw new Error('Generated database name is not a safe identifier');
  return name;
}

function namedUrl(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.href;
}

export async function createContentDisclosureDriver(): Promise<ContentDisclosureDriver> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createNativeContentSystem({ databaseUrl });
  let driver: ContentDisclosureDriver;
  try {
    driver = bindDisclosure(system);
  } catch (error) {
    await system.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const stop = driver.close.bind(driver);
  driver.close = () => {
    suiteDrivers.delete(driver);
    return (closing ??= stop());
  };
  suiteDrivers.add(driver);
  return driver;
}

function bindDisclosure(system: NativeContentSystem): ContentDisclosureDriver {
  const pool = system.database.pool;
  const turnstile = createDisclosureTurnstile();
  const scopes = [...system.actions.keys()].filter((action) => action !== 'media:complete').sort();
  let trustedInstant: number | undefined;
  const clock = () => new Date(trustedInstant ?? Date.now());
  const kernel = createKernel({
    pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    clock,
    content: {
      cursorNow: () => clock().getTime(),
      anonymousVerifier: turnstile.verifier,
    },
    reports: { anonymousVerifier: turnstile.verifier },
    access: () => system.access,
    writeRate: createWriteRateLimiter({
      secret: randomUUID() + randomUUID(),
      overrides: HIGH_RATE_OVERRIDES,
    }),
    ratePeer: () => '127.0.0.1',
  });
  const boardEffect = createBoardEffect(pool);
  const reportEffect = createReportEffect(pool);
  const recordedRequests = new Map<string, RecordedRequest>();
  const commandsByThread = new Map<string, Map<string, CommandReference>>();
  const threadByPost = new Map<string, string>();
  const reportsByTarget = new Map<string, Set<string>>();
  const firstPosts = new Map<string, string>();
  const projectionPartitions = new Set<number>();
  const boards: Board[] = [];
  const moderation = new Map<string, 'allow' | 'deny' | 'revoke'>();
  let serial = 0;
  let editCount = 0;
  let definitionsReady = false;
  let paused = false;
  let governanceBearerValue: string | undefined;
  let governanceAccountValue: string | undefined;
  let workerStarting: Promise<void> | undefined;
  let workClient: WorkClient | undefined;
  let workerStop: (() => Promise<void>) | undefined;
  let workerAbort: (() => Promise<void>) | undefined;
  let workerOutput = '';
  let storageServer: { stop(closeActiveConnections?: boolean): void; url: URL } | undefined;
  let consentServer: { stop(closeActiveConnections?: boolean): void; url: URL } | undefined;
  let closing: Promise<void> | undefined;

  function bearerFor(persona: Persona): string | undefined {
    if (persona === 'anonymous') return undefined;
    if (persona === 'author') return system.actors.author.bearer;
    if (persona === 'unrelated') return system.actors.other.bearer;
    if (persona === 'moderator') return system.actors.moderator.bearer;
    return system.actors.suspended.bearer;
  }

  function accountId(persona: Exclude<Persona, 'anonymous'>): string {
    if (persona === 'author') return system.actors.author.actor.accountId;
    if (persona === 'unrelated') return system.actors.other.actor.accountId;
    if (persona === 'moderator') return system.actors.moderator.actor.accountId;
    return system.actors.suspended.actor.accountId;
  }

  async function call(input: HttpCall): Promise<Response> {
    const headers = new Headers();
    const bearer = input.bearer ?? bearerFor(input.persona);
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    let body: string | undefined;
    if (input.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(input.body);
    }
    if (input.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(input.key));
    for (const [name, value] of Object.entries(input.extraHeaders ?? {})) headers.set(name, value);
    const url = `${AUDIENCE}${input.path}`;
    if (input.recordKey !== undefined) {
      recordedRequests.set(input.recordKey, {
        method: input.method,
        url,
        headers: [...headers.entries()],
        ...(body === undefined ? {} : { body }),
      });
    }
    return kernel.handle(new Request(url, { method: input.method, headers, ...(body === undefined ? {} : { body }) }));
  }

  function threadFor(target: Target): string | undefined {
    if (target.kind === 'thread') return target.id;
    if (target.kind === 'post') return threadByPost.get(target.id);
    return undefined;
  }

  function targetKey(target: Target): string {
    return JSON.stringify([target.kind, target.id]);
  }

  function rememberCommand(
    threadId: string,
    key: string,
    persona: Persona,
    commandKind: string,
    partition: number,
  ): void {
    if (!recordedRequests.has(key)) throw new Error(`Content command ${key} has no captured wire request`);
    const reference: CommandReference = {
      partition,
      principalKind: persona === 'anonymous' ? 'anonymous' : 'account',
      principalId: persona === 'anonymous' ? '00000000-0000-0000-0000-000000000000' : accountId(persona),
      commandKind,
      key,
    };
    const identity = JSON.stringify([
      reference.partition,
      reference.principalKind,
      reference.principalId,
      reference.commandKind,
      reference.key,
    ]);
    const commands = commandsByThread.get(threadId) ?? new Map<string, CommandReference>();
    commands.set(identity, reference);
    commandsByThread.set(threadId, commands);
  }

  async function setup(
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await call({
      method,
      path,
      persona: 'author',
      bearer,
      key: randomUUID(),
      body,
      ...(extraHeaders === undefined ? {} : { extraHeaders }),
    });
    if (!response.ok) {
      throw new Error(
        `Disclosure setup ${method} ${path} failed (${response.status}): ${await response.clone().text()}`,
      );
    }
    return asRecord(await response.clone().json(), path);
  }

  async function governanceAccount(): Promise<string> {
    if (governanceAccountValue) return governanceAccountValue;
    const { rows } = await pool.query<{ account_id: string }>(
      'SELECT account_id::text AS account_id FROM access.governance_bootstrap WHERE route = 0',
    );
    const account = rows[0]?.account_id;
    if (!account) throw new Error('Governance bootstrap account is missing');
    governanceAccountValue = account;
    return account;
  }

  async function governanceBearer(): Promise<string> {
    if (governanceBearerValue) return governanceBearerValue;
    const credential = await system.auth.issue({
      accountId: await governanceAccount(),
      clientId: system.auth.ordinaryClient.id,
      scopes,
    });
    governanceBearerValue = credential.bearer;
    return governanceBearerValue;
  }

  async function ensureGovernanceAuthority(target: Target): Promise<void> {
    const actions = [
      ...new Set(['access:grant', READ_ACTION[target.kind], ...OWNER_ACTIONS[target.kind], ...MODERATION_ACTIONS]),
    ];
    await seedGovernanceAuthority(pool, requiredRoute(target.id), target.id, await governanceAccount(), actions);
  }

  async function submitGrant(path: string, body: unknown, status: number, bearer?: string): Promise<void> {
    const response = await call({
      method: 'POST',
      path,
      persona: 'moderator',
      bearer: bearer ?? (await governanceBearer()),
      key: randomUUID(),
      body,
    });
    if (response.status !== status) {
      throw new Error(`Access ${path} failed (${response.status}): ${await response.clone().text()}`);
    }
  }

  async function submitResourceGrant(path: string, target: Target, body: unknown, status: number): Promise<void> {
    await ensureGovernanceAuthority(target);
    await submitGrant(path, body, status, await governanceBearer());
  }

  async function createGrant(subjectId: string, target: Target, actions: string[]): Promise<void> {
    await submitResourceGrant(
      '/v1/grants',
      target,
      {
        resource: { route: requiredRoute(target.id), id: target.id },
        subject: { kind: 'account', id: subjectId },
        actions,
        valid: '(,)',
      },
      201,
    );
  }

  async function revokeDirect(subjectId: string, target: Target, actions: string[]): Promise<void> {
    const route = requiredRoute(target.id);
    const { rows } = await pool.query<{ action: string; valid: string }>(
      `SELECT action, valid::text AS valid
       FROM access.resource_grant
       WHERE route = $1 AND resource_id = $2 AND subject_kind = 'identity' AND subject_id = $3
         AND subject_role = '' AND action = ANY($4::text[])
       ORDER BY valid::text, action`,
      [route, target.id, subjectId, actions],
    );
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const actionsForRange = grouped.get(row.valid) ?? [];
      actionsForRange.push(row.action);
      grouped.set(row.valid, actionsForRange);
    }
    for (const [valid, rangeActions] of grouped) {
      await submitResourceGrant(
        '/v1/grants:revoke',
        target,
        {
          resource: { route, id: target.id },
          subject: { kind: 'account', id: subjectId },
          actions: rangeActions,
          valid,
        },
        200,
      );
    }
  }

  async function revokeRole(subjectId: string, target: Target, role: string): Promise<void> {
    const route = requiredRoute(target.id);
    const { rows } = await pool.query<{ valid: string }>(
      `SELECT valid::text AS valid
       FROM access.resource_role_grant
       WHERE route = $1 AND resource_id = $2 AND subject_kind = 'identity' AND subject_id = $3
         AND subject_role = '' AND grant_role = $4
       ORDER BY valid::text`,
      [route, target.id, subjectId, role],
    );
    for (const row of rows) {
      await submitResourceGrant(
        '/v1/roleGrants:revoke',
        target,
        {
          resource: { route, id: target.id },
          subject: { kind: 'account', id: subjectId },
          role,
          valid: row.valid,
        },
        200,
      );
    }
  }

  async function creatorAccount(target: Target): Promise<string> {
    const route = requiredRoute(target.id);
    if (target.kind === 'board') {
      const { rows } = await pool.query<{ subject_id: string }>(
        `SELECT subject_id::text AS subject_id
         FROM access.resource_role_grant
         WHERE route = $1 AND resource_id = $2 AND grant_role = 'content.board.owner' AND subject_kind = 'identity'
         ORDER BY subject_id
         LIMIT 1`,
        [route, target.id],
      );
      const subject = rows[0]?.subject_id;
      if (!subject) throw new Error('Board creator role is missing');
      return subject;
    }
    const table = target.kind === 'thread' ? 'content.thread' : 'content.post';
    const idColumn = target.kind === 'thread' ? 'thread_id' : 'post_id';
    const { rows } = await pool.query<{ author_account_id: string }>(
      `SELECT author_account_id::text AS author_account_id FROM ${table} WHERE route = $1 AND ${idColumn} = $2`,
      [route, target.id],
    );
    const author = rows[0]?.author_account_id;
    if (!author) throw new Error('Content creator is missing');
    return author;
  }

  function moderationKey(target: Target): string {
    return `${target.kind}:${target.id}`;
  }

  async function ensureModerator(target: Target): Promise<void> {
    const key = moderationKey(target);
    const state = moderation.get(key);
    if (state === 'allow' || state === 'deny' || state === 'revoke') return;
    await createGrant(accountId('moderator'), target, MODERATION_ACTIONS);
    await createGrant(accountId('suspended'), target, MODERATION_ACTIONS);
    moderation.set(key, 'allow');
  }

  async function applyProjection(envelopes: readonly Envelope[]): Promise<void> {
    for (const envelope of envelopes) {
      for (const event of envelope.events) {
        const effect: Effect | undefined = boardEffect.types.includes(event.type)
          ? boardEffect
          : reportEffect.types.includes(event.type)
            ? reportEffect
            : undefined;
        if (effect) await effect.run(event);
      }
    }
  }

  async function drainPartition(partition: number): Promise<number> {
    let applied = 0;
    for (let attempt = 0; attempt < 32; attempt++) {
      const result = await projectBatch(pool, {
        consumer: PROJECTION_CONSUMER,
        partition,
        apply: applyProjection,
      });
      if (result.status === 'busy') continue;
      if (result.status === 'stopped') {
        throw new Error(`Projection stopped (${result.reason}) on partition ${partition} at ${result.position}`);
      }
      applied += result.envelopes;
      if (result.envelopes === 0) return applied;
    }
    throw new Error(`Projection drain did not settle partition ${partition}`);
  }

  async function drainProjections(): Promise<void> {
    for (let pass = 0; pass < 12; pass++) {
      let applied = 0;
      for (const partition of [...projectionPartitions].sort((left, right) => left - right)) {
        applied += await drainPartition(partition);
      }
      if (applied === 0) return;
    }
    throw new Error('Projection drain did not reach a barrier');
  }

  async function board(): Promise<Board> {
    if (!definitionsReady) {
      await bootstrapRelease(pool, bundledRelease);
      definitionsReady = true;
    }
    // Standing roles open at the creation command instant. The suite publishes
    // at 2026-01-01, so the container and its parents are created then.
    const previous = trustedInstant;
    trustedInstant = Date.parse('2026-01-01T00:00:00.000Z');
    try {
      serial += 1;
      const label = `${BOARD_TITLE} ${serial}`;
      const owner = system.actors.other.bearer;
      const author = system.actors.author.bearer;
      const space = asRecord(await setup('POST', '/v1/spaces', owner, { title: label, summary: '' }), 'space').space;
      const spaceId = text(asRecord(space, 'space'), 'spaceId');
      const realmBody = asRecord(
        await setup('POST', '/v1/realms', owner, {
          spaceId,
          title: label,
          summary: '',
          visibility: 'public',
          contextId: GLOBAL_CONTEXT,
        }),
        'realm',
      ).realm;
      const realm = asRecord(realmBody, 'realm');
      const realmId = text(realm, 'realmId');
      await submitGrant(
        '/v1/grants',
        {
          resource: { route: requiredRoute(realmId), id: realmId },
          subject: { kind: 'account', id: accountId('author') },
          actions: ['board:create'],
          valid: '(,)',
        },
        201,
        owner,
      );
      const scheme = asRecord(
        await setup('POST', '/v1/subjects', author, { type: 'skos:ConceptScheme', labels: { en: `${label} scheme` } }),
        'scheme',
      ).subject;
      const schemeId = text(asRecord(scheme, 'scheme'), 'id');
      const concept = asRecord(
        await setup('POST', '/v1/subjects', author, {
          type: 'skos:Concept',
          labels: { en: `${label} concept` },
          statements: {
            'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
          },
        }),
        'concept',
      ).subject;
      const conceptId = text(asRecord(concept, 'concept'), 'id');
      await setup(
        'PUT',
        `/v1/realms/${realmId}/boardScheme`,
        owner,
        { schemeId },
        {
          'if-match': JSON.stringify(text(realm, 'headRevisionId')),
        },
      );
      const created = asRecord(
        await setup('POST', `/v1/realms/${realmId}/boards`, author, {
          conceptId,
          title: label,
          visibility: 'published',
        }),
        'board',
      ).board;
      const id = text(asRecord(created, 'board'), 'id');
      const result: Board = { kind: 'board', id, partition: partitionOf(requiredRoute(id)) };
      boards.push(result);
      return result;
    } finally {
      trustedInstant = previous;
    }
  }

  async function publish(input: {
    board: Board;
    thread?: Content;
    parent?: Content;
    author?: 'author' | 'unrelated';
    body: string;
    key?: string;
    createdAt?: string;
    missingSemanticSubject?: boolean;
  }): Promise<Content> {
    const persona = input.author ?? 'author';
    const key = input.key ?? randomUUID();
    const previous = trustedInstant;
    if (input.createdAt !== undefined) {
      const parsed = Date.parse(input.createdAt);
      if (!Number.isFinite(parsed)) throw new TypeError('Invalid trusted command time');
      trustedInstant = parsed;
    }
    // A routed subject id with no semantic row. Existence is not required.
    const subjectIds = input.missingSemanticSubject ? [newId(1)] : [];
    try {
      const path = input.thread ? `/v1/threads/${input.thread.id}/posts` : '/v1/threads';
      const body = input.thread
        ? {
            body: fromPlainText(input.body),
            licence: 'MIT',
            subjectIds,
            ...(input.parent ? { parentId: input.parent.id } : {}),
          }
        : {
            title: `${BOARD_TITLE} ${++serial}`,
            body: fromPlainText(input.body),
            licence: 'MIT',
            subjectIds,
            boardId: input.board.id,
            visibility: 'published',
          };
      const response = await call({
        method: 'POST',
        path,
        persona,
        key,
        body,
        recordKey: key,
      });
      if (response.status !== 201) {
        throw new Error(`Content publish failed (${response.status}): ${await response.clone().text()}`);
      }
      const payload = asRecord(await response.clone().json(), 'publish');
      if (!input.thread) {
        const thread = asRecord(payload.thread, 'thread');
        const firstPost = asRecord(thread.firstPost, 'first post');
        const id = text(thread, 'id');
        const postId = text(firstPost, 'id');
        firstPosts.set(id, postId);
        threadByPost.set(postId, id);
        projectionPartitions.add(partitionOf(requiredRoute(id)));
        rememberCommand(id, key, persona, 'content.thread.create', partitionOf(requiredRoute(id)));
        return { kind: 'thread', id, partition: partitionOf(requiredRoute(id)), revision: revisionFromView(firstPost) };
      }
      const post = asRecord(payload.post, 'post');
      const id = text(post, 'id');
      threadByPost.set(id, input.thread.id);
      projectionPartitions.add(partitionOf(requiredRoute(input.thread.id)));
      rememberCommand(input.thread.id, key, persona, 'content.post.create', partitionOf(requiredRoute(id)));
      return { kind: 'post', id, partition: partitionOf(requiredRoute(id)), revision: revisionFromView(post) };
    } finally {
      trustedInstant = previous;
    }
  }

  async function firstPostId(threadId: string): Promise<string | null> {
    const known = firstPosts.get(threadId);
    if (known) return known;
    const { rows } = await pool.query<{ first_post_id: string | null }>(
      'SELECT first_post_id::text AS first_post_id FROM content.thread WHERE route = $1 AND thread_id = $2',
      [requiredRoute(threadId), threadId],
    );
    const id = rows[0]?.first_post_id;
    if (!id) return null;
    firstPosts.set(threadId, id);
    return id;
  }

  async function edit(target: Content, body: string, key?: string): Promise<Revision> {
    const resolved = target.kind === 'post' ? target.id : await firstPostId(target.id);
    if (!resolved) throw new Error('Thread first post is missing');
    const postId = resolved;
    const headerKey = key ?? randomUUID();
    const response = await call({
      method: 'POST',
      path: `/v1/posts/${postId}/revisions`,
      persona: 'author',
      key: headerKey,
      recordKey: headerKey,
      extraHeaders: { 'if-match': JSON.stringify(target.revision.id) },
      body: { body: fromPlainText(body), licence: 'MIT' },
    });
    if (response.status !== 200) {
      throw new Error(`Content edit failed (${response.status}): ${await response.clone().text()}`);
    }
    const post = asRecord(asRecord(await response.clone().json(), 'edit').post, 'post');
    const threadId = target.kind === 'thread' ? target.id : threadByPost.get(target.id);
    if (!threadId) throw new Error(`Post ${target.id} has no captured containing thread`);
    projectionPartitions.add(partitionOf(requiredRoute(threadId)));
    rememberCommand(threadId, headerKey, 'author', 'content.post.revise', partitionOf(requiredRoute(postId)));
    editCount += 1;
    if (editCount >= 2) void ensureWorker().catch(() => {});
    return revisionFromView(post);
  }

  async function replayCommand(key: string): Promise<Reply<Item>> {
    const recorded = recordedRequests.get(key);
    if (!recorded) throw new Error(`No recorded content request for ${key}`);
    const response = await kernel.handle(
      new Request(recorded.url, {
        method: recorded.method,
        headers: new Headers(recorded.headers),
        ...(recorded.body === undefined ? {} : { body: recorded.body }),
      }),
    );
    if (!response.ok) return { response };
    const payload = asRecord(await response.clone().json(), 'replay');
    if (payload.thread) {
      const thread = asRecord(payload.thread, 'thread');
      return { response, value: { id: text(thread, 'id'), revision: revisionFromView(thread.firstPost) } };
    }
    const post = asRecord(payload.post, 'post');
    return { response, value: { id: text(post, 'threadId'), revision: revisionFromView(post) } };
  }

  async function needles(target: Target): Promise<string[]> {
    return [target.id];
  }

  async function inspectCommandCopies(target: Target): Promise<{ receipts: unknown[]; events: unknown[] }> {
    void ensureWorker().catch(() => {});
    const threadId = threadFor(target);
    if (!threadId) throw new Error(`Target ${target.id} has no captured thread command scope`);
    const references = [...(commandsByThread.get(threadId)?.values() ?? [])];
    references.sort((left, right) => left.key.localeCompare(right.key));
    const receipts: unknown[] = [];
    const events: unknown[] = [];
    for (const reference of references) {
      const receipt = await pool.query<{ position: string; response: unknown }>(
        `SELECT position::text, response
         FROM core.receipt
         WHERE partition_no = $1 AND principal_kind = $2 AND principal_id = $3
           AND command_kind = $4 AND idempotency_key = $5`,
        [reference.partition, reference.principalKind, reference.principalId, reference.commandKind, reference.key],
      );
      for (const row of receipt.rows) {
        receipts.push(row.response);
        const envelope = await pool.query<{ data: unknown }>(
          `SELECT data
           FROM core.outbox
           WHERE partition_no = $1 AND position = $2::bigint
           ORDER BY event_seq`,
          [reference.partition, row.position],
        );
        events.push(...envelope.rows.map((event) => event.data));
      }
    }
    return { receipts, events };
  }

  async function protect(target: Target): Promise<void> {
    const table =
      target.kind === 'board' ? 'content.board' : target.kind === 'thread' ? 'content.thread' : 'content.post';
    const column = target.kind === 'board' ? 'board_id' : target.kind === 'thread' ? 'thread_id' : 'post_id';
    const result = await pool.query(
      `UPDATE ${table}
       SET visibility = 'protected', security_revision = security_revision + 1
       WHERE route = $1 AND ${column} = $2`,
      [requiredRoute(target.id), target.id],
    );
    if (result.rowCount !== 1) throw new Error(`Protect changed ${result.rowCount ?? 0} ${target.kind} rows`);
  }

  async function changedOne(result: { rowCount: number | null }, label: string): Promise<void> {
    if (result.rowCount !== 1) throw new Error(`${label} changed ${result.rowCount ?? 0} rows`);
  }

  async function failContainer(target: Target, failure: 'missing' | 'unavailable'): Promise<void> {
    const route = requiredRoute(target.id);
    if (failure === 'missing') {
      await changedOne(
        await pool.query('DELETE FROM content.board WHERE route = $1 AND board_id = $2', [route, target.id]),
        'Missing container',
      );
      return;
    }
    await changedOne(
      await pool.query(
        `UPDATE core.partition SET write_state = 'moved', moved_to = 'disclosure-unavailable' WHERE partition_no = $1`,
        [partitionOf(route)],
      ),
      'Unavailable container',
    );
  }

  async function projection(mode: 'pause' | 'drain' | 'replay'): Promise<void> {
    if (mode === 'pause') {
      paused = true;
      return;
    }
    paused = false;
    if (mode === 'replay') {
      const partitions = [...projectionPartitions];
      if (partitions.length > 0) {
        await pool.query(
          'DELETE FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = ANY($2::integer[])',
          [PROJECTION_CONSUMER, partitions],
        );
      }
    }
    await drainProjections();
  }

  async function list(
    persona: Persona,
    board: Target,
    input: { limit: number; cursor?: string; sort?: 'newest' | 'oldest'; query?: string },
  ): Promise<Reply<Page>> {
    const params = new URLSearchParams();
    params.set('limit', String(input.limit));
    if (input.cursor !== undefined) params.set('cursor', input.cursor);
    if (input.sort !== undefined) params.set('sort', input.sort);
    if (input.query !== undefined) params.set('query', input.query);
    const response = await call({
      method: 'GET',
      path: `/v1/boards/${board.id}/threads?${params.toString()}`,
      persona,
    });
    if (!response.ok) return { response };
    const payload = asRecord(await response.clone().json(), 'board threads');
    if (!Array.isArray(payload.threads)) throw new Error('Board threads response is missing threads');
    if (payload.next !== null && typeof payload.next !== 'string')
      throw new Error('Board threads response is missing next');
    return {
      response,
      value: {
        items: payload.threads.map((entry) => {
          const thread = asRecord(entry, 'thread');
          return { id: text(thread, 'id'), revision: revisionFromView(thread.firstPost) };
        }),
        next: payload.next,
      },
    };
  }

  async function read(persona: Persona, target: Target, revisionId?: string): Promise<Reply<Item>> {
    if (target.kind === 'board')
      return { response: await call({ method: 'GET', path: `/v1/boards/${target.id}`, persona }) };
    if (target.kind === 'thread' && revisionId === undefined) {
      const response = await call({ method: 'GET', path: `/v1/threads/${target.id}`, persona });
      if (!response.ok) return { response };
      const thread = asRecord(asRecord(await response.clone().json(), 'thread').thread, 'thread');
      return { response, value: { id: text(thread, 'id'), revision: revisionFromView(thread.firstPost) } };
    }
    // A thread with no stored first post still uses the revision route. The
    // product returns the same not_found problem as a missing post.
    const postId = target.kind === 'post' ? target.id : ((await firstPostId(target.id)) ?? target.id);
    const path = revisionId === undefined ? `/v1/posts/${postId}` : `/v1/posts/${postId}/revisions/${revisionId}`;
    const response = await call({ method: 'GET', path, persona });
    if (!response.ok) return { response };
    const post = asRecord(asRecord(await response.clone().json(), 'post').post, 'post');
    return {
      response,
      value: { id: target.kind === 'thread' ? target.id : text(post, 'id'), revision: revisionFromView(post) },
    };
  }

  async function takedown(
    persona: Persona,
    target: Target,
    key: string,
    untrusted?: { actor?: 'moderator'; action?: 'moderation:takedown' },
  ): Promise<Reply<{ securityRevision: string }>> {
    if (persona === 'moderator') await ensureModerator(target);
    const collection = target.kind === 'board' ? 'boards' : target.kind === 'thread' ? 'threads' : 'posts';
    const response = await call({
      method: 'POST',
      path: `/v1/${collection}/${target.id}:takeDown`,
      persona,
      key,
      recordKey: key,
      body: {
        reason: 'Disclosure takedown',
        ...(untrusted?.actor === undefined ? {} : { actor: untrusted.actor }),
        ...(untrusted?.action === undefined ? {} : { action: untrusted.action }),
      },
    });
    if (response.status !== 200) return { response };
    const securityRevision = asRecord(await response.clone().json(), 'takedown').securityRevision;
    if (typeof securityRevision !== 'string') throw new Error('Takedown response is missing securityRevision');
    const threadId = threadFor(target);
    if (threadId) {
      const partition = partitionOf(requiredRoute(target.id));
      rememberCommand(threadId, key, persona, 'content.moderation:takedown', partition);
      projectionPartitions.add(partition);
    }
    return { response, value: { securityRevision } };
  }

  async function cloneDatabaseUrl(): Promise<string> {
    const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
    const name = rows[0]?.name;
    if (!name) throw new Error('Disclosure database name is missing');
    const source = process.env.DATABASE_URL;
    if (!source) throw new Error('DATABASE_URL must name the migrated test database');
    return namedUrl(source, name);
  }

  async function ensureWorker(): Promise<void> {
    workerStarting ??= (async () => {
      const databaseUrl = await cloneDatabaseUrl();
      workClient = await createWorkClient(databaseUrl);
      const { readCurrentConsent } = createCurrentConsentReader({ database: system.database.authPool });
      consentServer = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const consent = await readCurrentConsent(await request.json());
          return consent ? Response.json(consent) : new Response(null, { status: 404 });
        },
      });
      const objects = new Map<string, Uint8Array>();
      storageServer = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const key = url.pathname.slice('/media-test/'.length).split('/').map(decodeURIComponent).join('/');
          if (url.searchParams.has('list-type')) {
            const prefix = url.searchParams.get('prefix') ?? '';
            const keys = [...objects.keys()].filter((objectKey) => objectKey.startsWith(prefix));
            const contents = keys
              .map((objectKey) => `<Contents><Key>${encodeURIComponent(objectKey)}</Key></Contents>`)
              .join('');
            return new Response(
              `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
            );
          }
          if (request.method === 'PUT') {
            objects.set(key, new Uint8Array(await request.arrayBuffer()));
            return new Response(null, { status: 200 });
          }
          if (request.method === 'DELETE') {
            objects.delete(key);
            return new Response(null, { status: 204 });
          }
          const bytes = objects.get(key);
          return bytes ? new Response(Uint8Array.from(bytes).buffer) : new Response(null, { status: 404 });
        },
      });
      const worker = await prepareDisclosureWorker();
      const child = Bun.spawn([process.execPath, worker.path, '--disclosure-worker'], {
        env: workerTestEnv({
          ...process.env,
          DATABASE_URL: databaseUrl,
          CONTENT_TEST_STORAGE: storageServer.url.origin,
          CONTENT_TEST_CONSENT: consentServer.url.origin,
          CONTENT_TEST_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
        }),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      workerAbort = async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      };
      let output = '';
      const readOutput = (async () => {
        for await (const chunk of child.stdout) {
          const message = new TextDecoder().decode(chunk);
          output += message;
          workerOutput = (workerOutput + message).slice(-32_768);
        }
      })();
      const errors = (async () => {
        let output = '';
        for await (const chunk of child.stderr) {
          const message = new TextDecoder().decode(chunk);
          output += message;
          workerOutput = (workerOutput + message).slice(-32_768);
        }
        return output;
      })();
      const readyDeadline = Date.now() + 50_000;
      while (!output.includes('ready')) {
        if (child.exitCode !== null || Date.now() >= readyDeadline) {
          child.kill('SIGKILL');
          await child.exited;
          throw new Error(`Disclosure worker did not become ready: ${output}\n${await errors}`);
        }
        await Bun.sleep(20);
      }
      workerStop = async () => {
        child.stdin.write('stop\n');
        child.stdin.end();
        const deadline = Date.now() + 10_000;
        while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
        await readOutput;
      };
    })();
    await workerStarting;
  }

  async function settleErasure(threadId: string, authorId: string): Promise<void> {
    const route = requiredRoute(threadId);
    const deadline = Date.now() + 15_000;
    let remaining = 1;
    let events = 0;
    let stable = 0;
    while (Date.now() < deadline) {
      const bodies = await pool.query<{ remaining: number }>(
        `SELECT count(*)::int AS remaining
         FROM content.revision
         WHERE route = $1 AND thread_id = $2 AND body IS NOT NULL
           AND post_id IN (
             SELECT post_id FROM content.post
             WHERE route = $1 AND thread_id = $2 AND author_account_id = $3
           )`,
        [route, threadId, authorId],
      );
      const effectRows = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM core.outbox
         WHERE type = 'com.rezics.content.moderation.erasure.v1' AND position($1 IN data::text) > 0`,
        [threadId],
      );
      remaining = bodies.rows[0]?.remaining ?? 1;
      const nextEvents = effectRows.rows[0]?.count ?? 0;
      if (remaining === 0 && nextEvents > 0 && nextEvents === events) {
        stable += 1;
        if (stable >= 3) return;
      } else {
        stable = 0;
      }
      events = nextEvents;
      await Bun.sleep(50);
    }
    const state = await pool.query(
      `SELECT revision_id::text, availability, body IS NULL AS nulled
       FROM content.revision WHERE route = $1 AND thread_id = $2 ORDER BY revision_id`,
      [route, threadId],
    );
    throw new Error(`Author erasure did not settle: ${JSON.stringify(state.rows)}`);
  }

  async function erase(persona: Persona, thread: Target, _author: 'author', key: string): Promise<Reply<unknown>> {
    const response = await call({
      method: 'POST',
      path: `/v1/threads/${thread.id}:erase`,
      persona,
      key,
      recordKey: key,
      body: { authorId: accountId('author') },
    });
    if (response.status !== 202) return { response };
    const workerReady = persona === 'author' ? ensureWorker() : undefined;
    const partition = partitionOf(requiredRoute(thread.id));
    rememberCommand(thread.id, key, persona, 'content.author-erasure', partition);
    projectionPartitions.add(partition);
    const value = await response.clone().json();
    await workerReady;
    try {
      await settleErasure(thread.id, accountId('author'));
    } catch (error) {
      const operationId = text(asRecord(value, 'author erasure'), 'name').slice('operations/'.length);
      const receipt = await pool.query(
        `SELECT transaction_id::text, position::text, response
         FROM core.receipt
         WHERE partition_no = $1 AND principal_kind = $4 AND principal_id = $2
           AND command_kind = 'content.author-erasure' AND idempotency_key = $3`,
        [
          partition,
          persona === 'anonymous' ? '00000000-0000-0000-0000-000000000000' : accountId(persona),
          key,
          persona === 'anonymous' ? 'anonymous' : 'account',
        ],
      );
      const operation = await pool.query(
        `SELECT operation.operation_id::text, operation.native_workflow_id,
                workflow.status, workflow.error
         FROM content.operation AS operation
         LEFT JOIN dbos.workflow_status AS workflow ON workflow.workflow_uuid = operation.native_workflow_id
         WHERE operation.route = $1 AND operation.operation_id = $2`,
        [requiredRoute(operationId), operationId],
      );
      const recorded = recordedRequests.get(key)!;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
          request: { method: recorded.method, url: recorded.url, body: recorded.body },
          response: { status: response.status, body: value },
          receipts: receipt.rows,
          operations: operation.rows,
          workerOutput,
        })}`,
      );
    }
    return { response, value };
  }

  async function report(
    persona: Persona,
    input: {
      target: Target;
      revisionId?: string;
      evidence?: string;
      key?: string;
      botToken?: string;
      verified?: boolean;
    },
  ): Promise<Reply<{ reportId: string }>> {
    const response = await call({
      method: 'POST',
      path: '/v1/reports',
      persona,
      ...(input.key === undefined ? {} : { key: input.key, recordKey: input.key }),
      body: {
        target: { kind: input.target.kind, id: input.target.id },
        ...(input.revisionId === undefined ? {} : { revisionId: input.revisionId }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        ...(input.botToken === undefined ? {} : { botToken: input.botToken }),
        ...(input.verified === undefined ? {} : { verified: input.verified }),
        reason: 'spam',
      },
    });
    if (response.status !== 201) return { response };
    const reportId = asRecord(await response.clone().json(), 'report').reportId;
    if (typeof reportId !== 'string') throw new Error('Report response is missing reportId');
    const reportIds = reportsByTarget.get(targetKey(input.target)) ?? new Set<string>();
    reportIds.add(reportId);
    reportsByTarget.set(targetKey(input.target), reportIds);
    const threadId = threadFor(input.target);
    if (threadId && input.key !== undefined) {
      const partition = partitionOf(requiredRoute(reportId));
      rememberCommand(threadId, input.key, persona, 'content.report.create', partition);
      projectionPartitions.add(partition);
    }
    if (!paused) await drainProjections();
    return { response, value: { reportId } };
  }

  function reportFromRow(row: {
    report_id: string;
    target_kind: string;
    target_id: string;
    revision_id: string | null;
    evidence: string | null;
    recorded_transaction_id: string;
  }): Report {
    if (row.target_kind !== 'board' && row.target_kind !== 'thread' && row.target_kind !== 'post') {
      throw new Error(`Unexpected report target ${row.target_kind}`);
    }
    return {
      id: row.report_id,
      anchorId: row.report_id,
      partition: partitionOf(requiredRoute(row.report_id)),
      target: { kind: row.target_kind, id: row.target_id },
      revisionId: row.revision_id,
      evidence: row.evidence,
      transactionId: row.recorded_transaction_id,
    };
  }

  async function inspectReports(persona: Persona, target: Target): Promise<Reply<Report[]>> {
    if (persona === 'moderator') await ensureModerator(target);
    const collection = target.kind === 'board' ? 'boards' : target.kind === 'thread' ? 'threads' : 'posts';
    const reports: Report[] = [];
    let cursor: string | undefined;
    let response: Response | undefined;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ limit: '100' });
      if (cursor) params.set('cursor', cursor);
      response = await call({
        method: 'GET',
        path: `/v1/${collection}/${target.id}/reports?${params.toString()}`,
        persona,
      });
      if (!response.ok) return { response };
      const payload = asRecord(await response.clone().json(), 'reports');
      if (!Array.isArray(payload.reports)) throw new Error('Report page is missing reports');
      for (const entry of payload.reports) {
        const view = asRecord(entry, 'report');
        const id = text(view, 'id');
        const targetView = asRecord(view.target, 'report target');
        const kind = text(targetView, 'kind');
        if (kind !== 'board' && kind !== 'thread' && kind !== 'post')
          throw new Error(`Unexpected report target ${kind}`);
        const revisionId = view.revisionId;
        const evidence = view.evidence;
        if (revisionId !== null && typeof revisionId !== 'string') throw new Error('Report revision is missing');
        if (evidence !== null && typeof evidence !== 'string') throw new Error('Report evidence is missing');
        if (typeof view.transactionId !== 'string') throw new Error('Report transaction is missing');
        reports.push({
          id,
          anchorId: id,
          partition: partitionOf(requiredRoute(id)),
          target: { kind, id: text(targetView, 'id') },
          revisionId,
          evidence,
          transactionId: view.transactionId,
        });
      }
      if (payload.next === null) return { response, value: reports };
      if (typeof payload.next !== 'string') throw new Error('Report page is missing next');
      cursor = payload.next;
    }
    if (!response) throw new Error('Report inspection produced no response');
    return { response, value: reports };
  }

  async function revisionsFor(route: number, postId: string): Promise<Revision[]> {
    const { rows } = await pool.query<{
      revision_id: string;
      body: unknown;
      body_sha256: unknown;
      availability: string;
    }>(
      `SELECT revision_id::text, body, body_sha256, availability
       FROM content.revision
       WHERE route = $1 AND post_id = $2
       ORDER BY revision_id`,
      [route, postId],
    );
    return rows.map((row) => {
      if (row.availability !== 'available' && row.availability !== 'erased') {
        throw new Error(`Unexpected revision availability ${row.availability}`);
      }
      return {
        id: row.revision_id,
        hash: hexFromBytea(row.body_sha256),
        body: textFromBytea(row.body),
        availability: row.availability,
      };
    });
  }

  async function observe(target: Target): Promise<Observation> {
    const route = requiredRoute(target.id);
    const table =
      target.kind === 'board' ? 'content.board' : target.kind === 'thread' ? 'content.thread' : 'content.post';
    const column = target.kind === 'board' ? 'board_id' : target.kind === 'thread' ? 'thread_id' : 'post_id';
    const head = await pool.query<{
      visibility: string;
      security_revision: string;
      transaction_id: string;
      first_post_id: string | null;
    }>(
      `SELECT target.visibility, target.security_revision::text,
              COALESCE(
                (SELECT receipt.transaction_id::text
                 FROM core.receipt AS receipt
                 WHERE receipt.partition_no = $3 AND receipt.xmin = target.xmin
                 LIMIT 1),
                target.recorded_transaction_id::text
              ) AS transaction_id,
              ${target.kind === 'thread' ? 'target.first_post_id::text' : 'NULL::text'} AS first_post_id
       FROM ${table} AS target WHERE target.route = $1 AND target.${column} = $2`,
      [route, target.id, partitionOf(route)],
    );
    const row = head.rows[0];
    if (!row) throw new Error(`Observed ${target.kind} is missing`);
    const revisions =
      target.kind === 'board'
        ? []
        : await revisionsFor(route, target.kind === 'thread' ? (row.first_post_id ?? '') : target.id);
    if (target.kind === 'thread' && !row.first_post_id) throw new Error('Observed thread is missing its first post');
    const ids = await needles(target);
    const reportIds = [...(reportsByTarget.get(targetKey(target)) ?? [])].sort();
    const reports: Report[] = [];
    for (const reportId of reportIds) {
      const reportRoute = requiredRoute(reportId);
      const result = await pool.query<{
        report_id: string;
        target_kind: string;
        target_id: string;
        revision_id: string | null;
        evidence: string | null;
        recorded_transaction_id: string;
      }>(
        `SELECT report_id::text, target_kind, target_id::text, revision_id::text, evidence,
                recorded_transaction_id::text
         FROM content.report WHERE route = $1 AND report_id = $2`,
        [reportRoute, reportId],
      );
      reports.push(...result.rows.map(reportFromRow));
    }
    const effectPartitions = [
      ...new Set([partitionOf(route), ...reportIds.map((id) => partitionOf(requiredRoute(id)))]),
    ];
    const effects = await pool.query<{
      id: string;
      type: string;
      partition_no: number;
      transaction_id: string | null;
    }>(
      `SELECT o.id::text, o.type, o.partition_no,
              (SELECT r.transaction_id::text FROM core.receipt r
               WHERE r.partition_no = o.partition_no AND r.position = o.position
               LIMIT 1) AS transaction_id
       FROM core.outbox o
       WHERE o.partition_no = ANY($3::integer[]) AND o.type = ANY($2::text[])
         AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS needle(value) WHERE position(value IN o.data::text) > 0)
       ORDER BY o.partition_no, o.position, o.event_seq`,
      [ids, EFFECT_TYPES, effectPartitions],
    );
    return {
      visibility: storedVisibility(row.visibility),
      securityRevision: row.security_revision,
      transactionId: row.transaction_id,
      revisions,
      effects: effects.rows.map((effect) => {
        const kind = effectKind(effect.type);
        if (!kind) throw new Error(`Unexpected effect type ${effect.type}`);
        if (!effect.transaction_id) throw new Error(`Effect ${effect.id} has no receipt transaction`);
        return { id: effect.id, kind, partition: effect.partition_no, transactionId: effect.transaction_id };
      }),
      reports,
    };
  }

  async function close(): Promise<void> {
    closing ??= (async () => {
      const errors: unknown[] = [];
      const release = async (operation: () => Promise<unknown> | void) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      if (workerStop) await release(workerStop);
      else if (workerAbort) await release(workerAbort);
      await workerStarting?.catch(() => {});
      await release(() => {
        storageServer?.stop(true);
      });
      await release(() => {
        consentServer?.stop(true);
      });
      if (workClient) await release(() => workClient!.close());
      await release(() => system.close());
      if (errors.length) throw new AggregateError(errors, 'Disclosure driver cleanup failed');
    })();
    return closing;
  }

  return {
    close,
    board,
    publish,
    edit,
    replayCommand,
    inspectCommandCopies,
    protect,
    async revokeCreatorReadAuthority(target) {
      const creator = await creatorAccount(target);
      // The owner role is the creator's read authority. Standing roles do not
      // include the read action. No denial: a later direct grant still applies.
      await revokeRole(creator, target, OWNER_ROLE[target.kind]);
    },
    async grantRead(persona, target) {
      if (persona === 'anonymous') throw new Error('Anonymous read grants have no account');
      await createGrant(accountId(persona), target, [READ_ACTION[target.kind]]);
      if (target.kind === 'thread') {
        const postId = await firstPostId(target.id);
        if (!postId) throw new Error('Thread first post is missing');
        await createGrant(accountId(persona), { kind: 'post', id: postId }, [READ_ACTION.post]);
      }
    },
    async setModeration(_persona, target, mode) {
      const key = moderationKey(target);
      if (mode === 'deny') {
        // No public denial command. The grant stays; the formula reads this row.
        await seedResourceDenial(pool, requiredRoute(target.id), target.id, accountId('moderator'), MODERATION_ACTIONS);
        moderation.set(key, 'deny');
        return;
      }
      if (mode === 'revoke') {
        await revokeDirect(accountId('moderator'), target, MODERATION_ACTIONS);
        await revokeDirect(accountId('suspended'), target, MODERATION_ACTIONS);
        moderation.set(key, 'revoke');
        return;
      }
      await createGrant(accountId('moderator'), target, MODERATION_ACTIONS);
      await createGrant(accountId('suspended'), target, MODERATION_ACTIONS);
      moderation.set(key, 'allow');
    },
    failContainer,
    projection,
    async expireCursors() {
      trustedInstant = Date.now() + 16 * 60 * 1000;
    },
    list,
    read,
    missing(kind) {
      const id = newId(1);
      return { kind, id };
    },
    takedown,
    erase,
    report,
    verifiedBotToken: async () => turnstile.mint(),
    inspectReports,
    observe,
  };
}

export async function openMeasuredDisclosure(database: GrowthDatabase): Promise<{
  grow(db: { admin: Pool }, scale: number, previous: number): Promise<void>;
  operation(db: { pool: Pool }, scale: number, repetition: number): Promise<number>;
  close(): Promise<void>;
}> {
  await releaseSuiteDrivers();
  const authName = databaseName('contentauth');
  const maintainer = new Pool({ connectionString: namedUrl(database.url, 'postgres') });
  const authPool = new Pool({ connectionString: namedUrl(database.url, authName) });
  const endAuthPool = authPool.end.bind(authPool);
  let authEnding: Promise<void> | undefined;
  authPool.end = () => (authEnding ??= endAuthPool());
  let authCreated = false;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      const release = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      if (host) await release(() => host!.stop());
      await release(() => authPool.end());
      if (authCreated) await release(() => maintainer.query(`DROP DATABASE ${authName}`));
      await release(() => maintainer.end());
      if (errors.length) throw new AggregateError(errors, 'Measured disclosure cleanup failed');
    })());

  try {
    await maintainer.query(`CREATE DATABASE ${authName} TEMPLATE template0`);
    authCreated = true;
    migrateAuth(namedUrl(database.url, authName));
    const issuer = `https://${authName}.auth.test`;
    const routeKey = crypto.getRandomValues(new Uint8Array(32));
    const tokenKeys = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
    const referenceKeys = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
    const clock = () => new Date();
    let nativeAuth: AuthService;
    const kernel = createKernel({
      pool: database.pool,
      routeKey,
      tokens: tokenKeys,
      clock,
      content: { cursorNow: () => Date.now() },
      access: () => access,
      writeRate: createWriteRateLimiter({ secret: randomUUID() + randomUUID(), overrides: HIGH_RATE_OVERRIDES }),
      ratePeer: () => '127.0.0.1',
    });
    const actions = actionCatalogue(kernel);
    const access = createAccess({
      actions,
      auth: {
        issuer,
        audience: AUDIENCE,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: (input, init) => nativeAuth.handler(new Request(input, init)),
      },
    });
    const proofs = createNativeWorkflowProofPorts({ database: authPool });
    const bindings = createNativeAccountBindings({
      pool: database.pool,
      access,
      actions: new Map([...LIFECYCLE_ACTIONS, ['account:manage', { anonymous: false }] as const, ...actions]),
      routeKey,
      clock,
      referenceKeys,
      auth: () => nativeAuth,
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
        barriers: createBarrierProofVerifier({ database: authPool }),
      },
    });
    const pair = await generateKeyPair('ES256', { extractable: true });
    const privateKey = { ...(await exportJWK(pair.privateKey)), kid: authName };
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience: AUDIENCE,
      secret: randomUUID() + randomUUID(),
      signing: { activeKid: privateKey.kid!, privateKeys: [privateKey] },
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      stagingKey: crypto.getRandomValues(new Uint8Array(32)),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: authName,
    });
    nativeAuth = host.service;
    const ordinaryClient = { id: `${authName}_ordinary` };
    const scopes = [...actions.keys()].filter((action) => action !== 'media:complete').sort();
    await nativeAuth.internal.registerClient({ clientId: ordinaryClient.id, firstParty: true, scopes });
    await host.start();
    const password = randomUUID() + randomUUID();
    const requestAuth = async (path: string, body: unknown, cookie = '') => {
      const response = await nativeAuth.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
      if (!response.ok) throw new Error(`Measured Auth ${path} denied (${response.status}): ${await response.text()}`);
      return response;
    };
    const issue = async (accountId: string) => {
      const signed = await requestAuth('/signin', {
        account_id: accountId,
        password,
        client_id: ordinaryClient.id,
        scope: scopes,
      });
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const token = await requestAuth('/token', {}, cookie);
      const { access_token: bearer } = (await token.json()) as { access_token: string };
      const actor = await access.authenticate(bearer, { pool: database.pool, deadline: Date.now() + 10_000 });
      if (actor.kind !== 'account') throw new Error('Measured Auth did not authenticate an account');
      return actor.accountId;
    };
    const person = async (name: string) => {
      const registered = await host!.workflows.register({
        key: name,
        handle: name,
        email: `${name}@content.test`,
        password,
      });
      return issue(registered.accountId);
    };
    await bootstrapGovernance(database.pool, await person('governance'));
    const authorId = await person('author');
    const boardId = newId(MEASURED_ROUTE);
    const distractorBoardId = newId(MEASURED_ROUTE);
    const threadId = newId(MEASURED_ROUTE);
    const postId = newId(MEASURED_ROUTE);
    const revisionId = newId(MEASURED_ROUTE);
    const subjectId = newId(MEASURED_ROUTE);
    const transactionId = randomUUID();
    const body = Buffer.from(documentBytes('Measured disclosure'));
    const client = await database.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.board
           (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
         VALUES ($1, $2, $3, 'Measured disclosure', 'published', 1, $4),
                ($1, $5, $3, 'Measured distractors', 'published', 1, $4)`,
        [MEASURED_ROUTE, boardId, subjectId, transactionId, distractorBoardId],
      );
      await client.query(
        `INSERT INTO content.thread
           (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
            recorded_transaction_id, first_post_id, availability)
         VALUES ($1, $2, $3, $4, 'Measured disclosure', 'published', 1, $5, $6, 'available')`,
        [MEASURED_ROUTE, threadId, authorId, boardId, transactionId, postId],
      );
      await client.query(
        `INSERT INTO content.post
           (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id, visibility,
            security_revision, recorded_transaction_id, availability)
         VALUES ($1, $2, $3, NULL, $4, $5, 'published', 1, $6, 'available')`,
        [MEASURED_ROUTE, threadId, postId, authorId, revisionId, transactionId],
      );
      await client.query(
        `INSERT INTO content.revision
           (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids,
            board_id, availability, recorded_transaction_id, media_ids)
         VALUES ($1, $2, $3, $4, $5, $6, 'Measured disclosure', 'MIT', '{}'::uuid[], $7, 'available', $8, '{}'::uuid[])`,
        [MEASURED_ROUTE, threadId, postId, revisionId, body, hexDigest(body), boardId, transactionId],
      );
      await client.query(
        `INSERT INTO content.board_thread
           (route, board_id, thread_id, created_at, source_epoch, source_position, source_revision_id)
         VALUES ($1, $2, $3, transaction_timestamp(), 1, 1, $4)`,
        [MEASURED_ROUTE, boardId, threadId, revisionId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await database.admin.query(
      'ANALYZE content.board, content.board_thread, content.thread, content.post, content.revision',
    );

    return {
      async grow(db, scale, previous) {
        await seedDisclosureDistractors(db.admin, MEASURED_ROUTE, authorId, distractorBoardId, scale - previous);
      },
      async operation(db, _scale, _repetition) {
        if (db.pool !== database.pool) throw new Error('Measured disclosure list must use the observed growth pool');
        const response = await kernel.handle(
          new Request(`${AUDIENCE}/v1/boards/${boardId}/threads?limit=10`, { method: 'GET' }),
        );
        const payload = await response.text();
        if (response.status !== 200)
          throw new Error(`Measured disclosure list failed (${response.status}): ${payload}`);
        return response.status;
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Measured disclosure construction and cleanup failed');
    }
    throw error;
  }
}
