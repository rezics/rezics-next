/**
 * Bounded local stacks for walk-and-repair tasks. A worker whose brief lists native or browser acceptance runs one
 * stack through `dev-stack.ts walk`. At most `REZICS_WALK_STACKS` stacks (default six) run on this host at once, and a
 * further start waits in arrival order with its position shown. An admitted stack owns its slot's loopback ports and
 * its task's container and volume names, so stacks cannot collide with each other or with a developer's stack.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { type StackSlot, acquireStackSlot } from './stack-lease.ts';
import { walkStackDirectory } from './stack-run.ts';

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

/** Container and volume names carry the task. An identifier Docker cannot use as a name is refused, not altered. */
export function walkStackNames(task: string): WalkNames {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(task))
    throw new Error(`GOAL_TASK_ID cannot name a walk stack: ${JSON.stringify(task)}`);
  const prefix = `rezics-walk-${task}`;
  return { prefix, database: `${prefix}-database`, search: `${prefix}-search` };
}

export function walkStackPorts(index: number): WalkPorts {
  const base = PORT_BASE + PORTS_PER_SLOT * index;
  return { web: base, issuer: base + 1, native: base + 2, kernel: base + 3, database: base + 4, search: base + 5 };
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
    const available = await new Promise<boolean>((resolve, reject) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      });
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close((error) => (error ? reject(error) : resolve(true)));
      });
    });
    if (!available) return false;
  }
  return true;
}

/** The variables that give one admitted stack its own names, ports and origins. */
export function walkStackEnvironment(task: string, index: number): Record<string, string> {
  const names = walkStackNames(task);
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
    KERNEL_SEARCH_MEMORY: '512m',
    KERNEL_DATABASE_MEMORY: '384m',
    KERNEL_DATABASE_BOUNDED: '1',
    KERNEL_WORKER_POOL_SIZE: '4',
    REZICS_WALK_SMOL: '1',
  };
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
  walkStackNames(task);
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
