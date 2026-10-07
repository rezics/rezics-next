import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';
import type { Credentials, SeedEndpoints } from './api.ts';

/** The dev stack's first platform administrator, the only principal that may
 * open a group. The web client is kept apart from a step's narrower seed client. */
export interface SeedPlatformGrant {
  email: string;
  password: string;
  actingSubject: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  accessDatabaseUrl: string;
}

const groupName = /^[a-z][a-z0-9-]{0,63}$/;
const principalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentIri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

interface RouteExposure {
  length: number;
  pattern: RegExp;
  methods: Record<string, string>;
}

let routes: RouteExposure[] | undefined;

function exposureRoutes(): RouteExposure[] {
  if (routes) return routes;
  const document = JSON.parse(readFileSync(new URL(
    '../../../generated/openapi/main/public.json', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  routes = Object.entries(document.paths).map(([route, operations]) => ({
    length: route.length,
    pattern: new RegExp(`^${route.split('/').map(segment => segment.startsWith('{')
      ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`),
    methods: Object.fromEntries(Object.entries(operations).flatMap(([method, operation]) =>
      operation.operationId ? [[method.toLowerCase(), operation.operationId]] : [])),
  })).sort((left, right) => right.length - left.length);
  return routes;
}

/** The exposure of one Main call, from the generated operation table. A path
 * matches the longest route, so a literal segment wins over a parameter. */
export function seedCallExposure(method: string, path: string): string | undefined {
  const pathname = path.split('?')[0] ?? path;
  const operationId = exposureRoutes().find(route =>
    route.pattern.test(pathname) && route.methods[method.toLowerCase()])?.methods[method.toLowerCase()];
  if (!operationId || !(operationId in operationExposures)) return undefined;
  return operationExposures[operationId as PlatformOperationId];
}

/** Put the closed group on a platform_closed problem so a seed failure names
 * it. Any other response is left as Main sent it. */
export function nameClosedRefusal(method: string, path: string, status: number, detail: string): string {
  if (status !== 403) return detail;
  let body: { code?: string; title?: string };
  try { body = JSON.parse(detail) as { code?: string; title?: string }; }
  catch { return detail; }
  if (body.code !== 'platform_closed') return detail;
  const exposure = seedCallExposure(method, path);
  if (!exposure || exposure === 'public' || body.title?.includes(exposure)) return detail;
  return JSON.stringify({ ...body, title: `${body.title ?? 'This capability is closed'} (${exposure})` });
}

interface AccountIdentity { issuer: string; subject: string }
interface GrantRow {
  permission: string;
  active: boolean;
  validUntil: string | null;
  recipient: { principalId?: string };
}
interface GrantPage {
  authorityEpoch?: string | number;
  /** Current grant lists name the page `items`. A list that still says `grants` is the same page. */
  items?: GrantRow[];
  grants?: GrantRow[];
  nextCursor?: string | null;
  complete?: boolean;
}

/** Live platform:use grants on one page, keyed by principal and permission. */
export function livePlatformUses(body: GrantPage, now = Date.now()): Set<string> {
  const found = new Set<string>();
  for (const grant of body.items ?? body.grants ?? []) {
    const principalId = grant.recipient?.principalId;
    const until = grant.validUntil ? Date.parse(grant.validUntil) : Number.POSITIVE_INFINITY;
    if (grant.active && principalId && grant.permission.startsWith('platform:use:') && until > now) {
      found.add(`${principalId} ${grant.permission}`);
    }
  }
  return found;
}
interface AdminSession { token: string; cookie: string; actingSubject: string; main: string;
  issuedAt: number; api: { token(cookie: string): Promise<string> } }

let adminSession: AdminSession | null = null;
let heldUses: Set<string> | null = null;
const opened = new Set<string>();
let queue: Promise<void> = Promise.resolve();

function enqueue(work: () => Promise<void>): Promise<void> {
  const run = queue.then(work, work);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function tokenAccount(token: string): AccountIdentity | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString()) as { iss?: string; sub?: string };
    if (!claims.iss || !claims.sub) return null;
    return { issuer: claims.iss, subject: claims.sub };
  } catch { return null; }
}

/** The public grant API addresses an access principal. A seed account that has
 * never held one yet has no row; this records that identity only, never a permission. */
async function seedPrincipalId(databaseUrl: string, account: AccountIdentity): Promise<string> {
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Seed platform grants read a loopback Access database only');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const read = () => pool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active`, [account.issuer, account.subject]);
    const existing = await read();
    if (existing.rows[0]) return existing.rows[0].id;
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3) ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
    [randomUUID(), account.issuer, account.subject]);
    const created = await read();
    if (!created.rows[0]) throw new Error('Seed account has no access principal to open a platform group for');
    return created.rows[0].id;
  } finally { await pool.end(); }
}

/** A dataset bootstrap can be designated before the recorded member. That
 * designation stays put, so the member's grant page answers grant_denied.
 * These files are the local fixture for the account that then holds platform:grant. */
function datasetAdministrators(): { email: string; password: string }[] {
  let directory: string;
  try {
    const root = resolve(import.meta.dir, '../../..');
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8' }).trim();
    directory = join(dirname(common), '.temp/datasets');
  } catch { return []; }
  if (!existsSync(directory)) return [];
  const seen = new Set<string>();
  const found: { email: string; password: string }[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith('administrator-') || !name.endsWith('.json')) continue;
    let body: { email?: string; password?: string; name?: string };
    try { body = JSON.parse(readFileSync(join(directory, name), 'utf8')) as typeof body; }
    catch { continue; }
    if (body.name !== 'Local dataset administrator' || !body.email?.endsWith('@example.test') || !body.password
      || seen.has(body.email)) continue;
    seen.add(body.email);
    found.push({ email: body.email, password: body.password });
  }
  return found;
}

async function controlledAgent(databaseUrl: string, account: AccountIdentity): Promise<string | null> {
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Seed platform grants read a loopback Access database only');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{ subject_id: string }>(`SELECT r.subject_id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
        AND s.kind = 'agent' AND s.active
      ORDER BY r.id LIMIT 1`, [account.issuer, account.subject]);
    const actor = result.rows[0]?.subject_id;
    return actor && agentIri.test(actor) ? actor : null;
  } finally { await pool.end(); }
}

async function signGrantSession(endpoints: SeedEndpoints, grant: SeedPlatformGrant,
  email: string, password: string, actingSubject: string): Promise<AdminSession> {
  const { SeedApi } = await import('./api.ts');
  const api = new SeedApi({ ...endpoints, clientId: grant.clientId, redirectUri: grant.redirectUri,
    resource: grant.resource, scope: 'openid access:grant', platformGrant: undefined });
  const signed = await api.signInOrUp({ email, password } satisfies Credentials);
  return { api, token: await api.token(signed.cookie), cookie: signed.cookie, actingSubject,
    main: endpoints.main, issuedAt: Date.now() };
}

async function canGrant(session: AdminSession): Promise<boolean> {
  try {
    await grantPage(session);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('HTTP 403') && message.includes('grant_denied')) return false;
    throw error;
  }
}

async function administratorSession(endpoints: SeedEndpoints, grant: SeedPlatformGrant): Promise<AdminSession> {
  if (adminSession && Date.now() - adminSession.issuedAt < 120_000) return adminSession;
  if (adminSession) {
    try {
      adminSession.token = await adminSession.api.token(adminSession.cookie);
      adminSession.issuedAt = Date.now();
      return adminSession;
    } catch {
      // A long theme build can outlive the Account session. Sign in again.
      adminSession = null;
    }
  }
  const member = await signGrantSession(endpoints, grant, grant.email, grant.password, grant.actingSubject);
  if (await canGrant(member)) {
    adminSession = member;
    return member;
  }
  // The recorded member is the intended first administrator. A dataset bootstrap
  // can already hold the designation, and that designation is not moved.
  let lastDenial = 'grant_denied';
  for (const candidate of datasetAdministrators()) {
    try {
      const probe = await signGrantSession(endpoints, grant, candidate.email, candidate.password, grant.actingSubject);
      const account = tokenAccount(probe.token);
      const actor = account ? await controlledAgent(grant.accessDatabaseUrl, account) : null;
      if (!actor) {
        lastDenial = 'local dataset administrator has no live agent';
        continue;
      }
      probe.actingSubject = actor;
      if (!await canGrant(probe)) {
        lastDenial = 'local dataset administrator grant page was denied';
        continue;
      }
      console.log('Platform administrator: the recorded member cannot grant; a local dataset administrator holds platform:grant.');
      adminSession = probe;
      return probe;
    } catch (error) {
      lastDenial = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }
  }
  throw new Error(`Platform grant page failed with HTTP 403: {"code":"grant_denied","title":"Platform grant authority is missing"} (${lastDenial})`);
}

async function grantPage(session: AdminSession, after?: string): Promise<GrantPage> {
  const url = new URL('/v1/access/grants', session.main);
  url.searchParams.set('issuerSubject', session.actingSubject);
  url.searchParams.set('profile', 'platform-grants-v1');
  if (after) url.searchParams.set('after', after);
  const response = await fetch(url, { headers: { authorization: `Bearer ${session.token}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Platform grant page failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) as GrantPage : {};
}

async function held(session: AdminSession): Promise<Set<string>> {
  if (heldUses) return heldUses;
  const found = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 40; page++) {
    const body = await grantPage(session, after);
    for (const key of livePlatformUses(body)) found.add(key);
    if (body.complete === true || typeof body.nextCursor !== 'string') break;
    after = body.nextCursor;
  }
  heldUses = found;
  return found;
}

async function authorityEpoch(session: AdminSession): Promise<string> {
  const body = await grantPage(session);
  const epoch = body.authorityEpoch;
  if (epoch === undefined || epoch === null || !/^(0|[1-9][0-9]*)$/.test(String(epoch))) {
    throw new Error('Platform grant page has no authority epoch');
  }
  return String(epoch);
}

async function issue(session: AdminSession, principalId: string, permission: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const grantId = randomUUID();
    const response = await fetch(new URL('/v1/access/grant-changes', session.main), {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'platform-grant-change-v1', issuerSubject: session.actingSubject,
        expectedAuthorityEpoch: await authorityEpoch(session), action: 'create', grantId, permission,
        recipient: { principalId }, validUntil: null }),
    });
    const text = await response.text();
    if (response.ok) {
      const result = text ? JSON.parse(text) as { grant?: { id?: string } } : {};
      if (result.grant?.id !== grantId) throw new Error('Platform grant response did not confirm the issued grant');
      return;
    }
    // The epoch is read immediately before the write. One other change can still move it.
    if (attempt === 0 && response.status === 409 && text.includes('grant_stale')) continue;
    throw new Error(`Platform grant failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
}

/** Give the caller platform:use for one exposure group, unless that principal
 * already holds a live grant. A repeat seed therefore issues nothing. */
export async function openSeedPlatformGroup(endpoints: SeedEndpoints, token: string, group: string): Promise<void> {
  const grant = endpoints.platformGrant;
  const exposure = `platform:${group}`;
  if (!grant) return;
  if (!groupName.test(group)) throw new Error(`Seed platform group ${exposure} is not an exposure group`);
  const account = tokenAccount(token);
  if (!account) {
    throw new Error(`Seed call needs platform:use:${group} for ${exposure} and the caller token has no account subject`);
  }
  const principalId = await seedPrincipalId(grant.accessDatabaseUrl, account);
  if (!principalIdPattern.test(principalId)) throw new Error('Seed platform recipient must be a principal id');
  const permission = `platform:use:${group}`;
  const key = `${principalId} ${permission}`;
  await enqueue(async () => {
    if (opened.has(key)) return;
    try {
      if (!agentIri.test(grant.actingSubject)) throw new Error('Platform grant issuer is not an agent');
      const session = await administratorSession(endpoints, grant);
      if ((await held(session)).has(key)) {
        opened.add(key);
        console.log(`Platform ${group}: already open for account ${account.subject} (principal ${principalId}).`);
        return;
      }
      await issue(session, principalId, permission);
      heldUses?.add(key);
      opened.add(key);
      console.log(`Platform ${group}: opened for account ${account.subject} (principal ${principalId}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Seed platform group ${exposure} (platform:use:${group}) was not opened for account ${
        account.subject}: ${message}`);
    }
  });
}
