import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, stable } from '../fixture/corpus.ts';
import { retainedIntegrity } from '../fixture/manifest.ts';
import { RetainedSources, sourceKey, sourceFileDigests, ownerErasurePreparationOptions, SOURCES_PER_PRODUCER, SOURCE_PREPARATION_MS, SOURCE_RESTORE_MS, type RetainedSourceAdapter, type SourceInputs } from './retained-source.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const temp = resolve(import.meta.dir, '../../.temp');
  mkdirSync(temp, { recursive: true });
  const directory = mkdtempSync(join(temp, 'retained-source-test-'));
  directories.push(directory);
  const inputs: SourceInputs = {
    producer: 'owner-erasure-source', version: '1', files: { producer: sha256('producer'), migration: sha256('schema') },
    inputs: { foregroundSeed: null, laterApiAdmission: false }, compatibility: { native: 'native@sha256:one', postgres: '18' },
  };
  let builds = 0, verifies = 0, restores = 0;
  const removed: string[] = [];
  const adapter: RetainedSourceAdapter<{ identity: string }, { directory: string; dispose(): Promise<void> }> = {
    specification: inputs,
    async build(context) {
      builds++;
      writeFileSync(join(context.backup, 'postgres'), 'physical backup');
      writeFileSync(join(context.backup, 'objects'), 'authored bodies');
      return { metadata: { identity: 'random-work-provenance' }, rdfDigest: sha256('rdf'), ownerState: { relay: 'post-cut', cursor: 'cut' },
        producerRevision: 'unrelated-commit', qaIdentity: 'qa-source', phases: { api: 5 } };
    },
    async verify() { verifies++; return []; },
    async restore(context) {
      restores++;
      const candidate = join(directory, `copy-${restores}`);
      cpSync(context.backup, candidate, { recursive: true });
      return { directory: candidate, async dispose() { rmSync(candidate, { recursive: true, force: true }); } };
    },
    async dispose(candidate) { await candidate.dispose(); },
    async remove(key) { removed.push(key); },
  };
  const store = new RetainedSources(join(directory, 'sources'));
  return { directory, inputs, adapter, store, removed, counts: () => ({ builds, verifies, restores }) };
}

test('key binds every declared digest, producer identity/version/options and compatibility, never revision', () => {
  const { inputs, directory } = setup();
  writeFileSync(join(directory, 'producer'), 'producer');
  const before = sourceFileDigests(directory, ['producer']);
  writeFileSync(join(directory, 'unrelated'), 'unrelated commit');
  expect(sourceFileDigests(directory, ['producer'])).toEqual(before);
  const key = sourceKey(inputs);
  expect(sourceKey(JSON.parse(stable(inputs)) as SourceInputs)).toBe(key);
  for (const path of Object.keys(inputs.files))
    expect(sourceKey({ ...inputs, files: { ...inputs.files, [path]: sha256('changed') } })).not.toBe(key);
  for (const change of [{ producer: 'retained-content-source' }, { version: '2' },
    { inputs: { foregroundSeed: { identity: 'recipe-v1', inputs: ['en'] }, laterApiAdmission: false } },
    { inputs: { foregroundSeed: null, laterApiAdmission: true } }, { compatibility: { native: 'other' } }])
    expect(sourceKey({ ...inputs, ...change })).not.toBe(key);
});

test('an unrelated Git commit leaves the source key unchanged', () => {
  const f = setup();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.directory, encoding: 'utf8' }).trim();
  git('init', '--quiet'); git('config', 'user.email', 'source@example.test'); git('config', 'user.name', 'Source test');
  writeFileSync(join(f.directory, 'producer.ts'), 'export const body = "retained source";');
  git('add', 'producer.ts'); git('commit', '--quiet', '-m', 'producer');
  const specification = { ...f.inputs, files: sourceFileDigests(f.directory, ['producer.ts']) };
  const before = sourceKey(specification), revision = git('rev-parse', 'HEAD');
  writeFileSync(join(f.directory, 'unrelated.md'), 'unrelated decision');
  git('add', 'unrelated.md'); git('commit', '--quiet', '-m', 'unrelated decision');
  expect(git('rev-parse', 'HEAD')).not.toBe(revision);
  expect(sourceKey({ ...specification, files: sourceFileDigests(f.directory, ['producer.ts']) })).toBe(before);
});

test('source options are explicit and invalid key data cannot disappear into the default', () => {
  const f = setup();
  expect(ownerErasurePreparationOptions('tests/qa/fault-recovery/owner-restore-erasure-production.test.ts')).toEqual({ laterApiAdmission: false });
  expect(ownerErasurePreparationOptions('tests/qa/fault-recovery/owner-restore-erasure-completion.test.ts')).toEqual({ laterApiAdmission: false });
  expect(ownerErasurePreparationOptions('tests/qa/fault-recovery/owner-restore-erasure-later-admission.test.ts')).toEqual({ laterApiAdmission: true });
  expect(ownerErasurePreparationOptions('tests/qa/fault-recovery/operator-restore-membership.test.ts')).toBeUndefined();
  expect(() => sourceKey({ ...f.inputs, inputs: { silent: undefined } } as unknown as SourceInputs)).toThrow('complete JSON');
  expect(() => sourceKey({ ...f.inputs, inputs: { value: Number.NaN } })).toThrow('complete JSON');
});

function childProducer(directory: string, inputs: SourceInputs, paused = false): string {
  const file = join(directory, paused ? 'interrupted.ts' : 'producer-child.ts');
  writeFileSync(file, `import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RetainedSources } from ${JSON.stringify(resolve(import.meta.dir, 'retained-source.ts'))};
const directory = ${JSON.stringify(directory)}, specification = ${JSON.stringify(inputs)};
const adapter = { specification,
  async build(context) {
    appendFileSync(join(directory, 'builds'), 'built\\n');
    writeFileSync(join(context.backup, 'physical'), 'retained bytes');
    ${paused ? "writeFileSync(join(directory, 'paused'), 'ready'); await new Promise(() => {});" : 'await Bun.sleep(75);'}
    return { metadata: { producer: 'child' }, rdfDigest: 'a'.repeat(64), ownerState: { cut: 'one' },
      producerRevision: 'revision', qaIdentity: 'child', phases: {} };
  },
  async verify() { appendFileSync(join(directory, 'verifications'), 'verified\\n'); return []; },
  async restore() { throw new Error('not consumed by preparation'); },
  async dispose() {}, async remove() {}
};
await new RetainedSources(join(directory, 'sources')).prepare(adapter);
`);
  return file;
}

test('separate QA processes build an absent key once and both verify publication', async () => {
  const f = setup(), file = childProducer(f.directory, f.inputs);
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, file], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    for (const child of children) {
      const stderr = await new Response(child.stderr).text();
      expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: '' });
    }
    expect(readFileSync(join(f.directory, 'builds'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(f.directory, 'verifications'), 'utf8').trim().split('\n')).toHaveLength(3);
  } finally { for (const child of children) child.kill(); }
});

test('a killed builder releases custody, publishes nothing and is discarded before preparation rebuild', async () => {
  const f = setup(), child = Bun.spawn([process.execPath, childProducer(f.directory, f.inputs, true)], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(f.directory, 'paused')) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.directory, 'paused'))).toBe(true);
    const selection = f.store.select(f.adapter);
    child.kill('SIGKILL'); await child.exited;
    await expect(selection).rejects.toThrow('complete manifest');
    const result = await f.store.prepare(f.adapter);
    expect(result.built).toBe(true);
    expect(readdirSync(join(f.directory, 'sources')).some(name => name.includes('.pending-'))).toBe(false);
  } finally { child.kill(); }
});

test('concurrent absent-key preparations build once; all consumers verify; selection never builds', async () => {
  const f = setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.store.prepare(f.adapter)));
  expect(results.filter(r => r.built)).toHaveLength(1);
  expect(f.counts().builds).toBe(1);
  expect(new Set(results.map(r => r.manifest.digest)).size).toBe(1);
  const before = f.counts().verifies;
  await f.store.select(f.adapter);
  await f.store.select(f.adapter);
  expect(f.counts().verifies).toBe(before + 2);
  expect(f.counts().builds).toBe(1);
});

test('incomplete preparation is invisible and cleaned; failed manifest removes then rebuilds only in preparation', async () => {
  const f = setup();
  const build = f.adapter.build;
  f.adapter.build = async context => { await build(context); throw new Error('producer interrupted'); };
  await expect(f.store.prepare(f.adapter)).rejects.toThrow('producer interrupted');
  await expect(f.store.select(f.adapter)).rejects.toThrow('complete manifest');
  expect(readdirSync(join(f.directory, 'sources')).filter(name => !name.endsWith('.lock'))).toEqual([]);
  f.adapter.build = build;
  const prepared = await f.store.prepare(f.adapter);
  writeFileSync(join(prepared.manifest.provenance.backupPath, 'postgres'), 'corrupt');
  const before = f.counts().builds;
  await expect(f.store.restore(f.adapter)).rejects.toThrow('retained source');
  expect(f.counts().builds).toBe(before);
  expect((await f.store.prepare(f.adapter)).built).toBe(true);
  expect(f.counts().builds).toBe(before + 1);
  expect(f.removed.filter(k => k === prepared.manifest.key).length).toBeGreaterThan(1);
});

test('metadata, backup and compatibility tampering refuse with evidence without rebuild', async () => {
  for (const fault of ['manifest', 'missing', 'extra', 'compatibility', 'external']) {
    const f = setup(), { manifest } = await f.store.prepare(f.adapter);
    if (fault === 'manifest') {
      manifest.metadata.identity = 'tampered';
      writeFileSync(manifest.provenance.manifestPath, JSON.stringify(manifest));
    } else if (fault === 'missing') rmSync(join(manifest.provenance.backupPath, 'objects'));
    else if (fault === 'extra') writeFileSync(join(manifest.provenance.backupPath, 'extra'), 'unbound');
    else if (fault === 'compatibility') f.adapter.specification.compatibility.native = 'incompatible';
    else f.adapter.verify = async () => ['graph/index physical digest differs'];
    await expect(f.store.select(f.adapter)).rejects.toThrow('refused');
    expect(f.counts().builds).toBe(1);
  }
});

test('a malformed manifest is refused by consumption and removed before preparation rebuild', async () => {
  const f = setup(), result = await f.store.prepare(f.adapter);
  writeFileSync(result.manifest.provenance.manifestPath, 'null');
  await expect(f.store.select(f.adapter)).rejects.toThrow('complete manifest');
  expect(f.counts().builds).toBe(1);
  expect((await f.store.prepare(f.adapter)).built).toBe(true);
  expect(f.counts().builds).toBe(2);
});

test('preparation exceeding 600 active seconds publishes no source', async () => {
  const f = setup();
  let clock = 0;
  const store = new RetainedSources(join(f.directory, 'timed-failure'), () => clock);
  const build = f.adapter.build;
  f.adapter.build = async context => { const result = await build(context); clock += 600_001; return result; };
  await expect(store.prepare(f.adapter)).rejects.toThrow('600 seconds');
  await expect(store.select(f.adapter)).rejects.toThrow('complete manifest');
  expect(readdirSync(join(f.directory, 'timed-failure')).filter(name => !name.endsWith('.lock'))).toEqual([]);
});

test('restores have fresh writable resources, independent disposal and immutable custody', async () => {
  const f = setup(), { manifest } = await f.store.prepare(f.adapter);
  const a = await f.store.restore(f.adapter), b = await f.store.restore(f.adapter);
  expect(a.candidate.directory).not.toBe(b.candidate.directory);
  writeFileSync(join(a.candidate.directory, 'objects'), 'candidate fault');
  expect(readFileSync(join(b.candidate.directory, 'objects'), 'utf8')).toBe('authored bodies');
  await a.dispose();
  expect(existsSync(b.candidate.directory)).toBe(true);
  expect((await f.store.select(f.adapter)).digest).toBe(manifest.digest);
  await b.dispose();
  expect(f.counts().builds).toBe(1);
});

test('source-writing consumer is refused and its candidate disposed', async () => {
  const f = setup();
  await f.store.prepare(f.adapter);
  const restore = f.adapter.restore;
  f.adapter.restore = async (context, manifest) => {
    const candidate = await restore(context, manifest);
    writeFileSync(join(context.backup, 'objects'), 'wrong writable authority');
    return candidate;
  };
  await expect(f.store.restore(f.adapter)).rejects.toThrow('retained source');
  expect(existsSync(join(f.directory, 'copy-1'))).toBe(false);
});

test('a consumer cannot reseal changed custody to hide a source write', async () => {
  const f = setup();
  await f.store.prepare(f.adapter);
  const restore = f.adapter.restore;
  f.adapter.restore = async (context, manifest) => {
    const candidate = await restore(context, manifest);
    writeFileSync(join(context.backup, 'objects'), 'wrong writable authority');
    const integrity = retainedIntegrity(context.backup, manifest.integrity.rdfDigest, manifest.integrity.ownerState);
    const { digest: _oldDigest, ...body } = { ...manifest, integrity };
    writeFileSync(manifest.provenance.manifestPath, stable({ ...body, digest: sha256(stable(body)) }));
    return candidate;
  };
  await expect(f.store.restore(f.adapter)).rejects.toThrow('source manifest changed');
  expect(existsSync(join(f.directory, 'copy-1'))).toBe(false);
});

test('failed candidate disposal keeps custody protected and can be retried independently', async () => {
  const f = setup();
  await f.store.prepare(f.adapter);
  const consumer = await f.store.restore(f.adapter), dispose = f.adapter.dispose;
  let attempts = 0;
  f.adapter.dispose = async candidate => { if (++attempts === 1) throw new Error('candidate stop failed'); await dispose(candidate); };
  await expect(consumer.dispose()).rejects.toThrow('candidate stop failed');
  expect(existsSync(consumer.candidate.directory)).toBe(true);
  await consumer.dispose();
  await consumer.dispose();
  expect(attempts).toBe(2);
  expect(existsSync(consumer.candidate.directory)).toBe(false);
});

test('preparation reuses valid custody while another operation holds a consumer lease', async () => {
  const f = setup();
  await f.store.prepare(f.adapter);
  const consumer = await f.store.restore(f.adapter);
  try {
    const reused = await Promise.race([f.store.prepare(f.adapter), Bun.sleep(250).then(() => { throw new Error('reuse waited on operation'); })]);
    expect(reused.built).toBe(false);
    expect(f.counts().builds).toBe(1);
  } finally { await consumer.dispose(); }
});

test('retention is two per producer, oldest publication first; historical backups survive', async () => {
  const f = setup();
  const historical = join(f.directory, 'sources', 'rezics-retained-g2205');
  mkdirSync(historical, { recursive: true });
  const keys: string[] = [];
  let now = 0;
  const store = new RetainedSources(join(f.directory, 'sources'), () => now);
  for (let ordinal = 0; ordinal < SOURCES_PER_PRODUCER + 1; ordinal++) {
    now = ordinal * 1_000;
    f.adapter.specification = { ...f.inputs, inputs: { ordinal } };
    const { manifest } = await store.prepare(f.adapter);
    keys.push(manifest.key);
  }
  expect(existsSync(join(f.directory, 'sources', keys[0]!))).toBe(false);
  expect(existsSync(join(f.directory, 'sources', keys[1]!))).toBe(true);
  expect(existsSync(join(f.directory, 'sources', keys[2]!))).toBe(true);
  expect(existsSync(historical)).toBe(true);
});

test('an active consumer protects oldest custody from pruning until successful disposal', async () => {
  const f = setup();
  const first = await f.store.prepare(f.adapter), consumer = await f.store.restore(f.adapter);
  f.adapter.specification = { ...f.inputs, inputs: { ordinal: 2 } };
  await f.store.prepare(f.adapter);
  f.adapter.specification = { ...f.inputs, inputs: { ordinal: 3 } };
  // The first adapter must retain its declared inputs throughout the consumer lease.
  const thirdAdapter = { ...f.adapter };
  f.adapter.specification = first.manifest.specification;
  let published = false;
  const preparing = f.store.prepare(thirdAdapter).then(result => { published = true; return result; });
  await Bun.sleep(100);
  expect(published).toBe(false);
  expect(existsSync(first.manifest.provenance.backupPath)).toBe(true);
  await consumer.dispose();
  await preparing;
  expect(existsSync(first.manifest.provenance.backupPath)).toBe(false);
});

test('restore exceeding its own ceiling disposes its candidate and never rebuilds', async () => {
  const f = setup();
  let clock = 0;
  const store = new RetainedSources(join(f.directory, 'timed-refusal'), () => clock);
  await store.prepare(f.adapter);
  const restore = f.adapter.restore;
  f.adapter.restore = async (context, manifest) => { const copy = await restore(context, manifest); clock += 600_001; return copy; };
  await expect(store.restore(f.adapter)).rejects.toThrow('600 seconds');
  expect(existsSync(join(f.directory, 'copy-1'))).toBe(false);
  expect(f.counts().builds).toBe(1);
});

test('preparation/admission and restore clocks remain separate at unchanged ceilings', async () => {
  const f = setup();
  let clock = 0;
  const store = new RetainedSources(join(f.directory, 'timed'), () => clock);
  const build = f.adapter.build;
  f.adapter.build = async context => {
    clock += 700_000;
    context.budget.excludeAdmissionWait(700_000);
    clock += 178_800;
    return build(context);
  };
  const preparation = await store.prepare(f.adapter);
  expect(preparation.elapsedMs).toBe(178_800);
  expect(preparation.admissionWaitMs).toBe(700_000);
  const restore = f.adapter.restore;
  f.adapter.restore = async (context, manifest) => { clock += 3_000; return restore(context, manifest); };
  const operation = await store.restore(f.adapter);
  expect(operation.elapsedMs).toBe(3_000);
  expect(SOURCE_PREPARATION_MS).toBe(600_000);
  expect(SOURCE_RESTORE_MS).toBe(600_000);
  await operation.dispose();
});
