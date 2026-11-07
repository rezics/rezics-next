/**
 * Bounded local stacks for walk-and-repair tasks. A worker whose brief lists native or browser acceptance runs one
 * stack through `dev-stack.ts walk`. At most `REZICS_WALK_STACKS` stacks (default six) run on this host at once, and a
 * further start waits in arrival order with its position shown. An admitted stack owns its slot's loopback ports and
 * its task's container and volume names, so stacks cannot collide with each other or with a developer's stack.
 */
import { spawnSync } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { type StackSlot, acquireStackSlot } from './stack-lease.ts';
import { ensureWalkStackDirectory, walkStackDirectory } from './stack-run.ts';

export {
  dropFileCache,
  reclaimBytesFromStat,
  reclaimInactiveFileCache,
  releaseWalkFileCache,
  walkCgroupPath,
} from './walk-memory.ts';

export const WALK_STACKS_DEFAULT = 6;
const WALK_STACKS_MAXIMUM = 1000;
/** Each slot owns ten loopback ports from here, below the ephemeral range; a stack uses six of them. */
const PORT_BASE = 20_000;
const PORTS_PER_SLOT = 10;
/** A waiting start repeats its position at least this often. */
const POSITION_INTERVAL_MS = 10_000;

export type WalkNames = { prefix: string; database: string; search: string };
export type WalkPorts = {
  web: number;
  issuer: number;
  native: number;
  kernel: number;
  database: number;
  search: number;
};

type WalkStackPortAvailability = (ports: WalkPorts) => Promise<boolean>;

/** The host policy: a positive count, bounded so every slot's ports stay below the ephemeral range. */
export function walkStackLimit(env: Record<string, string | undefined>): number {
  const value = env.REZICS_WALK_STACKS;
  if (value === undefined) return WALK_STACKS_DEFAULT;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > WALK_STACKS_MAXIMUM)
    throw new Error(
      `REZICS_WALK_STACKS must be an integer from 1 to ${WALK_STACKS_MAXIMUM}, received ${JSON.stringify(value)}`,
    );
  return Number(value);
}

/** Container and volume names carry the task and slot, so a stuck container cannot block a later slot. */
export function walkStackNames(task: string, index: number): WalkNames {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(task))
    throw new Error(`GOAL_TASK_ID cannot name a walk stack: ${JSON.stringify(task)}`);
  if (!Number.isInteger(index) || index < 1)
    throw new Error(`walk stack slot must be a positive integer, received ${index}`);
  const prefix = `rezics-walk-${task}-${index}`;
  return { prefix, database: `${prefix}-database`, search: `${prefix}-search` };
}

export function walkStackPorts(index: number): WalkPorts {
  const base = PORT_BASE + PORTS_PER_SLOT * index;
  return { web: base, issuer: base + 1, native: base + 2, kernel: base + 3, database: base + 4, search: base + 5 };
}

/** First Web compile can exceed a short poll; aborting that request prevents Vite from listening. */
export const WALK_READY_DEADLINE_MS = 1_200_000;
export const WALK_READY_FETCH_MS = 120_000;
export const WALK_READY_POLL_MS = 2_000;
export const WALK_DOCKER_REMOVE_MS = 120_000;
export const WALK_PROCESS_STOP_MS = 8_000;

/** Use the remaining window, never a short abort that strands Vite's first compile. */
export function walkReadyFetchTimeoutMs(remainingMs: number): number {
  return Math.max(WALK_READY_FETCH_MS, remainingMs);
}

export type WalkOriginProbe = { listening: true } | { listening: false; error: NodeJS.ErrnoException };

/** True when something already accepts TCP on the origin; connection refused is not a hung compile. */
export function walkOriginListening(url: string, timeoutMs = 500): Promise<boolean> {
  return walkOriginProbe(url, timeoutMs).then((result) => result.listening);
}

/** Probe the origin and keep the socket error or timeout; never substitute ECONNREFUSED. */
export function walkOriginProbe(url: string, timeoutMs = 500): Promise<WalkOriginProbe> {
  const parsed = new URL(url);
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    const done = (result: WalkOriginProbe) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done({ listening: true }));
    socket.once('error', (error: NodeJS.ErrnoException) => done({ listening: false, error }));
    socket.setTimeout(timeoutMs, () =>
      done({
        listening: false,
        error: Object.assign(new Error(`connect timeout ${url}`), { code: 'ETIMEDOUT' }),
      }),
    );
  });
}

type StoppableChild = {
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<number>;
  exitCode: number | null;
  signalCode: number | NodeJS.Signals | null;
};

/** SIGTERM, then SIGKILL so a walk cannot wait forever on a worker that ignores shutdown. */
export async function stopSpawned(child: StoppableChild, timeoutMs = WALK_PROCESS_STOP_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timedOut = await Promise.race([child.exited.then(() => false), Bun.sleep(timeoutMs).then(() => true)]);
  if (timedOut && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await child.exited;
}

/** A released lease may leave another task's containers behind; never claim their listening ports. */
export async function walkPortsAvailable(ports: Iterable<number>): Promise<boolean> {
  const reservations: Server[] = [];
  try {
    for (const port of ports) {
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
      });
      reservations.push(server);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return false;
    throw error;
  } finally {
    await Promise.all(
      reservations.map(
        (server) =>
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ),
    );
  }
}

/** Host ports Docker has already published, including stopped containers that still hold the mapping. */
export function publishedHostPorts(dockerPsPorts: string): Set<number> {
  const ports = new Set<number>();
  for (const match of dockerPsPorts.matchAll(/:(\d+)->/g)) ports.add(Number(match[1]));
  return ports;
}

function dockerPublishedPorts(): Set<number> {
  try {
    const result = spawnSync('docker', ['ps', '-a', '--format', '{{.Ports}}'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.status !== 0) return new Set();
    return publishedHostPorts(result.stdout);
  } catch {
    return new Set();
  }
}

/** Docker already refused this host port, even when nothing is listening yet. */
export function walkPortAllocated(text: string): boolean {
  return /port is already allocated/i.test(text);
}

/** Docker refused this admitted slot's published mapping; the walk skips it and admits another. */
export class WalkPublishedPortAllocated extends Error {
  readonly index: number;
  readonly detail: string;
  constructor(index: number, detail: string) {
    super(`walk: slot ${index} published port is already allocated`);
    this.name = 'WalkPublishedPortAllocated';
    this.index = index;
    this.detail = detail;
  }
}

/** Classify a failed setup process whose output already contains Docker's allocated-port refusal. */
export function walkPublishedPortAllocated(
  status: number,
  output: string,
  index: number,
): WalkPublishedPortAllocated | undefined {
  if (status === 0 || !walkPortAllocated(output)) return undefined;
  return new WalkPublishedPortAllocated(index, output);
}

/** A surviving container can own a slot's ports after its launcher's flock has been released. */
export async function walkStackPortsAvailable(ports: WalkPorts): Promise<boolean> {
  const published = dockerPublishedPorts();
  for (const port of Object.values(ports)) {
    if (published.has(port)) return false;
  }
  return walkPortsAvailable(Object.values(ports));
}

/**
 * Whether `url` currently answers below HTTP 500. A listener that accepts TCP and never writes
 * must not stall the walk's ready wait: abort and a hard budget both settle as not ready.
 */
export async function walkHttpAnswers(url: string, budgetMs = 2_000): Promise<boolean> {
  return await Promise.race([
    fetch(url, { signal: AbortSignal.timeout(budgetMs) }).then(
      (response) => response.status < 500,
      () => false,
    ),
    Bun.sleep(budgetMs + 500).then(() => false),
  ]);
}

const WALK_PAGE_LOCALE = /^\/(en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(\/|$)/;
const VITE_IMPORT_FAILURE = /Failed to resolve import|ENOENT: no such file or directory|messages\/access_account\.js/i;

/** Seeded frontends wait on the localized home, not `/`, so a Vite that never compiled `/en` is not ready. */
export const SEEDED_WEB_READY_PATH = '/en';

export function walkUrlNeedsHtml(url: string): boolean {
  const path = new URL(url).pathname;
  return path === '/' || path === '' || WALK_PAGE_LOCALE.test(path);
}

export function walkPageBodyIsUseful(body: string): boolean {
  return /<html[\s>]/i.test(body) && !VITE_IMPORT_FAILURE.test(body);
}

/**
 * A useful Vite page is HTTP 200 HTML without a missing generated-module overlay. Status 404/500 or
 * `messages/access_account.js` ENOENT is still compiling or broken, not ready.
 */
export async function walkUsefulPageResponse(url: string, budgetMs = 2_000): Promise<boolean> {
  return await Promise.race([
    fetch(url, { signal: AbortSignal.timeout(budgetMs) }).then(
      async (response) => {
        if (response.status !== 200) return false;
        const type = response.headers.get('content-type') ?? '';
        if (type && !/html|text\/plain/i.test(type) && !/json/i.test(type)) return false;
        return walkPageBodyIsUseful(await response.text());
      },
      () => false,
    ),
    Bun.sleep(budgetMs + 500).then(() => false),
  ]);
}

/** Pages need HTML; JWKS and Kernel definitions need a non-500 reply. */
export async function walkReadyResponse(url: string, budgetMs = 2_000): Promise<boolean> {
  return walkUrlNeedsHtml(url) ? walkUsefulPageResponse(url, budgetMs) : walkHttpAnswers(url, budgetMs);
}

/** Extra hydration monitor: an observed ECONNREFUSED while Vite compiles `/en` is startup, not a finished process. */
export function hydrationMonitorMessage(url: string, error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'ECONNREFUSED') return undefined;
  return `stack: hydration ${url} ${code}`;
}

export type WalkFetchObservation = { ready: true } | { ready: false; error?: unknown; status?: number };

export type WalkReadyWaiting =
  | { kind: 'probe'; url: string; error: unknown }
  | { kind: 'fetch'; url: string; error?: unknown; status?: number }
  | { kind: 'child-exit'; url: string; code: string };

function fetchWaiting(
  url: string,
  result: Extract<WalkFetchObservation, { ready: false }>,
): Extract<WalkReadyWaiting, { kind: 'fetch' }> {
  return {
    kind: 'fetch',
    url,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.status === undefined ? {} : { status: result.status }),
  };
}

export type WalkReadyChild = {
  exitCode: number | null;
  signalCode: number | NodeJS.Signals | null;
};

/** Fetch the origin and keep HTTP status or the rejected cause; a closed probe is not this path. */
export async function walkReadyFetchObservation(url: string, budgetMs = 2_000): Promise<WalkFetchObservation> {
  try {
    return await Promise.race([
      fetch(url, { signal: AbortSignal.timeout(budgetMs) }).then(
        async (response): Promise<WalkFetchObservation> => {
          if (walkUrlNeedsHtml(url)) {
            if (response.status !== 200) return { ready: false, status: response.status };
            const type = response.headers.get('content-type') ?? '';
            if (type && !/html|text\/plain/i.test(type) && !/json/i.test(type))
              return { ready: false, status: response.status };
            return walkPageBodyIsUseful(await response.text())
              ? { ready: true }
              : { ready: false, status: response.status };
          }
          return response.status < 500 ? { ready: true } : { ready: false, status: response.status };
        },
        (error: unknown): WalkFetchObservation => ({ ready: false, error }),
      ),
      Bun.sleep(budgetMs + 500).then((): WalkFetchObservation => ({
        ready: false,
        error: Object.assign(new Error(`fetch timeout ${url}`), { code: 'ETIMEDOUT' }),
      })),
    ]);
  } catch (error) {
    return { ready: false, error };
  }
}

/** Progress text for one not-ready origin: observed probe, fetch or child-exit, never an invented ECONNREFUSED. */
export function walkReadyWaitingMessage(waiting: WalkReadyWaiting): string {
  if (waiting.kind === 'child-exit') return `stack: child exited ${waiting.code} waiting for ${waiting.url}`;
  const error = waiting.error;
  const hydration = error !== undefined ? hydrationMonitorMessage(waiting.url, error) : undefined;
  if (hydration) return hydration;
  if (waiting.kind === 'probe') {
    const code = (waiting.error as NodeJS.ErrnoException | undefined)?.code ?? 'closed';
    return `stack: probe ${waiting.url} ${code}`;
  }
  if (waiting.status !== undefined) return `stack: fetch ${waiting.url} HTTP ${waiting.status}`;
  return `stack: fetch ${waiting.url} not ready`;
}

/**
 * Wait until every URL answers, reporting the observed probe, fetch or child-exit cause. A closed listener is not
 * rewritten as ECONNREFUSED; Management's hydration monitor applies only to an actual startup transport error.
 */
export async function waitUntilWalkReady(options: {
  urls: string[];
  children: readonly WalkReadyChild[];
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: (url: string) => Promise<WalkOriginProbe>;
  fetchReady?: (url: string, budgetMs: number) => Promise<WalkFetchObservation>;
  report?: (waiting: string[]) => void;
}): Promise<void> {
  const urls = options.urls;
  const deadlineMs = options.deadlineMs ?? WALK_READY_DEADLINE_MS;
  const pollMs = options.pollMs ?? WALK_READY_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const probe = options.probe ?? ((url: string) => walkOriginProbe(url));
  const fetchReady =
    options.fetchReady ?? ((url: string, budgetMs: number) => walkReadyFetchObservation(url, budgetMs));
  const deadline = now() + deadlineMs;
  const childExit = (): WalkReadyWaiting | undefined => {
    const exited = options.children.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (!exited) return undefined;
    return { kind: 'child-exit', url: urls[0] ?? '', code: String(exited.exitCode ?? exited.signalCode) };
  };
  const throwIfFailed = (waiting: WalkReadyWaiting | undefined): void => {
    if (waiting?.kind === 'child-exit')
      throw new Error(`walk: the local stack exited (${waiting.code}) before it was ready`);
    if (now() >= deadline)
      throw new Error(`walk: the local stack was not ready after ${deadlineMs} ms (${urls.join(', ')})`);
  };
  let lastReport = 0;
  const report = (waiting: string[]): void => {
    if (options.report) {
      options.report(waiting);
      return;
    }
    if (now() - lastReport < 30_000) return;
    console.error(`walk: waiting for ${waiting.join(', ')}`);
    lastReport = now();
  };

  for (;;) {
    throwIfFailed(childExit());
    const listening = await Promise.all(urls.map(async (url) => [url, await probe(url)] as const));
    throwIfFailed(childExit());
    if (listening.every(([, result]) => result.listening)) break;
    report(
      listening.flatMap(([url, result]) =>
        result.listening ? [] : [walkReadyWaitingMessage({ kind: 'probe', url, error: result.error })],
      ),
    );
    await sleep(pollMs);
  }
  for (;;) {
    throwIfFailed(childExit());
    const remaining = deadline - now();
    const ready = await Promise.all(
      urls.map(async (url) => {
        const budget = Math.min(remaining, walkReadyFetchTimeoutMs(remaining));
        return [url, await fetchReady(url, budget)] as const;
      }),
    );
    throwIfFailed(childExit());
    if (ready.every(([, result]) => result.ready)) return;
    report(
      ready.flatMap(([url, result]) => (result.ready ? [] : [walkReadyWaitingMessage(fetchWaiting(url, result))])),
    );
    await sleep(pollMs);
  }
}

/** Seed import writes wait until topology remaining is zero, not only until one subject POST succeeds. */
export async function waitUntilIdentityBootstrapRemainingZero(
  remaining: () => Promise<number | string>,
  options: { ms?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const ms = options.ms ?? 1_200_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((wait: number) => Bun.sleep(wait));
  const deadline = now() + ms;
  let last = 'no remaining';
  while (now() < deadline) {
    try {
      const value = await remaining();
      if (value === 0) return;
      last = `remaining ${value}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`identity epoch bootstrap not caught up: ${last}`);
}

/** The variables that give one admitted stack its own names, ports and origins. */
export function walkStackEnvironment(task: string, index: number): Record<string, string> {
  const names = walkStackNames(task, index);
  const ports = walkStackPorts(index);
  const origin = (port: number) => `http://127.0.0.1:${port}`;
  return {
    KERNEL_DATABASE_CONTAINER: names.database,
    KERNEL_DATABASE_VOLUME: names.database,
    KERNEL_DATABASE_PORT: String(ports.database),
    KERNEL_SEARCH_CONTAINER: names.search,
    KERNEL_SEARCH_VOLUME: names.search,
    KERNEL_SEARCH_PORT: String(ports.search),
    REZICS_LOCAL_STACK_WEB_ORIGIN: origin(ports.web),
    REZICS_LOCAL_STACK_ISSUER_ORIGIN: origin(ports.issuer),
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: origin(ports.native),
    REZICS_LOCAL_STACK_KERNEL_ORIGIN: origin(ports.kernel),
    REZICS_WALK_STACK_SLOT: String(index),
    // Seeded indexes stay on niofs; docker memory ceilings stop volume file cache filling the 6 GiB run slice.
    OPENSEARCH_JAVA_OPTS: '-Xms128m -Xmx128m',
    KERNEL_SEARCH_ALLOW_MMAP: '0',
    KERNEL_SEARCH_MEMORY: '768m',
    KERNEL_DATABASE_MEMORY: '384m',
    KERNEL_DATABASE_BOUNDED: '1',
    KERNEL_WORKER_POOL_SIZE: '1',
    REZICS_WALK_SMOL: '1',
    // Vite/workerd, Playwright and the worker stay down through persona/seed; the journey starts them for browsers.
    REZICS_WALK_DEFER_FRONTENDS: '1',
    MALLOC_ARENA_MAX: '2',
  };
}

/** Stack processes keep check-host cgroup placement off; worker checks still run on hosts a and b. */
export function walkProcessEnvironment(
  task: string,
  index: number,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== 'KERNEL_CHECK_ON_REMOTE') merged[name] = value;
  }
  const scoped = walkStackEnvironment(task, index);
  return {
    ...merged,
    ...scoped,
    // Full-effect journeys need the default worker and Search before seed. Keep Account walks deferred by default.
    REZICS_WALK_DEFER_FRONTENDS: env.REZICS_WALK_DEFER_FRONTENDS ?? scoped.REZICS_WALK_DEFER_FRONTENDS!,
  };
}

/** Re-exec the walk parent under bun --smol once, so its module graph shares the 6 GiB slice. */
export function walkParentInvocation(env: NodeJS.ProcessEnv, argv: readonly string[]): string[] | undefined {
  if (env.REZICS_WALK_SMOL === '1' || argv[1] === '--smol' || argv.length < 2) return undefined;
  return [argv[0]!, '--smol', ...argv.slice(1)];
}

/** Docker teardown returns empty output on failure so a killed daemon cannot hide the walk error. */
export function walkDockerOutput(result: { status: number | null; stdout?: string | null }): string {
  return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

/** Forward one issuer-origin request onto native Auth, including POST bodies used by seed sign-in. */
export function walkIssuerForward(request: Request, nativeOrigin: string): Request {
  const url = new URL(request.url);
  const native = new URL(nativeOrigin);
  url.protocol = native.protocol;
  url.host = native.host;
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: request.headers,
    redirect: 'manual',
  };
  if (request.body !== null) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

const dbosDiagnosticBlock = /\{\s*"?code"?:\s*"dbos_diagnostic"[\s\S]*?\}\n?/g;

/** Drop DBOS chatter so a failed walk's 32 KiB reprint still shows Kernel create errors. */
export function walkStackLogExcerpt(recorded: string, limit = 32_768): string {
  return recorded.replace(dbosDiagnosticBlock, '').slice(-limit);
}

/** Walks wait for Kernel and native Auth when frontends are deferred; otherwise Web, issuer and Kernel. */
export function walkReadyUrls(ports: WalkPorts, env: Record<string, string | undefined> = {}): string[] {
  if (env.REZICS_WALK_DEFER_FRONTENDS === '1')
    return [`http://127.0.0.1:${ports.native}/.well-known/jwks.json`, `http://127.0.0.1:${ports.kernel}/health`];
  return [`http://127.0.0.1:${ports.web}/`, `http://127.0.0.1:${ports.issuer}/`, `http://127.0.0.1:${ports.kernel}/`];
}

/** Kernel and Access use the issuer origin for public JWKS identity; Auth pages serve that URL locally. */
export function issuerJwksUrl(issuerOrigin: string): string {
  return `${issuerOrigin.replace(/\/$/u, '')}/.well-known/jwks.json`;
}

/** Signed local Stripe fixtures for Commerce journey walks; Checkout return URLs stay HTTPS. */
export function walkCommerceProviderEnvironment(port: number, webhookSecret: string): Record<string, string> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('Walk Stripe port is not a loopback TCP port');
  if (!/^whsec_[A-Za-z0-9_]+$/u.test(webhookSecret))
    throw new Error('Walk Stripe webhook secret is not a fixture secret');
  return {
    STRIPE_SECRET_KEY: 'sk_test_walk_commerce',
    STRIPE_API_HOST: `http://127.0.0.1:${port}`,
    STRIPE_WEBHOOK_SECRETS: webhookSecret,
    STRIPE_MANAGED_PAYMENTS: 'false',
    CHECKOUT_SUCCESS_URL: 'https://example.test/orders/{ORDER_ID}/paid',
    CHECKOUT_CANCEL_URL: 'https://example.test/orders/{ORDER_ID}/cancel',
  };
}

/**
 * Waits for one of the host's walk slots. The queue is the stack-lease FIFO, in the walk directory with the walk
 * capacity, so developers' stacks and check slots are not counted here. `blocked` indexes stay skipped for this
 * launch after Docker refused their published ports, including a `docker run` that still reported
 * `port is already allocated` after admission thought the slot was free.
 */
export function admitWalkStack(
  task: string,
  env: Record<string, string | undefined>,
  root: string,
  signal?: AbortSignal,
  blocked: ReadonlySet<number> = new Set(),
  portsAvailable: WalkStackPortAvailability = walkStackPortsAvailable,
): Promise<StackSlot> {
  walkStackNames(task, 1);
  const directory = walkStackDirectory(root, env);
  ensureWalkStackDirectory(directory);
  return acquireStackSlot(
    `walk ${task}`,
    { REZICS_STACK_LEASE_DIR: directory, REZICS_STACK_SLOTS: String(walkStackLimit(env)) },
    1,
    undefined,
    POSITION_INTERVAL_MS,
    signal,
    async (index) => !blocked.has(index) && (await portsAvailable(walkStackPorts(index))),
    join(directory, 'tickets'),
  );
}

/** Connection refused during hydration is startup, not a finished process. */
export function isStartupTransportError(error: unknown): boolean {
  if (error instanceof DOMException) return true;
  if (error instanceof TypeError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
}

export function firstRedactedDiagnostic(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  const line = redacted.split(/\r\n?|\n/).find((entry) => entry.trim() !== '');
  return line?.trim() || redacted.slice(0, 500);
}

/** Admitted 6GiB slices cannot afford Kernel `--watch`. Local `task dev` keeps it. */
export function kernelLaunchCommand(env: Record<string, string | undefined>, bun = process.execPath): string[] {
  const script = env.REZICS_WALK_STACK_SLOT ? 'start' : 'dev';
  return [bun, 'run', '--cwd', 'services/kernel', script];
}

export function nativeJwksUrl(nativeOrigin: string): string {
  return `${nativeOrigin.replace(/\/$/, '')}/.well-known/jwks.json`;
}

export type StackStartPlan = {
  kernel: string[];
  nativeReady: string[];
  kernelReady: string[];
  deferPages: boolean;
};

export function stackStartPlan(
  env: Record<string, string | undefined>,
  origins: { web: string; issuer: string; native: string; kernel: string },
): StackStartPlan {
  return {
    kernel: kernelLaunchCommand(env),
    nativeReady: [nativeJwksUrl(origins.native)],
    kernelReady: [`${origins.kernel.replace(/\/$/, '')}/v1/definitions`],
    deferPages: Boolean(env.REZICS_WALK_STACK_SLOT),
  };
}

export function seedJournalDatabaseIdentity(url: string): string {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:' ? '5432' : '');
  return `${parsed.hostname}:${port}${parsed.pathname}`;
}

export function seedJournalsNameDifferentDatabase(recorded: string | undefined, current: string): boolean {
  return recorded !== undefined && recorded !== '' && recorded !== current;
}

export const SEED_JOURNAL_IDENTITY_FILE = 'database-identity';

export function stackPhaseLine(phase: string, identity: string): string {
  return `stack: ${phase} ${identity}`;
}

/** Each acquired walk resource registers immediately; every cleanup settles before the original failure escapes. */
export async function withWalkResources<T>(
  run: (own: (name: string, cleanup: () => void | Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const owned: { name: string; cleanup: () => void | Promise<void> }[] = [];
  let failed = false;
  let original: unknown;
  try {
    return await run((name, cleanup) => owned.push({ name, cleanup }));
  } catch (error) {
    failed = true;
    original = error;
    throw error;
  } finally {
    const results = await Promise.allSettled(owned.map(({ cleanup }) => Promise.resolve().then(cleanup)));
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [new Error(`${owned[index]!.name}: ${String(result.reason)}`, { cause: result.reason })]
        : [],
    );
    if (failures.length)
      throw new AggregateError(
        [...(failed ? [original] : []), ...failures],
        `Walk cleanup failed${failed ? ` after ${String(original)}` : ''}: ${failures.map((error) => error.message).join('; ')}`,
        { cause: failed ? original : failures[0] },
      );
  }
}
