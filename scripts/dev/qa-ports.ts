import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { processAlive, processIdentity, type ProcessIdentity } from '../qa/process/identity.ts';
import { devPorts } from './config.ts';

type PortRange = readonly [number, number];
interface PortLease {
  token: string;
  ports: Record<string, number>;
  owner?: ProcessIdentity;
}
export interface QaPortOptions {
  localRange?: PortRange;
  candidateRange?: PortRange;
  registry?: string;
  owner?: ProcessIdentity;
}

export function localPortRange(): PortRange {
  const values = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
  const [first, last] = values;
  if (!first || !last || first > last || last > 65535) throw new Error('Invalid host local port range');
  return [first, last];
}

function tcpSockets(): { port: number; inode: string; state: string }[] {
  return ['tcp', 'tcp6'].flatMap(name => readFileSync(`/proc/net/${name}`, 'utf8').trim().split('\n').slice(1)
    .map(line => {
      const fields = line.trim().split(/\s+/);
      return { port: parseInt(fields[1]!.split(':')[1]!, 16), inode: fields[9]!, state: fields[3]! };
    }));
}

function readLease(path: string): PortLease | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as PortLease; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The abstract socket lock is host-wide and disappears on process death. It
 * protects stale takeover too: two reapers cannot delete a successor's lease. */
async function withAllocationLock<T>(registry: string, run: () => T): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const lock = createServer();
    const acquired = await new Promise<boolean>((accept, reject) => {
      lock.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? accept(false) : reject(error));
      lock.listen(`\0rezics-qa-ports:${createHash('sha256').update(registry).digest('hex')}`, () => accept(true));
    });
    if (acquired) {
      try { return run(); }
      finally { await new Promise<void>((accept, reject) => lock.close(error => error ? reject(error) : accept())); }
    }
    if (Date.now() >= deadline) throw new Error('QA port allocation lock timed out');
    await new Promise(accept => setTimeout(accept, 10));
  }
}

/** A CLI exits before services start. The runner's existing reaper identity,
 * when present, owns the lease; manual stacks retain it with their directory. */
export function qaPortOwner(env: NodeJS.ProcessEnv): ProcessIdentity | undefined {
  const [pid, start] = (env.REZICS_REAP_OWNER ?? '').split(':');
  const owner = processIdentity(Number(pid));
  if (owner && owner.start === start) return owner;
  return undefined;
}

export async function leaseQaPorts(directory: string, names: readonly string[],
  options: QaPortOptions = {}): Promise<Record<string, number>> {
  const registry = resolve(options.registry ?? '/tmp/rezics-qa-port-leases');
  const dir = resolve(directory);
  const path = join(dir, 'qa-ports.json');
  const local = options.localRange ?? localPortRange();
  const [first, last] = options.candidateRange ?? [10000, 65535];
  const reserved = new Set(Object.values(devPorts()));
  if (first < 1024 || last > 65535 || first > last) throw new Error('Invalid QA candidate port range');
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  return await withAllocationLock(registry, () => {
    const held = new Map<number, string>();
    for (const entry of readdirSync(registry)) {
      const port = Number(entry);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const index = join(registry, entry);
      const target = readlinkSync(index);
      const lease = readLease(target);
      if (!lease || (lease.owner && !processAlive(lease.owner)) || !Object.values(lease.ports).includes(port)) {
        rmSync(index);
      } else held.set(port, target);
    }
    const previous = readLease(path);
    const reusable = previous && (!previous.owner || processAlive(previous.owner));
    const ports: Record<string, number> = {};
    const occupied = new Set(tcpSockets().map(socket => socket.port));
    for (const name of names) {
      const prior = reusable ? previous.ports[name] : undefined;
      if (prior && !reserved.has(prior) && (prior < local[0] || prior > local[1])
        && (!held.has(prior) || held.get(prior) === path)) {
        ports[name] = prior;
        held.set(prior, path);
        continue;
      }
      const count = last - first + 1;
      const offset = randomInt(count);
      let chosen: number | undefined;
      for (let step = 0; step < count; step++) {
        const port = first + (offset + step) % count;
        if ((port >= local[0] && port <= local[1]) || reserved.has(port) || held.has(port) || occupied.has(port)) continue;
        chosen = port;
        break;
      }
      if (chosen === undefined) throw new Error(`No QA ports available outside local range ${local.join('-')}`);
      ports[name] = chosen;
      held.set(chosen, path);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lease: PortLease = { token: previous?.token ?? randomUUID(), ports,
      ...(options.owner ? { owner: options.owner } : reusable && previous.owner ? { owner: previous.owner } : {}) };
    const staged = `${path}.${randomUUID()}.next`;
    writeFileSync(staged, JSON.stringify(lease), { mode: 0o600 });
    renameSync(staged, path);
    for (const port of Object.values(ports)) {
      const index = join(registry, String(port));
      if (!existsSync(index)) { rmSync(index, { force: true }); symlinkSync(path, index); }
    }
    return ports;
  });
}

export function qaPortDiagnostic(port: number, service: string): string {
  const sockets = tcpSockets().filter(socket => socket.port === port);
  const inodes = new Set(sockets.map(socket => `socket:[${socket.inode}]`));
  const holders: string[] = [];
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const fds = join('/proc', pid, 'fd');
      if (readdirSync(fds).some(fd => {
        try { return inodes.has(readlinkSync(join(fds, fd))); }
        catch { return false; }
      })) {
        holders.push(`pid ${pid} (${readFileSync(join('/proc', pid, 'comm'), 'utf8').trim()})`);
      }
    } catch { /* A process may exit or belong to another user. */ }
  }
  const detail = holders.length ? holders.join(', ') : sockets.length
    ? `/proc/net/tcp socket inodes ${sockets.map(socket => socket.inode).join(', ')} (process unavailable)`
    : 'no socket remains in /proc/net/tcp{,6}';
  return `${service} cannot bind leased port ${port}; holder: ${detail}`;
}

/** Loaded through the disposable stack environment, including tests that bind
 * Main/Account minutes after Compose. Preserve Bun's original bind exception. */
if (process.env.REZICS_QA_PORT_DIAGNOSTICS === '1' && typeof Bun !== 'undefined') {
  const serve = Bun.serve;
  Bun.serve = ((...args: Parameters<typeof serve>) => {
    try { return serve(...args); }
    catch (error) {
      const port = Number(args[0]?.port);
      const service = Object.keys(process.env).find(key => key.endsWith('_PORT') && Number(process.env[key]) === port);
      if (service && /EADDRINUSE|port.*in use|Failed to start server/i.test(String(error))) {
        throw new Error(qaPortDiagnostic(port, service), { cause: error });
      }
      throw error;
    }
  }) as typeof serve;
}
