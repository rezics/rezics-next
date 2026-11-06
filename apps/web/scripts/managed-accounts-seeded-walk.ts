/**
 * Organization and software-account lifecycle walk. Runs inside `dev-stack.ts walk`.
 * Extra personas use public signup and membership; it never precomputes authority.
 * Catalogue seed is not consumed: these operations do not use catalogue identities,
 * and the import exceeds the check memory cap when composed with the walk stack.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AUTH_MANAGEMENT_CLIENT_ID,
  AUTH_MANAGEMENT_SCOPES,
  AUTH_PAGE_OPERATION_CLIENT_ID,
  AUTH_PAGE_OPERATION_SCOPES,
} from '@rezics/auth-contract';

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/accounts');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const password = 'walk persona password with enough entropy 32';
const softwarePassword = 'software actor password with enough entropy 32';
const turnstile = 'rezics-local-signup';

type Json = Record<string, unknown>;
type Origins = { web: string; issuer: string; native: string; kernel: string };
type Person = { handle: string; email: string; accountId: string };
type Session = { accountId: string; cookie: string; clientId: string; scopes: string[] };
type Evidence = {
  sourceRevision: string;
  stack: Origins;
  seed: { path: string; exit: number | null; skipped: string };
  personas: string[];
  sequence: string[];
  native: Json[];
  pages: Json[];
  defects: string[];
};

function origin(variable: string, fallback: string): string {
  const value = process.env[variable];
  if (value === undefined) return fallback;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error(`${variable} must be an unauthenticated loopback HTTP origin`);
  return url.origin;
}

function origins(): Origins {
  return {
    web: origin('REZICS_LOCAL_STACK_WEB_ORIGIN', 'http://127.0.0.1:3000'),
    issuer: origin('REZICS_LOCAL_STACK_ISSUER_ORIGIN', 'http://127.0.0.1:4200'),
    native: origin('REZICS_LOCAL_STACK_NATIVE_ORIGIN', 'http://127.0.0.1:3100'),
    kernel: origin('REZICS_LOCAL_STACK_KERNEL_ORIGIN', 'http://127.0.0.1:4100'),
  };
}

function publicFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 24).map(publicFields);
  if (!value || typeof value !== 'object') return value;
  const output: Json = {};
  for (const [key, field] of Object.entries(value as Json)) {
    if (/token|password|cookie|authorization|secret|credential/i.test(key)) continue;
    output[key] = publicFields(field);
  }
  return output;
}

function cookieHeader(response: Response, previous = ''): string {
  const next = new Map(
    previous
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), part.slice(index + 1)] as const;
      }),
  );
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!;
    const index = pair.indexOf('=');
    if (index > 0) next.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...next].map(([name, value]) => `${name}=${value}`).join('; ');
}

function routeOf(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(20, 24), 16);
}

function handle(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (!match?.groups) continue;
    values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function run(command: string[]): Promise<number> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}`);
  return code;
}

async function send(
  url: string,
  init: {
    method?: string;
    cookie?: string;
    body?: unknown;
    origin?: string;
    timeout?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; value: Json; cookie: string; raw: string }> {
  const response = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    signal: AbortSignal.timeout(init.timeout ?? (init.method === 'GET' || init.body === undefined ? 30_000 : 5_000)),
    redirect: 'manual',
    headers: {
      ...(init.origin ? { origin: init.origin } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const raw = await response.text();
  let value: Json = {};
  if (raw) {
    try {
      value = JSON.parse(raw) as Json;
    } catch {
      value = { text: raw.slice(0, 240) };
    }
  }
  return { status: response.status, value, cookie: cookieHeader(response, init.cookie), raw };
}

function requireStatus(result: { status: number; value: Json }, label: string, expected: number | number[]): Json {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.status))
    throw new Error(`${label} returned HTTP ${result.status}: ${JSON.stringify(publicFields(result.value))}`);
  return result.value;
}

function asId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`${label} is not a native identity`);
  return value;
}

async function kernel(
  stack: Origins,
  method: string,
  path: string,
  options: { bearer?: string; body?: unknown; query?: Record<string, string> } = {},
) {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  return send(url.href, {
    method,
    timeout: 30_000,
    headers: {
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

async function auth(
  stack: Origins,
  path: string,
  session: Session | undefined,
  body: unknown,
  timeout = 5_000,
) {
  return send(`${stack.issuer}${path}`, {
    method: 'POST',
    origin: stack.issuer,
    cookie: session?.cookie,
    body,
    timeout,
  });
}

async function signup(stack: Origins, tag: string): Promise<Person> {
  const name = handle(tag);
  const result = await auth(
    stack,
    '/signup',
    undefined,
    {
      key: crypto.randomUUID(),
      handle: name,
      email: `${name}@example.test`,
      password,
      turnstile_token: turnstile,
    },
    30_000,
  );
  requireStatus(result, `signup ${tag}`, 201);
  return { handle: name, email: `${name}@example.test`, accountId: asId(result.value.accountId, `${tag} account`) };
}

async function signIn(
  stack: Origins,
  person: Pick<Person, 'email'>,
  clientId: string,
  scopes: readonly string[],
  secret = password,
): Promise<Session> {
  const result = await auth(
    stack,
    '/signin',
    undefined,
    {
      email: person.email,
      password: secret,
      client_id: clientId,
      scope: [...scopes],
    },
    30_000,
  );
  requireStatus(result, `signin ${clientId}`, 200);
  return {
    accountId: asId(result.value.account_id, 'session account'),
    cookie: result.cookie,
    clientId,
    scopes: [...scopes],
  };
}

async function websiteToken(stack: Origins, person: Pick<Person, 'email'>, bindings: Record<string, string>) {
  const session = await signIn(stack, person, bindings.WEBSITE_CLIENT_ID ?? 'rezics-website', [
    ...(bindings.WEBSITE_SCOPES ?? '').split(' ').filter(Boolean),
  ]);
  const token = await auth(stack, '/token', session, {}, 30_000);
  requireStatus(token, 'website token', 200);
  if (typeof token.value.access_token !== 'string') throw new Error('website token omitted access_token');
  return { session, bearer: token.value.access_token };
}

async function operate(
  stack: Origins,
  session: Session,
  operation: Json,
  extra: Json = {},
): Promise<{ status: number; value: Json }> {
  const operationKey = crypto.randomUUID();
  const body = { operationKey, operation, accountId: session.accountId, ...extra };
  const approval = await auth(stack, '/account-operations/approve', session, body);
  if (approval.status !== 200) return approval;
  if (operation.kind === 'transfer-acceptance' || operation.kind === 'opening') return approval;
  return auth(stack, '/account-operations/execute', session, {
    ...body,
    reference: approval.value.reference,
  });
}

async function credentialEffect(
  stack: Origins,
  session: Session,
  subjectId: string,
  credential: Json,
): Promise<{ status: number; value: Json }> {
  const staged = await auth(stack, '/credential-effects/stage', session, {
    key: crypto.randomUUID(),
    subjectId,
    credential,
  });
  if (staged.status !== 200) return staged;
  const approval = await auth(stack, '/credential-effects/approve', session, staged.value);
  if (approval.status !== 200) return approval;
  return auth(stack, '/credential-effects/apply', session, {
    ...staged.value,
    reference: approval.value.reference,
  });
}

function loopbackOnly(route: import('playwright').Route) {
  const url = new URL(route.request().url());
  return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
}

async function settle(page: import('playwright').Page, url: string) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return response;
}

async function fillPasswordSignIn(page: import('playwright').Page, email: string, secret: string) {
  await page.getByLabel(/email/i).fill(email);
  await page.locator('input[name="password"]').fill(secret);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signInAuthPage(
  page: import('playwright').Page,
  stack: Origins,
  email: string,
  secret: string,
): Promise<void> {
  await settle(page, `${stack.issuer}/login`);
  if (await page.getByLabel(/email/i).count()) await fillPasswordSignIn(page, email, secret);
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 60_000 }).catch(() => {});
}

async function signInWebsitePage(
  page: import('playwright').Page,
  stack: Origins,
  email: string,
  secret: string,
): Promise<void> {
  await settle(page, `${stack.web}/en/accounts`);
  if (page.url().includes('/accounts') && (await page.locator('h1').count())) return;
  const login = page.locator('a[href^="/auth/sign-in"], a[href*="/login"]').first();
  if (await login.count()) await login.click();
  await page.waitForURL('**/login**', { timeout: 60_000 });
  await fillPasswordSignIn(page, email, secret);
  const approve = page.getByRole('button', { name: 'Approve' });
  if (await approve.isVisible({ timeout: 8_000 }).catch(() => false)) await approve.click();
  await page.waitForURL(`${stack.web}/**`, { timeout: 120_000 });
}

if (!process.env.GOAL_TASK_ID || !/native|browser/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
  throw new Error('This walk runs on a controller-owned walk stack with native and browser acceptance');

const sourceRevision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
const stack = origins();
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const evidence: Evidence = {
  sourceRevision,
  stack,
  seed: {
    path: '.temp/cross-media-seed/result.json',
    exit: null,
    skipped: 'catalogue seed omitted; account operations do not consume catalogue identities',
  },
  personas: [
    'ordinary-human',
    'organization-owner',
    'delegated-member',
    'nondelegated-member',
    'automated-operator',
    'outsider',
  ],
  sequence: [],
  native: [],
  pages: [],
  defects: [],
};

await run(['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
evidence.sequence.push('persona');
const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as {
  password: string;
};
const developer: Person = {
  handle: 'developer',
  email: 'developer@rezics.test',
  accountId: '',
};
const developerPassword = keys.password;
const bindings = await parseEnv(join(root, 'apps/web/.dev.vars'));

async function developerSignIn(clientId: string, scopes: readonly string[]): Promise<Session> {
  const result = await auth(
    stack,
    '/signin',
    undefined,
    {
      email: developer.email,
      password: developerPassword,
      client_id: clientId,
      scope: [...scopes],
    },
    30_000,
  );
  requireStatus(result, `developer ${clientId}`, 200);
  developer.accountId = asId(result.value.account_id, 'developer');
  return {
    accountId: developer.accountId,
    cookie: result.cookie,
    clientId,
    scopes: [...scopes],
  };
}

const website = await (async () => {
  const session = await developerSignIn(bindings.WEBSITE_CLIENT_ID ?? 'rezics-website', [
    ...(bindings.WEBSITE_SCOPES ?? '').split(' ').filter(Boolean),
  ]);
  const token = await auth(stack, '/token', session, {}, 30_000);
  requireStatus(token, 'developer website token', 200);
  return { session, bearer: token.value.access_token as string };
})();
evidence.native.push({ developer: developer.accountId });
evidence.sequence.push('developer-token');

const opened = await kernel(stack, 'POST', '/v1/platform/exposure/organizations:open', {
  bearer: website.bearer,
  body: {},
});
if (![200, 409].includes(opened.status))
  evidence.defects.push(`organizations exposure open HTTP ${opened.status}`);

const operations = await developerSignIn(AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES.organization);
const orgHandle = handle('org');
const createdOrg = await operate(stack, operations, { kind: 'organization', handle: orgHandle });
if (createdOrg.status !== 200) {
  evidence.defects.push(`organization create HTTP ${createdOrg.status}`);
  throw new Error(`organization create HTTP ${createdOrg.status}: ${JSON.stringify(publicFields(createdOrg.value))}`);
}
const organizationId = asId(createdOrg.value.accountId, 'organization');
evidence.native.push({ organizationId, handle: orgHandle });
evidence.sequence.push('organization-create');

const publicOrg = requireStatus(
  await kernel(stack, 'GET', '/v1/accounts', { query: { handle: orgHandle } }),
  'public organization',
  200,
);
const orgRow = Array.isArray(publicOrg.accounts) ? (publicOrg.accounts[0] as Json | undefined) : undefined;
if (!orgRow || orgRow.kind !== 'organization' || orgRow.id !== organizationId)
  evidence.defects.push('public organization identity mismatch');
if (orgRow && ('email' in orgRow || 'credentials' in orgRow))
  evidence.defects.push('public organization disclosed private fields');

const delegated = await signup(stack, 'del');
const member = await signup(stack, 'mem');
const outsider = await signup(stack, 'out');
const dest = await signup(stack, 'dst');
evidence.native.push({
  delegated: delegated.accountId,
  member: member.accountId,
  outsider: outsider.accountId,
  destination: dest.accountId,
});
evidence.sequence.push('extra-personas');

const membershipSession = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.membership);
async function addMember(person: Person, role: 'owner' | 'member') {
  const result = await operate(stack, membershipSession, {
    kind: 'membership',
    organizationId,
    memberAccountId: person.accountId,
    role,
  });
  if (result.status !== 200) evidence.defects.push(`membership ${person.handle} HTTP ${result.status}`);
  return result;
}
await addMember(delegated, 'member');
await addMember(member, 'member');
evidence.sequence.push('named-membership');

const roster: Person[] = [];
for (let index = 0; index < 20; index += 1) {
  const person = await signup(stack, 'r');
  roster.push(person);
  await addMember(person, 'member');
}
evidence.native.push({ roster: roster.length });
evidence.sequence.push('twenty-row-roster');

const rosterPage = await auth(stack, '/account-management/organizations/page', membershipSession, {
  organizationId,
});
if (rosterPage.status === 200) {
  const items = ((rosterPage.value.members as Json | undefined)?.items ?? []) as Json[];
  const leave = (rosterPage.value.viewer as Json | undefined)?.leave ?? null;
  evidence.native.push({
    membershipPage: {
      status: rosterPage.status,
      count: items.length,
      next: Boolean((rosterPage.value.members as Json | undefined)?.next),
      leave,
    },
  });
  if (items.length !== 20) evidence.defects.push(`membership page roster length ${items.length}`);
  if (!(rosterPage.value.members as Json | undefined)?.next)
    evidence.defects.push('membership page omitted roster next');
  if (leave !== 'unavailable') evidence.defects.push(`sole-owner leave advice ${String(leave)}`);
  const ownerRow = items.find((row) => (row as Json).accountId === developer.accountId) as Json | undefined;
  const ownerActions = ownerRow?.actions as Json | undefined;
  if (
    ownerActions &&
    (ownerActions.changeRole !== 'last-owner' || ownerActions.remove !== 'last-owner')
  )
    evidence.defects.push('sole-owner row omitted last-owner advice');
  if (JSON.stringify(rosterPage.value).includes('account:read'))
    evidence.defects.push('membership roster mentioned account:read');
} else evidence.defects.push(`membership page HTTP ${rosterPage.status}`);

async function selectedMembership(person: Person) {
  return auth(stack, '/account-management/organizations/member', membershipSession, {
    organizationId,
    memberAccountId: person.accountId,
  });
}
const delegatedSelected = await selectedMembership(delegated);
if (delegatedSelected.status !== 200) evidence.defects.push(`selected delegated HTTP ${delegatedSelected.status}`);
else {
  const membership = delegatedSelected.value.membership as Json | undefined;
  evidence.native.push({
    selectedMember: {
      status: delegatedSelected.status,
      role: membership?.role ?? null,
      reservation: Boolean(membership?.reservationId),
    },
  });
  if (typeof membership?.reservationId !== 'string')
    evidence.defects.push('selected member omitted reservation');
  else {
    const promoted = await operate(stack, membershipSession, {
      kind: 'membership',
      organizationId,
      memberAccountId: delegated.accountId,
      role: 'owner',
      reservationId: membership.reservationId,
    });
    if (promoted.status !== 200) evidence.defects.push(`delegated role change HTTP ${promoted.status}`);
  }
}
const removable = roster[0];
if (removable) {
  const current = await selectedMembership(removable);
  const reservation = (current.value.membership as Json | undefined)?.reservationId;
  if (current.status !== 200 || typeof reservation !== 'string')
    evidence.defects.push(`selected roster member HTTP ${current.status}`);
  else {
    const removed = await operate(stack, membershipSession, {
      kind: 'membership',
      organizationId,
      memberAccountId: removable.accountId,
      role: null,
      reservationId: reservation,
    });
    if (removed.status !== 200) evidence.defects.push(`roster remove HTTP ${removed.status}`);
    else await addMember(removable, 'member');
  }
}
evidence.sequence.push('roster-selected-roles');

const manageGrant = await kernel(stack, 'POST', '/v1/grants', {
  bearer: website.bearer,
  body: {
    resource: { route: routeOf(organizationId), id: organizationId },
    subject: { kind: 'account', id: delegated.accountId },
    actions: ['account:manage'],
    valid: '(,)',
  },
});
if (![201, 409].includes(manageGrant.status))
  evidence.native.push({ delegatedGrant: manageGrant.status });
evidence.sequence.push('delegated-manage');

const management = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.transfer);
const humanSoftwareHandle = handle('bot');
const orgSoftwareHandle = handle('svc');
async function createSoftware(operatorAccountId: string, softwareHandle: string, label: string) {
  const operationKey = crypto.randomUUID();
  const operation = {
    kind: 'automated',
    registrationId: '',
    operationKey,
    operatorAccountId,
    handle: softwareHandle,
  };
  const approval = await auth(stack, '/account-operations/approve', management, {
    operationKey,
    operation,
    accountId: management.accountId,
  });
  if (approval.status !== 200) {
    evidence.defects.push(`${label} approval HTTP ${approval.status}`);
    return approval;
  }
  return auth(stack, '/account-operations/execute', management, {
    operationKey,
    operation,
    accountId: management.accountId,
    reference: approval.value.reference,
  });
}
const humanSoftwareDraft = await createSoftware(developer.accountId, humanSoftwareHandle, 'human software');
if (humanSoftwareDraft.status !== 200)
  evidence.defects.push(`human software create HTTP ${humanSoftwareDraft.status}`);
const humanSoftwareId =
  humanSoftwareDraft.status === 200 ? asId(humanSoftwareDraft.value.accountId, 'human software') : '';
const orgSoftwareDraft = await createSoftware(organizationId, orgSoftwareHandle, 'organization software');
if (orgSoftwareDraft.status !== 200)
  evidence.defects.push(`organization software create HTTP ${orgSoftwareDraft.status}`);
const orgSoftwareId =
  orgSoftwareDraft.status === 200 ? asId(orgSoftwareDraft.value.accountId, 'organization software') : '';
evidence.native.push({ humanSoftwareId, orgSoftwareId });
evidence.sequence.push('software-create');

async function passwordSignInStatus(accountId: string, secret: string) {
  return auth(stack, '/signin', undefined, {
    account_id: accountId,
    password: secret,
    client_id: 'login',
    scope: [],
  });
}

if (humanSoftwareId) {
  const credentialless = await passwordSignInStatus(humanSoftwareId, password);
  if (credentialless.status === 200) evidence.defects.push('credentialless software signed in with a password');
  evidence.native.push({ credentiallessSignIn: credentialless.status });
}
const organizationSignIn = await passwordSignInStatus(organizationId, developerPassword);
if (organizationSignIn.status === 200) evidence.defects.push('organization signed in with credentials');
evidence.native.push({ organizationSignIn: organizationSignIn.status });

const organizationCredential = await credentialEffect(stack, management, organizationId, {
  kind: 'password',
  password: softwarePassword,
});
if (organizationCredential.status === 200)
  evidence.defects.push('organization accepted a sign-in credential');
evidence.native.push({ organizationCredential: organizationCredential.status });

if (humanSoftwareId) {
  const setPassword = await credentialEffect(stack, management, humanSoftwareId, {
    kind: 'password',
    password: softwarePassword,
  });
  if (setPassword.status !== 200) evidence.defects.push(`software set-password HTTP ${setPassword.status}`);
  const independent = await passwordSignInStatus(humanSoftwareId, softwarePassword);
  if (setPassword.status === 200 && independent.status !== 200)
    evidence.defects.push(`software independent sign-in HTTP ${independent.status}`);
  const removed = await credentialEffect(stack, management, humanSoftwareId, {
    kind: 'password',
    password: null,
  });
  if (removed.status !== 200) evidence.defects.push(`software remove-password HTTP ${removed.status}`);
  const afterRemove = await passwordSignInStatus(humanSoftwareId, softwarePassword);
  if (afterRemove.status === 200) evidence.defects.push('software signed in after password removal');
  evidence.native.push({
    softwareCredentials: {
      set: setPassword.status,
      independent: independent.status,
      removed: removed.status,
      afterRemove: afterRemove.status,
    },
  });
  evidence.sequence.push('software-credentials');
}

async function openOperator(session: Session, subjectAccountId: string) {
  const openingKey = crypto.randomUUID();
  const openingOperation = {
    kind: 'opening',
    operatorAccountId: session.accountId,
    subjectAccountId,
  };
  const openingApproval = await auth(stack, '/account-operations/approve', session, {
    operationKey: openingKey,
    operation: openingOperation,
    accountId: session.accountId,
  });
  if (openingApproval.status !== 200) return { status: openingApproval.status, value: openingApproval.value };
  return auth(stack, '/operator-sessions/open', session, {
    operationKey: openingKey,
    operation: openingOperation,
    accountId: session.accountId,
    reference: openingApproval.value.reference,
  });
}

if (humanSoftwareId) {
  const openingSession = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.opening);
  const openedSession = await openOperator(openingSession, humanSoftwareId);
  if (openedSession.status !== 200) evidence.defects.push(`operator opening HTTP ${openedSession.status}`);
  else if (openedSession.value.account_id !== humanSoftwareId)
    evidence.defects.push('operator opening did not return the software actor');
  else if (!Array.isArray(openedSession.value.amr) || !openedSession.value.amr.includes('operator'))
    evidence.defects.push('operator opening omitted operator AMR');
  evidence.native.push({
    openedActor: openedSession.value.account_id,
    amr: openedSession.value.amr,
  });
  const outsiderOpening = await openOperator(
    await signIn(stack, outsider, AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.opening),
    humanSoftwareId,
  );
  if (outsiderOpening.status === 200) evidence.defects.push('outsider opened the software session');
  const memberOpening = await openOperator(
    await signIn(stack, member, AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.opening),
    humanSoftwareId,
  );
  if (memberOpening.status === 200) evidence.defects.push('nondelegated member opened the software session');
  evidence.native.push({
    outsiderOpening: outsiderOpening.status,
    memberOpening: memberOpening.status,
  });
  evidence.sequence.push('operator-opening');
}

if (humanSoftwareId) {
  const relation = await auth(stack, '/account-management/operators/relation', management, {
    subjectAccountId: humanSoftwareId,
  });
  if (relation.status !== 200) evidence.defects.push(`operator relation HTTP ${relation.status}`);
  else {
    const previous = {
      operatorAccountId: asId((relation.value.previous as Json | undefined)?.operatorAccountId, 'source operator'),
      subjectAccountId: humanSoftwareId,
      reservationId: asId((relation.value.previous as Json | undefined)?.reservationId, 'reservation'),
    };
    const destSession = await signIn(
      stack,
      dest,
      AUTH_MANAGEMENT_CLIENT_ID,
      AUTH_MANAGEMENT_SCOPES['transfer-acceptance'],
    );
    const sourceKey = crypto.randomUUID();
    const acceptance = await operate(stack, destSession, {
      kind: 'transfer-acceptance',
      previous,
      expectedVersion: relation.value.expectedVersion,
      operatorAccountId: dest.accountId,
      sourceOperationKey: sourceKey,
    });
    if (acceptance.status !== 200) evidence.defects.push(`transfer acceptance HTTP ${acceptance.status}`);
    else {
      const sourceSession = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.transfer);
      const execution = await operate(
        stack,
        sourceSession,
        {
          kind: 'transfer',
          previous,
          expectedVersion: relation.value.expectedVersion,
          operatorAccountId: dest.accountId,
          acceptance: acceptance.value.reference,
        },
        { acceptance: acceptance.value.reference },
      );
      if (execution.status !== 200) evidence.defects.push(`transfer execute HTTP ${execution.status}`);
      evidence.native.push({ transfer: { status: execution.status, accountId: execution.value.accountId } });
    }
  }
  evidence.sequence.push('software-transfer');
}

const renameHandle = handle('ren');
const renameSession = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.rename);
const currentPublic = requireStatus(
  await kernel(stack, 'GET', '/v1/accounts', { query: { ids: developer.accountId } }),
  'developer public',
  200,
);
const currentHandle = Array.isArray(currentPublic.accounts)
  ? String((currentPublic.accounts[0] as Json | undefined)?.handle ?? '')
  : '';
if (currentHandle) {
  const renamed = await operate(stack, renameSession, {
    kind: 'rename',
    accountId: developer.accountId,
    handle: renameHandle,
    expectedHandle: currentHandle,
  });
  if (renamed.status !== 200) evidence.defects.push(`rename HTTP ${renamed.status}`);
  else {
    const former = requireStatus(
      await kernel(stack, 'GET', '/v1/accounts', { query: { handle: currentHandle } }),
      'former handle',
      200,
    );
    const next = requireStatus(
      await kernel(stack, 'GET', '/v1/accounts', { query: { handle: renameHandle } }),
      'new handle',
      200,
    );
    const formerRow = Array.isArray(former.accounts) ? (former.accounts[0] as Json | undefined) : undefined;
    const nextRow = Array.isArray(next.accounts) ? (next.accounts[0] as Json | undefined) : undefined;
    if (nextRow?.id !== developer.accountId) evidence.defects.push('renamed handle did not resolve to the same account');
    if (formerRow && formerRow.id !== developer.accountId && formerRow.movedTo !== renameHandle)
      evidence.defects.push('former handle did not forward to the renamed account');
    evidence.native.push({
      rename: { former: currentHandle, next: renameHandle, formerMovedTo: formerRow?.movedTo ?? null },
    });
  }
  evidence.sequence.push('rename');
}

const inventory = await kernel(stack, 'GET', '/v1/me/managedAccounts', { bearer: website.bearer });
requireStatus(inventory, 'managed inventory', 200);
if (JSON.stringify(inventory.value).includes('account:read'))
  evidence.defects.push('management inventory mentioned account:read');
const detail = await kernel(stack, 'GET', `/v1/accounts/${organizationId}/management`, { bearer: website.bearer });
requireStatus(detail, 'organization management', 200);
const members = (detail.value.members as Json | undefined)?.items;
if (!Array.isArray(members) || members.length !== 20)
  evidence.defects.push(`organization management roster length ${Array.isArray(members) ? members.length : 'missing'}`);
if (!(detail.value.members as Json | undefined)?.next) evidence.defects.push('organization management omitted roster next');
if (JSON.stringify(detail.value).includes('account:read'))
  evidence.defects.push('management detail mentioned account:read');
evidence.native.push({
  inventory: { status: inventory.status, organizations: (inventory.value.organizations as Json | undefined)?.items },
  detail: {
    role: detail.value.role,
    memberCount: Array.isArray(members) ? members.length : 0,
    next: Boolean((detail.value.members as Json | undefined)?.next),
    authActions: detail.value.authActions ?? null,
  },
});

const outsiderToken = await websiteToken(stack, outsider, bindings);
const outsiderInventory = await kernel(stack, 'GET', '/v1/me/managedAccounts', { bearer: outsiderToken.bearer });
const outsiderDetail = await kernel(stack, 'GET', `/v1/accounts/${organizationId}/management`, {
  bearer: outsiderToken.bearer,
});
if (outsiderDetail.status === 200) evidence.defects.push('outsider read organization management');
const memberToken = await websiteToken(stack, member, bindings);
const memberDetail = await kernel(stack, 'GET', `/v1/accounts/${organizationId}/management`, {
  bearer: memberToken.bearer,
});
if (memberDetail.status === 200 && (memberDetail.value.authActions as Json | undefined)?.state === 'ready') {
  const operationsList = ((memberDetail.value.authActions as Json).operations ?? []) as Json[];
  if (operationsList.some((entry) => entry.operationId === 'auth.operator.transfer'))
    evidence.defects.push('nondelegated member received transfer operations');
}
const delegatedToken = await websiteToken(stack, delegated, bindings);
const delegatedSoftware = orgSoftwareId
  ? await kernel(stack, 'GET', `/v1/accounts/${orgSoftwareId}/management`, { bearer: delegatedToken.bearer })
  : { status: 0, value: {} as Json };
evidence.native.push({
  outsiderInventory: outsiderInventory.status,
  outsiderDetail: outsiderDetail.status,
  memberDetail: memberDetail.status,
  delegatedSoftware: delegatedSoftware.status,
});
evidence.sequence.push('persona-management-reads');

await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
if (typeof Bun.gc === 'function') Bun.gc(true);
const require = createRequire(resolve(root, 'apps/web/package.json'));
const { chromium } = require('playwright') as typeof import('playwright');
const browser = await chromium.launch({
  headless: true,
  env: { ...process.env, TMPDIR: '/tmp/rw' },
  args: ['--disable-dev-shm-usage', '--disable-gpu', '--renderer-process-limit=1'],
});
try {
  const capture = async (
    page: import('playwright').Page,
    persona: string,
    locale: string,
    width: number,
    theme: 'light' | 'dark',
    path: string,
  ) => {
    await page.context().addCookies([{ name: 'rezics_theme', value: theme, url: stack.web }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme });
    const response = await settle(page, `${stack.web}/${locale}${path}`);
    evidence.pages.push({
      persona,
      locale,
      width,
      theme,
      path: new URL(page.url()).pathname,
      status: response?.status() ?? 0,
      title: await page.locator('h1').first().textContent().catch(() => null),
    });
    return response;
  };

  const ownerContext = await browser.newContext({ locale: 'en-US' });
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(60_000);
  await ownerPage.route('**/*', loopbackOnly);
  await signInWebsitePage(ownerPage, stack, developer.email, developerPassword);
  for (const width of [390, 1280] as const)
    for (const theme of ['light', 'dark'] as const)
      await capture(ownerPage, 'organization-owner', 'en', width, theme, '/accounts');
  for (const locale of ['zh-Hant', 'ja'] as const)
    await capture(ownerPage, 'organization-owner', locale, 1280, 'light', '/accounts');
  await capture(ownerPage, 'organization-owner', 'en', 1280, 'light', `/organizations/${organizationId}`);
  const heading = await ownerPage.locator('h1, [data-slot="page-heading"]').first().textContent().catch(() => '');
  if (heading?.includes('account:read')) evidence.defects.push('mounted management heading mentioned account:read');
  evidence.sequence.push('owner-web-management');

  await signInAuthPage(ownerPage, stack, developer.email, developerPassword);
  const orgCreate = await settle(ownerPage, `${stack.issuer}/organizations/new`);
  evidence.pages.push({
    persona: 'organization-owner',
    path: '/organizations/new',
    status: orgCreate?.status() ?? 0,
    heading: await ownerPage.locator('h1').first().textContent().catch(() => null),
  });
  const subject = orgSoftwareId || humanSoftwareId;
  if (subject) {
    const transfer = await settle(ownerPage, `${stack.issuer}/operators/transfer?accountId=${subject}`);
    evidence.pages.push({
      persona: 'organization-owner',
      path: '/operators/transfer',
      status: transfer?.status() ?? 0,
    });
    const opening = await settle(ownerPage, `${stack.issuer}/automated/open`);
    evidence.pages.push({
      persona: 'organization-owner',
      path: '/automated/open',
      status: opening?.status() ?? 0,
    });
    const create = await settle(ownerPage, `${stack.issuer}/automated/new`);
    evidence.pages.push({
      persona: 'organization-owner',
      path: '/automated/new',
      status: create?.status() ?? 0,
    });
    const renamePage = await settle(ownerPage, `${stack.issuer}/account/rename`);
    evidence.pages.push({
      persona: 'organization-owner',
      path: '/account/rename',
      status: renamePage?.status() ?? 0,
    });
  }
  const membersPage = await settle(ownerPage, `${stack.issuer}/organizations/members?organizationId=${organizationId}`);
  evidence.pages.push({
    persona: 'organization-owner',
    path: '/organizations/members',
    status: membersPage?.status() ?? 0,
    rows: await ownerPage.locator('li, [data-slot="membership-row"]').count().catch(() => 0),
  });
  const firstRow = ownerPage.locator('li a, [data-slot="membership-row"] a, li button').first();
  if (await firstRow.count()) await firstRow.click().catch(() => {});
  evidence.sequence.push('owner-auth-pages');
  await ownerContext.close();

  for (const [persona, person] of [
    ['delegated-member', delegated],
    ['nondelegated-member', member],
    ['outsider', outsider],
  ] as const) {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.route('**/*', loopbackOnly);
    await signInWebsitePage(page, stack, person.email, password);
    await capture(page, persona, 'en', persona === 'outsider' ? 390 : 1280, 'light', `/organizations/${organizationId}`);
    await context.close();
  }
  evidence.sequence.push('persona-web');

  if (currentHandle || renameHandle) {
    const anonymous = await browser.newContext({ locale: 'en-US' });
    const page = await anonymous.newPage();
    page.setDefaultTimeout(45_000);
    await page.route('**/*', loopbackOnly);
    if (renameHandle) {
      const current = await page.goto(`${stack.web}/en/@${renameHandle}`, { waitUntil: 'domcontentloaded' });
      evidence.pages.push({ persona: 'anonymous', path: `/@${renameHandle}`, status: current?.status() ?? 0 });
    }
    if (currentHandle && currentHandle !== renameHandle) {
      const former = await page.goto(`${stack.web}/en/@${currentHandle}`, { waitUntil: 'domcontentloaded' });
      evidence.pages.push({
        persona: 'anonymous',
        path: `/@${currentHandle}`,
        status: former?.status() ?? 0,
        finalPath: new URL(page.url()).pathname,
      });
    }
    await anonymous.close();
    evidence.sequence.push('public-handle-destinations');
  }
} finally {
  await browser.close();
}

await writeFile(join(evidenceDir, 'passing.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
await writeFile(
  join(evidenceDir, 'identities.json'),
  `${JSON.stringify(
    {
      sourceRevision,
      developer: developer.accountId,
      organizationId,
      delegated: delegated.accountId,
      member: member.accountId,
      outsider: outsider.accountId,
      destination: dest.accountId,
      humanSoftwareId,
      orgSoftwareId,
      roster: roster.length,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
if (evidence.defects.length) throw new Error(evidence.defects.join('; '));
console.log(
  `managed-accounts-walk: org=${organizationId} software=${humanSoftwareId},${orgSoftwareId} roster=${roster.length} sequence=${evidence.sequence.join(',')}`,
);
