import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['openid'];
const pageLimit = '100';

// The website client's key, which only the Worker holds, and the issuer's signing key.
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = {
  challenge: string;
  nonce: string;
  redirectUri: string;
  scope: string;
  sub: string;
  expiresIn: number;
  idNonce?: string;
};
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const accessTokens: string[] = [];
const accessSubjects = new Map<string, string>();
let counter = 0;

const json = (body: unknown, status = 200, problem = false) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(problem ? { 'content-type': 'application/problem+json' } : {}),
    },
  });

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const stamp = '2026-04-02T15:04:05.000Z';
const subjectId = id(1);
const subject = { id: subjectId, label: 'Night watch', type: 'book' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimal = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const unitIdPattern = /^[A-Za-z0-9._:~-]{1,128}$/;

type Mode = 'scalar_amount' | 'cursor_position' | 'completed_units';
type Unit = 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
type ProgressState = 'active' | 'completed' | 'abandoned';
type Intent =
  | { amount: string }
  | { locator: string; position: string }
  | { add: string[] }
  | { remove: string[] }
  | { add: string[]; remove: string[] }
  | { action: 'complete' | 'abandon' };
type Change = { id: string; revision: number; intent: Intent; createdAt: string };
type ProgressSession = {
  id: string;
  subjectId: string;
  versionSubjectId: string | null;
  mode: Mode;
  unit: Unit;
  total: string | null;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: ProgressState;
  revision: number;
  startedAt: string;
  completedAt: string | null;
  units: string[];
  changes: Change[];
};
type Call = {
  method: string;
  path: string;
  view: string | null;
  limit: string | null;
  cursor: string | null;
  subjectId: string | null;
  accountId: string | null;
  authorization: string | null;
  key: string | null;
  body: unknown;
};
type PublishedLog = {
  id: string;
  accountId: string;
  subjectId: string;
  sessionState: ProgressState;
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
};

const subjects = new Map([[subjectId, subject]]);
const sessions = new Map<string, ProgressSession>();
const publishedLogs = new Map<string, PublishedLog>();
const calls: Call[] = [];
const replay = new Map<string, { status: number; body: unknown }>();
let gateClosed = false;
let nextSession = 80;

function problem(status: number, code: string) {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: status === 409 ? 'not_applied' : 'not_applicable',
    request_id: randomUUID(),
  };
}
function sessionView(item: ProgressSession, full: boolean) {
  return {
    id: item.id,
    subjectId: item.subjectId,
    versionSubjectId: item.versionSubjectId,
    mode: item.mode,
    unit: item.unit,
    total: item.total,
    amount: item.amount,
    locator: item.locator,
    position: item.position,
    completedUnitCount: item.completedUnitCount,
    state: item.state,
    revision: item.revision,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    ...(full
      ? {
          subject: subjects.get(item.subjectId) ?? null,
          versionSubject: item.versionSubjectId ? (subjects.get(item.versionSubjectId) ?? null) : null,
        }
      : {}),
  };
}
function makeSession(
  n: number,
  mode: Mode,
  unit: Unit,
  extras: { total?: string; amount?: string; revision?: number; change?: Intent } = {},
): ProgressSession {
  const item: ProgressSession = {
    id: id(n),
    subjectId,
    versionSubjectId: null,
    mode,
    unit,
    total: extras.total ?? null,
    amount: extras.amount ?? null,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision: extras.revision ?? 1,
    startedAt: stamp,
    completedAt: null,
    units: [],
    changes: [],
  };
  if (extras.change) {
    item.changes.push({
      id: `${item.id}:${item.revision}`,
      revision: item.revision,
      intent: extras.change,
      createdAt: stamp,
    });
  }
  return item;
}
function seed() {
  sessions.clear();
  sessions.set(id(20), makeSession(20, 'scalar_amount', 'page', { total: '200' }));
  sessions.set(id(21), makeSession(21, 'scalar_amount', 'minute', { total: '120' }));
  sessions.set(id(22), makeSession(22, 'completed_units', 'episode'));
  sessions.set(id(23), makeSession(23, 'scalar_amount', 'page', { amount: '4', revision: 2, change: { amount: '4' } }));
  sessions.set(id(24), makeSession(24, 'scalar_amount', 'page', { amount: '9', revision: 2, change: { amount: '9' } }));
}
function reset() {
  calls.length = 0;
  replay.clear();
  publishedLogs.clear();
  cursors.clear();
  cursorSerial = 0;
  gateClosed = false;
  nextSession = 80;
  seed();
}
function diverge(sessionId: string) {
  const item = sessions.get(sessionId);
  if (!item) throw new Error(`missing session ${sessionId}`);
  item.revision += 1;
}
function pageOf<T>(rows: T[], cursor: string | null, limit: number, key: string) {
  if (cursor === 'stale') return { stale: true as const };
  let offset = 0;
  if (cursor) {
    const saved = cursors.get(cursor);
    if (!saved || saved.key !== key) return { stale: true as const };
    offset = saved.offset;
  }
  const slice = rows.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  let next: string | null = null;
  if (nextOffset < rows.length) {
    next = `page${++cursorSerial}`;
    cursors.set(next, { key, offset: nextOffset });
  }
  return { stale: false as const, slice, next };
}
const cursors = new Map<string, { key: string; offset: number }>();
let cursorSerial = 0;

function sortedIds(values: string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
function unitList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !unitIdPattern.test(entry) || seen.has(entry)) return null;
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}
function remembered(key: string | null) {
  if (!key) return json(problem(400, 'invalid_request'), 400, true);
  const prior = replay.get(key);
  return prior ? json(prior.body, prior.status, prior.status >= 400) : null;
}
function remember(key: string, status: number, body: unknown) {
  replay.set(key, { status, body });
  return json(body, status, status >= 400);
}
function record(item: ProgressSession, body: Record<string, unknown>, key: string) {
  if (typeof body.revision !== 'number' || body.revision !== item.revision || item.state !== 'active') {
    return remember(key, 409, problem(409, 'conflict'));
  }
  const amount = Object.hasOwn(body, 'amount');
  const cursor = Object.hasOwn(body, 'locator') || Object.hasOwn(body, 'position');
  const units = Object.hasOwn(body, 'add') || Object.hasOwn(body, 'remove');
  const groups = [amount, cursor, units].filter(Boolean).length;
  let intent: Intent;
  if (groups !== 1) return remember(key, 400, problem(400, 'invalid_request'));
  if (item.mode === 'scalar_amount' && amount && typeof body.amount === 'string' && decimal.test(body.amount)) {
    if (item.unit === 'percent' && Number(body.amount) > 100)
      return remember(key, 400, problem(400, 'invalid_request'));
    item.amount = body.amount;
    intent = { amount: body.amount };
  } else if (
    item.mode === 'cursor_position' &&
    cursor &&
    typeof body.locator === 'string' &&
    body.locator.length > 0 &&
    body.locator.length <= 256 &&
    typeof body.position === 'string' &&
    decimal.test(body.position)
  ) {
    item.locator = body.locator;
    item.position = body.position;
    intent = { locator: body.locator, position: body.position };
  } else if (item.mode === 'completed_units' && units && !amount && !cursor) {
    const add = Object.hasOwn(body, 'add') ? unitList(body.add) : [];
    const remove = Object.hasOwn(body, 'remove') ? unitList(body.remove) : [];
    if (!add || !remove || add.length + remove.length > 100 || (add.length === 0 && remove.length === 0)) {
      return remember(key, 400, problem(400, 'invalid_request'));
    }
    const set = new Set(item.units);
    for (const unit of remove) set.delete(unit);
    for (const unit of add) set.add(unit);
    item.units = [...set].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    item.completedUnitCount = item.units.length;
    intent =
      add.length > 0 && remove.length > 0
        ? { add: sortedIds(add), remove: sortedIds(remove) }
        : add.length > 0
          ? { add: sortedIds(add) }
          : { remove: sortedIds(remove) };
  } else return remember(key, 400, problem(400, 'invalid_request'));
  // An amount, including elapsed minutes that meet the total, never changes the session state.
  item.revision += 1;
  item.changes.push({ id: `${item.id}:${item.revision}`, revision: item.revision, intent, createdAt: stamp });
  return remember(key, 200, { progressSession: sessionView(item, false) });
}
function transition(item: ProgressSession, body: Record<string, unknown>, key: string, action: 'complete' | 'abandon') {
  if (Object.keys(body).some((name) => name !== 'revision')) return remember(key, 400, problem(400, 'invalid_request'));
  if (typeof body.revision !== 'number' || body.revision !== item.revision || item.state !== 'active') {
    return remember(key, 409, problem(409, 'conflict'));
  }
  item.state = action === 'complete' ? 'completed' : 'abandoned';
  item.completedAt = action === 'complete' ? stamp : null;
  item.revision += 1;
  item.changes.push({
    id: `${item.id}:${item.revision}`,
    revision: item.revision,
    intent: { action },
    createdAt: stamp,
  });
  return remember(key, 200, { progressSession: sessionView(item, false) });
}

// OpenID provider copied from posting.test.ts; progress reads and writes use its access token.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure') return json({ admitted: ['reading_progress'] });
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const client = async (form: URLSearchParams) => {
      if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return false;
      try {
        // Auth's contract: the registered kid, iss = sub = the client, aud exactly the issuer, at most 120 seconds.
        const { payload, protectedHeader } = await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        if (
          protectedHeader.kid !== clientJwk.kid ||
          payload.aud !== issuer ||
          !payload.jti ||
          assertions.has(payload.jti) ||
          !payload.exp ||
          !payload.iat ||
          payload.exp - payload.iat > 120
        )
          return false;
        assertions.add(payload.jti);
        return true;
      } catch {
        return false;
      }
    };
    const issue = async (family: Family, nonce?: string) => {
      counter += 1;
      const access = `access-${counter}`;
      const refresh = `refresh-${counter}`;
      family.current = refresh;
      families.set(refresh, family);
      accessTokens.push(access);
      accessSubjects.set(access, family.sub);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (nonce !== undefined) {
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(family.sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      }
      return json(body);
    };

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await client(form))) return json({ error: 'invalid_client' }, 401);
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        return issue(
          { sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false },
          grant.idNonce ?? grant.nonce,
        );
      }
      if (form.get('grant_type') === 'refresh_token') {
        const family = families.get(form.get('refresh_token') ?? '');
        if (!family || family.revoked || family.current !== form.get('refresh_token')) {
          if (family) family.revoked = true;
          return json({ error: 'invalid_grant' }, 400);
        }
        return issue(family);
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await client(form))) return json({ error: 'invalid_client' }, 401);
      const family = families.get(form.get('token') ?? '');
      if (family) family.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    // Home readiness reads pages:read with no session. Unknown routes stay not found, like a hidden record.
    if (!url.pathname.startsWith('/v1/progressSessions') && !url.pathname.startsWith('/v1/publishedLogs'))
      return json(problem(404, 'not_found'), 404, true);
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.json().catch(() => null);
    calls.push({
      method: request.method,
      path: url.pathname,
      view: url.searchParams.get('view'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      subjectId: url.searchParams.get('subjectId'),
      accountId: url.searchParams.get('accountId'),
      authorization: request.headers.get('authorization'),
      key: request.headers.get('idempotency-key'),
      body,
    });
    const authorization = request.headers.get('authorization');
    const isLogRead = url.pathname.startsWith('/v1/publishedLogs') && request.method === 'GET';
    if (!isLogRead && !authorization?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (!url.pathname.startsWith('/v1/publishedLogs') && gateClosed)
      return json(problem(403, 'platform_closed'), 403, true);
    const full = url.searchParams.get('view') === 'FULL';
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;

    const fullLog = (item: PublishedLog) => ({
      ...item,
      ...(full
        ? {
            subject: subjects.get(item.subjectId) ?? null,
            account: { id: item.accountId, handle: `@${item.accountId}`, displayName: item.accountId },
          }
        : {}),
    });
    if (url.pathname === '/v1/publishedLogs' && request.method === 'GET') {
      const accountId = url.searchParams.get('accountId');
      if (!accountId) return json(problem(404, 'not_found'), 404, true);
      const rows = [...publishedLogs.values()]
        .filter((item) => item.accountId === accountId)
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
      const page = pageOf(rows, url.searchParams.get('cursor'), bounded, `publishedLogs:${accountId}`);
      if (page.stale) return json(problem(409, 'stale_cursor'), 409, true);
      return json({ publishedLogs: page.slice.map(fullLog), next: page.next });
    }
    const oneLog = /^\/v1\/publishedLogs\/([^/]+)$/.exec(url.pathname);
    if (oneLog && request.method === 'GET') {
      const item = publishedLogs.get(oneLog[1]!);
      return item ? json({ publishedLog: fullLog(item) }) : json(problem(404, 'not_found'), 404, true);
    }
    if (url.pathname === '/v1/publishedLogs' && request.method === 'POST') {
      const key = request.headers.get('idempotency-key');
      if (!key) return json(problem(400, 'invalid_request'), 400, true);
      const draft = body as { sessionId?: string; note?: string | null } | null;
      const item = draft?.sessionId ? sessions.get(draft.sessionId) : undefined;
      if (!item) return json(problem(404, 'not_found'), 404, true);
      const owner = authorization?.startsWith('Bearer ') ? accessSubjects.get(authorization.slice(7)) : undefined;
      if (!owner) return json(problem(401, 'authentication_required'), 401, true);
      const log: PublishedLog = {
        id: id(1000 + publishedLogs.size + 1),
        accountId: owner,
        subjectId: item.subjectId,
        sessionState: item.state,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        note: draft?.note?.trim() || null,
        publishedAt: `2026-05-01T00:00:${String(publishedLogs.size + 1).padStart(2, '0')}.000Z`,
      };
      publishedLogs.set(log.id, log);
      return json({ publishedLog: log }, 201);
    }
    if (oneLog && request.method === 'DELETE') {
      const item = publishedLogs.get(oneLog[1]!);
      if (!item) return json(problem(404, 'not_found'), 404, true);
      const owner = authorization?.startsWith('Bearer ') ? accessSubjects.get(authorization.slice(7)) : undefined;
      if (owner !== item.accountId) return json(problem(404, 'not_found'), 404, true);
      if (!request.headers.get('idempotency-key')) return json(problem(400, 'invalid_request'), 400, true);
      publishedLogs.delete(item.id);
      return json({ publishedLog: item });
    }

    if (url.pathname === '/v1/progressSessions' && request.method === 'POST') {
      const draft = body as { subjectId?: unknown; mode?: unknown; unit?: unknown; total?: unknown } | null;
      const key = request.headers.get('idempotency-key');
      const prior = remembered(key);
      if (prior) return prior;
      const mode = draft?.mode;
      const unit = draft?.unit;
      const modes = new Set(['scalar_amount', 'cursor_position', 'completed_units']);
      const units = new Set(['page', 'chapter', 'episode', 'volume', 'minute', 'percent']);
      if (
        !draft ||
        draft.subjectId !== subjectId ||
        typeof mode !== 'string' ||
        !modes.has(mode) ||
        typeof unit !== 'string' ||
        !units.has(unit) ||
        (draft.total !== undefined && mode !== 'scalar_amount') ||
        (typeof draft.total === 'string' && !decimal.test(draft.total))
      )
        return remember(key!, 400, problem(400, 'invalid_request'));
      const item = makeSession(nextSession++, mode as Mode, unit as Unit, {
        ...(typeof draft.total === 'string' ? { total: draft.total } : {}),
      });
      item.startedAt = `2026-05-01T00:00:${String(nextSession).padStart(2, '0')}.000Z`;
      sessions.set(item.id, item);
      return remember(key!, 201, { progressSession: sessionView(item, false) });
    }
    if (url.pathname === '/v1/progressSessions' && request.method === 'GET') {
      const owner = url.searchParams.get('subjectId');
      if (!owner || !subjects.has(owner)) return json(problem(404, 'not_found'), 404, true);
      const rows = [...sessions.values()]
        .filter((item) => item.subjectId === owner)
        .sort((left, right) => (left.startedAt < right.startedAt ? 1 : left.startedAt > right.startedAt ? -1 : 0));
      const page = pageOf(rows, url.searchParams.get('cursor'), bounded, `sessions:${owner}`);
      if (page.stale) return json(problem(409, 'stale_cursor'), 409, true);
      return json({ progressSessions: page.slice.map((item) => sessionView(item, full)), next: page.next });
    }
    const action = /^\/v1\/progressSessions\/([^/]+):(record|complete|abandon)$/.exec(url.pathname);
    if (action && request.method === 'POST') {
      const item = sessions.get(action[1]!);
      if (!item) return json(problem(404, 'not_found'), 404, true);
      const key = request.headers.get('idempotency-key');
      const prior = remembered(key);
      if (prior) return prior;
      const payload = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      if (action[2] === 'record') return record(item, payload, key!);
      return transition(item, payload, key!, action[2] as 'complete' | 'abandon');
    }
    const child = /^\/v1\/progressSessions\/([^/]+)\/(completedUnits|changes)$/.exec(url.pathname);
    if (child && request.method === 'GET') {
      const item = sessions.get(child[1]!);
      if (!item) return json(problem(404, 'not_found'), 404, true);
      if (child[2] === 'completedUnits') {
        const page = pageOf(item.units, url.searchParams.get('cursor'), bounded, `units:${item.id}`);
        if (page.stale) return json(problem(409, 'stale_cursor'), 409, true);
        return json({ completedUnits: page.slice, next: page.next });
      }
      const page = pageOf(item.changes, url.searchParams.get('cursor'), bounded, `changes:${item.id}`);
      if (page.stale) return json(problem(409, 'stale_cursor'), 409, true);
      return json({ changes: page.slice, next: page.next });
    }
    const one = /^\/v1\/progressSessions\/([^/]+)$/.exec(url.pathname);
    if (one && request.method === 'GET') {
      const item = sessions.get(one[1]!);
      if (!item) return json(problem(404, 'not_found'), 404, true);
      return json({ progressSession: sessionView(item, full) });
    }
    return json(problem(404, 'not_found'), 404, true);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;

// The documented command, pointed at the fake through the environment it reads in development.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) {
          browser ??= await chromium.launch();
          const context = await browser.newContext({ javaScriptEnabled: true });
          try {
            const page = await context.newPage();
            for (const path of [`/en/library/progress?subjectId=${subjectId}`, `/en/library/progress/${id(20)}`]) {
              for (let attempt = 0; ; attempt += 1) {
                try {
                  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
                  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
                  break;
                } catch (error) {
                  if (attempt >= 1) throw error;
                }
              }
            }
          } finally {
            await context.close();
          }
          return origin;
        }
      } catch {
        // The dev server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

const setCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) =>
  setCookie(response, name)
    ?.split(';')[0]
    ?.slice(name.length + 1);

// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the session cookie.
async function signIn(returnTo = '/en', sub = 'alice') {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location')!);
  const params = location.searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub,
    expiresIn: 3600,
  });
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303], 'OpenID callback setup').toContain(answer.status);
  const sessionCookie = cookieValue(answer, session);
  expect(sessionCookie, 'signed-in session setup').toBeTruthy();
  return { cookie: sessionCookie!, access: accessTokens.at(-1)! };
}

let browser: Browser | undefined;
const people = new Map<string, Promise<{ cookie: string; access: string }>>();
async function open(path: string, sub = 'alice'): Promise<{ page: Page; access: string }> {
  let person = people.get(sub);
  if (!person) {
    person = signIn(path, sub);
    people.set(sub, person);
  }
  const auth = await person;
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: true,
  });
  await context.addCookies([
    {
      name: session,
      value: auth.cookie,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await hydrated(page);
  return { page, access: auth.access };
}
async function openAnonymous(path: string): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await hydrated(page);
  return page;
}
async function hydrated(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}
afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The dev server has already exited.
    }
});

const writesTo = (path: string) => calls.filter((call) => call.path === path && call.method !== 'GET');
const logListReads = () => calls.filter((call) => call.method === 'GET' && call.path === '/v1/publishedLogs');

function seedLogs(count: number) {
  publishedLogs.clear();
  for (let index = 0; index < count; index += 1) {
    const publishedAt = new Date(Date.parse(stamp) + index * 60_000).toISOString();
    const log: PublishedLog = {
      id: id(200 + index),
      accountId: 'alice',
      subjectId,
      sessionState: index % 2 === 0 ? 'active' : 'completed',
      startedAt: stamp,
      completedAt: index % 2 === 0 ? null : publishedAt,
      note: `Published log ${String(index + 1).padStart(3, '0')}`,
      publishedAt,
    };
    publishedLogs.set(log.id, log);
  }
}

test(
  'a person publishes a log from their session with an optional note, and anyone can read it',
  async () => {
    reset();
    const sessionId = id(20);
    const { page } = await open(`/en/library/progress/${sessionId}`);
    try {
      await page.getByRole('textbox', { name: 'Publish note', exact: true }).fill('A public reading milestone');
      await page.getByRole('button', { name: 'Publish log', exact: true }).click();
      await page.waitForURL(/\/en\/logs\//);
      const logId = new URL(page.url()).pathname.split('/').at(-1)!;
      expect(publishedLogs.get(logId)).toMatchObject({
        accountId: 'alice',
        subjectId,
        sessionState: 'active',
        startedAt: stamp,
        completedAt: null,
        note: 'A public reading milestone',
      });
      expect(writesTo('/v1/publishedLogs')).toHaveLength(1);
      expect(writesTo('/v1/publishedLogs')[0]).toMatchObject({
        body: { sessionId, note: 'A public reading milestone' },
        authorization: expect.stringMatching(/^Bearer access-/),
        key: expect.stringMatching(uuid),
      });

      const anonymous = await openAnonymous(`/en/logs/${logId}`);
      try {
        const content = await anonymous.locator('main').innerText();
        expect(content).toContain('alice');
        expect(content).toContain('Night watch');
        expect(content).toContain('Active');
        expect(content).toContain('A public reading milestone');
        const times = await anonymous
          .locator('time')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime')));
        expect(times).toContain(stamp);
        const read = calls.find(
          (call) => call.method === 'GET' && call.path === `/v1/publishedLogs/${logId}` && call.authorization === null,
        );
        expect(read).toMatchObject({ view: 'FULL', authorization: null });
      } finally {
        await anonymous.context().close();
      }
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a published log does not change when its session changes later',
  async () => {
    reset();
    const sessionId = id(20);
    const { page } = await open(`/en/library/progress/${sessionId}`);
    try {
      await page.getByRole('button', { name: 'Publish log', exact: true }).click();
      await page.waitForURL(/\/en\/logs\//);
      const logId = new URL(page.url()).pathname.split('/').at(-1)!;
      const saved = publishedLogs.get(logId)!;
      const current = sessions.get(sessionId)!;
      current.state = 'completed';
      current.completedAt = '2026-06-01T00:00:00.000Z';
      current.startedAt = '2026-01-01T00:00:00.000Z';
      current.amount = '200';
      current.revision += 1;

      const anonymous = await openAnonymous(`/en/logs/${logId}`);
      try {
        const content = await anonymous.locator('main').innerText();
        expect(content).toContain('Active');
        expect(content).not.toContain('Completed');
        const times = await anonymous
          .locator('time')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime')));
        expect(times).toContain(stamp);
        expect(times).not.toContain('2026-06-01T00:00:00.000Z');
        expect(publishedLogs.get(logId)).toEqual(saved);
      } finally {
        await anonymous.context().close();
      }
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'only its owner can delete a log',
  async () => {
    reset();
    const { page: author } = await open(`/en/library/progress/${id(20)}`);
    let logId = '';
    try {
      await author.getByRole('button', { name: 'Publish log', exact: true }).click();
      await author.waitForURL(/\/en\/logs\//);
      logId = new URL(author.url()).pathname.split('/').at(-1)!;
    } finally {
      await author.context().close();
    }

    const { page: visitor, access: visitorAccess } = await open(`/en/logs/${logId}`, 'bob');
    try {
      expect(await visitor.getByRole('button', { name: 'Delete log', exact: true }).count()).toBe(0);
      const denied = await fetch(`${fake.url.origin}/v1/publishedLogs/${logId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${visitorAccess}`, 'idempotency-key': crypto.randomUUID() },
      });
      expect(denied.status).toBe(404);
      expect(publishedLogs.has(logId)).toBe(true);
    } finally {
      await visitor.context().close();
    }

    const { page: owner } = await open(`/en/logs/${logId}`, 'alice');
    try {
      const beforeOwnerDelete = writesTo(`/v1/publishedLogs/${logId}`).length;
      await owner.getByRole('button', { name: 'Delete log', exact: true }).click();
      expect(writesTo(`/v1/publishedLogs/${logId}`)).toHaveLength(beforeOwnerDelete);
      await owner.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await owner.getByText('This log has been deleted.', { exact: true }).waitFor();
      const deletion = writesTo(`/v1/publishedLogs/${logId}`);
      expect(deletion).toHaveLength(beforeOwnerDelete + 1);
      expect(deletion.at(-1)?.key).toMatch(uuid);
      expect(publishedLogs.has(logId)).toBe(false);
    } finally {
      await owner.context().close();
    }
  },
  timeout,
);

test(
  "a person's published logs are listed newest first, paged",
  async () => {
    reset();
    seedLogs(101);
    const { page } = await open(`/en/library/progress/${id(20)}`);
    try {
      const list = page.getByRole('region', { name: 'Published logs', exact: true });
      await list.getByText('Published log 101', { exact: true }).waitFor();
      await list.getByText('Published log 002', { exact: true }).waitFor();
      expect(await list.getByText('Published log 001', { exact: true }).count()).toBe(0);
      const firstPageContent = await list.innerText();
      expect(firstPageContent.indexOf('Published log 101')).toBeLessThan(firstPageContent.indexOf('Published log 002'));
      let read = logListReads().at(-1)!;
      expect(read).toMatchObject({
        view: 'FULL',
        limit: pageLimit,
        authorization: expect.stringMatching(/^Bearer /),
        accountId: 'alice',
        cursor: null,
      });

      await list.getByRole('link', { name: 'More published logs', exact: true }).click();
      await list.getByText('Published log 001', { exact: true }).waitFor();
      read = logListReads().at(-1)!;
      expect(read?.cursor).toBeTruthy();
      expect(read?.limit).toBe(pageLimit);
      expect(logListReads()).toHaveLength(2);
      expect(await list.getByText('Published log 101', { exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
