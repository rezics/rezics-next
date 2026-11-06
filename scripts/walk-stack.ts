/**
 * Bounded local stacks for walk-and-repair tasks. A worker whose brief lists native or browser acceptance runs one
 * stack through `dev-stack.ts walk`. At most `REZICS_WALK_STACKS` stacks (default six) run on this host at once, and a
 * further start waits in arrival order with its position shown. An admitted stack owns its slot's loopback ports and
 * its task's container and volume names, so stacks cannot collide with each other or with a developer's stack.
 */
import { spawnSync } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import { type StackSlot, acquireStackSlot } from './stack-lease.ts';
import { walkStackDirectory } from './stack-run.ts';

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

/** True when something already accepts TCP on the origin; connection refused is not a hung compile. */
export function walkOriginListening(url: string, timeoutMs = 500): Promise<boolean> {
  const parsed = new URL(url);
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
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
  return { ...merged, ...walkStackEnvironment(task, index) };
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

/**
 * Waits for one of the host's walk slots. The queue is the stack-lease FIFO, in the walk directory with the walk
 * capacity, so developers' stacks and check slots are not counted here. `blocked` indexes stay skipped for this
 * launch after Docker refused their published ports.
 */
export function admitWalkStack(
  task: string,
  env: Record<string, string | undefined>,
  root: string,
  signal?: AbortSignal,
  blocked: ReadonlySet<number> = new Set(),
): Promise<StackSlot> {
  walkStackNames(task, 1);
  return acquireStackSlot(
    `walk ${task}`,
    { REZICS_STACK_LEASE_DIR: walkStackDirectory(root, env), REZICS_STACK_SLOTS: String(walkStackLimit(env)) },
    1,
    undefined,
    POSITION_INTERVAL_MS,
    signal,
    async (index) => !blocked.has(index) && (await walkStackPortsAvailable(walkStackPorts(index))),
  );
}
