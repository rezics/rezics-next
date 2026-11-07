/**
 * Content Goal seeded walk. Runs inside `dev-stack.ts walk` for a worker whose brief lists native and browser
 * acceptance. Persona, journal cleanup, identity-epoch remaining-zero and the cross-media seed run before Auth
 * pages and Web start. Seed token
 * minting keeps issuer `AUTH_ORIGIN` and reaches native Auth through `withIssuerSeedProxy` until pages bind that
 * port. Frontend readiness uses Performance's `waitUntilWalkReady` hydration recovery through `startSeededFrontends`.
 * Evidence stays under `.temp/content-walk/`. A wrong result becomes a repair brief naming trigger, defect and correct
 * result.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import {
  waitUntilIdentityBootstrapRemainingZero,
  waitUntilWalkReady,
  walkIssuerForward,
} from '../../../scripts/walk-stack.ts';
import {
  identityEpochBootstrapRemaining,
  kernelEnvironment,
  retireDevelopmentSeedState,
  retireStaleSeedJournals,
  startSeededFrontends,
} from '../../../services/auth/scripts/dev-stack.ts';

const webRoot = resolve(import.meta.dir, '..');
const root = resolve(webRoot, '../..');
const evidenceDir = join(root, '.temp/content-walk');
const seedResultPath = join(root, '.temp/cross-media-seed/result.json');
const signupTurnstile = 'rezics-local-signup';
const standardQuestion = '00000000-0000-7000-8000-000000000001';
const globalContext = '00000000-0000-8000-8000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const launchLocales = ['en', 'zh-Hant', 'ja'] as const;

export const FIRST_SCOPE_ROWS = [
  'threads-and-boards',
  'exact-revisions',
  'board-paging',
  'container-disclosure',
  'late-revocation',
  'edit-history-return',
  'watches-and-reactions',
  'takedown-erasure',
  'author-erasure',
  'media',
  'realms-and-spaces',
  'ratings-and-reviews',
  'work-to-review',
  'moderation-reports-appeals',
  'notices',
  'home-discovery',
  'independent-queues',
  'persona-matrix',
] as const;

export type FirstScopeRow = (typeof FIRST_SCOPE_ROWS)[number];
export type Json = Record<string, unknown>;
export type Stack = { web: string; issuer: string; kernel: string };
export type Persona = {
  label: string;
  email: string;
  password: string;
  bearer: string;
  accountId: string | null;
};
export type RowResult = {
  row: FirstScopeRow;
  status: 'passing' | 'failing';
  durationMs: number;
  observed: Json;
  defect?: string;
};
export type WalkSummary = {
  passing: number;
  total: number;
  slowestFailure: { row: string; durationMs: number; defect: string } | null;
};

type Showcase = {
  workId: string;
  boardId: string;
  threadId: string;
  postId: string | null;
  realmId: string | null;
  collections: { id: string }[];
};
type CreatedCommunity = {
  spaceId: string;
  realmId: string;
  boardId: string;
  threadId: string;
  postId: string;
};
type WalkContext = {
  stack: Stack;
  developer: Persona;
  author: Persona;
  member: Persona;
  outsider: Persona;
  banned: Persona;
  suspended: Persona;
  reviewer: Persona;
  showcase: Showcase;
  community: CreatedCommunity;
  protectedBoardId: string;
};
type InboxItem = Json & { id?: unknown; kind?: unknown; unread?: unknown; decisionId?: unknown; reportId?: unknown };

export function walkWorkingDirectory(): string {
  return webRoot;
}

export function firstScopeRows(): readonly FirstScopeRow[] {
  return FIRST_SCOPE_ROWS;
}

export function jwtAccountId(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof json.sub === 'string' && uuid.test(json.sub) ? json.sub : null;
  } catch {
    return null;
  }
}

/** Native Auth prints a bootstrap credential; returned diagnostics must retain phases without that credential. */
export function publicStackLog(log: string): string {
  return log.replace(/^Password:.*$/gm, 'Password: [redacted]');
}

export function publicFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 24).map(publicFields);
  if (!value || typeof value !== 'object') return value;
  const output: Json = {};
  for (const [key, field] of Object.entries(value as Json)) {
    if (/token|password|cookie|authorization|secret|credential|bearer/i.test(key)) continue;
    output[key] = publicFields(field);
  }
  return output;
}

export function summarizeWalk(rows: readonly RowResult[]): WalkSummary {
  const failing = rows.filter((row) => row.status === 'failing');
  const slowest = failing.reduce<RowResult | null>(
    (current, row) => (!current || row.durationMs > current.durationMs ? row : current),
    null,
  );
  return {
    passing: rows.filter((row) => row.status === 'passing').length,
    total: rows.length,
    slowestFailure: slowest ? { row: slowest.row, durationMs: slowest.durationMs, defect: slowest.defect ?? '' } : null,
  };
}

function loopback(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required inside dev-stack walk`);
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error(`${name} must be loopback HTTP`);
  return url.origin;
}

function stackOrigins(): Stack {
  return {
    web: loopback('REZICS_LOCAL_STACK_WEB_ORIGIN'),
    issuer: loopback('REZICS_LOCAL_STACK_ISSUER_ORIGIN'),
    kernel: loopback('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
  };
}

function asId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`${label} is not a native identity`);
  return value;
}

function routeOf(id: string): number {
  const hex = id.replaceAll('-', '');
  return (Number.parseInt(hex.slice(20, 22), 16) << 8) | Number.parseInt(hex.slice(22, 24), 16);
}

async function parseEnvFile(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (match?.groups) values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  return await child.exited;
}

/** Walk stacks defer Auth pages until after seed, so the issuer port is free. Own-key assertions still
 * target `${issuer}/token`; this forwards that origin to native Auth for the seed subprocess only, including
 * POST bodies, matching the VNDB seeded journey. */
export async function withIssuerSeedProxy<T>(run: () => Promise<T>): Promise<T> {
  const issuer = loopback('REZICS_LOCAL_STACK_ISSUER_ORIGIN');
  const native = loopback('REZICS_LOCAL_STACK_NATIVE_ORIGIN');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(new URL(issuer).port || '80'),
    fetch(request) {
      return fetch(walkIssuerForward(request, native));
    },
  });
  try {
    return await run();
  } finally {
    await server.stop(true);
  }
}

async function kernel(
  stack: Stack,
  method: string,
  path: string,
  options: {
    bearer?: string;
    body?: unknown;
    query?: Record<string, string>;
    ifMatch?: string;
    idempotencyKey?: string;
  } = {},
): Promise<{ status: number; value: Json }> {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { 'idempotency-key': JSON.stringify(options.idempotencyKey ?? crypto.randomUUID()) }),
      ...(options.ifMatch ? { 'if-match': JSON.stringify(options.ifMatch) } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      'accept-language': 'en',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let value: Json = {};
  if (text) {
    try {
      value = JSON.parse(text) as Json;
    } catch {
      value = { raw: text.slice(0, 240) };
    }
  }
  return { status: response.status, value };
}

export function requireStatus(
  result: { status: number; value: Json },
  label: string,
  expected: number | readonly number[] = 200,
) {
  const allowed = typeof expected === 'number' ? [expected] : expected;
  if (!allowed.includes(result.status))
    throw new Error(
      `${label} returned HTTP ${result.status}: ${JSON.stringify(publicFields(result.value)).slice(0, 600)}`,
    );
  return result.value;
}

async function issuerJson(stack: Stack, path: string, body: Json, expected: number | readonly number[]): Promise<Json> {
  const response = await fetch(`${stack.issuer}${path}`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  const value = text ? (JSON.parse(text) as Json) : {};
  const allowed = typeof expected === 'number' ? [expected] : expected;
  if (!allowed.includes(response.status))
    throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 400)}`);
  return value;
}

async function websiteBearer(stack: Stack, email: string, password: string, bindings: Record<string, string>) {
  const signin = await fetch(`${stack.issuer}/signin`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      client_id: bindings.WEBSITE_CLIENT_ID ?? 'rezics-website',
      scope: bindings.WEBSITE_SCOPES,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!signin.ok) throw new Error(`${email} sign-in failed: HTTP ${signin.status}`);
  const token = await fetch(`${stack.issuer}/token`, {
    method: 'POST',
    headers: {
      origin: stack.issuer,
      'content-type': 'application/json',
      cookie: signin.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    },
    body: '{}',
    signal: AbortSignal.timeout(60_000),
  });
  if (!token.ok) throw new Error(`${email} token failed: HTTP ${token.status}`);
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`${email} omitted access_token`);
  return body.access_token;
}

async function registerPersona(stack: Stack, label: string, bindings: Record<string, string>): Promise<Persona> {
  const handle = `${label}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const email = `${handle}@example.test`;
  const password = `content walk password ${label} 2026`;
  const created = await issuerJson(
    stack,
    '/signup',
    { key: crypto.randomUUID(), handle, email, password, turnstile_token: signupTurnstile },
    [200, 201],
  );
  const bearer = await websiteBearer(stack, email, password, bindings);
  const accountId =
    (typeof created.accountId === 'string' && uuid.test(created.accountId) ? created.accountId : null) ??
    jwtAccountId(bearer);
  return { label, email, password, bearer, accountId };
}

async function waitForMembership(stack: Stack, realmId: string, bearer: string): Promise<string> {
  const deadline = Date.now() + 90_000;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const current = await kernel(stack, 'GET', `/v1/realms/${realmId}/members/me`, { bearer });
    const state = typeof current.value.state === 'string' ? current.value.state : `http-${current.status}`;
    last = state;
    if (state === 'member') return state;
    await Bun.sleep(1_000);
  }
  throw new Error(`membership did not become member (last ${last})`);
}

function documentText(value: unknown): string {
  const pending: unknown[] = [value];
  const text: string[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const record = node as Json;
    if (typeof record.text === 'string') text.push(record.text);
    if (record.doc && typeof record.doc === 'object') pending.push(record.doc);
    if (Array.isArray(record.content)) pending.push(...[...record.content].reverse());
  }
  return text.join('').replace(/\s+/g, ' ').trim();
}

async function readShowcase(): Promise<Showcase> {
  const seed = JSON.parse(await readFile(seedResultPath, 'utf8')) as Json;
  const community = (seed.developmentShowcase as Json | undefined)?.community as Json | undefined;
  if (community?.state !== 'published') throw new Error('seed did not publish the Global discussion community');
  const source = community.source as Json | undefined;
  const board = community.board as Json | undefined;
  const thread = community.thread as Json | undefined;
  const collections = Array.isArray((seed.developmentShowcase as Json | undefined)?.collections)
    ? (((seed.developmentShowcase as Json).collections as Json[]) ?? [])
        .filter((row) => row.status === 'current' && row.public && typeof (row.public as Json).id === 'string')
        .map((row) => ({ id: asId((row.public as Json).id, 'seeded Collection') }))
    : [];
  return {
    workId: asId(source?.subjectId, 'seeded work'),
    boardId: asId(board?.id, 'seeded board'),
    threadId: asId(thread?.threadId ?? thread?.id, 'seeded thread'),
    postId: typeof thread?.postId === 'string' && uuid.test(thread.postId) ? thread.postId : null,
    realmId: typeof board?.realmId === 'string' && uuid.test(board.realmId) ? board.realmId : null,
    collections,
  };
}

async function provisionCommunity(stack: Stack, developer: Persona, workId: string): Promise<CreatedCommunity> {
  const space = requireStatus(
    await kernel(stack, 'POST', '/v1/spaces', {
      bearer: developer.bearer,
      body: { title: 'Content walk Space', summary: 'Public Space for the Content Goal walk' },
    }),
    'space create',
    201,
  ).space as Json;
  const spaceId = asId(space.spaceId, 'space');
  let realm = requireStatus(
    await kernel(stack, 'POST', '/v1/realms', {
      bearer: developer.bearer,
      body: {
        spaceId,
        title: 'Content walk Realm',
        summary: 'Public discussion Realm for the Content Goal walk',
        visibility: 'public',
        contextId: globalContext,
      },
    }),
    'realm create',
    201,
  ).realm as Json;
  const realmId = asId(realm.realmId, 'realm');
  const scheme = requireStatus(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer: developer.bearer,
      body: { type: 'skos:ConceptScheme', labels: { en: 'Content walk discussion scheme' } },
    }),
    'scheme create',
    201,
  ).subject as Json;
  realm = requireStatus(
    await kernel(stack, 'PUT', `/v1/realms/${realmId}/boardScheme`, {
      bearer: developer.bearer,
      body: { schemeId: scheme.id },
      ifMatch: asId(realm.headRevisionId, 'realm head'),
    }),
    'board scheme',
  ).realm as Json;
  const concept = requireStatus(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer: developer.bearer,
      body: {
        type: 'skos:Concept',
        labels: { en: 'Content walk discussion' },
        statements: {
          'skos:inScheme': [
            { property: { id: 'skos:inScheme' }, value: { type: 'value', content: realm.boardSchemeId } },
          ],
        },
      },
    }),
    'concept create',
    201,
  ).subject as Json;
  const board = requireStatus(
    await kernel(stack, 'POST', `/v1/realms/${realmId}/boards`, {
      bearer: developer.bearer,
      body: { conceptId: concept.id, title: 'Content walk discussion', purpose: 'discussion', visibility: 'published' },
    }),
    'board create',
    201,
  ).board as Json;
  const thread = requireStatus(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer: developer.bearer,
      body: {
        boardId: board.id,
        title: 'Opening the Content Goal walk',
        kind: 'discussion',
        body: fromPlainText('This original note opens the Content Goal walk on a public Realm Board.'),
        licence: 'CC-BY-4.0',
        subjectIds: [workId],
        visibility: 'published',
      },
    }),
    'thread create',
    201,
  ).thread as Json;
  const published = await kernel(stack, 'POST', `/v1/realms/${realmId}/publications`, {
    bearer: developer.bearer,
    body: { subjectId: workId },
  });
  if (published.status !== 201 && published.status !== 409)
    throw new Error(`publication returned HTTP ${published.status}`);
  return {
    spaceId,
    realmId,
    boardId: asId(board.id, 'board'),
    threadId: asId(thread.id ?? thread.threadId, 'thread'),
    postId: asId(thread.firstPost ? (thread.firstPost as Json).id : thread.postId, 'opening post'),
  };
}

async function createProtectedBoard(stack: Stack, developer: Persona): Promise<string> {
  const concept = requireStatus(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer: developer.bearer,
      body: { type: 'skos:Concept', labels: { en: 'Protected walk Board' } },
    }),
    'protected concept',
    201,
  ).subject as Json;
  const board = requireStatus(
    await kernel(stack, 'POST', '/v1/boards', {
      bearer: developer.bearer,
      body: {
        conceptId: concept.id,
        title: 'Protected Content walk Board',
        purpose: 'discussion',
        visibility: 'protected',
      },
    }),
    'protected board',
    201,
  ).board as Json;
  return asId(board.id, 'protected board');
}

export function grantReceiptKey(resource: { route: number; id: string }, accountId: string, action: string): string {
  return `accounts.grant:${resource.route}:${resource.id}:${accountId}:${action}`;
}

export function mentionBody(text: string, accountIds: readonly string[]) {
  const plain = fromPlainText(text, 'text');
  const paragraphs = plain.doc.content ?? [];
  const first = paragraphs[0];
  if (!first) throw new Error('plain text document omitted its paragraph');
  return normalizeDocument({
    ...plain,
    doc: {
      ...plain.doc,
      content: [
        {
          ...first,
          content: [
            ...(first.content ?? []),
            ...accountIds.map((accountId) => ({
              type: 'mention' as const,
              attrs: { accountId: accountId.toLowerCase() },
            })),
          ],
        },
        ...paragraphs.slice(1),
      ],
    },
  });
}

async function grantActions(
  stack: Stack,
  grantor: Persona,
  resourceId: string,
  accountId: string,
  actions: readonly string[],
) {
  const resource = { route: routeOf(resourceId), id: resourceId };
  for (const action of actions) {
    const granted = await kernel(stack, 'POST', '/v1/grants', {
      bearer: grantor.bearer,
      body: {
        resource,
        subject: { kind: 'account', id: accountId },
        actions: [action],
        valid: '(,)',
      },
      idempotencyKey: grantReceiptKey(resource, accountId, action),
    });
    if (granted.status !== 200 && granted.status !== 201 && granted.status !== 409)
      throw new Error(
        `ordinary grant ${action} on ${resourceId} returned HTTP ${granted.status}: ${JSON.stringify(publicFields(granted.value)).slice(0, 400)}`,
      );
  }
}

async function grantBoardRead(stack: Stack, developer: Persona, boardId: string, accountId: string) {
  await grantActions(stack, developer, boardId, accountId, ['board:read']);
}

function inboxItems(page: Json): InboxItem[] {
  return Array.isArray(page.items) ? (page.items as InboxItem[]) : [];
}

async function readInbox(
  stack: Stack,
  person: Persona,
  query: Record<string, string> = { limit: '20', selection: 'all' },
): Promise<{ status: number; value: Json; items: InboxItem[] }> {
  if (!person.accountId) throw new Error(`${person.label} account is required for inbox`);
  const page = await kernel(stack, 'GET', `/v1/accounts/${person.accountId}/notifications`, {
    bearer: person.bearer,
    query,
  });
  if (page.status === 404 || page.status === 501)
    throw new Error(
      `notices remain unbound: GET /v1/accounts/{id}/notifications returned HTTP ${page.status}; correct result is a 200 inbox page of eligible reply, mention and moderation notices`,
    );
  return { ...page, items: inboxItems(page.value) };
}

export async function waitForNotices(
  read: () => Promise<{ status: number; items: InboxItem[] }>,
  match: (item: InboxItem) => boolean,
  label: string,
  timeoutMs = 90_000,
): Promise<InboxItem[]> {
  const deadline = Date.now() + timeoutMs;
  let last: InboxItem[] = [];
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const page = await read();
    lastStatus = page.status;
    last = page.items;
    const found = last.filter(match);
    if (page.status === 200 && found.length > 0) return found;
    await Bun.sleep(1_000);
  }
  throw new Error(
    `${label} did not appear after default-worker wait (last HTTP ${lastStatus}, ${last.length} items): correct result is a delivered notice from the published-post effect`,
  );
}

async function waitForPersonNotices(
  stack: Stack,
  person: Persona,
  match: (item: InboxItem) => boolean,
  label: string,
  timeoutMs = 90_000,
): Promise<InboxItem[]> {
  return waitForNotices(() => readInbox(stack, person), match, label, timeoutMs);
}

async function assertNoMatchingNotice(
  stack: Stack,
  person: Persona,
  match: (item: InboxItem) => boolean,
  label: string,
  holdMs = 12_000,
): Promise<number> {
  const deadline = Date.now() + holdMs;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const page = await readInbox(stack, person);
    requireStatus(page, `${person.label} inbox during ${label}`);
    lastCount = page.items.filter(match).length;
    if (lastCount > 0)
      throw new Error(`${label} delivered ${lastCount} notice(s); correct result is none after send-time denial`);
    await Bun.sleep(1_000);
  }
  return lastCount;
}

async function unreadSummary(stack: Stack, person: Persona) {
  if (!person.accountId) throw new Error(`${person.label} account is required for unread`);
  return kernel(stack, 'GET', `/v1/accounts/${person.accountId}/notifications/count`, { bearer: person.bearer });
}

async function markInboxSeen(stack: Stack, person: Persona, through: string) {
  if (!person.accountId) throw new Error(`${person.label} account is required for markSeen`);
  return kernel(stack, 'POST', `/v1/accounts/${person.accountId}/notifications:markSeen`, {
    bearer: person.bearer,
    body: { through },
  });
}

async function readPreferences(stack: Stack, person: Persona) {
  if (!person.accountId) throw new Error(`${person.label} account is required for preferences`);
  return requireStatus(
    await kernel(stack, 'GET', `/v1/accounts/${person.accountId}/preferences`, { bearer: person.bearer }),
    `${person.label} preferences`,
  );
}

async function setMentionPreference(stack: Stack, person: Persona, enabled: boolean) {
  const current = await readPreferences(stack, person);
  const version = typeof current.version === 'number' ? current.version : 0;
  return requireStatus(
    await kernel(stack, 'PATCH', `/v1/accounts/${person.accountId}/preferences`, {
      bearer: person.bearer,
      body: { expectedVersion: version, notifications: { mention: enabled } },
    }),
    `${person.label} mention preference`,
  );
}

function noticeDecisionId(item: InboxItem): string | null {
  if (typeof item.decisionId === 'string' && uuid.test(item.decisionId)) return item.decisionId;
  const open = item.actions as Json | undefined;
  const target = open?.open as Json | undefined;
  if (target && target.kind === 'moderation_decision' && typeof target.decisionId === 'string')
    return asId(target.decisionId, 'decision');
  return null;
}

function publicRuntime(): Json {
  const issuer = process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN ?? process.env.AUTH_ISSUER ?? null;
  const native = process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN ?? null;
  const jwks = process.env.AUTH_JWKS_URL ?? null;
  const issuerJwks = typeof issuer === 'string' ? `${issuer.replace(/\/$/, '')}/.well-known/jwks.json` : null;
  const nativeJwks = typeof native === 'string' ? `${native.replace(/\/$/, '')}/.well-known/jwks.json` : null;
  return {
    issuer,
    native,
    jwks,
    jwksMatchesIssuer: Boolean(jwks && issuerJwks && jwks === issuerJwks),
    jwksMatchesNative: Boolean(jwks && nativeJwks && jwks === nativeJwks),
  };
}

async function createPublishedThread(
  stack: Stack,
  author: Persona,
  boardId: string,
  workId: string,
  title: string,
  body: string,
): Promise<{ threadId: string; postId: string; revisionId: string }> {
  const created = requireStatus(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer: author.bearer,
      body: {
        boardId,
        title,
        kind: 'discussion',
        body: fromPlainText(body),
        licence: 'CC-BY-4.0',
        subjectIds: [workId],
        visibility: 'published',
      },
    }),
    title,
    201,
  ).thread as Json;
  const opening = created.firstPost as Json | undefined;
  return {
    threadId: asId(created.id ?? created.threadId, `${title} thread`),
    postId: asId(opening?.id ?? created.postId, `${title} post`),
    revisionId: asId(opening?.revisionId ?? created.revisionId, `${title} revision`),
  };
}

function pageContains(page: Json, identity: string): boolean {
  return JSON.stringify(page).includes(identity);
}

async function timedRow(row: FirstScopeRow, run: () => Promise<Json>): Promise<RowResult> {
  const started = Date.now();
  try {
    const observed = await run();
    return { row, status: 'passing', durationMs: Date.now() - started, observed };
  } catch (error) {
    return {
      row,
      status: 'failing',
      durationMs: Date.now() - started,
      observed: {},
      defect: error instanceof Error ? error.message : String(error),
    };
  }
}

async function walkThreadsAndBoards(context: WalkContext): Promise<Json> {
  const { stack, author, member, showcase, community } = context;
  const created = requireStatus(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer: author.bearer,
      body: {
        boardId: community.boardId,
        title: 'Author thread for the Content walk',
        kind: 'discussion',
        body: fromPlainText('Canonical opening bytes for the Content Goal walk.'),
        licence: 'CC-BY-4.0',
        subjectIds: [showcase.workId],
        visibility: 'published',
      },
    }),
    'author thread',
    201,
  ).thread as Json;
  const threadId = asId(created.id ?? created.threadId, 'author thread');
  const opening = created.firstPost as Json | undefined;
  const openingId = asId(opening?.id ?? created.postId, 'opening post');
  const openingRevision = asId(opening?.revisionId ?? created.revisionId, 'opening revision');
  const reply = requireStatus(
    await kernel(stack, 'POST', `/v1/threads/${threadId}/posts`, {
      bearer: member.bearer,
      body: { body: fromPlainText('Member reply on the Content walk thread.'), licence: 'MIT' },
    }),
    'member reply',
    201,
  ).post as Json;
  const replyId = asId(reply.id, 'reply');
  const before = requireStatus(
    await kernel(stack, 'GET', `/v1/posts/${replyId}/revisions/${asId(reply.revisionId, 'reply revision')}`),
    'exact original revision',
  ).post as Json;
  const revised = requireStatus(
    await kernel(stack, 'POST', `/v1/posts/${replyId}/revisions`, {
      bearer: member.bearer,
      body: { body: fromPlainText('Edited member reply for immutable history.'), licence: 'MIT' },
      ifMatch: asId(reply.revisionId, 'reply revision'),
    }),
    'revise reply',
  ).post as Json;
  const exact = requireStatus(
    await kernel(stack, 'GET', `/v1/posts/${replyId}/revisions/${reply.revisionId}`),
    'retained exact revision',
  ).post as Json;
  if (exact.revisionId !== before.revisionId) throw new Error('exact revision identity moved');
  if (exact.licence !== 'MIT') throw new Error(`exact revision licence ${String(exact.licence)}`);
  if (exact.sha256 !== before.sha256) throw new Error('exact revision hash changed');
  if (documentText(exact.body) !== documentText(before.body)) throw new Error('exact revision body changed');
  if (revised.revisionId === reply.revisionId) throw new Error('revision did not create a new immutable head');
  const reading = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${threadId}/reading-page`),
    'anonymous reading-page',
  );
  const threadPage = reading.thread as Json;
  if (asId(threadPage.id, 'reading thread') !== threadId) throw new Error('reading-page thread drifted');
  const sorts: Record<string, Json> = {};
  for (const sort of ['hot', 'active', 'newest'] as const) {
    const page = requireStatus(
      await kernel(stack, 'GET', `/v1/boards/${community.boardId}/threads`, { query: { sort, limit: '20' } }),
      `${sort} board page`,
    );
    const threads = Array.isArray(page.threads) ? (page.threads as Json[]) : [];
    const pinned = Array.isArray(page.pinnedThreads) ? page.pinnedThreads : [];
    const ids = threads.map((item) => asId((item.thread as Json | undefined)?.id ?? item.id, `${sort} thread`));
    if (ids.includes(threadId) === false && threads.length === 20)
      throw new Error(`${sort} first page is full without the walk thread`);
    sorts[sort] = {
      count: threads.length,
      next: page.next ?? null,
      pinned: pinned.length,
      hasWalkThread: ids.includes(threadId),
    };
  }
  const posts = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${threadId}/posts`, { query: { limit: '20' } }),
    'thread posts',
  );
  const watched = await kernel(stack, 'PUT', `/v1/threads/${threadId}/watch`, { bearer: member.bearer });
  if (watched.status !== 204) throw new Error(`watch returned HTTP ${watched.status}`);
  const watchState = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${threadId}/watch`, { bearer: member.bearer }),
    'watch state',
  );
  if (watchState.watching !== true) throw new Error('watch state was not true after PUT');
  const reaction = requireStatus(
    await kernel(stack, 'PUT', `/v1/threads/${threadId}/reaction`, {
      bearer: member.bearer,
      body: { kind: 'upvote' },
    }),
    'thread reaction',
  );
  const disposable = requireStatus(
    await kernel(stack, 'POST', `/v1/threads/${threadId}/posts`, {
      bearer: author.bearer,
      body: { body: fromPlainText('Author point that will be erased.'), licence: 'MIT' },
    }),
    'erasable post',
    201,
  ).post as Json;
  const erased = requireStatus(
    await kernel(stack, 'POST', `/v1/posts/${asId(disposable.id, 'erasable post')}:erase`, {
      bearer: author.bearer,
      body: { reason: 'Content walk synchronous point erasure' },
    }),
    'point erasure',
  );
  const erasedRead = await kernel(stack, 'GET', `/v1/posts/${asId(disposable.id, 'erasable post')}`);
  if (
    erasedRead.status === 200 &&
    documentText((erasedRead.value.post as Json | undefined)?.body) === 'Author point that will be erased.'
  )
    throw new Error('erased post still disclosed its original body');
  const erasureThread = requireStatus(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer: author.bearer,
      body: {
        boardId: community.boardId,
        title: 'Bounded author erasure walk',
        kind: 'discussion',
        body: fromPlainText('This thread exists so author erasure can make bounded progress.'),
        licence: 'CC-BY-4.0',
        subjectIds: [showcase.workId],
        visibility: 'published',
      },
    }),
    'erasure thread',
    201,
  ).thread as Json;
  const erasureThreadId = asId(erasureThread.id ?? erasureThread.threadId, 'erasure thread');
  if (!author.accountId) throw new Error('author account is required for bounded erasure');
  const authorErasure = requireStatus(
    await kernel(stack, 'POST', `/v1/threads/${erasureThreadId}:erase`, {
      bearer: author.bearer,
      body: { authorId: author.accountId },
    }),
    'bounded author erasure',
    [202, 200],
  );
  return {
    threadId,
    openingId,
    openingRevision,
    replyId,
    revisedRevision: revised.revisionId,
    exactLicence: exact.licence,
    exactHash: exact.sha256,
    readingTitle: threadPage.title,
    posts: Array.isArray(posts.posts) ? (posts.posts as unknown[]).length : 0,
    sorts,
    watching: watchState.watching,
    reaction: reaction.kind,
    pointErasure: publicFields(erased) as Json,
    erasedPost: erasedRead.status,
    authorErasure: publicFields(authorErasure) as Json,
  };
}

async function walkRealmsAndSpaces(context: WalkContext): Promise<Json> {
  const { stack, developer, member, community } = context;
  requireStatus(await kernel(stack, 'GET', `/v1/spaces/${community.spaceId}`), 'anonymous space');
  requireStatus(await kernel(stack, 'GET', `/v1/realms/${community.realmId}`), 'anonymous realm');
  const join = await kernel(stack, 'POST', `/v1/realms/${community.realmId}/membership`, { bearer: member.bearer });
  if (join.status !== 202 && join.status !== 200 && join.status !== 409)
    throw new Error(`realm join returned HTTP ${join.status}: ${JSON.stringify(publicFields(join.value))}`);
  const membership = await waitForMembership(stack, community.realmId, member.bearer);
  const home = requireStatus(
    await kernel(stack, 'GET', `/v1/realms/${community.realmId}/home`, { query: { languages: 'en' } }),
    'realm home',
  );
  const shelf = await kernel(stack, 'GET', `/v1/realms/${community.realmId}/boardShelf`);
  const discovery = await kernel(stack, 'GET', '/v1/realms/discovery', { query: { sort: 'popular', limit: '20' } });
  const participation = await kernel(stack, 'GET', `/v1/realms/${community.realmId}/participation`, {
    bearer: member.bearer,
  });
  const slowMode = requireStatus(
    await kernel(stack, 'PUT', `/v1/boards/${community.boardId}/slowMode`, {
      bearer: developer.bearer,
      body: { intervalSeconds: 5 },
    }),
    'slow mode',
  );
  const slowRead = requireStatus(
    await kernel(stack, 'GET', `/v1/boards/${community.boardId}/slowMode`, { bearer: member.bearer }),
    'slow mode read',
  );
  if (slowRead.intervalSeconds !== 5) throw new Error(`slow mode interval ${String(slowRead.intervalSeconds)}`);
  await kernel(stack, 'PUT', `/v1/boards/${community.boardId}/slowMode`, {
    bearer: developer.bearer,
    body: { intervalSeconds: 0 },
  });
  return {
    membership,
    homeStatus: 200,
    boards: shelf.status,
    discovery: discovery.status,
    participation: participation.status,
    developer: developer.label,
    slowMode: publicFields(slowMode) as Json,
  };
}

async function walkRatingsAndReviews(context: WalkContext): Promise<Json> {
  const { stack, member, showcase, community } = context;
  const vote = requireStatus(
    await kernel(stack, 'PUT', `/v1/subjects/${showcase.workId}/ratings/${standardQuestion}/vote`, {
      bearer: member.bearer,
      body: { units: 16 },
    }),
    'member vote',
  );
  const own = requireStatus(
    await kernel(stack, 'GET', `/v1/subjects/${showcase.workId}/ratings/${standardQuestion}/vote`, {
      bearer: member.bearer,
    }),
    'own vote',
  );
  if (own.units !== 16) throw new Error(`own vote units ${String(own.units)}`);
  const figure = await kernel(stack, 'GET', `/v1/subjects/${showcase.workId}/figure`);
  const aggregate = await kernel(stack, 'GET', `/v1/subjects/${showcase.workId}/ratings`, {
    query: { question: standardQuestion, population: globalContext },
  });
  const review = requireStatus(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer: member.bearer,
      body: {
        boardId: community.boardId,
        title: 'A cited review from the Content walk',
        kind: 'review',
        body: fromPlainText('The walk cites the member vote at publication time.'),
        licence: 'CC-BY-4.0',
        subjectIds: [showcase.workId],
        visibility: 'published',
        voteCitation: {
          questionId: standardQuestion,
          units: 16,
          revision: own.revision,
        },
      },
    }),
    'review thread',
    [200, 201],
  );
  return {
    voteUnits: vote.units ?? own.units,
    voteRevision: own.revision,
    figure: figure.status,
    aggregate: aggregate.status,
    reviewThread: (review.thread as Json | undefined)?.id ?? null,
  };
}

async function walkWorkToReview(context: WalkContext): Promise<Json> {
  const { stack, member, showcase, community } = context;
  const destinations = requireStatus(
    await kernel(stack, 'GET', `/v1/realms/${community.realmId}/review-destinations`, {
      bearer: member.bearer,
      query: { subjectId: showcase.workId },
    }),
    'review destinations',
  );
  const items = Array.isArray(destinations.items) ? (destinations.items as Json[]) : [];
  const state = typeof destinations.state === 'string' ? destinations.state : 'unknown';
  if (!['choices', 'sparse', 'no-destinations', 'exhausted', 'denied', 'expired'].includes(state))
    throw new Error(`unexpected destination state ${state}`);
  let inspection: Json | null = null;
  if (items[0] && typeof items[0].id === 'string') {
    inspection = requireStatus(
      await kernel(stack, 'GET', `/v1/realms/${community.realmId}/review-destinations`, {
        bearer: member.bearer,
        query: { subjectId: showcase.workId, boardId: asId(items[0].id, 'destination board') },
      }),
      'exact board inspection',
    );
  }
  const submitted = requireStatus(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer: member.bearer,
      body: {
        boardId: community.boardId,
        title: 'Work-to-review captured return',
        kind: 'review',
        body: fromPlainText('Submitted after destination inspection.'),
        licence: 'CC-BY-4.0',
        subjectIds: [showcase.workId],
        visibility: 'published',
      },
    }),
    'review submission',
    201,
  ).thread as Json;
  const threadId = asId(submitted.id ?? submitted.threadId, 'review thread');
  const acknowledged = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${threadId}`),
    'authoritative acknowledgement',
  );
  const subjectPage = await kernel(stack, 'GET', `/v1/subjects/${showcase.workId}/threads`, {
    query: { place: globalContext, kind: 'review', limit: '20' },
  });
  return {
    destinationState: state,
    destinationCount: items.length,
    inspectionState: inspection && typeof inspection.state === 'string' ? inspection.state : null,
    threadId,
    acknowledged: (acknowledged.thread as Json | undefined)?.id ?? threadId,
    subjectReviews: subjectPage.status,
    returnTo: `/en/subjects/${showcase.workId}`,
  };
}

async function walkMedia(context: WalkContext): Promise<Json> {
  const { stack, author, community } = context;
  const key = crypto.randomUUID();
  const reserved = requireStatus(
    await kernel(stack, 'POST', '/v1/media', {
      bearer: author.bearer,
      body: {
        newThread: { boardId: community.boardId, idempotencyKey: key },
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: 128,
      },
    }),
    'media reservation',
    201,
  );
  const media = reserved.media as Json | undefined;
  if (!media || media.state !== 'reserved') throw new Error(`reservation state ${String(media?.state)}`);
  const mediaId = asId(media.id, 'media');
  const read = requireStatus(
    await kernel(stack, 'GET', `/v1/media/${mediaId}`, { bearer: author.bearer }),
    'reserved media read',
  );
  const own = await kernel(stack, 'GET', '/v1/media', { bearer: author.bearer, query: { limit: '20' } });
  const completed = await kernel(stack, 'POST', `/v1/media/${mediaId}:complete`, {
    bearer: author.bearer,
    body: {
      containerId: media.containerId ?? community.threadId,
      reservationRequestId: media.reservationRequestId ?? media.key,
      byteCount: 128,
      sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });
  const download = await kernel(stack, 'GET', `/v1/media/${mediaId}:authorizeDownload`, {
    bearer: author.bearer,
    query: { variant: 'original' },
  });
  if (completed.status !== 200 && completed.status !== 409)
    throw new Error(
      `media completion returned HTTP ${completed.status}; correct result is uploaded then available after derivatives`,
    );
  return {
    id: media.id,
    state: media.state,
    read: (read.media as Json | undefined)?.state ?? read.state,
    own: own.status,
    completed: completed.status,
    completedState: (completed.value.media as Json | undefined)?.state ?? null,
    download: download.status,
  };
}

async function walkReports(context: WalkContext): Promise<Json> {
  const { stack, author, member, reviewer, developer, community, showcase } = context;
  if (!author.accountId || !reviewer.accountId)
    throw new Error('author and reviewer accounts are required for appeals');
  const created = requireStatus(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer: author.bearer,
      body: {
        boardId: community.boardId,
        title: 'Independent appeal walk thread',
        kind: 'discussion',
        body: fromPlainText('This post is taken down so an independent reviewer can reverse it.'),
        licence: 'CC-BY-4.0',
        subjectIds: [showcase.workId],
        visibility: 'published',
      },
    }),
    'appeal thread',
    201,
  ).thread as Json;
  const threadId = asId(created.id ?? created.threadId, 'appeal thread');
  const postId = asId(created.firstPost ? (created.firstPost as Json).id : created.postId, 'appeal post');
  for (const resourceId of [community.realmId, community.boardId, threadId, postId]) {
    await grantActions(stack, developer, resourceId, reviewer.accountId, [
      'moderation:takedown',
      'moderation:read_reports',
    ]);
  }
  const report = requireStatus(
    await kernel(stack, 'POST', '/v1/reports', {
      bearer: member.bearer,
      body: { target: { kind: 'post', id: postId }, reason: 'spam' },
    }),
    'create report',
    201,
  );
  const reportId = asId(report.reportId, 'report');
  const own = requireStatus(
    await kernel(stack, 'GET', '/v1/reports/me', { bearer: member.bearer, query: { reportId } }),
    'own report',
  );
  const exact = await kernel(stack, 'GET', `/v1/reports/${reportId}`, { bearer: member.bearer });
  const directory = await kernel(stack, 'GET', '/v1/me/moderation-directory', { bearer: developer.bearer });
  const takenDown = requireStatus(
    await kernel(stack, 'POST', `/v1/posts/${postId}:takeDown`, {
      bearer: developer.bearer,
      body: { reason: 'Content walk takedown for independent appeal' },
    }),
    'post takedown',
  );
  const hidden = await kernel(stack, 'GET', `/v1/posts/${postId}`, { bearer: member.bearer });
  if (hidden.status === 200) throw new Error('taken-down post remained readable; correct result is 404');
  const decisionNotice = (
    await waitForPersonNotices(
      stack,
      author,
      (item) => item.kind === 'moderation_decision' && noticeDecisionId(item) !== null,
      'takedown decision notice',
    )
  )[0]!;
  const decisionId = asId(noticeDecisionId(decisionNotice), 'decision');
  const decision = requireStatus(
    await kernel(stack, 'GET', `/v1/moderation-decisions/${decisionId}`, { bearer: author.bearer }),
    'author decision',
  );
  if (JSON.stringify(decision).includes(developer.accountId ?? 'no-developer'))
    throw new Error('decision disclosed the decider identity');
  const appeal = requireStatus(
    await kernel(stack, 'POST', `/v1/moderation-decisions/${decisionId}:appeal`, {
      bearer: author.bearer,
      body: { statement: 'Please reverse this Content walk takedown.' },
    }),
    'author appeal',
    201,
  );
  const appealId = asId(appeal.id ?? appeal.appealId, 'appeal');
  const deciderResolve = await kernel(stack, 'POST', `/v1/moderation-appeals/${appealId}:resolve`, {
    bearer: developer.bearer,
    body: { outcome: 'reverse', statement: 'Original decider must not resolve' },
  });
  if (deciderResolve.status !== 403)
    throw new Error(`original decider resolved the appeal with HTTP ${deciderResolve.status}; correct result is 403`);
  const pending = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${threadId}/appeals`, { bearer: reviewer.bearer, query: { limit: '20' } }),
    'independent appeal queue',
  );
  const pendingItems = Array.isArray(pending.items) ? (pending.items as Json[]) : [];
  if (!pendingItems.some((item) => item.id === appealId))
    throw new Error('independent reviewer queue omitted the pending appeal');
  const resolution = requireStatus(
    await kernel(stack, 'POST', `/v1/moderation-appeals/${appealId}:resolve`, {
      bearer: reviewer.bearer,
      body: { outcome: 'reverse', statement: 'Independent review reverses the walk takedown.' },
    }),
    'independent reverse',
  );
  await waitForPersonNotices(
    stack,
    author,
    (item) =>
      item.kind === 'moderation_decision' && noticeDecisionId(item) === decisionId && item.id !== decisionNotice.id,
    'appeal resolution notice',
  );
  const restored = requireStatus(
    await kernel(stack, 'GET', `/v1/posts/${postId}`, { bearer: member.bearer }),
    'restored post',
  );
  const reporterInbox = await readInbox(stack, member);
  requireStatus(reporterInbox, 'reporter inbox');
  const reporterNotices = reporterInbox.items.filter(
    (item) => item.reportId === reportId || item.kind === 'moderation_decision',
  );
  const replayed = await readInbox(stack, author);
  requireStatus(replayed, 'author inbox after appeal replay');
  const decisionNotices = replayed.items.filter((item) => noticeDecisionId(item) === decisionId);
  if (decisionNotices.length < 2)
    throw new Error(`appeal resolution did not add a second decision notice; saw ${decisionNotices.length}`);
  await Bun.sleep(3_000);
  const afterReplay = await readInbox(stack, author);
  if (afterReplay.items.filter((item) => noticeDecisionId(item) === decisionId).length !== decisionNotices.length)
    throw new Error('replay added a duplicate moderation notice');
  return {
    reportId,
    own: publicFields(own) as Json,
    exactStatus: exact.status,
    directoryStatus: directory.status,
    directoryState:
      typeof directory.value.state === 'string'
        ? directory.value.state
        : typeof directory.value.code === 'string'
          ? directory.value.code
          : directory.status,
    takedown: publicFields(takenDown) as Json,
    hidden: hidden.status,
    decisionId,
    appealId,
    deciderResolve: deciderResolve.status,
    pending: pendingItems.length,
    resolution: publicFields(resolution) as Json,
    restored: (restored.post as Json | undefined)?.id ?? postId,
    reporterNotices: reporterNotices.length,
  };
}

async function walkNotices(context: WalkContext): Promise<Json> {
  // Published-post effects (`post.published`) are the notice authority; the default worker delivers them.
  const { stack, author, member, outsider, community } = context;
  if (!author.accountId || !outsider.accountId)
    throw new Error('author and outsider accounts are required for notices');
  const reply = requireStatus(
    await kernel(stack, 'POST', `/v1/threads/${community.threadId}/posts`, {
      bearer: member.bearer,
      body: { body: fromPlainText('Reply for published-post notice delivery to the author.'), licence: 'MIT' },
    }),
    'notice reply',
    201,
  ).post as Json;
  const replyId = asId(reply.id, 'notice reply');
  const replies = await waitForPersonNotices(
    stack,
    author,
    (item) =>
      item.kind === 'reply' && (item.postId === replyId || (item.target as Json | undefined)?.postId === replyId),
    'author reply notice',
  );
  const actorNotice = await readInbox(stack, member);
  requireStatus(actorNotice, 'actor inbox');
  if (
    actorNotice.items.some((item) => item.postId === replyId || (item.target as Json | undefined)?.postId === replyId)
  )
    throw new Error('the acting member received their own reply notice');
  const mention = requireStatus(
    await kernel(stack, 'POST', `/v1/threads/${community.threadId}/posts`, {
      bearer: member.bearer,
      body: {
        body: mentionBody('Mention delivery for the Content walk.', [outsider.accountId, author.accountId]),
        licence: 'MIT',
      },
    }),
    'mention post',
    201,
  ).post as Json;
  const mentionId = asId(mention.id, 'mention post');
  const mentions = await waitForPersonNotices(
    stack,
    outsider,
    (item) =>
      item.kind === 'mention' && (item.postId === mentionId || (item.target as Json | undefined)?.postId === mentionId),
    'outsider mention notice',
  );
  await setMentionPreference(stack, outsider, false);
  const suppressed = requireStatus(
    await kernel(stack, 'POST', `/v1/threads/${community.threadId}/posts`, {
      bearer: member.bearer,
      body: { body: mentionBody('Mention while the preference is off.', [outsider.accountId]), licence: 'MIT' },
    }),
    'suppressed mention',
    201,
  ).post as Json;
  const suppressedId = asId(suppressed.id, 'suppressed mention');
  await assertNoMatchingNotice(
    stack,
    outsider,
    (item) => item.postId === suppressedId || (item.target as Json | undefined)?.postId === suppressedId,
    'preference-off mention',
  );
  await setMentionPreference(stack, outsider, true);
  await assertNoMatchingNotice(
    stack,
    outsider,
    (item) => item.postId === suppressedId || (item.target as Json | undefined)?.postId === suppressedId,
    'replay after mention preference restored',
    8_000,
  );
  const unread = requireStatus(await unreadSummary(stack, author), 'author unread');
  const firstPage = await readInbox(stack, author, { limit: '1', selection: 'all' });
  requireStatus(firstPage, 'author inbox page');
  if (firstPage.items.length !== 1) throw new Error('inbox page did not honour limit=1');
  const through = asId(firstPage.items[0]?.id, 'seen notice');
  requireStatus(await markInboxSeen(stack, author, through), 'mark seen', [200, 204]);
  const afterSeen = await readInbox(stack, author);
  requireStatus(afterSeen, 'author inbox after seen');
  const replayed = await readInbox(stack, author);
  const replyIds = new Set(
    afterSeen.items
      .filter(
        (item) =>
          item.kind === 'reply' && (item.postId === replyId || (item.target as Json | undefined)?.postId === replyId),
      )
      .map((item) => item.id),
  );
  if (replyIds.size !== 1) throw new Error(`reply notice duplicated under replay: ${replyIds.size}`);
  if (replayed.items.filter((item) => replyIds.has(item.id)).length !== 1)
    throw new Error('default-worker replay added a second reply notice');
  const otherInbox = await kernel(stack, 'GET', `/v1/accounts/${author.accountId}/notifications`, {
    bearer: member.bearer,
  });
  if (otherInbox.status !== 404) throw new Error(`foreign inbox HTTP ${otherInbox.status}; correct result is 404`);
  return {
    replyId,
    mentionId,
    suppressedId,
    replies: replies.length,
    mentions: mentions.length,
    unread: publicFields(unread) as Json,
    pageNext: firstPage.value.next ?? null,
    seen: through,
    afterSeen: afterSeen.items.filter((item) => item.id === through && item.unread === true).length,
    foreignInbox: otherInbox.status,
  };
}

async function walkHomeDiscovery(context: WalkContext): Promise<Json> {
  const { stack, showcase, community } = context;
  const home = await fetch(`${stack.web}/en/`, { signal: AbortSignal.timeout(120_000), redirect: 'manual' });
  const html = await home.text();
  if (home.status !== 200) throw new Error(`Home returned HTTP ${home.status}`);
  if (!html.includes('<main')) throw new Error('Home omitted main');
  const discovery = await kernel(stack, 'GET', '/v1/realms/discovery', { query: { sort: 'trending', limit: '20' } });
  const boardPage = requireStatus(
    await kernel(stack, 'GET', `/v1/boards/${showcase.boardId}/page`),
    'seeded board opening',
  );
  const thread = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${showcase.threadId}/reading-page`),
    'seeded reading-page',
  );
  return {
    home: home.status,
    discovery: discovery.status,
    board: (boardPage.board as Json | undefined)?.id ?? showcase.boardId,
    seededThread: (thread.thread as Json | undefined)?.id ?? showcase.threadId,
    walkRealm: community.realmId,
  };
}

async function walkPersonaMatrix(context: WalkContext): Promise<Json> {
  const { stack, author, member, outsider, banned, suspended, community, protectedBoardId, developer } = context;
  const join = await kernel(stack, 'POST', `/v1/realms/${community.realmId}/membership`, { bearer: banned.bearer });
  if (join.status !== 202 && join.status !== 200 && join.status !== 409)
    throw new Error(`banned-member join returned HTTP ${join.status}`);
  if (join.status === 202 || join.status === 200) await waitForMembership(stack, community.realmId, banned.bearer);
  if (!banned.accountId) throw new Error('banned account id missing');
  const ban = requireStatus(
    await kernel(stack, 'PUT', `/v1/realms/${community.realmId}/bans/${banned.accountId}`, {
      bearer: developer.bearer,
      body: { reason: 'Content walk ban barrier' },
    }),
    'realm ban',
    [200, 201],
  );
  const bannedParticipation = await kernel(stack, 'GET', `/v1/realms/${community.realmId}/participation`, {
    bearer: banned.bearer,
  });
  const bannedPost = await kernel(stack, 'POST', `/v1/threads/${community.threadId}/posts`, {
    bearer: banned.bearer,
    body: { body: fromPlainText('Banned member must not post.'), licence: 'MIT' },
  });
  if (bannedPost.status === 201) throw new Error('banned member published a reply; correct result is 403');
  if (!suspended.accountId) throw new Error('suspended account id missing');
  const suspension = requireStatus(
    await kernel(stack, 'POST', `/v1/accounts/${suspended.accountId}:suspend`, {
      bearer: developer.bearer,
      body: { reason: 'Content walk suspended persona' },
    }),
    'account suspend',
    [200, 201],
  );
  const suspendedThread = await kernel(stack, 'POST', '/v1/threads', {
    bearer: suspended.bearer,
    body: {
      boardId: community.boardId,
      title: 'Suspended must not publish',
      kind: 'discussion',
      body: fromPlainText('Suspended write'),
      licence: 'CC-BY-4.0',
      visibility: 'published',
    },
  });
  if (suspendedThread.status === 201)
    throw new Error('suspended account published a thread; correct result is 401 or 403');
  const protectedAnonymous = await kernel(stack, 'GET', `/v1/boards/${protectedBoardId}/threads`);
  const protectedOutsider = await kernel(stack, 'GET', `/v1/boards/${protectedBoardId}/threads`, {
    bearer: outsider.bearer,
  });
  if (member.accountId) await grantBoardRead(stack, developer, protectedBoardId, member.accountId);
  const protectedMember = await kernel(stack, 'GET', `/v1/boards/${protectedBoardId}/threads`, {
    bearer: member.bearer,
  });
  const publishedAnonymous = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${community.threadId}`),
    'anonymous public thread',
  );
  const authorRead = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${community.threadId}`, { bearer: author.bearer }),
    'author public thread',
  );
  if (protectedAnonymous.status !== 404)
    throw new Error(`anonymous protected board HTTP ${protectedAnonymous.status}; correct result is 404`);
  if (protectedOutsider.status !== 404)
    throw new Error(`outsider protected board HTTP ${protectedOutsider.status}; correct result is 404`);
  return {
    ban: publicFields(ban) as Json,
    bannedParticipation: bannedParticipation.status,
    bannedPost: bannedPost.status,
    suspension: publicFields(suspension) as Json,
    suspendedWrite: suspendedThread.status,
    protectedAnonymous: protectedAnonymous.status,
    protectedOutsider: protectedOutsider.status,
    protectedMember: protectedMember.status,
    anonymousThread: (publishedAnonymous.thread as Json | undefined)?.id,
    authorThread: (authorRead.thread as Json | undefined)?.id,
  };
}

async function walkExactRevisions(context: WalkContext): Promise<Json> {
  const { stack, member, showcase, community } = context;
  const created = await createPublishedThread(
    stack,
    member,
    community.boardId,
    showcase.workId,
    'Exact revision walk',
    'Canonical opening bytes for exact revision retention.',
  );
  const before = requireStatus(
    await kernel(stack, 'GET', `/v1/posts/${created.postId}/revisions/${created.revisionId}`),
    'exact original revision',
  ).post as Json;
  const revised = requireStatus(
    await kernel(stack, 'POST', `/v1/posts/${created.postId}/revisions`, {
      bearer: member.bearer,
      body: { body: fromPlainText('Edited bytes for immutable history.'), licence: 'MIT' },
      ifMatch: created.revisionId,
    }),
    'revise for exact history',
  ).post as Json;
  const exact = requireStatus(
    await kernel(stack, 'GET', `/v1/posts/${created.postId}/revisions/${created.revisionId}`),
    'retained exact revision',
  ).post as Json;
  if (exact.revisionId !== before.revisionId) throw new Error('exact revision identity moved');
  if (exact.licence !== before.licence) throw new Error(`exact revision licence ${String(exact.licence)}`);
  if (exact.sha256 !== before.sha256) throw new Error('exact revision hash changed');
  if (documentText(exact.body) !== documentText(before.body)) throw new Error('exact revision body changed');
  if (revised.revisionId === created.revisionId) throw new Error('revision did not create a new immutable head');
  return {
    postId: created.postId,
    originalRevision: created.revisionId,
    revisedRevision: revised.revisionId,
    exactLicence: exact.licence,
    exactHash: exact.sha256,
  };
}

async function walkBoardPaging(context: WalkContext): Promise<Json> {
  const { stack, author, showcase, community } = context;
  const created = await createPublishedThread(
    stack,
    author,
    community.boardId,
    showcase.workId,
    'Paging walk thread',
    'A thread used to prove sparse hot, active and newest pages.',
  );
  const sorts: Record<string, Json> = {};
  for (const sort of ['hot', 'active', 'newest'] as const) {
    const page = requireStatus(
      await kernel(stack, 'GET', `/v1/boards/${community.boardId}/threads`, { query: { sort, limit: '20' } }),
      `${sort} board page`,
    );
    const threads = Array.isArray(page.threads) ? (page.threads as Json[]) : [];
    const pinned = Array.isArray(page.pinnedThreads) ? page.pinnedThreads : [];
    const ids = threads.map((item) => asId((item.thread as Json | undefined)?.id ?? item.id, `${sort} thread`));
    const pinnedIds = pinned.flatMap((item) => {
      const record = item as Json;
      const id = record.id ?? (record.thread as Json | undefined)?.id;
      return typeof id === 'string' ? [id] : [];
    });
    if (pinnedIds.some((id) => ids.includes(id)))
      throw new Error(`${sort} page mixed pinned threads into the sparse continuation`);
    if (ids.includes(created.threadId) === false && threads.length === 20)
      throw new Error(`${sort} first page is full without the paging walk thread`);
    sorts[sort] = {
      count: threads.length,
      next: page.next ?? null,
      pinned: pinned.length,
      hasWalkThread: ids.includes(created.threadId),
    };
  }
  return { threadId: created.threadId, sorts };
}

async function walkContainerDisclosure(context: WalkContext): Promise<Json> {
  const { stack, community } = context;
  const reading = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${community.threadId}/reading-page`),
    'container-chain reading-page',
  );
  const thread = reading.thread as Json;
  if (asId(thread.id, 'reading thread') !== community.threadId) throw new Error('reading-page thread drifted');
  if (asId(thread.boardId ?? (thread.board as Json | undefined)?.id, 'reading board') !== community.boardId)
    throw new Error('reading-page board drifted from the current container');
  return {
    threadId: community.threadId,
    boardId: community.boardId,
    title: thread.title,
    posts: Array.isArray(reading.posts) ? (reading.posts as unknown[]).length : null,
  };
}

async function walkLateRevocation(context: WalkContext): Promise<Json> {
  const { stack, developer, author, showcase } = context;
  const concept = requireStatus(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer: developer.bearer,
      body: { type: 'skos:Concept', labels: { en: 'Late revocation walk Board' } },
    }),
    'late-revocation concept',
    201,
  ).subject as Json;
  const board = requireStatus(
    await kernel(stack, 'POST', '/v1/boards', {
      bearer: developer.bearer,
      body: {
        conceptId: concept.id,
        title: 'Late revocation walk Board',
        purpose: 'discussion',
        visibility: 'published',
      },
    }),
    'late-revocation board',
    201,
  ).board as Json;
  const boardId = asId(board.id, 'late-revocation board');
  const created = await createPublishedThread(
    stack,
    author,
    boardId,
    showcase.workId,
    'Late revocation walk thread',
    'This thread must vanish from every reader surface after Board takedown.',
  );
  const baseline = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${created.threadId}`),
    'late-revocation baseline thread',
  );
  requireStatus(await kernel(stack, 'GET', `/v1/posts/${created.postId}`), 'late-revocation baseline post');
  requireStatus(
    await kernel(stack, 'GET', `/v1/posts/${created.postId}/revisions/${created.revisionId}`),
    'late-revocation baseline revision',
  );
  requireStatus(
    await kernel(stack, 'POST', `/v1/boards/${boardId}:takeDown`, {
      bearer: developer.bearer,
      body: { reason: 'Content walk late Board revocation' },
    }),
    'late Board takedown',
  );
  const afterThread = await kernel(stack, 'GET', `/v1/threads/${created.threadId}`);
  const afterPost = await kernel(stack, 'GET', `/v1/posts/${created.postId}`);
  const afterRevision = await kernel(stack, 'GET', `/v1/posts/${created.postId}/revisions/${created.revisionId}`);
  if (afterThread.status !== 404)
    throw new Error(`taken-down board thread HTTP ${afterThread.status}; correct result is 404 with no item`);
  if (afterPost.status !== 404)
    throw new Error(`taken-down board post HTTP ${afterPost.status}; correct result is 404 with no item`);
  if (afterRevision.status !== 404)
    throw new Error(`taken-down board revision HTTP ${afterRevision.status}; correct result is 404 with no item`);
  const pages: Record<string, Json> = {};
  for (const sort of ['hot', 'active', 'newest'] as const) {
    const page = await kernel(stack, 'GET', `/v1/boards/${boardId}/threads`, { query: { sort, limit: '20' } });
    if (page.status === 200 && pageContains(page.value, created.threadId))
      throw new Error(`${sort} page disclosed the revoked thread`);
    pages[sort] = { status: page.status, disclosed: pageContains(page.value, created.threadId) };
  }
  const subject = await kernel(stack, 'GET', `/v1/subjects/${showcase.workId}/threads`, {
    query: { place: globalContext, kind: 'discussion', limit: '20' },
  });
  if (subject.status === 200 && pageContains(subject.value, created.threadId))
    throw new Error('subject threads disclosed the revoked thread');
  const authorActivity = author.accountId
    ? await kernel(stack, 'GET', `/v1/accounts/${author.accountId}/threads`, {
        bearer: author.bearer,
        query: { kind: 'discussion', limit: '20' },
      })
    : { status: 0, value: {} };
  if (authorActivity.status === 200 && pageContains(authorActivity.value, created.threadId))
    throw new Error('author activity disclosed the revoked thread');
  return {
    boardId,
    threadId: created.threadId,
    baseline: (baseline.thread as Json | undefined)?.id ?? created.threadId,
    afterThread: afterThread.status,
    afterPost: afterPost.status,
    afterRevision: afterRevision.status,
    pages,
    subject: subject.status,
    authorActivity: authorActivity.status,
  };
}

async function walkEditHistoryReturn(context: WalkContext): Promise<Json> {
  const { stack, member, showcase, community } = context;
  const created = await createPublishedThread(
    stack,
    member,
    community.boardId,
    showcase.workId,
    'Edit history return',
    'Opening body before the captured return edit.',
  );
  const revised = requireStatus(
    await kernel(stack, 'POST', `/v1/posts/${created.postId}/revisions`, {
      bearer: member.bearer,
      body: { body: fromPlainText('Edited body after Board inspection.'), licence: 'CC-BY-4.0' },
      ifMatch: created.revisionId,
    }),
    'return edit',
  ).post as Json;
  const history = requireStatus(
    await kernel(stack, 'GET', `/v1/posts/${created.postId}/revisions/${created.revisionId}`),
    'history after edit',
  ).post as Json;
  const reading = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${created.threadId}/reading-page`, { bearer: member.bearer }),
    'reading-page after edit',
  );
  const returnTo = `/en/subjects/${showcase.workId}`;
  if (history.revisionId !== created.revisionId) throw new Error('edit history lost the original revision');
  if (revised.revisionId === created.revisionId) throw new Error('edit did not create a new head');
  return {
    threadId: created.threadId,
    originalRevision: created.revisionId,
    headRevision: revised.revisionId,
    historyLicence: history.licence,
    readingId: (reading.thread as Json | undefined)?.id ?? created.threadId,
    returnTo,
  };
}

async function walkWatchesAndReactions(context: WalkContext): Promise<Json> {
  const { stack, member, community } = context;
  const watched = await kernel(stack, 'PUT', `/v1/threads/${community.threadId}/watch`, { bearer: member.bearer });
  if (watched.status !== 204 && watched.status !== 200)
    throw new Error(`watch returned HTTP ${watched.status}; correct result is 204`);
  const watchState = requireStatus(
    await kernel(stack, 'GET', `/v1/threads/${community.threadId}/watch`, { bearer: member.bearer }),
    'watch state',
  );
  if (watchState.watching !== true) throw new Error('watch state was not true after PUT');
  const reaction = requireStatus(
    await kernel(stack, 'PUT', `/v1/threads/${community.threadId}/reaction`, {
      bearer: member.bearer,
      body: { kind: 'upvote' },
    }),
    'thread reaction',
  );
  const counts = await kernel(stack, 'GET', `/v1/threads/${community.threadId}/reactions`);
  return {
    threadId: community.threadId,
    watching: watchState.watching,
    reaction: reaction.kind,
    counts: counts.status,
  };
}

async function walkTakedownErasure(context: WalkContext): Promise<Json> {
  const { stack, author, showcase, community } = context;
  const created = await createPublishedThread(
    stack,
    author,
    community.boardId,
    showcase.workId,
    'Synchronous point erasure',
    'Author point that will be erased.',
  );
  const erased = requireStatus(
    await kernel(stack, 'POST', `/v1/posts/${created.postId}:erase`, {
      bearer: author.bearer,
      body: { reason: 'Content walk synchronous point erasure' },
    }),
    'point erasure',
  );
  const erasedRead = await kernel(stack, 'GET', `/v1/posts/${created.postId}`);
  if (
    erasedRead.status === 200 &&
    documentText((erasedRead.value.post as Json | undefined)?.body) === 'Author point that will be erased.'
  )
    throw new Error('erased post still disclosed its original body');
  return {
    postId: created.postId,
    erasure: publicFields(erased) as Json,
    read: erasedRead.status,
  };
}

async function walkAuthorErasure(context: WalkContext): Promise<Json> {
  const { stack, author, showcase, community } = context;
  if (!author.accountId) throw new Error('author account is required for bounded erasure');
  const created = await createPublishedThread(
    stack,
    author,
    community.boardId,
    showcase.workId,
    'Bounded author erasure walk',
    'This thread exists so author erasure can make bounded progress.',
  );
  const authorErasure = requireStatus(
    await kernel(stack, 'POST', `/v1/threads/${created.threadId}:erase`, {
      bearer: author.bearer,
      body: { authorId: author.accountId },
    }),
    'bounded author erasure',
    [202, 200],
  );
  return {
    threadId: created.threadId,
    authorErasure: publicFields(authorErasure) as Json,
  };
}

async function walkIndependentQueues(context: WalkContext): Promise<Json> {
  const { stack, developer, member, reviewer } = context;
  const anonymousDirectory = await kernel(stack, 'GET', '/v1/me/moderation-directory');
  const moderatorDirectory = await kernel(stack, 'GET', '/v1/me/moderation-directory', { bearer: developer.bearer });
  const memberDirectory = await kernel(stack, 'GET', '/v1/me/moderation-directory', { bearer: member.bearer });
  const reports = await kernel(stack, 'GET', '/v1/reports/me', { bearer: member.bearer, query: { limit: '20' } });
  const reviewerAppeals = reviewer.accountId
    ? await kernel(stack, 'GET', `/v1/threads/${context.community.threadId}/appeals`, {
        bearer: reviewer.bearer,
        query: { limit: '20' },
      })
    : { status: 0, value: {} };
  if (anonymousDirectory.status === 200)
    throw new Error('anonymous caller received the moderator directory; correct result withholds it');
  if (moderatorDirectory.status !== 200 && moderatorDirectory.status !== 404)
    throw new Error(`moderator directory HTTP ${moderatorDirectory.status}`);
  if (memberDirectory.status === 200 && moderatorDirectory.status === 200) {
    const memberState = memberDirectory.value.state ?? memberDirectory.value.code;
    const moderatorState = moderatorDirectory.value.state ?? moderatorDirectory.value.code;
    if (
      memberState === moderatorState &&
      JSON.stringify(memberDirectory.value) === JSON.stringify(moderatorDirectory.value)
    )
      throw new Error('member and moderator directory pages were identical; queues must stay independent');
  }
  return {
    anonymousDirectory: anonymousDirectory.status,
    moderatorDirectory: moderatorDirectory.status,
    memberDirectory: memberDirectory.status,
    reports: reports.status,
    reviewerAppeals: reviewerAppeals.status,
  };
}

async function signInThroughIssuer(page: import('playwright').Page, stack: Stack, email: string, password: string) {
  for (let attempt = 0; attempt < 4 && new URL(page.url()).origin === stack.issuer; attempt++) {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
    const emailField = page.locator('input[name="email"]');
    if ((await emailField.count()) > 0) {
      await emailField.fill(email);
      await page.locator('input[name="password"]').fill(password);
    }
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    if ((await submit.count()) > 0) await submit.click();
    else await page.locator('form button[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded');
    const approve = page.getByRole('button', { name: 'Approve' });
    if (await approve.isVisible({ timeout: 8_000 }).catch(() => false)) await approve.click();
  }
  await page.waitForURL((url) => url.origin === stack.web, { timeout: 180_000 });
}

async function walkBrowser(context: WalkContext, rows: RowResult[]): Promise<Json> {
  const require = createRequire(resolve(root, 'apps/web/package.json'));
  const { chromium } = require('playwright') as typeof import('playwright');
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
  const pages: Json[] = [];
  try {
    const anonymous = await browser.newContext({ locale: 'en-US' });
    const page = await anonymous.newPage();
    page.setDefaultTimeout(60_000);
    for (const visit of [
      { locale: 'en', width: 1440, theme: 'light' as const },
      { locale: 'en', width: 390, theme: 'dark' as const },
      { locale: 'zh-Hant', width: 1280, theme: 'light' as const },
      { locale: 'ja', width: 1440, theme: 'dark' as const },
    ]) {
      await page.setViewportSize({ width: visit.width, height: 1000 });
      await page.emulateMedia({ colorScheme: visit.theme });
      await page.context().addCookies([{ name: 'rezics_theme', value: visit.theme, url: context.stack.web }]);
      const href = `${context.stack.web}/${visit.locale}/threads/${context.community.threadId}`;
      const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
      pages.push({
        persona: 'anonymous',
        locale: visit.locale,
        width: visit.width,
        theme: visit.theme,
        status: response?.status() ?? null,
        path: new URL(page.url()).pathname,
        conversation: await page.locator('ol[id^="thread-"] > li').count(),
      });
      if ((response?.status() ?? 500) >= 400) throw new Error(`anonymous thread HTTP ${response?.status()}`);
    }
    await anonymous.close();

    const member = await browser.newContext({ locale: 'en-US' });
    const signed = await member.newPage();
    signed.setDefaultTimeout(90_000);
    await signed.goto(
      `${context.stack.web}/en/auth/sign-in?return_to=${encodeURIComponent(`/en/subjects/${context.showcase.workId}`)}`,
      {
        waitUntil: 'domcontentloaded',
        timeout: 180_000,
      },
    );
    await signInThroughIssuer(signed, context.stack, context.member.email, context.member.password);
    await signed.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
    const composer = `${context.stack.web}/en/boards/${context.community.boardId}/new?subject=${encodeURIComponent(context.showcase.workId)}&returnTo=${encodeURIComponent(`/en/subjects/${context.showcase.workId}`)}`;
    const compose = await signed.goto(composer, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await signed.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
    const heading = await signed.locator('h1').first().textContent();
    pages.push({
      persona: 'member',
      path: new URL(signed.url()).pathname,
      status: compose?.status() ?? null,
      heading,
      slowMode: await signed.locator('[data-slot="slow-mode"]').count(),
    });
    await member.close();

    const authorSession = await browser.newContext({ locale: 'en-US' });
    const inboxPage = await authorSession.newPage();
    inboxPage.setDefaultTimeout(90_000);
    await inboxPage.goto(`${context.stack.web}/en/auth/sign-in?return_to=${encodeURIComponent('/en/inbox')}`, {
      waitUntil: 'domcontentloaded',
      timeout: 180_000,
    });
    await signInThroughIssuer(inboxPage, context.stack, context.author.email, context.author.password);
    await inboxPage.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
    pages.push({
      persona: 'author',
      path: new URL(inboxPage.url()).pathname,
      heading: await inboxPage.locator('h1').first().textContent(),
      notices: await inboxPage.locator('main li, main article, [data-slot="inbox-item"]').count(),
    });
    await authorSession.close();
  } finally {
    await browser.close();
  }
  const browserRow = rows.find((row) => row.row === 'work-to-review');
  return { pages, workToReview: browserRow?.status ?? null };
}

async function writeRepairBrief(row: RowResult, revision: string): Promise<string | null> {
  if (row.status !== 'failing' || !row.defect) return null;
  const path = join(root, '.temp/continuation', `content-${row.row}.md`);
  await mkdir(join(root, '.temp/continuation'), { recursive: true });
  const owner = row.row === 'ratings-and-reviews' ? 'content/rating' : 'content';
  await writeFile(
    path,
    `# Repair ${row.row}

goal: content
manager: content
owner: ${owner}

Trigger: Content Goal seeded walk on ${revision}, row \`${row.row}\`, duration ${row.durationMs} ms.

Defect: ${row.defect}

Correct result: the named first-scope journey in docs/goals/content.capabilities.md for ${row.row} succeeds on the current seeded stack for the frozen personas, with native HTTP/API and browser receiving on the same identities.

Do not restart the walk until this repair lands. Implementation owners land on typing; this Goal walk rewalks the failing row after the repair.
`,
    { mode: 0o600 },
  );
  return path;
}

async function main(): Promise<void> {
  if (process.cwd() !== webRoot) {
    const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
      cwd: webRoot,
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    process.exit(await child.exited);
  }
  if (!process.env.GOAL_TASK_ID || !/native|browser/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
    throw new Error('The Content Goal walk runs on a walk stack whose brief lists native and browser acceptance');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  await retireDevelopmentSeedState(root);
  const kernelEnv = await kernelEnvironment();
  const databaseUrl = kernelEnv.DATABASE_URL;
  if (databaseUrl) await retireStaleSeedJournals(root, databaseUrl);
  if (!databaseUrl) throw new Error('KERNEL DATABASE_URL missing');
  const bootstrapStarted = Date.now();
  try {
    await waitUntilIdentityBootstrapRemainingZero(() => identityEpochBootstrapRemaining(databaseUrl));
  } catch (error) {
    // A pre-seed failure is not a failed product journey. Retain the worker's causal trace before teardown.
    const stackLog = join(root, '.temp/walk', process.env.GOAL_TASK_ID, 'stack.log');
    await writeFile(join(evidenceDir, 'bootstrap-stack.log'), publicStackLog(await readFile(stackLog, 'utf8')), {
      mode: 0o600,
    });
    await writeFile(
      join(evidenceDir, 'setup-failure.json'),
      `${JSON.stringify(
        {
          sourceRevision: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(),
          observedAt: new Date().toISOString(),
          installedRoot: process.env.REZICS_INSTALLED_ROOT ?? null,
          runtime: publicRuntime(),
          phase: 'identity-epoch-bootstrap',
          durationMs: Date.now() - bootstrapStarted,
          defect: error instanceof Error ? error.message : String(error),
          seed: 'not-started',
          personas: 'not-provisioned',
          rows: FIRST_SCOPE_ROWS.map((row) => ({ row, status: 'not-reached' })),
          stackLog: 'bootstrap-stack.log',
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    throw error;
  }
  if ((await runCommand(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'])) !== 0)
    throw new Error('Developer persona provisioning failed');
  const seedEnv = {
    ...process.env,
    ...(await parseEnvFile(join(root, '.temp/local-stack/seed.env'))),
    AUTH_ORIGIN: process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN,
    KERNEL_ORIGIN: process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN,
  };
  const seedCode = await withIssuerSeedProxy(() =>
    runCommand(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], seedEnv),
  );
  if (!(await Bun.file(seedResultPath).exists()))
    throw new Error(`Content Goal walk has no seed result after exit ${seedCode}`);
  const frontends = await startSeededFrontends();
  const stack = stackOrigins();
  await waitUntilWalkReady({
    urls: [`${stack.issuer}/.well-known/openid-configuration`, `${stack.web}/en`],
    children: [],
    deadlineMs: 20 * 60_000,
  });
  const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as { password: string };
  const bindings = await parseEnvFile(join(root, 'apps/web/.dev.vars'));
  const showcase = await readShowcase();
  const developerBearer = await websiteBearer(stack, 'developer@rezics.test', keys.password, bindings);
  const developer: Persona = {
    label: 'moderator',
    email: 'developer@rezics.test',
    password: keys.password,
    bearer: developerBearer,
    accountId: jwtAccountId(developerBearer),
  };
  const author = await registerPersona(stack, 'author', bindings);
  const member = await registerPersona(stack, 'member', bindings);
  const outsider = await registerPersona(stack, 'outsider', bindings);
  const banned = await registerPersona(stack, 'banned', bindings);
  const suspended = await registerPersona(stack, 'suspended', bindings);
  const reviewer = await registerPersona(stack, 'reviewer', bindings);
  const community = await provisionCommunity(stack, developer, showcase.workId);
  for (const person of [author, member, reviewer]) {
    const joined = await kernel(stack, 'POST', `/v1/realms/${community.realmId}/membership`, { bearer: person.bearer });
    if (joined.status !== 202 && joined.status !== 200 && joined.status !== 409)
      throw new Error(`${person.label} join returned HTTP ${joined.status}`);
    if (joined.status === 202 || joined.status === 200)
      await waitForMembership(stack, community.realmId, person.bearer);
  }
  const protectedBoardId = await createProtectedBoard(stack, developer);
  const context: WalkContext = {
    stack,
    developer,
    author,
    member,
    outsider,
    banned,
    suspended,
    reviewer,
    showcase,
    community,
    protectedBoardId,
  };
  const rows: RowResult[] = [];
  try {
    rows.push(await timedRow('threads-and-boards', () => walkThreadsAndBoards(context)));
    rows.push(await timedRow('exact-revisions', () => walkExactRevisions(context)));
    rows.push(await timedRow('board-paging', () => walkBoardPaging(context)));
    rows.push(await timedRow('container-disclosure', () => walkContainerDisclosure(context)));
    rows.push(await timedRow('late-revocation', () => walkLateRevocation(context)));
    rows.push(await timedRow('edit-history-return', () => walkEditHistoryReturn(context)));
    rows.push(await timedRow('watches-and-reactions', () => walkWatchesAndReactions(context)));
    rows.push(await timedRow('takedown-erasure', () => walkTakedownErasure(context)));
    rows.push(await timedRow('author-erasure', () => walkAuthorErasure(context)));
    rows.push(await timedRow('media', () => walkMedia(context)));
    rows.push(await timedRow('realms-and-spaces', () => walkRealmsAndSpaces(context)));
    rows.push(await timedRow('ratings-and-reviews', () => walkRatingsAndReviews(context)));
    rows.push(await timedRow('work-to-review', () => walkWorkToReview(context)));
    rows.push(await timedRow('moderation-reports-appeals', () => walkReports(context)));
    rows.push(await timedRow('notices', () => walkNotices(context)));
    rows.push(await timedRow('home-discovery', () => walkHomeDiscovery(context)));
    rows.push(await timedRow('independent-queues', () => walkIndependentQueues(context)));
    rows.push(await timedRow('persona-matrix', () => walkPersonaMatrix(context)));
    const browser = await walkBrowser(context, rows);
    const summary = summarizeWalk(rows);
    const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
    const briefs = (await Promise.all(rows.map((row) => writeRepairBrief(row, revision)))).filter(
      (path): path is string => path !== null,
    );
    const evidence = {
      sourceRevision: revision,
      seedExit: seedCode,
      installedRoot: process.env.REZICS_INSTALLED_ROOT ?? null,
      runtime: publicRuntime(),
      stack,
      personas: [
        'anonymous',
        'author',
        'member',
        'moderator',
        'reviewer',
        'banned',
        'suspended',
        'protected-non-member',
      ],
      showcase: publicFields(showcase),
      community: publicFields(community),
      rows: rows.map((row) => ({ ...row, observed: publicFields(row.observed) })),
      summary,
      browser,
      briefs,
    };
    await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(
      `content-goal-walk: ${summary.passing}/${summary.total} passing; slowest failure ${summary.slowestFailure ? `${summary.slowestFailure.row} ${summary.slowestFailure.durationMs}ms` : 'none'}`,
    );
    if (summary.slowestFailure) process.exitCode = 1;
  } finally {
    await frontends.stop();
  }
}

if (import.meta.main) await main();
