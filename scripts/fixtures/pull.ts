import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sources, type FixtureSource } from '../../tests/fixtures/sources/wikidata.ts';

export interface FixtureEntry {
  id: string;
  source: string;
  requestUrl: string;
  fetchedAt: string;
  sha256: string;
  size: number;
  reuseBasis: string;
  seed: string;
}
export interface FixtureLock { version: 1; entries: FixtureEntry[] }
export interface PullOptions {
  source?: string;
  mode?: 'replay' | 'live';
  updateLock?: boolean;
  offline?: boolean;
  fetcher?: typeof fetch;
  adapters?: readonly FixtureSource[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}
export interface PullResult {
  id: string;
  source: string;
  status: 'cached' | 'hydrated' | 'fetched' | 'unchanged' | 'drift' | 'updated';
  sha256: string;
  previousSha256?: string;
}

const lockRelative = 'tests/fixtures/fixtures.lock.json';
const hash = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const canonical = (value: unknown) => JSON.stringify(value) + '\n';
const defaultSleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms));

function readLock(root: string): FixtureLock {
  const path = join(root, lockRelative);
  if (!existsSync(path)) return { version: 1, entries: [] };
  const lock = JSON.parse(readFileSync(path, 'utf8')) as FixtureLock;
  if (lock.version !== 1 || !Array.isArray(lock.entries)) throw new Error('Unsupported fixture lock');
  const seen = new Set<string>();
  for (const entry of lock.entries) {
    const key = `${entry.source}/${entry.id}`;
    if (seen.has(key) || !/^[a-z][a-z0-9-]*$/.test(entry.source)
      || !/^[A-Za-z0-9-]+$/.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || entry.seed !== `tests/fixtures/seeds/${entry.source}/${entry.sha256}.json`
      || !entry.requestUrl.startsWith('https://') || !entry.reuseBasis || !entry.fetchedAt) {
      throw new Error(`Invalid fixture lock entry ${key}`);
    }
    seen.add(key);
  }
  return lock;
}

function checkedBytes(path: string, entry: FixtureEntry): string {
  const bytes = readFileSync(path);
  if (bytes.length !== entry.size || hash(bytes.toString('utf8')) !== entry.sha256) {
    throw new Error(`Fixture integrity mismatch at ${path}; run yarn fixtures:pull --source ${entry.source} --update-lock`);
  }
  return bytes.toString('utf8');
}

function cachePath(root: string, source: string, digest: string): string {
  return join(root, '.cache', 'fixtures', source, `${digest}.json`);
}

function putImmutable(path: string, bytes: string, digest: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (hash(readFileSync(path, 'utf8')) !== digest) throw new Error(`Fixture cache collision at ${path}`);
    return;
  }
  writeFileSync(path, bytes, { flag: 'wx' });
}

/** Verified replay is available without network in a clean checkout via committed minimal seeds. */
export function readLockedFixture(root: string, source: string, id: string): unknown {
  const entry = readLock(root).entries.find(item => item.source === source && item.id === id);
  if (!entry) throw new Error(`No locked fixture ${source}/${id}; run yarn fixtures:pull --source ${source} --update-lock`);
  const cache = cachePath(root, source, entry.sha256);
  if (!existsSync(cache)) {
    const seed = join(root, entry.seed);
    if (!existsSync(seed)) throw new Error(`Fixture ${source}/${id} unavailable offline; run yarn fixtures:pull --source ${source} with network access`);
    putImmutable(cache, checkedBytes(seed, entry), entry.sha256);
  }
  return JSON.parse(checkedBytes(cache, entry));
}

async function fetchNormalized(adapter: FixtureSource, request: { id: string; url: string },
  fetcher: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<string> {
  const userAgent = `REZICSFixtureHarness/1.0 (+https://github.com/rezics/rezics-next)`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetcher(request.url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000) });
    } catch (error) { throw new Error(`Fixture fetch failed for ${adapter.name}/${request.id}: ${String(error)}`); }
    if (response.status === 429 || response.status === 503) {
      const retry = Number(response.headers.get('retry-after'));
      if (attempt === 2) throw new Error(`Fixture fetch ${adapter.name}/${request.id}: HTTP ${response.status}`);
      await sleep(Math.min(30_000, Math.max(adapter.minimumIntervalMs, Number.isFinite(retry) ? retry * 1000 : 1000)));
      continue;
    }
    if (!response.ok) throw new Error(`Fixture fetch ${adapter.name}/${request.id}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2_000_000) throw new Error(`Fixture response too large for ${adapter.name}/${request.id}`);
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error(`Fixture response was not JSON for ${adapter.name}/${request.id}`); }
    return canonical(adapter.normalize(raw, request.id));
  }
  throw new Error('Unreachable fixture retry state');
}

export async function pullFixtures(root: string, options: PullOptions = {}): Promise<PullResult[]> {
  const adapters = options.adapters ?? sources;
  const selected = options.source ? adapters.filter(item => item.name === options.source) : adapters;
  if (!selected.length) throw new Error(`Unsupported fixture source: ${options.source}`);
  const mode = options.mode ?? 'replay';
  if (options.updateLock && mode !== 'live') throw new Error('--update-lock requires REZICS_FIXTURES=live');
  const lock = readLock(root);
  const next = [...lock.entries];
  const results: PullResult[] = [];
  const sleep = options.sleep ?? defaultSleep;
  for (const adapter of selected) {
    let lastRequest = 0;
    for (const request of adapter.requests) {
      const index = next.findIndex(item => item.source === adapter.name && item.id === request.id);
      const prior = next[index];
      if (prior && (prior.requestUrl !== request.url || prior.reuseBasis !== adapter.reuseBasis)) {
        if (!options.updateLock) throw new Error(`Fixture acquisition metadata changed for ${adapter.name}/${request.id}; review and update lock`);
      }
      const cache = prior && cachePath(root, adapter.name, prior.sha256);
      if (mode === 'replay' && prior && cache && existsSync(cache)) {
        checkedBytes(cache, prior);
        results.push({ id: request.id, source: adapter.name, status: 'cached', sha256: prior.sha256 });
        continue;
      }
      if (mode === 'replay' && prior && existsSync(join(root, prior.seed))) {
        readLockedFixture(root, adapter.name, request.id);
        results.push({ id: request.id, source: adapter.name, status: 'hydrated', sha256: prior.sha256 });
        continue;
      }
      if (options.offline) throw new Error(`Fixture ${adapter.name}/${request.id} unavailable offline; run yarn fixtures:pull --source ${adapter.name} with network access`);
      if (mode === 'replay' && !prior) throw new Error(`No locked fixture ${adapter.name}/${request.id}; run REZICS_FIXTURES=live yarn fixtures:pull --source ${adapter.name} --update-lock`);
      const gap = adapter.minimumIntervalMs - (Date.now() - lastRequest);
      if (gap > 0) await sleep(gap);
      const payload = await fetchNormalized(adapter, request, options.fetcher ?? fetch, sleep);
      lastRequest = Date.now();
      const sha256 = hash(payload);
      putImmutable(cachePath(root, adapter.name, sha256), payload, sha256);
      const drift = prior?.sha256 !== sha256;
      if (mode === 'replay' && prior && drift) {
        throw new Error(`Fixture ${adapter.name}/${request.id} drifted while restoring replay cache; run REZICS_FIXTURES=live yarn fixtures:pull --source ${adapter.name} to inspect, then --update-lock`);
      }
      if (options.updateLock) {
        const seed = `tests/fixtures/seeds/${adapter.name}/${sha256}.json`;
        putImmutable(join(root, seed), payload, sha256);
        const entry: FixtureEntry = { id: request.id, source: adapter.name, requestUrl: request.url,
          fetchedAt: (options.now ?? (() => new Date()))().toISOString(), sha256,
          size: Buffer.byteLength(payload), reuseBasis: adapter.reuseBasis, seed };
        if (index < 0) next.push(entry); else next[index] = entry;
      }
      results.push({ id: request.id, source: adapter.name,
        status: options.updateLock ? 'updated' : drift ? 'drift' : mode === 'live' ? 'unchanged' : 'fetched',
        sha256, ...(prior && drift ? { previousSha256: prior.sha256 } : {}) });
    }
  }
  if (options.updateLock) {
    next.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
    const path = join(root, lockRelative);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, entries: next }, null, 2) + '\n');
    renameSync(temp, path);
  }
  return results;
}

export function parseArgs(args: string[]): { source?: string; updateLock: boolean } {
  let source: string | undefined;
  let updateLock = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && /^[a-z][a-z0-9-]*$/.test(args[i + 1] ?? '') && !source) source = args[++i];
    else if (args[i] === '--update-lock' && !updateLock) updateLock = true;
    else throw new Error(`Unsupported fixture option: ${args[i]}`);
  }
  return { ...(source ? { source } : {}), updateLock };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const mode = Bun.env.REZICS_FIXTURES ?? 'replay';
    if (mode !== 'replay' && mode !== 'live') throw new Error(`Unsupported REZICS_FIXTURES mode: ${mode}`);
    const result = await pullFixtures(resolve(import.meta.dir, '../..'), {
      ...args, mode, offline: Bun.env.REZICS_FIXTURES_OFFLINE === '1',
    });
    for (const item of result) console.log(`${item.source}/${item.id}: ${item.status} ${item.sha256}${item.previousSha256 ? ` (was ${item.previousSha256})` : ''}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
