import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../fixture/corpus.ts';
import { RetainedSources, sourceKey, type RetainedSourceAdapter, type SourceInputs } from './retained-source.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(producer = 'realm-discussion-source') {
  const temp = resolve(import.meta.dir, '../../.temp');
  mkdirSync(temp, { recursive: true });
  const directory = mkdtempSync(join(temp, 'source-publication-'));
  directories.push(directory);
  const specification: SourceInputs = { producer, version: '1', files: { source: sha256('source') }, inputs: {}, compatibility: {} };
  const removed: string[] = [];
  const adapter: RetainedSourceAdapter<{ complete: boolean }, never> = {
    specification,
    async build(context) {
      writeFileSync(join(context.backup, 'physical'), 'complete backup');
      return { metadata: { complete: true }, rdfDigest: sha256('rdf'), ownerState: {}, producerRevision: 'revision', qaIdentity: 'test', phases: {} };
    },
    async verify() { return []; },
    async restore() { throw new Error('not a restore test'); },
    async dispose() {},
    async remove(key) { removed.push(key); },
  };
  return { directory, root: join(directory, 'sources'), adapter, removed, store: new RetainedSources(join(directory, 'sources')) };
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path), `child reached ${path}`).toBe(true);
}

// Run real producers in a separate process. Filesystem spies stop synchronous
// boundaries deterministically, including a partially written manifest.
function producer(f: ReturnType<typeof setup>, phase: string) {
  const file = join(f.directory, 'producer.test.ts');
  writeFileSync(file, `import { spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { RetainedSources, sourceKey } from ${JSON.stringify(resolve(import.meta.dir, 'retained-source.ts'))};
const directory = ${JSON.stringify(f.directory)}, specification = ${JSON.stringify(f.adapter.specification)}, phase = ${JSON.stringify(phase)};
const key = sourceKey(specification), write = fs.writeFileSync;
function pause(at) {
  if (phase !== at) return;
  write(join(directory, 'paused'), at);
  // SIGKILL must interrupt even synchronous sealing/publication.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const writing = spyOn(fs, 'writeFileSync').mockImplementation((path, ...args) => {
  if (String(path).endsWith('/manifest.json') && phase === 'seal') {
    write(path, '{"format":'); pause('seal');
  }
  return write(path, ...args);
});
const rename = fs.renameSync;
const renaming = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
  if (String(to).endsWith(key)) pause('publish');
  return rename(from, to);
});
test('producer', async () => {
  const result = await new RetainedSources(join(directory, 'sources')).prepare({ specification,
    producerBuild: { deadlineMs: 60_000, evidence: 'bounded subprocess test', async run() { pause('producer-build'); } },
    async build(context) {
      write(join(context.backup, 'physical'), 'partial backup'); pause('backup');
      write(join(context.backup, 'physical'), 'complete backup');
      return { metadata: { complete: true }, rdfDigest: 'a'.repeat(64), ownerState: {},
        producerRevision: 'revision', qaIdentity: 'child', phases: {} };
    },
    async verify(context) { pause(context.directory.includes('.pending-') ? 'verify-staging' : 'verify-published'); return []; },
    async restore() { throw new Error('unused'); }, async dispose() {},
    async remove(removing) {
      if (removing !== key) pause('prune');
      if (!fs.existsSync(join(directory, 'sources', key)) && fs.readdirSync(join(directory, 'sources')).some(name => name.includes('.pending-')))
        pause('remove-invalid');
    }
  });
  write(join(directory, 'finished'), result.manifest.digest);
  writing.mockRestore(); renaming.mockRestore();
});
`);
  return Bun.spawn([process.execPath, 'test', file], { stdout: 'pipe', stderr: 'pipe' });
}

const producers = ['realm-discussion-source', 'owner-erasure-source', 'independent-recipe-source', 'independent-authority-source'];
for (const name of producers) {
  for (const phase of ['producer-build', 'backup', 'seal', 'verify-staging', 'prune', 'publish', 'verify-published', 'remove-invalid']) {
    test(`${name}: SIGKILL during ${phase} leaves only pending or verified publication; a fresh run passes`, async () => {
      const f = setup(name), key = sourceKey(f.adapter.specification), published = join(f.root, key);
      if (phase === 'prune') {
        for (const digest of ['b', 'c']) {
          const old = join(f.root, `rs-${name}-${digest.repeat(64)}`);
          mkdirSync(old, { recursive: true });
          writeFileSync(join(old, 'manifest.json'), JSON.stringify({ provenance: { completedAt: '2026-01-01' } }));
        }
      }
      if (phase === 'remove-invalid') {
        mkdirSync(published, { recursive: true });
        writeFileSync(join(published, 'partial'), 'interrupted legacy producer');
      }
      const child = producer(f, phase);
      const report = spyOn(console, 'info').mockImplementation(() => {});
      try {
        await waitFor(join(f.directory, 'paused'));
        expect(existsSync(published)).toBe(phase === 'verify-published');
        if (existsSync(published)) expect(JSON.parse(readFileSync(join(published, 'manifest.json'), 'utf8')).metadata.complete).toBe(true);
        child.kill('SIGKILL'); await child.exited;
        const prepared = await f.store.prepare(f.adapter);
        expect(prepared.built).toBe(phase !== 'verify-published');
        expect((await f.store.select(f.adapter)).digest).toBe(prepared.manifest.digest);
        expect(readdirSync(f.root).filter(path => path.includes('.pending-'))).toEqual([]);
        if (prepared.built) expect(report.mock.calls).toContainEqual([
          `RETAINED_SOURCE_RECOVERY ${JSON.stringify({ key, reason: 'unpublished-staging' })}`,
        ]);
      } finally {
        report.mockRestore(); child.kill(); await child.exited;
        await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      }
    }, 15_000);
  }
}

test('a concurrent waiter preserves a live producer and cannot select partial publication', async () => {
  const f = setup(), key = sourceKey(f.adapter.specification), child = producer(f, 'backup');
  let selected = false, prepared = false;
  try {
    await waitFor(join(f.directory, 'paused'));
    const pending = readdirSync(f.root).find(name => name.includes('.pending-'))!;
    const selection = f.store.select(f.adapter).then(manifest => { selected = true; return manifest; }, error => error);
    const preparation = f.store.prepare(f.adapter).then(result => { prepared = true; return result; });
    await Bun.sleep(150);
    expect(selected).toBe(false); expect(prepared).toBe(false);
    expect(f.removed).toEqual([]);
    expect(readFileSync(join(f.root, pending, 'backup/physical'), 'utf8')).toBe('partial backup');
    expect(existsSync(join(f.root, key))).toBe(false);
    child.kill('SIGKILL'); await child.exited;
    const result = await preparation;
    const selectionResult = await selection;
    // The read waiter may run before recovery (refusal) or after atomic publication.
    if (selectionResult instanceof Error) expect(selectionResult.message).toContain('complete manifest');
    else expect(selectionResult.digest).toBe(result.manifest.digest);
    expect(result.built).toBe(true);
    expect((await f.store.select(f.adapter)).digest).toBe(result.manifest.digest);
  } finally {
    child.kill(); await child.exited;
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  }
});

test('an unmanifested legacy publication is quarantined before asynchronous cleanup and its recovery reason is reported', async () => {
  const f = setup(), key = sourceKey(f.adapter.specification), published = join(f.root, key);
  mkdirSync(published, { recursive: true });
  writeFileSync(join(published, 'partial'), 'interrupted legacy producer');
  const cleanup = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const remove = f.adapter.remove;
  f.adapter.remove = async removing => { entered.resolve(); await cleanup.promise; await remove(removing); };
  const report = spyOn(console, 'info').mockImplementation(() => {});
  const preparation = f.store.prepare(f.adapter);
  try {
    await entered.promise;
    expect(existsSync(published)).toBe(false);
    expect(report.mock.calls).toContainEqual([`RETAINED_SOURCE_RECOVERY ${JSON.stringify({ key, reason: 'unreadable-manifest' })}`]);
  } finally { cleanup.resolve(); await preparation; report.mockRestore(); }
  expect((await f.store.select(f.adapter)).metadata.complete).toBe(true);
});

test('orphan cleanup waits for its own key lock and rechecks pending work after a live producer publishes', async () => {
  const f = setup();
  const first = await f.store.prepare(f.adapter), key = first.manifest.key;
  const published = join(f.root, key), pending = join(f.root, `.${key}.pending-live`);
  const holder = Bun.spawn(['flock', '--nonblock', join(f.root, `${key}.lock`), 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const reader = holder.stdout.getReader();
  expect((await reader.read()).done).toBe(false); reader.releaseLock();
  renameSync(published, pending);
  f.adapter.specification = { ...f.adapter.specification, version: '2' };
  f.removed.length = 0;
  const preparation = f.store.prepare(f.adapter);
  try {
    await Bun.sleep(150);
    expect(existsSync(pending)).toBe(true);
    expect(f.removed).toEqual([]);
    renameSync(pending, published);
  } finally {
    await holder.stdin.end(); await holder.exited;
    await holder.stdout.cancel(); await holder.stderr.cancel();
  }
  await preparation;
  expect(f.removed).not.toContain(key);
  expect(existsSync(published)).toBe(true);
  f.adapter.specification = first.manifest.specification;
  expect((await f.store.select(f.adapter)).digest).toBe(first.manifest.digest);
});
