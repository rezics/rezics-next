/**
 * Accounts Goal environment walk. Runs inside `dev-stack.ts walk` with native and browser
 * acceptance. Extra personas use public signup. Catalogue seed is omitted: these journeys
 * do not consume catalogue identities except J11, which records that gap. Website Kernel
 * bearers use the zero-scope login client then OAuth. Auth page-operation and management
 * client identities are inlined because Web cannot depend on auth-contract.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { importJWK, SignJWT, type JWK } from 'jose';

const AUTH_PAGE_OPERATION_CLIENT_ID = 'rezics-auth-account-operations';
const AUTH_PAGE_OPERATION_SCOPES = {
  organization: ['organization:create'] as const,
  delete: ['account:delete'] as const,
};
const AUTH_MANAGEMENT_CLIENT_ID = 'rezics-auth-account-management';
const AUTH_MANAGEMENT_SCOPES = {
  rename: ['account:update'] as const,
  membership: ['organization:membership'] as const,
  transfer: ['account:manage'] as const,
  'transfer-acceptance': ['account:manage'] as const,
  opening: ['account:manage'] as const,
};
export const API_CAPTURE_CREDENTIAL_STEP_UP = {
  clientId: AUTH_MANAGEMENT_CLIENT_ID,
  scopes: AUTH_MANAGEMENT_SCOPES.opening,
};
const WEBSITE_CLIENT_ID = 'rezics-website';
const WEBSITE_AUDIENCE = 'https://api.rezics.test';
const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const CAPABILITIES = 'docs/goals/accounts.capabilities.md';
const JOURNEY_HEADING = '## First-public journeys';

export const JOURNEYS = [
  { id: 'J01', journey: 'signup → callback → authenticated Home', owner: 'Auth c883' },
  { id: 'J02', journey: 'sign in → refresh/session review → sign out', owner: 'Auth c883' },
  { id: 'J03', journey: 'recover access → sign in → old credential/session loses authority', owner: 'Auth c883' },
  { id: 'J04', journey: 'security → fresh step-up → manage and revoke credentials/tokens', owner: 'Auth c883' },
  { id: 'J05', journey: 'own profile → edit/save → independent public readback', owner: 'Identity 4ff' },
  { id: 'J06', journey: 'accounts → create organization → manage memberships/roles', owner: 'Accounts' },
  { id: 'J07', journey: 'managed organization → transfer control → new owner manages it', owner: 'Accounts' },
  { id: 'J08', journey: 'managed account → rename → new address works/old address retires', owner: 'Accounts' },
  {
    id: 'J09',
    journey: 'accounts → create software agent → operator/delegated caller uses held permissions',
    owner: 'Accounts',
  },
  {
    id: 'J10',
    journey: 'consent → grant requested authority → revoke → next operation reflects it',
    owner: 'Auth c883',
  },
  {
    id: 'J11',
    journey: 'account verification → verify/unverify address → independent publication readback',
    owner: 'Identity 4ff',
  },
  {
    id: 'J12',
    journey: 'public person/organization/agent page → identity without private data',
    owner: 'Identity 4ff',
  },
  {
    id: 'J13',
    journey: 'public eligible target → follow → Following → unfollow, including stored unavailable target',
    owner: 'Accounts',
  },
  {
    id: 'J14',
    journey: 'own follow counts → current count; unrelated reader lacks the private aggregate',
    owner: 'Accounts',
  },
  {
    id: 'J15',
    journey: 'Realm/Space → join → protected read → leave → next read reflects authority',
    owner: 'Authority 89',
  },
  {
    id: 'J16',
    journey: 'membership management → ban/revoke → affected reads change before cleanup; authorized readmission works',
    owner: 'Authority 89',
  },
  {
    id: 'J17',
    journey: 'Settings → per-kind preference save/reopen → actual notice send-time eligibility',
    owner: 'Preferences 4776',
  },
  {
    id: 'J18',
    journey: 'delete account → fresh confirmation → terminal erasure and retained attribution across consumers',
    owner: 'Accounts',
  },
  {
    id: 'J19',
    journey: 'operator grants → open/revoke product capability → viewer operation discovery and actual access agree',
    owner: 'Authority 89',
  },
] as const;

export type JourneyId = (typeof JOURNEYS)[number]['id'];
export type JourneyResult = 'PASS' | 'FAIL' | 'unobserved';
export type JourneyRow = {
  id: JourneyId;
  journey: string;
  result: JourneyResult;
  reached: string;
  revision: string;
  observedAt: string;
  elapsed: string;
  cause: string;
  owner: string;
  persona: string;
  evidence: string;
};

/** Website-bearer Kernel mutations. Auth-only journeys and anonymous public reads continue after a bearer 401. */
export const KERNEL_BEARER_JOURNEYS = [
  'J05',
  'J10',
  'J11',
  'J15',
  'J16',
  'J17',
  'J19',
] as const satisfies readonly JourneyId[];

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/accounts');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const password = process.argv.includes('--api-capture')
  ? randomBytes(32).toString('base64url')
  : 'walk persona password with enough entropy 32';
const nextPassword = process.argv.includes('--api-capture')
  ? randomBytes(32).toString('base64url')
  : 'walk recovered password with enough entropy 32';
const softwarePassword = 'software actor password with enough entropy 32';
const turnstile = 'rezics-local-signup';
const observedPersonas = new Set<string>();
const journeyPersonas = new Set<string>();

type Json = Record<string, unknown>;
type Origins = { web: string; issuer: string; native: string; kernel: string };
type Person = { handle: string; email: string; accountId: string };
type CaptureUnknownKind = 'transport' | 'overload' | 'setup' | 'unclassified';
class UnknownCaptureOutcome extends Error {
  constructor(readonly kind: CaptureUnknownKind) {
    super(`capture outcome unknown: ${kind}`);
    this.name = 'UnknownCaptureOutcome';
  }
}
type Session = { accountId: string; cookie: string; clientId: string; scopes: string[] };
type WalkEvidence = {
  sourceRevision: string;
  observedAt: string;
  stack: Origins;
  personas: string[];
  sequence: string[];
  native: Json[];
  pages: Json[];
  defects: string[];
};

function requestedWebsiteScopes(configured: string): string {
  return [...new Set(['openid', 'offline_access', ...configured.split(/\s+/).filter(Boolean)])].join(' ');
}

export function parseJourneyTable(markdown: string): JourneyRow[] {
  const heading = markdown.indexOf(JOURNEY_HEADING);
  if (heading < 0) throw new Error('First-public journeys heading is missing');
  const next = markdown.indexOf('\n## ', heading + JOURNEY_HEADING.length);
  const section = markdown.slice(heading, next < 0 ? markdown.length : next);
  const rows: JourneyRow[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| J')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 11) throw new Error(`journey row is short: ${line}`);
    const id = cells[0] as JourneyId;
    if (!JOURNEYS.some((journey) => journey.id === id)) throw new Error(`unknown journey ${id}`);
    const result = cells[2] as JourneyResult;
    if (result !== 'PASS' && result !== 'FAIL' && result !== 'unobserved') throw new Error(`${id} result is ${result}`);
    rows.push({
      id,
      journey: cells[1]!,
      result,
      reached: cells[3]!,
      revision: cells[4]!,
      observedAt: cells[5]!,
      elapsed: cells[6]!,
      cause: cells[7]!,
      owner: cells[8]!,
      persona: cells[9]!,
      evidence: cells[10]!,
    });
  }
  return rows;
}

function cell(value: string): string {
  return value.replaceAll('|', '/').replaceAll('\n', ' ').slice(0, 280);
}

export function renderJourneyTable(rows: JourneyRow[]): string {
  const header = [
    '| ID | Journey | Result | Reached | Revision | Observed (UTC) | Elapsed | First cause | Repair owner | Persona | Evidence |',
    '| -- | ------- | ------ | ------- | -------- | -------------- | ------- | ----------- | ------------ | ------- | -------- |',
  ];
  const body = rows.map(
    (row) =>
      `| ${row.id} | ${cell(row.journey)} | ${row.result} | ${cell(row.reached)} | ${cell(row.revision)} | ${cell(row.observedAt)} | ${cell(row.elapsed)} | ${cell(row.cause)} | ${cell(row.owner)} | ${cell(row.persona)} | ${cell(row.evidence)} |`,
  );
  return [...header, ...body].join('\n');
}

const CENSUS_REPAIRS =
  '`.temp/continuation/accounts-walk-admission.md`, `auth-website-kernel-bearer.md`, `auth-recovery-and-credentials.md`, `accounts-operations-e18.md`, `accounts-follow.md`, `accounts-walk-browser.md`, `accounts-realm.md`';
const CENSUS_MARKER = ' The table-shape check does not start Storybook.';

export function renderWalkCensus(
  rows: JourneyRow[],
  sourceRevision: string,
  observedAt: string,
  nextHourly: string,
  deferFrontends = process.env.REZICS_WALK_DEFER_FRONTENDS === '1',
): string {
  const passing = rows.filter((row) => row.result === 'PASS');
  const failing = rows.filter((row) => row.result === 'FAIL');
  const slowest = [...failing].sort((left, right) => parseInt(right.elapsed, 10) - parseInt(left.elapsed, 10))[0];
  const passList = passing.map((row) => row.id).join(', ') || 'none';
  const slowestText = slowest ? `${slowest.id} ${slowest.elapsed} ${cell(slowest.cause).slice(0, 120)}` : 'none';
  const observed = observedAt.replace(/\.\d+Z$/, 'Z');
  return `Round ${observed} on \`${sourceRevision}\` with \`REZICS_WALK_DEFER_FRONTENDS=${deferFrontends ? '1' : '0'}\`: ${passing.length}/19 PASS (${passList}). Slowest FAIL ${slowestText}. Next hourly due ${nextHourly}. Causal repairs: ${CENSUS_REPAIRS}.`;
}

export function replaceWalkCensus(markdown: string, sentence: string): string {
  const heading = markdown.indexOf(JOURNEY_HEADING);
  const from = heading < 0 ? 0 : heading;
  const relative = markdown.slice(from).search(/Round \d{4}-\d{2}-\d{2}T/);
  const roundAt = relative < 0 ? -1 : from + relative;
  const markerAt = markdown.indexOf(CENSUS_MARKER, roundAt);
  if (roundAt < 0 || markerAt < 0) throw new Error('Walk census sentence is missing');
  return `${markdown.slice(0, roundAt)}${sentence}${markdown.slice(markerAt)}`;
}

export async function writeJourneyTable(
  rows: JourneyRow[],
  markdownPath = join(root, CAPABILITIES),
  census?: { revision: string; observedAt: string; nextHourly: string },
): Promise<void> {
  const markdown = await readFile(markdownPath, 'utf8');
  const heading = markdown.indexOf(JOURNEY_HEADING);
  if (heading < 0) throw new Error('First-public journeys heading is missing');
  const tableStart = markdown.indexOf('\n| ID |', heading);
  const tableLine = markdown.indexOf('\n| J01 ', heading);
  const start = tableStart >= 0 ? tableStart + 1 : tableLine + 1;
  if (start <= 0) throw new Error('First-public journeys table is missing');
  let end = start;
  const lines = markdown.slice(start).split('\n');
  let consumed = 0;
  for (const line of lines) {
    if (line.startsWith('|')) consumed += line.length + 1;
    else break;
  }
  end = start + consumed;
  if (markdown.slice(end - 1, end) === '\n') end -= 1;
  const tableOutput = `${markdown.slice(0, start)}${renderJourneyTable(rows)}${markdown.slice(end)}`;
  let output = tableOutput;
  if (census) {
    try {
      output = replaceWalkCensus(
        tableOutput,
        renderWalkCensus(rows, census.revision, census.observedAt, census.nextHourly),
      );
    } catch (error) {
      console.error(`accounts-goal-walk: ${error instanceof Error ? error.message : String(error)}`);
      output = tableOutput;
    }
  }
  await writeFile(markdownPath, output);
}

/** A launcher failure has no seeded persona and must never reuse last round's product result. */
export function finishUnobservedJourneys(
  rows: JourneyRow[],
  diagnostic: string,
  exitCode: number,
  observedAt: string,
  elapsedMs: number,
): JourneyRow[] {
  const cause =
    diagnostic
      .split(/\r?\n/)
      .find((line) => /^(?:[A-Z][A-Z_]+:|error:|Error:)/.test(line.trim()))
      ?.trim() ?? `walk launcher exited ${exitCode} before the journey driver recorded a result`;
  return rows.map((row) =>
    row.result !== 'unobserved'
      ? row
      : {
          ...row,
          result: 'FAIL',
          reached: 'not reached: dev-stack walk admission/startup',
          observedAt,
          elapsed: `${elapsedMs}ms`,
          cause,
          owner: cause.includes('/tmp/rezics-walk-stacks/')
            ? 'Performance (shared walk admission)'
            : 'Content (walk stack startup)',
          persona: 'not reached: no persona provisioned',
          evidence: '.temp/accounts/launcher.log',
        },
  );
}

/** Own only the supported stack command; its existing signal/cleanup handling owns stack resources. */
async function launchWalk(): Promise<number> {
  if (!process.env.GOAL_TASK_ID || !/native|browser/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
    throw new Error('This walk runs on a controller-owned walk stack with native and browser acceptance');
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
  const started = Date.now();
  const observedAt = new Date(started).toISOString();
  const nextHourly = new Date(started + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const rows: JourneyRow[] = JOURNEYS.map((journey) => ({
    ...journey,
    result: 'unobserved',
    reached: 'not reached: launching supported walk stack',
    revision,
    observedAt,
    elapsed: '0ms',
    cause: 'awaiting stack admission',
    persona: 'not reached: no persona provisioned',
    evidence: '.temp/accounts/launcher.log',
  }));
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const resultFile = join(evidenceDir, 'journeys.json');
  await writeFile(resultFile, `${JSON.stringify({ evidence: { revision, observedAt }, rows }, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeJourneyTable(rows, join(root, CAPABILITIES), { revision, observedAt, nextHourly });
  const log = await open(join(evidenceDir, 'launcher.log'), 'w', 0o600);
  let exitCode: number;
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        'services/auth/scripts/dev-stack.ts',
        'walk',
        '--',
        process.execPath,
        'apps/web/scripts/accounts-goal-walk.ts',
      ],
      { cwd: root, env: process.env, stdin: 'ignore', stdout: log.fd, stderr: log.fd },
    );
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const handlers = signals.map((signal) => {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    try {
      exitCode = await child.exited;
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  } finally {
    await log.close();
  }
  const recorded = JSON.parse(await readFile(resultFile, 'utf8')) as { evidence: Json; rows: JourneyRow[] };
  const diagnostic = await readFile(join(evidenceDir, 'launcher.log'), 'utf8');
  const finishedAt = new Date().toISOString();
  const finishedRows = finishUnobservedJourneys(recorded.rows, diagnostic, exitCode, finishedAt, Date.now() - started);
  await writeFile(resultFile, `${JSON.stringify({ ...recorded, rows: finishedRows }, null, 2)}\n`, { mode: 0o600 });
  await writeJourneyTable(finishedRows, join(root, CAPABILITIES), { revision, observedAt: finishedAt, nextHourly });
  console.log(renderWalkCensus(finishedRows, revision, finishedAt, nextHourly));
  return exitCode;
}

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

function handle(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

function routeOf(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(20, 24), 16);
}

function summarize(value: unknown): string {
  return JSON.stringify(publicFields(value)).slice(0, 240);
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

async function send(
  url: string,
  init: {
    method?: string;
    cookie?: string;
    body?: unknown;
    origin?: string;
    timeout?: number;
    headers?: Record<string, string>;
    encoded?: string;
  } = {},
): Promise<{ status: number; value: Json; cookie: string; raw: string; location: string | null }> {
  const encoded = init.encoded;
  const captureRequest = beginCaptureRequest(url, init);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (init.body === undefined && encoded === undefined ? 'GET' : 'POST'),
      signal: AbortSignal.timeout(init.timeout ?? (init.method === 'GET' || init.body === undefined ? 30_000 : 8_000)),
      redirect: 'manual',
      headers: {
        ...(init.origin ? { origin: init.origin } : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.body === undefined && encoded === undefined ? {} : { 'content-type': 'application/json' }),
        ...(encoded === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(encoded === undefined ? {} : { body: encoded }),
    });
  } catch (error) {
    if (!captureRequest) throw error;
    markCaptureRequestUnknown(captureRequest, 'transport');
    throw new UnknownCaptureOutcome('transport');
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    if (!captureRequest) throw error;
    Object.assign(captureRequest, { status: response.status });
    markCaptureRequestUnknown(captureRequest, 'transport');
    throw new UnknownCaptureOutcome('transport');
  }
  let value: Json = {};
  if (raw) {
    try {
      value = JSON.parse(raw) as Json;
    } catch {
      value = { text: raw.slice(0, 240) };
    }
  }
  endCaptureRequest(captureRequest, response, value);
  return {
    status: response.status,
    value,
    cookie: cookieHeader(response, init.cookie),
    raw,
    location: response.headers.get('location'),
  };
}

function requireStatus(result: { status: number; value: Json }, label: string, expected: number | number[]): Json {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.status)) {
    throwIfUnknownResponse(result);
    throw new Error(`${label} returned HTTP ${result.status}: ${summarize(result.value)}`);
  }
  return result.value;
}

async function untilStatus(
  read: () => Promise<{ status: number; value: Json }>,
  label: string,
  expected: number,
): Promise<Json> {
  const deadline = Date.now() + 30_000;
  let last = { status: 0, value: {} as Json };
  while (Date.now() < deadline) {
    last = await read();
    if (last.status === expected) return last.value;
    await Bun.sleep(250);
  }
  throw new Error(`${label} returned HTTP ${last.status}: ${summarize(last.value)}`);
}

function isInvalidCredentials(result: { status: number; value: Json }): boolean {
  return result.status === 401 && result.value.code === 'invalid_credentials';
}

function asId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`${label} is not a native identity`);
  return value;
}

function accountRow(value: Json): Json | undefined {
  const accounts = value.accounts;
  return Array.isArray(accounts) ? (accounts[0] as Json | undefined) : undefined;
}

function agentSubjectId(row: Json | undefined, label: string): string {
  const subject = row?.subject;
  const id = subject && typeof subject === 'object' ? (subject as Json).id : undefined;
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error(`${label} omitted a public agent subject`);
  return id;
}

async function waitForPublicAgentSubject(stack: Origins, handle: string, label: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const publicTarget = accountRow(
      requireStatus(await kernel(stack, 'GET', '/v1/accounts', { query: { handle } }), label, 200),
    );
    try {
      return agentSubjectId(publicTarget, label);
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`${label} omitted a public agent subject`);
}

async function deliveredRecoveryToken(email: string): Promise<string> {
  const path = join(
    process.env.REZICS_CAPTURE_RECOVERY_DIR ?? join(root, '.temp/local-stack/recovery'),
    `${email}.json`,
  );
  if (activeCapture) {
    activeCapture.operation = 'local recovery delivery';
    activeCapture.phases.push({ operation: 'local recovery delivery', result: 'waiting' });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const delivered = JSON.parse(await readFile(path, 'utf8')) as Json;
      if (typeof delivered.token === 'string' && delivered.token) {
        captureLocalDelivery();
        return delivered.token;
      }
    } catch {
      // HTTP recovery never returns the proof; local assemble writes it privately.
    }
    await Bun.sleep(100);
  }
  if (activeCapture) throw captureUnknownOutcome('setup');
  throw new Error('recovery start acknowledged with no token; local walk stack has no supported recovery delivery');
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

async function auth(stack: Origins, path: string, session: Session | undefined, body: unknown, timeout = 8_000) {
  return send(`${stack.native}${path}`, {
    method: 'POST',
    origin: stack.issuer,
    ...(session?.cookie === undefined ? {} : { cookie: session.cookie }),
    body,
    timeout,
  });
}

async function untilAnswers(url: string, label: string) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (ok) return;
    await Bun.sleep(500);
  }
  throw new Error(`${label} was not ready after ten minutes`);
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
  const accountId = asId(result.value.accountId, `${tag} account`);
  const persona = `${name} (${accountId})`;
  observedPersonas.add(persona);
  journeyPersonas.add(persona);
  if (activeCapture) activeCapture.authority = { subjectAccountId: accountId };
  return { handle: name, email: `${name}@example.test`, accountId };
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
    { email: person.email, password: secret, client_id: clientId, scope: [...scopes] },
    30_000,
  );
  requireStatus(result, `signin ${clientId}`, 200);
  const accountId = asId(result.value.account_id, 'session account');
  const persona = `account ${accountId}`;
  observedPersonas.add(persona);
  journeyPersonas.add(persona);
  if (activeCapture)
    activeCapture.authority = {
      ...activeCapture.authority,
      sameSubject: activeCapture.authority?.subjectAccountId === accountId,
      client: clientId,
      scopes: [...scopes],
    };
  return {
    accountId,
    cookie: result.cookie,
    clientId,
    scopes: [...scopes],
  };
}

async function websiteAssertion(stack: Origins, websiteKey: JWK): Promise<string> {
  if (typeof websiteKey.kid !== 'string' || !websiteKey.kid || !websiteKey.d)
    throw new Error('keys.json omitted the website client private key');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: websiteKey.kid })
    .setIssuer(WEBSITE_CLIENT_ID)
    .setSubject(WEBSITE_CLIENT_ID)
    .setAudience(stack.issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomBytes(24).toString('base64url'))
    .sign(await importJWK(websiteKey, 'ES256'));
}

async function websiteToken(
  stack: Origins,
  person: Pick<Person, 'email'>,
  bindings: Record<string, string>,
  websiteKey: JWK,
  secret = password,
): Promise<{ session: Session; bearer: string; refresh: string; codePath: string }> {
  capturePhase('website login');
  const session = await signIn(stack, person, 'login', [], secret);
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const redirectUri = `${stack.web}/auth/callback`;
  const resource = bindings.API_RESOURCE ?? WEBSITE_AUDIENCE;
  const authorize = new URL('/authorize', stack.native);
  authorize.search = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: requestedWebsiteScopes(bindings.WEBSITE_SCOPES ?? ''),
    state,
    nonce: state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource,
  }).toString();
  capturePhase('website authorization');
  const authorization = await send(authorize.href, {
    headers: { cookie: session.cookie, origin: stack.issuer },
    timeout: 30_000,
  });
  if (![302, 303].includes(authorization.status)) {
    throwIfUnknownResponse(authorization);
    const body = authorization.raw;
    throw new Error(`website authorize returned HTTP ${authorization.status}: ${body.slice(0, 240)}`);
  }
  const location = authorization.location;
  if (!location) throw new Error('website authorize omitted location');
  const redirected = new URL(location, stack.web);
  if (redirected.searchParams.get('state') !== state) throw new Error('website authorize returned a foreign state');
  const code = redirected.searchParams.get('code');
  if (!code) throw new Error(`website authorize omitted code (${redirected.pathname})`);
  capturePhase('website code exchange');
  const token = await send(`${stack.native}/token`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/x-www-form-urlencoded' },
    encoded: new URLSearchParams({
      client_id: WEBSITE_CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await websiteAssertion(stack, websiteKey),
      resource,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
    timeout: 30_000,
  });
  const issued = token.value;
  if (token.status !== 200) throwIfUnknownResponse(token);
  if (token.status !== 200 || typeof issued.access_token !== 'string')
    throw new Error(`website token returned HTTP ${token.status}: ${summarize(issued)}`);
  return {
    session,
    bearer: issued.access_token,
    refresh: typeof issued.refresh_token === 'string' ? issued.refresh_token : '',
    codePath: redirected.pathname,
  };
}

async function operate(
  stack: Origins,
  session: Session,
  operation: Json,
  extra: Json = {},
): Promise<{ status: number; value: Json }> {
  const operationKey = crypto.randomUUID();
  const confirmation = extra.confirmation;
  const rest = { ...extra };
  delete rest.confirmation;
  const body = {
    operationKey,
    operation,
    ...(operation.kind === 'organization' || operation.kind === 'delete' ? {} : { accountId: session.accountId }),
    ...rest,
  };
  const approval = await auth(stack, '/account-operations/approve', session, body, 30_000);
  if (approval.status !== 200) return approval;
  if (operation.kind === 'transfer-acceptance' || operation.kind === 'opening') return approval;
  return auth(
    stack,
    '/account-operations/execute',
    session,
    {
      ...body,
      reference: approval.value.reference,
      ...(typeof confirmation === 'string' ? { confirmation } : {}),
    },
    30_000,
  );
}

async function credentialEffect(
  stack: Origins,
  session: Session,
  subjectId: string,
  credential: Json,
): Promise<{ status: number; value: Json }> {
  if (activeCapture)
    activeCapture.authority = {
      ...activeCapture.authority,
      sameSubject: subjectId === session.accountId,
      sameSessionAcrossPhases: true,
      client: session.clientId,
      credentialKind: credential.kind,
    };
  capturePhase('credential effect stage');
  const staged = await auth(
    stack,
    '/credential-effects/stage',
    session,
    {
      key: crypto.randomUUID(),
      subjectId,
      credential,
    },
    30_000,
  );
  if (staged.status !== 200) return staged;
  capturePhase('credential effect approval');
  const approval = await auth(stack, '/credential-effects/approve', session, staged.value, 30_000);
  if (approval.status !== 200) return approval;
  capturePhase('credential effect application');
  return auth(
    stack,
    '/credential-effects/apply',
    session,
    {
      ...staged.value,
      reference: approval.value.reference,
    },
    30_000,
  );
}

function loopbackOnly(route: import('playwright').Route) {
  const type = route.request().resourceType();
  if (type === 'image' || type === 'media' || type === 'font') return route.abort();
  const url = new URL(route.request().url());
  return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
}

async function settle(page: import('playwright').Page, url: string) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page
    .locator('html[data-hydrated]')
    .waitFor({ state: 'attached', timeout: 120_000 })
    .catch(() => {});
  return response;
}

async function fillPasswordSignIn(page: import('playwright').Page, email: string, secret: string) {
  await page.getByLabel(/email/i).fill(email);
  await page.locator('input[name="password"]').fill(secret);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function startFrontend(action: 'pages' | 'web', stack: Origins) {
  const child = Bun.spawn([process.execPath, 'services/auth/scripts/dev-stack.ts', action], {
    cwd: root,
    env: process.env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const url = action === 'pages' ? `${stack.issuer}/` : `${stack.web}/`;
  const label = action === 'pages' ? 'Auth pages' : 'Web';
  const deadline = Date.now() + 600_000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode} before becoming ready`);
      const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
        (response) => response.status < 500,
        () => false,
      );
      if (ok) break;
      await Bun.sleep(500);
    }
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode} before becoming ready`);
    const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (!ok) throw new Error(`${label} was not ready after ten minutes`);
  } catch (error) {
    child.kill('SIGTERM');
    await child.exited;
    throw error;
  }
  return {
    stop: async () => {
      child.kill('SIGTERM');
      await child.exited;
    },
  };
}

/** API-only evidence never updates the complete census or the visual owner's output. */
export const API_CAPTURE_JOURNEYS = ['J03', 'J04', 'J10'] as const;
export const API_CAPTURE_DIRECTORY = '.temp/goal/accounts/post-seed-api-capture';
type CaptureId = (typeof API_CAPTURE_JOURNEYS)[number];
type CaptureCase = {
  id: CaptureId;
  personaRole: 'newly registered ordinary human';
  result: 'PASS' | 'FAIL' | 'unknown' | 'unverified';
  elapsedMs: number;
  operation: string;
  phase?: string;
  firstFailingOperation?: string;
  unknownOperation?: string;
  unknownKind?: CaptureUnknownKind;
  authority?: Json;
  phases: Json[];
};
let activeCapture: CaptureCase | undefined;

// Keep values only from the public error vocabulary; arbitrary service strings are never evidence.
export function captureResponse(input: unknown): Json {
  const value: Json = input && typeof input === 'object' && !Array.isArray(input) ? (input as Json) : {};
  const fields = [
    'success',
    'error',
    'effect_status',
    'accountId',
    'account_id',
    'sessions',
    'code',
    'access_token',
    'refresh_token',
    'token_type',
    'expires_in',
    'scope',
    'effectRef',
    'key',
    'subjectId',
    'purpose',
    'digest',
    'reference',
    'expiresAt',
    'receiptId',
    'replayed',
  ];
  const shape = Object.fromEntries(
    fields.filter((key) => key in value).map((key) => [key, Array.isArray(value[key]) ? 'array' : typeof value[key]]),
  );
  const codes = [
    'authentication_denied',
    'credential_effect_denied',
    'invalid_request',
    'invalid_credentials',
    'invalid_client',
    'invalid_grant',
    'access_denied',
    'unsupported_grant_type',
    'unsupported_response_type',
    'invalid_scope',
    'temporarily_unavailable',
    'server_error',
    'authentication_required',
    'overloaded',
    'deadline_exceeded',
    'transaction_retry_exhausted',
    'partition_unavailable',
    'dependency_unavailable',
    'contention',
    'unauthorized_client',
    'step_up_required',
    'account_suspended',
    'stale_review',
  ];
  const code = [value.code, value.error].find((candidate) => typeof candidate === 'string' && codes.includes(candidate));
  return {
    shape,
    ...(typeof code === 'string' ? { code } : {}),
    ...(['not_applied', 'applied'].includes(String(value.effect_status)) ? { effectStatus: value.effect_status } : {}),
  };
}

type CaptureHttpResult = { status: number; value: unknown };
type AuthorityDenialSource = 'auth' | 'kernel';
type AuthorityDenialClassification = 'qualified-denial' | 'unknown' | 'not-denial';

function unknownHttpResponse(result: CaptureHttpResult): boolean {
  const record = result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? (result.value as Json) : {};
  const codes = [record.code, record.error].filter((code): code is string => typeof code === 'string');
  return (
    result.status === 408 ||
    result.status === 425 ||
    result.status === 429 ||
    result.status >= 500 ||
    codes.some((code) =>
      [
        'overloaded',
        'deadline_exceeded',
        'transaction_retry_exhausted',
        'partition_unavailable',
        'contention',
        'invalid_client',
        'invalid_grant',
        'unauthorized_client',
        'invalid_request',
        'unsupported_grant_type',
        'unsupported_response_type',
        'invalid_scope',
        'access_denied',
        'temporarily_unavailable',
        'dependency_unavailable',
      ].includes(code),
    )
  );
}

function unknownResponseKind(result: CaptureHttpResult): CaptureUnknownKind {
  const value = result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? (result.value as Json) : {};
  const codes = [value.code, value.error].filter((code): code is string => typeof code === 'string');
  if (
    codes.some((code) =>
      ['overloaded', 'deadline_exceeded', 'transaction_retry_exhausted', 'partition_unavailable', 'contention'].includes(
        code,
      ),
    )
  )
    return 'overload';
  if (
    codes.some((code) =>
      [
        'invalid_client',
        'invalid_grant',
        'unauthorized_client',
        'invalid_request',
        'unsupported_grant_type',
        'unsupported_response_type',
        'invalid_scope',
        'access_denied',
      ].includes(code),
    )
  )
    return 'setup';
  return 'unclassified';
}

export function classifyAuthorityDenial(
  source: AuthorityDenialSource,
  result: CaptureHttpResult,
): AuthorityDenialClassification {
  if (unknownHttpResponse(result)) return 'unknown';
  const value = result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? (result.value as Json) : {};
  if (source === 'auth')
    return result.status === 401 && value.error === 'authentication_denied' && value.code === undefined
      ? 'qualified-denial'
      : 'not-denial';
  return result.status === 401 && value.code === 'invalid_credentials' ? 'qualified-denial' : 'not-denial';
}

function markCaptureRequestUnknown(entry: Json, kind: CaptureUnknownKind) {
  Object.assign(entry, { classification: 'unknown', unknownKind: kind, result: 'unknown' });
}

function captureUnknownOutcome(kind: CaptureUnknownKind): UnknownCaptureOutcome {
  const capture = activeCapture;
  if (capture) {
    const last = capture.phases.at(-1);
    if (last && last.operation === capture.operation) markCaptureRequestUnknown(last, kind);
    else {
      capture.phases.push({
        phase: capture.phase ?? 'setup',
        operation: capture.operation,
        result: 'unknown',
        classification: 'unknown',
        unknownKind: kind,
      });
    }
  }
  return new UnknownCaptureOutcome(kind);
}

function throwIfUnknownResponse(result: CaptureHttpResult) {
  if (activeCapture && unknownHttpResponse(result)) throw captureUnknownOutcome(unknownResponseKind(result));
}

export function assertAuthorityDenial(
  source: AuthorityDenialSource,
  result: CaptureHttpResult,
  label: string,
): void {
  const classification = classifyAuthorityDenial(source, result);
  if (classification === 'unknown') throw captureUnknownOutcome(unknownResponseKind(result));
  if (classification === 'not-denial') throw new Error(`${label} did not return a qualifying authority denial`);
  const phase = activeCapture?.phases.at(-1);
  if (phase)
    Object.assign(phase, {
      authorityOutcome: 'denied',
      authorityDenialSource: source,
      authorityDenialCode: source === 'auth' ? 'authentication_denied' : 'invalid_credentials',
    });
}

function beginCaptureRequest(url: string, init: Parameters<typeof send>[1]): Json | undefined {
  if (!activeCapture) return;
  const target = new URL(url);
  const method = init?.method ?? (init?.body === undefined && init?.encoded === undefined ? 'GET' : 'POST');
  const path = target.pathname.replace(uuid, ':account');
  activeCapture.operation = `${method} ${path}`;
  const body = init?.encoded ? Object.fromEntries(new URLSearchParams(init.encoded)) : init?.body;
  const fields = body && typeof body === 'object' ? (body as Json) : Object.fromEntries(target.searchParams);
  const entry: Json = {
    operation: activeCapture.operation,
    phase: activeCapture.phase,
    startedAt: new Date().toISOString(),
    requestId: crypto.randomUUID(),
    requestCorrelation: 'local sequence only; runtime correlation unavailable',
    fields: Object.keys(fields).sort(),
    presence: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, value !== '' && value !== undefined && value !== null]),
    ),
    origin: init?.origin ?? init?.headers?.origin ?? null,
    client:
      fields.client_id === WEBSITE_CLIENT_ID
        ? WEBSITE_CLIENT_ID
        : fields.client_id === AUTH_MANAGEMENT_CLIENT_ID
          ? AUTH_MANAGEMENT_CLIENT_ID
          : fields.client_id === 'login'
            ? 'login'
            : undefined,
    resource:
      typeof fields.resource === 'string' && fields.resource.startsWith('https://') ? fields.resource : undefined,
    tokenKind: fields.token_type_hint === 'refresh_token' ? 'refresh_token' : undefined,
    bearerPresent: Boolean(init?.headers?.authorization),
    cookiePresent: Boolean(init?.cookie ?? init?.headers?.cookie),
    authority: activeCapture.authority,
    result: 'dispatched',
  };
  activeCapture.phases.push(entry);
  return entry;
}

function endCaptureRequest(entry: Json | undefined, response: Response, value: Json) {
  if (!entry) return;
  Object.assign(entry, {
    status: response.status,
    response: captureResponse(value),
    locationPresent: response.headers.has('location'),
    result: 'responded',
    classification: unknownHttpResponse({ status: response.status, value }) ? 'unknown' : 'response',
    elapsedMs: Date.now() - Date.parse(String(entry.startedAt)),
    // Native Auth deliberately omits request context from its diagnostic stream.
    diagnostics: 'Auth/Access internal cause unavailable; no request-correlated diagnostic handoff',
  });
}

function capturePhase(phase: string) {
  if (activeCapture) activeCapture.phase = phase;
}

function captureAuthority(authority: Json) {
  if (activeCapture) activeCapture.authority = { ...activeCapture.authority, ...authority };
}

function captureLocalDelivery() {
  const delivery = activeCapture?.phases.at(-1);
  if (delivery) Object.assign(delivery, { result: 'delivered', tokenPresent: true });
}

/** A failed case must not suppress either sibling. The sink belongs only to this capture. */
export async function collectApiCapture(
  operations: Record<CaptureId, () => Promise<unknown>>,
  persist: (cases: CaptureCase[]) => Promise<void>,
): Promise<CaptureCase[]> {
  const cases: CaptureCase[] = [];
  for (const id of API_CAPTURE_JOURNEYS) {
    const started = Date.now();
    const current: CaptureCase = {
      id,
      personaRole: 'newly registered ordinary human',
      result: 'unverified',
      elapsedMs: 0,
      operation: 'persona signup',
      phases: [],
    };
    activeCapture = current;
    try {
      await operations[id]();
      const unknownPhase = current.phases.filter((phase) => phase.classification === 'unknown').at(-1);
      if (unknownPhase) {
        current.result = 'unknown';
        current.unknownOperation = `${String(unknownPhase.phase ?? 'setup')}: ${String(unknownPhase.operation)}`;
        current.unknownKind = (unknownPhase.unknownKind as CaptureUnknownKind | undefined) ?? 'unclassified';
      } else current.result = 'PASS';
    } catch (error) {
      const last = current.phases.at(-1);
      const unknownPhase = current.phases.filter((phase) => phase.classification === 'unknown').at(-1);
      const observedUnknownKind = unknownPhase?.unknownKind as CaptureUnknownKind | undefined;
      const unknownKind =
        error instanceof UnknownCaptureOutcome
          ? error.kind
          : observedUnknownKind ?? (unknownPhase ? 'unclassified' : undefined);
      if (unknownKind) {
        current.unknownOperation = `${String(unknownPhase?.phase ?? current.phase ?? 'setup')}: ${String(unknownPhase?.operation ?? current.operation)}`;
        current.unknownKind = unknownKind;
        if (last && (last.result === 'dispatched' || last.result === 'waiting'))
          Object.assign(last, { result: 'unknown', classification: 'unknown', unknownKind });
        if (error instanceof UnknownCaptureOutcome) current.result = 'unknown';
        else {
          current.result = 'FAIL';
          current.firstFailingOperation = `${current.phase ?? 'setup'}: ${current.operation}`;
        }
      } else {
        current.result = 'FAIL';
        current.firstFailingOperation = `${current.phase ?? 'setup'}: ${current.operation}`;
        if (last && (last.result === 'dispatched' || last.result === 'waiting')) last.result = 'unavailable';
      }
    } finally {
      current.elapsedMs = Date.now() - started;
      activeCapture = undefined;
    }
    cases.push(current);
    await persist(cases);
  }
  return cases;
}

export type CaptureHandoff = {
  slot: string;
  runtimeRevision: string;
  runtimeService?: string;
  runtimeLeasePid?: number;
  runtimeStackPid?: number;
  seedCompleted?: boolean;
  seedState?: string;
  origins: Origins;
  keysPath?: string;
  bindingsPath?: string;
  recoveryDirectory?: string;
};

export function parseCaptureHandoff(value: unknown): CaptureHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid capture handoff');
  const input = value as Record<string, unknown>;
  if (typeof input.slot !== 'string' || !input.slot || typeof input.runtimeRevision !== 'string')
    throw new Error('invalid capture handoff identity');
  if (!/^[a-f0-9]{40}$/.test(input.runtimeRevision)) throw new Error('invalid capture runtime revision');
  if (input.seedCompleted !== undefined && typeof input.seedCompleted !== 'boolean')
    throw new Error('invalid capture seed observation');
  if (input.seedState !== undefined && typeof input.seedState !== 'string')
    throw new Error('invalid capture seed observation');
  if (input.runtimeService !== undefined && (typeof input.runtimeService !== 'string' || !input.runtimeService))
    throw new Error('invalid capture runtime service');
  for (const name of ['runtimeLeasePid', 'runtimeStackPid'] as const) {
    const pid = input[name];
    if (pid !== undefined && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1))
      throw new Error('invalid capture runtime process');
  }
  if (!input.origins || typeof input.origins !== 'object' || Array.isArray(input.origins))
    throw new Error('invalid capture origins');

  const rawOrigins = input.origins as Record<string, unknown>;
  const originNames = ['web', 'issuer', 'native', 'kernel'] as const;
  for (const value of Object.values(rawOrigins)) {
    if (typeof value !== 'string') throw new Error('invalid capture origin');
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== value)
      throw new Error('capture requires loopback origins');
  }
  const origins = Object.fromEntries(
    originNames.map((name) => {
      const value = rawOrigins[name];
      if (typeof value !== 'string') throw new Error('invalid capture origin');
      return [name, value];
    }),
  ) as Origins;

  const optionalPath = (name: 'keysPath' | 'bindingsPath' | 'recoveryDirectory') => {
    const path = input[name];
    if (path === undefined) return undefined;
    if (typeof path !== 'string' || !path) throw new Error('invalid capture credential path');
    return path;
  };

  return {
    slot: input.slot,
    runtimeRevision: input.runtimeRevision,
    ...(input.runtimeService === undefined ? {} : { runtimeService: input.runtimeService as string }),
    ...(input.runtimeLeasePid === undefined ? {} : { runtimeLeasePid: input.runtimeLeasePid as number }),
    ...(input.runtimeStackPid === undefined ? {} : { runtimeStackPid: input.runtimeStackPid as number }),
    ...(input.seedCompleted === undefined ? {} : { seedCompleted: input.seedCompleted }),
    ...(input.seedState === undefined ? {} : { seedState: input.seedState }),
    origins,
    keysPath: optionalPath('keysPath'),
    bindingsPath: optionalPath('bindingsPath'),
    recoveryDirectory: optionalPath('recoveryDirectory'),
  };
}

export async function runApiCaptureOnHandoff(
  handoff: CaptureHandoff,
  sourceRevision: string,
  operations: Record<CaptureId, () => Promise<unknown>>,
  persist: (identity: Json, cases: CaptureCase[]) => Promise<void>,
): Promise<{ identity: Json; cases: CaptureCase[] }> {
  const identity: Json = {
    sourceRevision,
    observedAt: new Date().toISOString(),
    runtimeRevision: handoff.runtimeRevision,
    slot: handoff.slot,
    runtimeService: handoff.runtimeService ?? null,
    lease: {
      runtimeLeasePid: handoff.runtimeLeasePid ?? null,
      runtimeStackPid: handoff.runtimeStackPid ?? null,
    },
    origins: handoff.origins,
    seed: {
      completed: handoff.seedCompleted ?? null,
      state: handoff.seedState ?? null,
    },
  };
  const cases = await collectApiCapture(operations, (rows) => persist(identity, rows));
  return { identity, cases };
}

export function hasNativeCaptureOwnership(environment: {
  GOAL_TASK_ID?: string;
  GOAL_ATTEMPT?: string;
  GOAL_ACCEPTANCE_REQUIRES?: string;
}): boolean {
  const taskId = environment.GOAL_TASK_ID ?? '';
  const attemptText = environment.GOAL_ATTEMPT ?? '';
  const attempt = Number(attemptText);
  const nativeRequired = (environment.GOAL_ACCEPTANCE_REQUIRES ?? '').split(',').map((item) => item.trim());
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId) &&
    /^[1-9][0-9]*$/.test(attemptText) &&
    Number.isSafeInteger(attempt) &&
    attempt > 0 &&
    nativeRequired.includes('native')
  );
}

async function captureOriginalAuthJourneys(): Promise<number> {
  if (!hasNativeCaptureOwnership(process.env)) throw new Error('API capture requires native task ownership');
  const directory = join(root, API_CAPTURE_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sourceRevision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
  let identity: Json = { sourceRevision, observedAt: new Date().toISOString() };
  const persistUnverified = async (prerequisite: string) => {
    const cases = API_CAPTURE_JOURNEYS.map((id) => ({
      id,
      result: 'unverified',
      prerequisite,
      preventedPhases:
        id === 'J03'
          ? [
              'signup',
              'sign-in',
              'recovery start',
              'local delivery',
              'completion',
              'old/new-password sign-in',
              'old-session read',
            ]
          : id === 'J04'
            ? ['signup', 'sign-in', 'stage', 'approve', 'apply', 'old/new-password sign-in', 'current-session read']
            : ['signup', 'website OAuth', 'admitted Kernel read', 'revoke', 'formerly admitted Kernel bearer denial'],
      owner: 'existing manager_event_idle visual runtime owner via Content and supermanager',
      phases: [],
      elapsedMs: 0,
      personaRole: 'newly registered ordinary human (not provisioned)',
    }));
    await writeFile(join(directory, 'capture.json'), JSON.stringify({ identity, cases }, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(`accounts-api-capture: unverified; prerequisite: ${prerequisite}`);
  };

  let handoff: CaptureHandoff;
  const path = process.env.REZICS_API_CAPTURE_HANDOFF;
  if (!path) {
    await persistUnverified('admitted runtime handoff is unavailable');
    return 1;
  }
  try {
    handoff = parseCaptureHandoff(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    await persistUnverified('admitted runtime handoff is invalid or unavailable');
    return 1;
  }

  const runtime = handoff;
  const operations: Record<CaptureId, () => Promise<unknown>> = {
    J03: () => {
      capturePhase('recovery delivery setup');
      if (activeCapture) activeCapture.operation = 'recovery delivery path from runtime handoff';
      if (!runtime.recoveryDirectory) throw captureUnknownOutcome('setup');
      process.env.REZICS_CAPTURE_RECOVERY_DIR = runtime.recoveryDirectory;
      activeCapture?.phases.push({
        phase: 'recovery delivery setup',
        operation: 'recovery delivery path from runtime handoff',
        result: 'ready',
        classification: 'setup',
      });
      return originalJ03(runtime.origins);
    },
    J04: () => originalJ04(runtime.origins),
    J10: async () => {
      // Missing website setup affects only revocation, never recovery or credential replacement.
      capturePhase('website credential setup');
      if (activeCapture) activeCapture.operation = 'website private key/binding from runtime handoff';
      let websiteKey: JWK;
      let bindings: Record<string, string>;
      try {
        if (!runtime.keysPath || !runtime.bindingsPath) throw new Error('credential paths unavailable');
        const keys = JSON.parse(await readFile(runtime.keysPath, 'utf8')) as { website?: unknown };
        if (!keys.website || typeof keys.website !== 'object' || Array.isArray(keys.website))
          throw new Error('website private key unavailable');
        websiteKey = keys.website as JWK;
        if (typeof websiteKey.kid !== 'string' || !websiteKey.kid || typeof websiteKey.d !== 'string' || !websiteKey.d)
          throw new Error('website private key unavailable');
        await importJWK(websiteKey, 'ES256');
        bindings = await parseEnv(runtime.bindingsPath);
      } catch {
        throw captureUnknownOutcome('setup');
      }
      activeCapture?.phases.push({
        phase: 'website credential setup',
        operation: 'website private key/binding from runtime handoff',
        result: 'ready',
        classification: 'setup',
        authority: { client: WEBSITE_CLIENT_ID, issuer: runtime.origins.issuer, resource: bindings.API_RESOURCE ?? WEBSITE_AUDIENCE },
      });
      return originalJ10(runtime.origins, bindings, websiteKey);
    },
  };
  const { cases } = await runApiCaptureOnHandoff(runtime, sourceRevision, operations, async (recordedIdentity, rows) => {
    identity = recordedIdentity;
    await writeFile(join(directory, 'capture.json'), JSON.stringify({ identity, cases: rows }, null, 2) + '\n', {
      mode: 0o600,
    });
  });
  console.log(`accounts-api-capture: ${cases.map((entry) => `${entry.id} ${entry.result}`).join('; ')}`);
  return cases.every((entry) => entry.result === 'PASS') ? 0 : 1;
}

if (import.meta.main && process.argv.includes('--api-capture')) {
  process.exitCode = await captureOriginalAuthJourneys();
}

if (import.meta.main && !process.argv.includes('--api-capture') && process.argv.includes('--launch')) {
  process.exitCode = await launchWalk();
}

if (import.meta.main && !process.argv.includes('--api-capture') && !process.argv.includes('--launch')) {
  if (!process.env.GOAL_TASK_ID || !/native|browser/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
    throw new Error('This walk runs on a controller-owned walk stack with native and browser acceptance');

  const sourceRevision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
  const stack = origins();
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const observedAt = new Date().toISOString();
  const rows = new Map<JourneyId, JourneyRow>(
    JOURNEYS.map((journey) => [
      journey.id,
      {
        id: journey.id,
        journey: journey.journey,
        result: 'unobserved',
        reached: '—',
        revision: sourceRevision,
        observedAt,
        elapsed: '—',
        cause: 'not walked',
        owner: journey.owner,
        persona: 'not reached: no persona provisioned',
        evidence: '.temp/accounts/journeys.json',
      },
    ]),
  );
  const evidence: WalkEvidence = {
    sourceRevision,
    observedAt,
    stack,
    personas: [],
    sequence: [],
    native: [],
    pages: [],
    defects: [],
  };

  function note(step: string) {
    (evidence.sequence as string[]).push(step);
    console.log(`accounts-goal-walk: ${step}`);
  }

  function mark(
    id: JourneyId,
    result: JourneyResult,
    reached: string,
    elapsedMs: number,
    cause: string,
    owner: string = JOURNEYS.find((journey) => journey.id === id)!.owner,
  ) {
    rows.set(id, {
      ...rows.get(id)!,
      result,
      reached,
      revision: sourceRevision,
      observedAt: new Date().toISOString(),
      elapsed: `${Math.max(0, elapsedMs)}ms`,
      cause,
      owner,
      persona: reached.startsWith('not reached:')
        ? 'not reached: no persona used'
        : [...journeyPersonas].join(', ') || 'anonymous public reader',
      evidence: `.temp/accounts/journeys.json#${id}`,
    });
  }

  async function failDependents(ids: JourneyId[], cause: string, reached: string) {
    for (const id of ids) {
      const row = rows.get(id)!;
      if (row.result === 'unobserved') mark(id, 'FAIL', `not reached: ${reached}`, 0, cause, row.owner);
    }
    await persist();
  }

  async function persist() {
    evidence.personas = [...observedPersonas];
    await writeFile(
      join(evidenceDir, 'journeys.json'),
      `${JSON.stringify({ evidence, rows: [...rows.values()] }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    await writeJourneyTable([...rows.values()], join(root, CAPABILITIES), {
      revision: sourceRevision,
      observedAt: new Date().toISOString(),
      nextHourly: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
    });
  }

  async function runJourney(id: JourneyId, reached: string, body: () => Promise<string | void>) {
    if (rows.get(id)?.result !== 'unobserved') return;
    const started = Date.now();
    journeyPersonas.clear();
    try {
      const detail = (await body()) ?? 'ok';
      mark(id, 'PASS', reached, Date.now() - started, detail);
      note(`${id} PASS ${reached}`);
    } catch (error) {
      const cause = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      mark(id, 'FAIL', reached, Date.now() - started, cause);
      (evidence.defects as string[]).push(`${id}: ${cause}`);
      note(`${id} FAIL ${reached}: ${cause}`);
    }
    await persist();
  }

  async function failRemaining(cause: string, reached: string) {
    await failDependents(
      JOURNEYS.map((journey) => journey.id),
      cause,
      reached,
    );
  }

  try {
    await untilAnswers(`${stack.native}/`, 'native Auth');
    note('native-ready');
    await persist();

    const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as {
      password: string;
      website: JWK;
    };
    const developer: Person = { handle: 'developer', email: 'developer@rezics.test', accountId: '' };
    const developerPassword = keys.password;
    const bindings = await parseEnv(join(root, 'apps/web/.dev.vars'));
    let website: { session: Session; bearer: string; refresh: string; codePath: string } | undefined;
    try {
      website = await websiteToken(stack, developer, bindings, keys.website, developerPassword);
      developer.accountId = website.session.accountId;
      evidence.native.push({ developer: developer.accountId, callback: website.codePath });
      note('developer-token');
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      await failDependents(
        JOURNEYS.map((journey) => journey.id),
        cause,
        'POST /signin login then GET /authorize',
      );
      throw error;
    }
    if (!website) throw new Error('developer website token was not issued');

    async function developerSignIn(clientId: string, scopes: readonly string[]): Promise<Session> {
      const result = await auth(
        stack,
        '/signin',
        undefined,
        { email: developer.email, password: developerPassword, client_id: clientId, scope: [...scopes] },
        30_000,
      );
      requireStatus(result, `developer ${clientId}`, 200);
      return {
        accountId: asId(result.value.account_id, 'developer'),
        cookie: result.cookie,
        clientId,
        scopes: [...scopes],
      };
    }

    let kernelBearerCause = '';
    async function rememberKernelBearerFailure(result: { status: number; value: Json }, label: string) {
      if (!isInvalidCredentials(result) || kernelBearerCause) return;
      kernelBearerCause = `${label} returned HTTP ${result.status}: ${summarize(result.value)}`;
      await failDependents([...KERNEL_BEARER_JOURNEYS], kernelBearerCause, label);
    }

    const openedOrg = await kernel(stack, 'POST', '/v1/platform/exposure/organizations:open', {
      bearer: website.bearer,
      body: {},
    });
    if (![200, 409].includes(openedOrg.status))
      evidence.native.push({ organizationsOpen: openedOrg.status, body: publicFields(openedOrg.value) });
    await rememberKernelBearerFailure(openedOrg, 'POST /v1/platform/exposure/organizations:open');

    let walker: Person | undefined;
    let outsider: Person | undefined;
    let dest: Person | undefined;
    let organizationId = '';
    let orgHandle = '';
    let humanSoftwareId = '';
    let followTarget: Person | undefined;
    let followTargetId = '';
    let realmId = '';
    let spaceId = '';

    await runJourney('J01', 'POST /signup → GET /authorize → GET /auth/callback → GET /en/', async () => {
      walker = await signup(stack, 'j01');
      const token = await websiteToken(stack, walker, bindings, keys.website);
      if (!token.codePath.includes('/auth/callback') && token.codePath !== '/auth/callback')
        throw new Error(`callback path ${token.codePath}`);
      const me = await kernel(stack, 'GET', '/v1/accounts', {
        bearer: token.bearer,
        query: { ids: token.session.accountId },
      });
      await rememberKernelBearerFailure(me, 'authenticated account');
      requireStatus(me, 'authenticated account', 200);
      walker.accountId = token.session.accountId;
      evidence.native.push({ j01: walker.accountId, callback: token.codePath });
      return `signup ${walker.handle}; callback ${token.codePath}`;
    });

    await runJourney('J02', 'POST /signin → GET /sessions → POST /sessions/revoke', async () => {
      const person = walker ?? (await signup(stack, 'j02'));
      const session = await signIn(stack, person, 'login', []);
      const listed = await send(`${stack.native}/sessions`, {
        method: 'GET',
        cookie: session.cookie,
        origin: stack.issuer,
      });
      requireStatus(listed, 'session review', [200, 204]);
      const items = Array.isArray(listed.value.items)
        ? (listed.value.items as Json[])
        : Array.isArray(listed.value.sessions)
          ? (listed.value.sessions as Json[])
          : [];
      const current = items.find((item) => item.current === true) ?? items[0];
      const sessionId =
        typeof current?.id === 'string'
          ? current.id
          : typeof listed.value.viewer === 'object' && listed.value.viewer
            ? String((listed.value.viewer as Json).session_id ?? '')
            : '';
      if (sessionId) {
        const revoked = await auth(stack, '/sessions/revoke', session, { session_id: sessionId });
        requireStatus(revoked, 'session revoke', [200, 204]);
      }
      const after = await send(`${stack.native}/sessions`, {
        method: 'GET',
        cookie: session.cookie,
        origin: stack.issuer,
      });
      if (after.status === 200 && sessionId && JSON.stringify(after.value).includes(sessionId))
        throw new Error('revoked session still listed');
      return sessionId ? `revoked ${sessionId}` : `session review HTTP ${listed.status}`;
    });

    await runJourney('J03', 'POST /recovery/start → POST /recovery/complete → POST /signin', async () =>
      originalJ03(stack),
    );

    await runJourney('J04', 'POST /credential-effects → GET /sessions → POST /sessions/revoke', async () =>
      originalJ04(stack),
    );

    await runJourney('J05', 'PATCH /v1/accounts/{id} → GET /v1/accounts?handle=', async () => {
      const person = walker ?? (await signup(stack, 'j05'));
      const token = await websiteToken(stack, person, bindings, keys.website);
      const patched = await kernel(stack, 'PATCH', `/v1/accounts/${token.session.accountId}`, {
        bearer: token.bearer,
        body: { displayName: 'Walk profile', biography: 'Goal walk biography' },
      });
      requireStatus(patched, 'profile save', 200);
      const publicRead = requireStatus(
        await kernel(stack, 'GET', '/v1/accounts', { query: { handle: person.handle } }),
        'independent public profile',
        200,
      );
      const row = accountRow(publicRead);
      if (row?.displayName !== 'Walk profile') throw new Error(`public displayName ${String(row?.displayName)}`);
      if (row && ('email' in row || 'credentials' in row)) throw new Error('public profile disclosed private fields');
      return 'independent handle readback matched';
    });

    await runJourney('J06', 'POST /account-operations organization → membership', async () => {
      const operations = await developerSignIn(AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES.organization);
      orgHandle = handle('org');
      const created = await operate(stack, operations, { kind: 'organization', handle: orgHandle });
      if (created.status !== 200)
        throw new Error(`organization create HTTP ${created.status}: ${summarize(created.value)}`);
      organizationId = asId(created.value.accountId, 'organization');
      dest = dest ?? (await signup(stack, 'dst'));
      outsider = outsider ?? (await signup(stack, 'out'));
      const membership = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.membership);
      const added = await operate(stack, membership, {
        kind: 'membership',
        organizationId,
        memberAccountId: dest.accountId,
        role: 'member',
      });
      if (added.status !== 200) throw new Error(`membership HTTP ${added.status}: ${summarize(added.value)}`);
      evidence.native.push({ organizationId, orgHandle, member: dest.accountId });
      return `organization ${orgHandle}`;
    });
    if (rows.get('J06')?.result === 'FAIL') await failDependents(['J07'], rows.get('J06')!.cause, 'J06 organization');

    await runJourney('J07', 'POST /account-operations membership role=owner → management read', async () => {
      if (!organizationId || !dest) throw new Error('organization create did not yield an identity');
      const membership = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.membership);
      const selected = await auth(stack, '/account-management/organizations/member', membership, {
        organizationId,
        memberAccountId: dest.accountId,
      });
      requireStatus(selected, 'selected member', 200);
      const reservation = (selected.value.membership as Json | undefined)?.reservationId;
      if (typeof reservation !== 'string') throw new Error('selected member omitted reservation');
      const promoted = await operate(stack, membership, {
        kind: 'membership',
        organizationId,
        memberAccountId: dest.accountId,
        role: 'owner',
        reservationId: reservation,
      });
      if (promoted.status !== 200)
        throw new Error(`owner promotion HTTP ${promoted.status}: ${summarize(promoted.value)}`);
      const destToken = await websiteToken(stack, dest, bindings, keys.website);
      const detail = await kernel(stack, 'GET', `/v1/accounts/${organizationId}/management`, {
        bearer: destToken.bearer,
      });
      requireStatus(detail, 'new owner management', 200);
      return `dest owner role ${String(detail.value.role)}`;
    });

    await runJourney('J08', 'POST /account-operations rename → GET /v1/accounts?handle=', async () => {
      const person = await signup(stack, 'j08');
      const renameSession = await signIn(stack, person, AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.rename);
      const nextHandle = handle('ren');
      const renamed = await operate(stack, renameSession, {
        kind: 'rename',
        accountId: person.accountId,
        handle: nextHandle,
        expectedHandle: person.handle,
      });
      if (renamed.status !== 200) throw new Error(`rename HTTP ${renamed.status}: ${summarize(renamed.value)}`);
      const next = accountRow(
        requireStatus(await kernel(stack, 'GET', '/v1/accounts', { query: { handle: nextHandle } }), 'new handle', 200),
      );
      if (next?.id !== person.accountId) throw new Error('new handle did not resolve to the same account');
      const former = accountRow(
        requireStatus(
          await kernel(stack, 'GET', '/v1/accounts', { query: { handle: person.handle } }),
          'former handle',
          200,
        ),
      );
      if (former && former.id !== person.accountId && former.movedTo !== nextHandle)
        throw new Error('former handle did not retire toward the new address');
      person.handle = nextHandle;
      return `renamed to ${nextHandle}`;
    });

    await runJourney('J09', 'POST /account-operations automated → POST /operator-sessions/open', async () => {
      const management = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.transfer);
      const softwareHandle = handle('bot');
      const operationKey = crypto.randomUUID();
      const operation = {
        kind: 'automated',
        registrationId: '',
        operationKey,
        operatorAccountId: developer.accountId,
        handle: softwareHandle,
      };
      const approval = await auth(
        stack,
        '/account-operations/approve',
        management,
        {
          operationKey,
          operation,
          accountId: management.accountId,
        },
        30_000,
      );
      if (approval.status !== 200)
        throw new Error(`software approval HTTP ${approval.status}: ${summarize(approval.value)}`);
      const executed = await auth(
        stack,
        '/account-operations/execute',
        management,
        {
          operationKey,
          operation,
          accountId: management.accountId,
          reference: approval.value.reference,
        },
        30_000,
      );
      if (executed.status !== 200)
        throw new Error(`software execute HTTP ${executed.status}: ${summarize(executed.value)}`);
      humanSoftwareId = asId(executed.value.accountId, 'software');
      const passwordSet = await credentialEffect(stack, management, humanSoftwareId, {
        kind: 'password',
        password: softwarePassword,
      });
      if (passwordSet.status !== 200)
        throw new Error(`software password HTTP ${passwordSet.status}: ${summarize(passwordSet.value)}`);
      const opening = await developerSignIn(AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.opening);
      const openingKey = crypto.randomUUID();
      const openingOperation = {
        kind: 'opening',
        operatorAccountId: opening.accountId,
        subjectAccountId: humanSoftwareId,
      };
      const openingApproval = await auth(
        stack,
        '/account-operations/approve',
        opening,
        {
          operationKey: openingKey,
          operation: openingOperation,
          accountId: opening.accountId,
        },
        30_000,
      );
      requireStatus(openingApproval, 'operator approve', 200);
      const opened = await auth(
        stack,
        '/operator-sessions/open',
        opening,
        {
          operationKey: openingKey,
          operation: openingOperation,
          accountId: opening.accountId,
          reference: openingApproval.value.reference,
        },
        30_000,
      );
      requireStatus(opened, 'operator opening', 200);
      if (opened.value.account_id !== humanSoftwareId) throw new Error('operator opening returned a foreign actor');
      outsider = outsider ?? (await signup(stack, 'out'));
      const outsiderSession = await signIn(stack, outsider, AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES.opening);
      const outsiderKey = crypto.randomUUID();
      const outsiderOperation = {
        kind: 'opening',
        operatorAccountId: outsider.accountId,
        subjectAccountId: humanSoftwareId,
      };
      const outsiderApproval = await auth(
        stack,
        '/account-operations/approve',
        outsiderSession,
        {
          operationKey: outsiderKey,
          operation: outsiderOperation,
          accountId: outsiderSession.accountId,
        },
        30_000,
      );
      if (outsiderApproval.status === 200) {
        const outsiderOpened = await auth(
          stack,
          '/operator-sessions/open',
          outsiderSession,
          {
            operationKey: outsiderKey,
            operation: outsiderOperation,
            accountId: outsiderSession.accountId,
            reference: outsiderApproval.value.reference,
          },
          30_000,
        );
        if (outsiderOpened.status === 200) throw new Error('outsider opened the software session');
        return `software ${humanSoftwareId}; outsider open HTTP ${outsiderOpened.status}`;
      }
      return `software ${humanSoftwareId}; outsider approve HTTP ${outsiderApproval.status}`;
    });

    await runJourney('J10', 'GET /authorize grant → POST /revoke → GET /v1/accounts/{id}/profile', async () =>
      originalJ10(stack, bindings, keys.website),
    );

    await runJourney('J11', 'POST /v1/accounts/{id}:requestVerification → POST :withdrawVerification', async () => {
      const person = walker ?? (await signup(stack, 'j11'));
      const token = await websiteToken(stack, person, bindings, keys.website);
      const opened = await kernel(stack, 'POST', '/v1/platform/exposure/agent_verification:open', {
        bearer: website.bearer,
        body: {},
      });
      if (![200, 409, 403].includes(opened.status))
        throw new Error(`agent_verification open HTTP ${opened.status}: ${summarize(opened.value)}`);
      const requested = await kernel(stack, 'POST', `/v1/accounts/${token.session.accountId}:requestVerification`, {
        bearer: token.bearer,
        body: {
          subject: GLOBAL_CONTEXT,
          statement: 'Goal walk verification of the Global Context address.',
          links: [],
        },
      });
      if (requested.status === 201) {
        const withdrawn = await kernel(stack, 'POST', `/v1/accounts/${token.session.accountId}:withdrawVerification`, {
          bearer: token.bearer,
          body: {},
        });
        requireStatus(withdrawn, 'withdraw verification', 200);
        const publicRead = requireStatus(
          await kernel(stack, 'GET', '/v1/accounts', { query: { handle: person.handle } }),
          'unverified public readback',
          200,
        );
        return `requested then withdrawn; public ${String(accountRow(publicRead)?.id)}`;
      }
      throw new Error(
        `requestVerification HTTP ${requested.status}: ${summarize(requested.value)}; no catalogue agent identity on this walk stack`,
      );
    });

    await runJourney('J12', 'GET /v1/accounts?handle= person/organization/agent', async () => {
      const person = walker ?? { handle: developer.handle, email: developer.email, accountId: developer.accountId };
      const personRow = accountRow(
        requireStatus(
          await kernel(stack, 'GET', '/v1/accounts', { query: { handle: person.handle } }),
          'public person',
          200,
        ),
      );
      if (!personRow || personRow.kind === 'organization') throw new Error('person page missing or mistyped');
      if ('email' in personRow || 'credentials' in personRow) throw new Error('person page disclosed private fields');
      evidence.native.push({ publicPerson: person.handle, id: personRow.id });
      const missing: string[] = [];
      if (!organizationId) missing.push('organization (J06)');
      else {
        const orgRow = accountRow(
          requireStatus(
            await kernel(stack, 'GET', '/v1/accounts', { query: { handle: orgHandle } }),
            'public organization',
            200,
          ),
        );
        if (orgRow?.kind !== 'organization' || orgRow.id !== organizationId)
          throw new Error('organization page identity mismatch');
        if (orgRow && ('email' in orgRow || 'credentials' in orgRow))
          throw new Error('organization page disclosed private fields');
      }
      if (!humanSoftwareId) missing.push('software (J09)');
      else {
        const agent = requireStatus(
          await kernel(stack, 'GET', '/v1/accounts', { query: { ids: humanSoftwareId } }),
          'public agent',
          200,
        );
        const agentRow = accountRow(agent);
        if (!agentRow || agentRow.id !== humanSoftwareId) throw new Error('agent page identity mismatch');
        if (agentRow && ('email' in agentRow || 'credentials' in agentRow))
          throw new Error('agent page disclosed private fields');
      }
      if (missing.length)
        throw new Error(`person public HTTP 200 without private fields; not reached: ${missing.join(', ')}`);
      return 'person, organization and agent omit private fields';
    });

    await runJourney('J13', 'PUT /v1/follows/{id} → GET /v1/follows → DELETE /v1/follows/{id}', async () => {
      const follower = walker ?? (await signup(stack, 'j13a'));
      followTarget = await signup(stack, 'j13b');
      const token = await websiteToken(stack, follower, bindings, keys.website);
      followTargetId = await waitForPublicAgentSubject(stack, followTarget.handle, 'follow target');
      const followed = await kernel(stack, 'PUT', `/v1/follows/${followTargetId}`, { bearer: token.bearer });
      if (followed.status !== 200) throw new Error(`follow HTTP ${followed.status}: ${summarize(followed.value)}`);
      const listed = await kernel(stack, 'GET', '/v1/follows', { bearer: token.bearer, query: { limit: '20' } });
      requireStatus(listed, 'Following', 200);
      const removed = await kernel(stack, 'DELETE', `/v1/follows/${followTargetId}`, { bearer: token.bearer });
      requireStatus(removed, 'unfollow', 200);
      const again = await kernel(stack, 'PUT', `/v1/follows/${followTargetId}`, { bearer: token.bearer });
      requireStatus(again, 'refollow', 200);
      const deleteSession = await signIn(
        stack,
        followTarget,
        AUTH_PAGE_OPERATION_CLIENT_ID,
        AUTH_PAGE_OPERATION_SCOPES.delete,
      );
      const erased = await operate(
        stack,
        deleteSession,
        { kind: 'delete', accountId: followTarget.accountId },
        { confirmation: followTarget.handle },
      );
      const unavailable = await kernel(stack, 'DELETE', `/v1/follows/${followTargetId}`, { bearer: token.bearer });
      if (unavailable.status !== 200 && erased.status !== 200)
        throw new Error(
          `unavailable unfollow HTTP ${unavailable.status} after target delete HTTP ${erased.status}: ${summarize(unavailable.value)}`,
        );
      if (unavailable.status !== 200)
        throw new Error(`stored unavailable unfollow HTTP ${unavailable.status}: ${summarize(unavailable.value)}`);
      return `followed then removed unavailable ${followTargetId}`;
    });

    await runJourney('J14', 'GET /v1/followCounts/outgoing → stranger GET /v1/followCounts/{type}/{id}', async () => {
      const anonymous = await kernel(stack, 'GET', '/v1/followCounts/outgoing');
      if (anonymous.status === 200 && typeof anonymous.value.followingCount === 'number')
        throw new Error('anonymous reader received a private outgoing count');
      if (kernelBearerCause)
        throw new Error(`anonymous outgoing HTTP ${anonymous.status}; not reached: own count (${kernelBearerCause})`);
      const follower = walker ?? (await signup(stack, 'j14a'));
      const target = outsider ?? (await signup(stack, 'j14b'));
      const token = await websiteToken(stack, follower, bindings, keys.website);
      const stranger = await websiteToken(stack, target, bindings, keys.website);
      const subjectId = await waitForPublicAgentSubject(stack, target.handle, 'count target');
      await kernel(stack, 'PUT', `/v1/follows/${subjectId}`, { bearer: token.bearer });
      const own = await kernel(stack, 'GET', '/v1/followCounts/outgoing', { bearer: token.bearer });
      await rememberKernelBearerFailure(own, 'own outgoing count');
      requireStatus(own, 'own outgoing count', 200);
      if (typeof own.value.followingCount !== 'number') throw new Error('outgoing omitted followingCount');
      const concealed = await kernel(stack, 'GET', `/v1/followCounts/subject/${subjectId}`, {
        bearer: stranger.bearer,
      });
      if (concealed.status === 200 && typeof concealed.value.followerCount === 'number')
        throw new Error('unrelated reader received the private follower aggregate');
      return `own followingCount ${String(own.value.followingCount)}; stranger HTTP ${concealed.status}; anonymous HTTP ${anonymous.status}`;
    });

    await runJourney(
      'J15',
      'POST /v1/spaces → POST /v1/realms → POST /v1/realms/{id}/membership → DELETE',
      async () => {
        const member = dest ?? (await signup(stack, 'j15'));
        const ownerToken = website;
        const space = await kernel(stack, 'POST', '/v1/spaces', {
          bearer: ownerToken.bearer,
          body: { title: 'Accounts walk Space', summary: 'Goal walk protected membership' },
        });
        if (space.status !== 201) throw new Error(`space create HTTP ${space.status}: ${summarize(space.value)}`);
        spaceId = asId((space.value.space as Json | undefined)?.spaceId ?? space.value.spaceId, 'space');
        const realm = await kernel(stack, 'POST', '/v1/realms', {
          bearer: ownerToken.bearer,
          body: {
            spaceId,
            title: 'Accounts walk Realm',
            summary: 'Goal walk protected reads',
            visibility: 'protected',
            contextId: GLOBAL_CONTEXT,
          },
        });
        if (realm.status !== 201) throw new Error(`realm create HTTP ${realm.status}: ${summarize(realm.value)}`);
        realmId = asId((realm.value.realm as Json | undefined)?.realmId ?? realm.value.realmId, 'realm');
        const memberToken = await websiteToken(stack, member, bindings, keys.website);
        const joined = await kernel(stack, 'POST', `/v1/realms/${realmId}/members`, {
          bearer: ownerToken.bearer,
          body: { accountId: member.accountId },
        });
        if (![200, 201, 202].includes(joined.status))
          throw new Error(`join HTTP ${joined.status}: ${summarize(joined.value)}`);
        const allowed = await untilStatus(
          () => kernel(stack, 'GET', `/v1/realms/${realmId}/members/me`, { bearer: memberToken.bearer }),
          'protected member read',
          200,
        );
        const left = await kernel(stack, 'DELETE', `/v1/realms/${realmId}/membership`, { bearer: memberToken.bearer });
        if (![200, 202, 204].includes(left.status))
          throw new Error(`leave HTTP ${left.status}: ${summarize(left.value)}`);
        const after = await kernel(stack, 'GET', `/v1/realms/${realmId}/members/me`, { bearer: memberToken.bearer });
        if (after.status === 200) throw new Error('member read still succeeded after leave');
        return `realm ${realmId} leave HTTP ${after.status}`;
      },
    );
    if (rows.get('J15')?.result === 'FAIL') await failDependents(['J16'], rows.get('J15')!.cause, 'J15 realm');

    await runJourney('J16', 'PUT /v1/realms/{id}/bans/{accountId} → GET members/me → POST members', async () => {
      if (!realmId) throw new Error('realm create did not yield an identity');
      const banned = dest ?? (await signup(stack, 'j16'));
      const memberToken = await websiteToken(stack, banned, bindings, keys.website);
      const joined = await kernel(stack, 'POST', `/v1/realms/${realmId}/members`, {
        bearer: website.bearer,
        body: { accountId: banned.accountId },
      });
      if (![200, 201, 202].includes(joined.status))
        throw new Error(`rejoin HTTP ${joined.status}: ${summarize(joined.value)}`);
      await untilStatus(
        () => kernel(stack, 'GET', `/v1/realms/${realmId}/members/me`, { bearer: memberToken.bearer }),
        'rejoined member read',
        200,
      );
      const ban = await kernel(stack, 'PUT', `/v1/realms/${realmId}/bans/${banned.accountId}`, {
        bearer: website.bearer,
        body: { reason: 'Goal walk ban' },
      });
      if (![200, 201, 202].includes(ban.status)) throw new Error(`ban HTTP ${ban.status}: ${summarize(ban.value)}`);
      const hidden = await kernel(stack, 'GET', `/v1/realms/${realmId}/members/me`, { bearer: memberToken.bearer });
      if (hidden.status === 200) throw new Error('banned member still read membership before cleanup');
      const selfJoin = await kernel(stack, 'POST', `/v1/realms/${realmId}/membership`, {
        bearer: memberToken.bearer,
        body: {},
      });
      if (selfJoin.status === 200 || selfJoin.status === 201 || selfJoin.status === 202)
        throw new Error('banned member rejoined before unban');
      const lifted = await kernel(stack, 'DELETE', `/v1/realms/${realmId}/bans/${banned.accountId}`, {
        bearer: website.bearer,
      });
      if (![200, 202, 204].includes(lifted.status))
        throw new Error(`unban HTTP ${lifted.status}: ${summarize(lifted.value)}`);
      const readmit = await kernel(stack, 'POST', `/v1/realms/${realmId}/members`, {
        bearer: website.bearer,
        body: { accountId: banned.accountId },
      });
      if (![200, 201, 202].includes(readmit.status))
        throw new Error(`authorized readmission HTTP ${readmit.status}: ${summarize(readmit.value)}`);
      await untilStatus(
        () => kernel(stack, 'GET', `/v1/realms/${realmId}/members/me`, { bearer: memberToken.bearer }),
        'readmitted member read',
        200,
      );
      return `ban HTTP ${ban.status}; readmission HTTP ${readmit.status}`;
    });

    await runJourney('J17', 'PATCH /v1/accounts/{id}/preferences → GET reopen', async () => {
      const person = walker ?? (await signup(stack, 'j17'));
      const token = await websiteToken(stack, person, bindings, keys.website);
      const current = requireStatus(
        await kernel(stack, 'GET', `/v1/accounts/${token.session.accountId}/preferences`, { bearer: token.bearer }),
        'preferences open',
        200,
      );
      const version = typeof current.version === 'number' ? current.version : 0;
      const saved = await kernel(stack, 'PATCH', `/v1/accounts/${token.session.accountId}/preferences`, {
        bearer: token.bearer,
        body: { expectedVersion: version, notifications: { reply: false, mention: true } },
      });
      requireStatus(saved, 'preference save', 200);
      const reopened = requireStatus(
        await kernel(stack, 'GET', `/v1/accounts/${token.session.accountId}/preferences`, { bearer: token.bearer }),
        'preferences reopen',
        200,
      );
      const notifications = reopened.notifications as Json | undefined;
      if (notifications?.reply !== false) throw new Error(`reopened reply ${String(notifications?.reply)}`);
      const stranger = outsider ?? (await signup(stack, 'j17b'));
      const other = await websiteToken(stack, stranger, bindings, keys.website);
      const concealed = await kernel(stack, 'GET', `/v1/accounts/${token.session.accountId}/preferences`, {
        bearer: other.bearer,
      });
      if (concealed.status === 200) throw new Error('unrelated reader read notification preferences');
      return 'reply disabled at reopen; stranger denied';
    });

    await runJourney('J18', 'POST /account-operations delete → GET /v1/accounts/{id}', async () => {
      const person = await signup(stack, 'j18');
      const session = await signIn(stack, person, AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES.delete);
      const deleted = await operate(
        stack,
        session,
        { kind: 'delete', accountId: person.accountId },
        { confirmation: person.handle },
      );
      if (deleted.status !== 200) throw new Error(`delete HTTP ${deleted.status}: ${summarize(deleted.value)}`);
      const stale = await auth(
        stack,
        '/signin',
        undefined,
        { email: person.email, password, client_id: 'login', scope: [] },
        15_000,
      );
      if (stale.status === 200) throw new Error('deleted account still signed in');
      const tombstone = await kernel(stack, 'GET', '/v1/accounts', { query: { ids: person.accountId } });
      requireStatus(tombstone, 'retained attribution', 200);
      const row = accountRow(tombstone);
      if (row && row.state !== 'deleted' && row.kind !== undefined && 'handle' in row && row.handle === person.handle)
        throw new Error('deleted identity still published a live handle');
      return `erased ${person.accountId}; attribution HTTP ${tombstone.status}`;
    });

    await runJourney('J19', 'POST /v1/platform/exposure/{group}:open|:close → POST /v1/viewerActions', async () => {
      const person = walker ?? (await signup(stack, 'j19'));
      const token = await websiteToken(stack, person, bindings, keys.website);
      const group = 'agent_verification';
      const opened = await kernel(stack, 'POST', `/v1/platform/exposure/${group}:open`, {
        bearer: website.bearer,
        body: {},
      });
      if (![200, 409].includes(opened.status))
        throw new Error(`open ${group} HTTP ${opened.status}: ${summarize(opened.value)}`);
      const discovery = await kernel(stack, 'POST', '/v1/viewerActions', {
        bearer: token.bearer,
        body: { resources: [{ type: 'access.account', id: person.accountId }] },
      });
      requireStatus(discovery, 'viewer discovery while open', [200, 403]);
      const actual = await kernel(stack, 'GET', `/v1/accounts/${person.accountId}/verification`, {
        bearer: token.bearer,
      });
      const closed = await kernel(stack, 'POST', `/v1/platform/exposure/${group}:close`, {
        bearer: website.bearer,
        body: {},
      });
      if (![200, 409].includes(closed.status))
        throw new Error(`close ${group} HTTP ${closed.status}: ${summarize(closed.value)}`);
      const afterDiscovery = await kernel(stack, 'POST', '/v1/viewerActions', {
        bearer: token.bearer,
        body: { resources: [{ type: 'access.account', id: person.accountId }] },
      });
      const afterActual = await kernel(stack, 'GET', `/v1/accounts/${person.accountId}/verification`, {
        bearer: token.bearer,
      });
      if (afterActual.status === 200 && actual.status === 200 && afterDiscovery.status === discovery.status)
        throw new Error('close did not change discovery or access');
      await kernel(stack, 'POST', `/v1/platform/exposure/${group}:open`, { bearer: website.bearer, body: {} });
      return `open access HTTP ${actual.status}; closed HTTP ${afterActual.status}`;
    });

    const frontends: Array<{ stop: () => Promise<void> }> = [];
    let browser: import('playwright').Browser | undefined;
    try {
      if (process.env.REZICS_WALK_STACK_SLOT) {
        frontends.push(await startFrontend('pages', stack));
        note('auth-pages-ready');
        frontends.push(await startFrontend('web', stack));
        note('web-ready');
      }
      const browserTemp = join(evidenceDir, 'browser');
      await mkdir(browserTemp, { recursive: true, mode: 0o700 });
      if (typeof Bun.gc === 'function') Bun.gc(true);
      const require = createRequire(resolve(root, 'apps/web/package.json'));
      const { chromium } = require('playwright') as typeof import('playwright');
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        env: { ...process.env, TMPDIR: browserTemp },
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--mute-audio',
          '--renderer-process-limit=1',
        ],
      });
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      await page.route('**/*', loopbackOnly);

      const person = walker ?? { handle: developer.handle, email: developer.email, accountId: developer.accountId };
      const secret = walker ? password : developerPassword;

      if (rows.get('J01')?.result === 'PASS') {
        await page.setViewportSize({ width: 1280, height: 1000 });
        await settle(page, `${stack.web}/en/auth/sign-in?return_to=${encodeURIComponent('/en/')}`);
        if (page.url().includes('/login')) await fillPasswordSignIn(page, person.email, secret);
        const approve = page.getByRole('button', { name: 'Approve' });
        if (await approve.isVisible({ timeout: 8_000 }).catch(() => false)) await approve.click();
        await page.waitForURL((url) => url.origin === stack.web, { timeout: 120_000 }).catch(() => {});
        const home = await settle(page, `${stack.web}/en/`);
        evidence.pages.push({
          journey: 'J01',
          path: new URL(page.url()).pathname,
          status: home?.status() ?? 0,
          width: 1280,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: 'dark' });
        const phone = await settle(page, `${stack.web}/en/`);
        evidence.pages.push({
          journey: 'J01',
          path: new URL(page.url()).pathname,
          status: phone?.status() ?? 0,
          width: 390,
        });
        if (rows.get('J02')?.result === 'PASS') {
          await page.setViewportSize({ width: 1280, height: 1000 });
          const security = await settle(page, `${stack.issuer}/security`);
          evidence.pages.push({ journey: 'J02', path: '/security', status: security?.status() ?? 0 });
          await page
            .locator('form[action="/auth/sign-out"]')
            .first()
            .evaluate((form) => (form as HTMLFormElement).requestSubmit())
            .catch(() => {});
        }
      }

      if (person.handle) {
        await page.setViewportSize({ width: 1280, height: 1000 });
        const publicPage = await settle(page, `${stack.web}/en/@${person.handle}`);
        evidence.pages.push({
          journey: 'J12',
          path: `/@${person.handle}`,
          status: publicPage?.status() ?? 0,
          width: 1280,
          title: await page
            .locator('h1')
            .first()
            .textContent()
            .catch(() => null),
        });
        await page.setViewportSize({ width: 390, height: 844 });
        const phonePublic = await settle(page, `${stack.web}/en/@${person.handle}`);
        evidence.pages.push({
          journey: 'J12',
          path: `/@${person.handle}`,
          status: phonePublic?.status() ?? 0,
          width: 390,
        });
        const html = await page.content();
        if (/@example\.test|credentials/i.test(html))
          (evidence.defects as string[]).push('J12 public page included private-looking fields');
      }

      if (rows.get('J17')?.result === 'PASS') {
        await context.clearCookies();
        await settle(
          page,
          `${stack.web}/en/auth/sign-in?return_to=${encodeURIComponent('/en/settings/notifications')}`,
        );
        if (page.url().includes('/login')) await fillPasswordSignIn(page, person.email, secret);
        const settings = await settle(page, `${stack.web}/en/settings/notifications`);
        evidence.pages.push({
          journey: 'J17',
          path: new URL(page.url()).pathname,
          status: settings?.status() ?? 0,
          width: 1280,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        const phoneSettings = await settle(page, `${stack.web}/en/settings/notifications`);
        evidence.pages.push({
          journey: 'J17',
          path: new URL(page.url()).pathname,
          status: phoneSettings?.status() ?? 0,
          width: 390,
        });
      }
      await context.close();
    } catch (error) {
      (evidence.defects as string[]).push(`browser: ${error instanceof Error ? error.message : String(error)}`);
      note(`browser ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await browser?.close();
      for (const frontend of [...frontends].reverse()) await frontend.stop();
      await persist();
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    await failRemaining(cause, 'walk ended');
    note(`walk ended: ${cause}`);
  } finally {
    if ([...rows.values()].some((row) => row.result === 'unobserved'))
      await failRemaining('walk ended before every journey ran', 'walk ended');
    const passing = [...rows.values()].filter((row) => row.result === 'PASS').length;
    const failing = [...rows.values()].filter((row) => row.result === 'FAIL');
    const slowest = [...failing].sort((left, right) => parseInt(right.elapsed, 10) - parseInt(left.elapsed, 10))[0];
    const nextHourly = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    console.log(
      `accounts-goal-walk: ${passing}/19 passing; slowest failing ${slowest ? `${slowest.id} ${slowest.elapsed} ${slowest.cause}` : 'none'}; next hourly due ${nextHourly}`,
    );
    await persist();
  }
}

async function originalJ03(stack: Origins): Promise<string> {
  capturePhase('independent persona signup');
  const person = await signup(stack, 'j03');
  capturePhase('old-password session');
  const oldSession = await signIn(stack, person, 'login', []);
  capturePhase('recovery start');
  const started = await auth(stack, '/recovery/start', undefined, { email: person.email }, 15_000);
  requireStatus(started, 'recovery start', 200);
  capturePhase('local recovery delivery');
  const token = await deliveredRecoveryToken(person.email);
  capturePhase('recovery completion');
  const completed = await auth(
    stack,
    '/recovery/complete',
    undefined,
    { account_id: person.accountId, token, new_password: nextPassword },
    15_000,
  );
  requireStatus(completed, 'recovery complete', 200);
  capturePhase('old-password sign-in refusal');
  captureAuthority({ credential: 'old password', credentialClient: 'login', credentialRelation: 'replaced by recovery' });
  const stale = await auth(
    stack,
    '/signin',
    undefined,
    { email: person.email, password, client_id: 'login', scope: [] },
    15_000,
  );
  if (stale.status === 200) throw new Error('old password still established a session');
  assertAuthorityDenial('auth', stale, 'old-password sign-in refusal');
  capturePhase('new-password sign-in');
  await signIn(stack, person, 'login', [], nextPassword);
  capturePhase('old-session read refusal');
  captureAuthority({
    credential: 'original session cookie',
    sessionRelation: 'established before recovery completion',
    credentialClient: 'login',
  });
  const staleCookie = await send(`${stack.native}/sessions`, {
    method: 'GET',
    cookie: oldSession.cookie,
    origin: stack.issuer,
  });
  if (staleCookie.status === 200) throw new Error('old session retained authority after recovery');
  assertAuthorityDenial('auth', staleCookie, 'original-session read refusal');
  return 'old password and session refused';
}

async function originalJ04(stack: Origins): Promise<string> {
  capturePhase('independent persona signup');
  const person = await signup(stack, 'j04');
  // The registered management client carries only the action scope required by native credential approval.
  capturePhase('fresh same-subject account-management step-up');
  const session = await signIn(
    stack,
    person,
    API_CAPTURE_CREDENTIAL_STEP_UP.clientId,
    API_CAPTURE_CREDENTIAL_STEP_UP.scopes,
  );
  capturePhase('credential replacement');
  const changed = await credentialEffect(stack, session, session.accountId, {
    kind: 'password',
    password: nextPassword,
  });
  if (changed.status !== 200) {
    throwIfUnknownResponse(changed);
    throw new Error(`credential effect HTTP ${changed.status}: ${summarize(changed.value)}`);
  }
  capturePhase('old-password sign-in refusal');
  captureAuthority({ credential: 'old password', credentialClient: 'login', credentialRelation: 'replaced by effect' });
  const stale = await auth(
    stack,
    '/signin',
    undefined,
    { email: person.email, password, client_id: 'login', scope: [] },
    15_000,
  );
  if (stale.status === 200) throw new Error('old password still signed in after credential replace');
  assertAuthorityDenial('auth', stale, 'old-password sign-in refusal');
  capturePhase('new-password sign-in');
  const fresh = await signIn(stack, person, 'login', [], nextPassword);
  capturePhase('current-session readback');
  captureAuthority({ credential: 'replacement password', sessionRelation: 'current session after replacement' });
  const listed = await send(`${stack.native}/sessions`, {
    method: 'GET',
    cookie: fresh.cookie,
    origin: stack.issuer,
  });
  requireStatus(listed, 'security sessions', [200, 204]);
  const sessions = listed.value.sessions;
  if (!Array.isArray(sessions) || !sessions.some((entry) => entry && typeof entry === 'object' && (entry as Json).current === true))
    throw new Error('replacement password session was absent from the independent current-session readback');
  captureAuthority({ currentSessionReadback: 'replacement password sign-in listed as current' });
  return `password replaced HTTP ${changed.status}`;
}

async function originalJ10(stack: Origins, bindings: Record<string, string>, websiteKey: JWK): Promise<string> {
  capturePhase('independent persona signup');
  const person = await signup(stack, 'j10');
  capturePhase('website OAuth');
  const granted = await websiteToken(stack, person, bindings, websiteKey);
  const resource = bindings.API_RESOURCE ?? WEBSITE_AUDIENCE;
  captureAuthority({
    subjectAccountId: granted.session.accountId,
    sameSubject: granted.session.accountId === person.accountId,
    client: WEBSITE_CLIENT_ID,
    issuer: stack.issuer,
    resource,
    tokenKind: 'access_token',
    bearerRelation: 'website bearer issued to this account',
  });
  capturePhase('admitted Kernel bearer read');
  const before = await kernel(stack, 'GET', `/v1/accounts/${granted.session.accountId}/profile`, {
    bearer: granted.bearer,
  });
  requireStatus(before, 'consented profile', 200);
  captureAuthority({ bearerAuthority: 'admitted before refresh-family revocation' });
  if (!granted.refresh) throw new Error('website token omitted refresh_token');
  capturePhase('website refresh-family revoke');
  const revoked = await send(`${stack.native}/revoke`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/x-www-form-urlencoded' },
    encoded: new URLSearchParams({
      client_id: WEBSITE_CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await websiteAssertion(stack, websiteKey),
      resource: bindings.API_RESOURCE ?? WEBSITE_AUDIENCE,
      token: granted.refresh,
      token_type_hint: 'refresh_token',
    }).toString(),
    timeout: 30_000,
  });
  if (revoked.status !== 200) {
    throwIfUnknownResponse(revoked);
    throw new Error(`website revoke returned HTTP ${revoked.status}: ${summarize(revoked.value)}`);
  }
  captureAuthority({ refreshFamilyRevocation: 'acknowledged', refreshTokenKind: 'refresh_token' });
  capturePhase('formerly admitted Kernel bearer denial');
  const after = await kernel(stack, 'GET', `/v1/accounts/${granted.session.accountId}/profile`, {
    bearer: granted.bearer,
  });
  if (after.status === 200) throw new Error('revoked website family still read the editable profile');
  assertAuthorityDenial('kernel', after, 'formerly admitted Kernel bearer read');
  return `profile after revoke HTTP ${after.status}`;
}
