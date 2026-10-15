import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, stable } from '../fixture/corpus.ts';
import { retainedIntegrity } from '../fixture/manifest.ts';
import { rebindRetainedRecoveryAttachment } from '../../tests/qa/fault-recovery/owner-restore-erasure-fixture.ts';
import { RetainedSources, RetainedSourceRefusal, retainedSourceFailure, sourceKey, sourceFileDigests, ownerErasurePreparationOptions, SOURCES_PER_PRODUCER, SOURCE_PREPARATION_MS, SOURCE_RESTORE_MS, type RetainedSourceAdapter, type SourceInputs } from './retained-source.ts';

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

test('restoring absent custody refuses without creating a source directory or running a producer', async () => {
  const f = setup(), key = sourceKey(f.inputs);
  await expect(f.store.restore(f.adapter)).rejects.toThrow('complete manifest is missing or unreadable');
  expect(existsSync(join(f.directory, 'sources', key))).toBe(false);
  expect(readdirSync(join(f.directory, 'sources'))).toEqual([`${key}.lock`]);
  expect(f.counts()).toEqual({ builds: 0, verifies: 0, restores: 0 });
  expect(f.removed).toEqual([]);
});

test('a failed build remains primary when removal fails and cannot become selectable custody', async () => {
  const f = setup(), cause = new Error('producer cause'), primary = new Error('producer interrupted', { cause });
  const cleanup = new Error('external volume still held');
  const stack = primary.stack;
  f.adapter.build = async () => { throw primary; };
  let removals = 0;
  f.adapter.remove = async () => { if (++removals > 1) throw cleanup; };
  const error = await f.store.prepare(f.adapter).catch(error => error);
  expect(error).toBe(primary);
  expect(error.cause).toBe(cause);
  expect(error.stack).toBe(stack);
  expect(retainedSourceFailure(error)?.boundary).toBe('build');
  expect(retainedSourceFailure(error)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
  expect(readdirSync(join(f.directory, 'sources')).filter(name => !name.endsWith('.lock'))).toEqual([]);
  await expect(f.store.select(f.adapter)).rejects.toThrow('complete manifest');
});

test('a failed custody verification retains its exception when removal also fails', async () => {
  const f = setup(), primary = new Error('native inventory refused'), cleanup = new Error('external volume still held');
  f.adapter.verify = async () => { throw primary; };
  let removals = 0;
  f.adapter.remove = async () => { if (++removals > 1) throw cleanup; };
  const error = await f.store.prepare(f.adapter).catch(error => error);
  expect(error.message).toContain('physical verification failed');
  expect(error.cause).toBe(primary);
  expect(error).toBeInstanceOf(RetainedSourceRefusal);
  expect(retainedSourceFailure(error)?.boundary).toBe('verify-staging');
  expect(retainedSourceFailure(error)?.adapterPhases).toEqual({ api: 5 });
  expect(retainedSourceFailure(error)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
  await expect(f.store.select(f.adapter)).rejects.toThrow('complete manifest');
});

// Fault the real holder only after it exits, so tests never leave a kernel lease behind.
function failLeaseRelease(error: Error) {
  const spawn = Bun.spawn;
  return spyOn(Bun, 'spawn').mockImplementation((...args) => {
    const holder = Reflect.apply(spawn, Bun, args) as ReturnType<typeof Bun.spawn>;
    if (holder.stderr instanceof ReadableStream) {
      const cancel = holder.stderr.cancel.bind(holder.stderr);
      holder.stderr.cancel = async () => { await cancel(); throw error; };
    }
    return holder;
  });
}

test('failed preparation records active/admission phases before cleanup and logs no exception payload', async () => {
  const f = setup();
  let clock = 0, removals = 0;
  const store = new RetainedSources(join(f.directory, 'timings'), () => clock);
  const primary = Object.freeze(new Error('compose.env PRIVATE_PASSWORD=private-primary'));
  const cleanup = new Error('compose.env PRIVATE_PASSWORD=private-cleanup');
  const messages: string[] = [];
  const log = spyOn(console, 'error').mockImplementation(message => { messages.push(String(message)); });
  try {
    f.adapter.build = async context => {
      clock += 750;
      context.budget.excludeAdmissionWait(700);
      throw primary;
    };
    f.adapter.remove = async () => { if (++removals > 1) { clock += 20; throw cleanup; } };
    expect(await store.prepare(f.adapter).catch(error => error)).toBe(primary);
    const evidence = retainedSourceFailure(primary)!;
    expect(evidence.elapsedMs).toBe(50);
    expect(evidence.admissionWaitMs).toBe(700);
    expect(evidence.phases.build).toEqual({ elapsedMs: 50, admissionWaitMs: 700 });
    expect(evidence.adapterPhases).toBeUndefined();
    expect(evidence.cleanup).toEqual([{ boundary: 'remove', error: cleanup, elapsedMs: 20, admissionWaitMs: 0 }]);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join('')).not.toContain('private-primary');
    expect(messages.join('')).not.toContain('private-cleanup');
    expect(messages.join('').length).toBeLessThan(8_000);
  } finally { log.mockRestore(); }
});

test('successful failure cleanup preserves the primary; cleanup alone stops preparation before build', async () => {
  const f = setup(), primary = new Error('producer interrupted');
  f.adapter.build = async () => { throw primary; };
  expect(await f.store.prepare(f.adapter).catch(error => error)).toBe(primary);
  expect(retainedSourceFailure(primary)?.cleanup).toEqual([]);
  expect(readdirSync(join(f.directory, 'sources')).filter(name => !name.endsWith('.lock'))).toEqual([]);
  const cleanup = new Error('preparation removal refused');
  f.adapter.remove = async () => { throw cleanup; };
  expect(await f.store.prepare(f.adapter).catch(error => error)).toBe(cleanup);
  expect(retainedSourceFailure(cleanup)?.boundary).toBe('remove');
  expect(f.counts().builds).toBe(0);
});

test('failure after publication quarantines custody even when external removal fails', async () => {
  const f = setup(), primary = new Error('published inventory failed'), cleanup = new Error('volume held');
  let verifies = 0, removes = 0;
  f.adapter.verify = async () => { if (++verifies === 2) throw primary; return []; };
  f.adapter.remove = async () => { if (++removes > 1) throw cleanup; };
  const error = await f.store.prepare(f.adapter).catch(error => error);
  expect(error.cause).toBe(primary);
  expect(retainedSourceFailure(error)?.boundary).toBe('verify-published');
  expect(retainedSourceFailure(error)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
  expect(existsSync(join(f.directory, 'sources', sourceKey(f.inputs)))).toBe(false);
  await expect(f.store.select(f.adapter)).rejects.toThrow('complete manifest');
  expect(readdirSync(join(f.directory, 'sources')).some(name => name.includes('.pending-'))).toBe(true);
});

test('failed verification of existing custody remains primary when rebuild removal fails', async () => {
  const f = setup();
  const { manifest } = await f.store.prepare(f.adapter);
  writeFileSync(join(manifest.provenance.backupPath, 'objects'), 'tampered');
  const cleanup = new Error('volume held');
  f.adapter.remove = async () => { throw cleanup; };
  const error = await f.store.prepare(f.adapter).catch(error => error);
  expect(error).toBeInstanceOf(RetainedSourceRefusal);
  expect(retainedSourceFailure(error)?.boundary).toBe('verify-existing');
  expect(retainedSourceFailure(error)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
  expect(f.counts().builds).toBe(1);
});

test('select refusal and restore exception survive failed lease release; release alone also fails', async () => {
  const f = setup();
  await f.store.prepare(f.adapter);
  const primary = new Error('restore interrupted'), cleanup = new Error('lease stream failed');
  const release = failLeaseRelease(cleanup);
  try {
    f.adapter.restore = async () => { throw primary; };
    expect(await f.store.restore(f.adapter).catch(error => error)).toBe(primary);
    expect(retainedSourceFailure(primary)?.boundary).toBe('restore');
    expect(retainedSourceFailure(primary)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
    expect(await f.store.select(f.adapter).catch(error => error)).toBe(cleanup);
    expect(retainedSourceFailure(cleanup)?.boundary).toBe('release');
    f.adapter.verify = async () => ['physical state differs'];
    const refusal = await f.store.select(f.adapter).catch(error => error);
    expect(refusal).toBeInstanceOf(RetainedSourceRefusal);
    expect(retainedSourceFailure(refusal)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
  } finally { release.mockRestore(); }
});

test('restore budget failure survives failed candidate disposal and lease release', async () => {
  const f = setup();
  let clock = 0;
  const store = new RetainedSources(join(f.directory, 'restore-failure'), () => clock);
  await store.prepare(f.adapter);
  const restore = f.adapter.restore, disposal = new Error('candidate stop failed'), lease = new Error('lease stream failed');
  f.adapter.restore = async (context, manifest) => { const candidate = await restore(context, manifest); clock += 600_001; return candidate; };
  f.adapter.dispose = async () => { throw disposal; };
  const release = failLeaseRelease(lease);
  try {
    const error = await store.restore(f.adapter).catch(error => error);
    expect(error.message).toBe('Fixture preparation exceeded 600 seconds');
    const evidence = retainedSourceFailure(error)!;
    expect(evidence.boundary).toBe('verify-restored');
    expect(evidence.elapsedMs).toBe(600_001);
    expect(evidence.cleanup.map(entry => entry.error)).toEqual([disposal, lease]);
  } finally { release.mockRestore(); }
});

test('post-disposal custody refusal survives lease failure and cannot be reported as successful disposal', async () => {
  const f = setup();
  await f.store.prepare(f.adapter);
  const consumer = await f.store.restore(f.adapter), dispose = f.adapter.dispose, cleanup = new Error('lease stream failed');
  f.adapter.dispose = async candidate => { await dispose(candidate); f.adapter.verify = async () => ['source changed during disposal']; };
  // The holder already exists; inject at its release through the stream method instead of acquiring a new lease.
  const cancel = ReadableStream.prototype.cancel;
  const release = spyOn(ReadableStream.prototype, 'cancel').mockImplementation(async function(this: ReadableStream, reason) {
    await cancel.call(this, reason);
    throw cleanup;
  });
  try {
    const error = await consumer.dispose().catch(error => error);
    expect(error).toBeInstanceOf(RetainedSourceRefusal);
    expect(retainedSourceFailure(error)?.boundary).toBe('verify-disposed');
    expect(retainedSourceFailure(error)?.cleanup.map(entry => entry.error)).toEqual([cleanup]);
    expect(existsSync(consumer.candidate.directory)).toBe(false);
  } finally { release.mockRestore(); }
});

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

test('retained attachment consumers reconstruct proof custody after the producer directory is gone', () => {
  const f = setup(), copy = join(f.directory, 'isolated-attachments');
  mkdirSync(copy);
  const ciphertext = Buffer.from('exact retained encrypted owner state');
  const attachment = { path: join(f.directory, 'former-producer', 'attachment.gpg'),
    value: { ownerCut: 'original-cut', erasureId: 'original-erasure' },
    ciphertextDigest: sha256(ciphertext), ciphertextBytes: String(ciphertext.length), recipientFingerprint: 'b'.repeat(40) };
  writeFileSync(join(copy, 'attachment.gpg'), ciphertext);
  const restored = rebindRetainedRecoveryAttachment(attachment, copy);
  expect(existsSync(attachment.path)).toBe(false);
  expect(restored.path).toBe(join(copy, 'attachment.gpg'));
  expect(restored).toEqual({ ...attachment, path: restored.path });
  expect(readFileSync(restored.path)).toEqual(ciphertext);
  writeFileSync(restored.path, 'corrupt copy');
  expect(() => rebindRetainedRecoveryAttachment(attachment, copy)).toThrow('differs from retained ciphertext');
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

test('declared producer build has its own evidenced deadline before the unchanged physical-cut clock', async () => {
  const f = setup();
  let clock = 0, producers = 0;
  const store = new RetainedSources(join(f.directory, 'declared'), () => clock);
  const key = sourceKey(f.inputs), build = f.adapter.build;
  f.adapter.producerBuild = {
    deadlineMs: 900_000, evidence: 'Measured producer requires 800 s active work before the physical cut',
    async run(context) {
      producers++;
      expect(context.key).toBe(key);
      expect(context.budget.remaining()).toBe(900_000);
      clock += 700_000;
      context.budget.excludeAdmissionWait(700_000);
      clock += 800_000;
      expect(context.budget.remaining()).toBe(100_000);
    },
  };
  f.adapter.build = async context => {
    expect(producers).toBe(1);
    expect(context.budget.remaining()).toBe(SOURCE_PREPARATION_MS);
    clock += 1_000;
    context.budget.excludeAdmissionWait(1_000);
    clock += 599_900;
    return build(context);
  };
  f.adapter.verify = async context => {
    clock += 40;
    expect(context.budget.remaining()).toBeGreaterThan(0);
    return [];
  };
  const prepared = await store.prepare(f.adapter);
  expect(prepared.manifest.key).toBe(key);
  expect(prepared.elapsedMs).toBe(599_980);
  expect(prepared.admissionWaitMs).toBe(701_000);
  expect(prepared.producerBuild).toEqual({ deadlineMs: 900_000,
    evidence: f.adapter.producerBuild.evidence, elapsedMs: 800_000, admissionWaitMs: 700_000 });
  expect(prepared.manifest.provenance.producerBuild).toEqual(prepared.producerBuild);
  expect(prepared.manifest.provenance.admissionWaitMs).toBe(701_000);
  const reused = await store.prepare(f.adapter);
  expect(reused.built).toBe(false);
  expect(reused.manifest.digest).toBe(prepared.manifest.digest);
  await store.select(f.adapter);
  const restored = await store.restore(f.adapter);
  await restored.dispose();
  expect(producers).toBe(1);
  expect(f.counts().builds).toBe(1);
  expect(SOURCE_PREPARATION_MS).toBe(600_000);
  expect(SOURCE_RESTORE_MS).toBe(600_000);
});

test('declared build deadlines reject the exact boundary and overruns before any cut or seal', async () => {
  for (const duration of [900_000, 900_001]) {
    const f = setup();
    let clock = 0;
    const root = join(f.directory, 'declared-overrun'), store = new RetainedSources(root, () => clock);
    const cleanup = new Error('overrun producer resources held');
    let removals = 0;
    f.adapter.remove = async () => { if (++removals > 1) throw cleanup; };
    f.adapter.producerBuild = { deadlineMs: 900_000, evidence: 'Measured producer bound',
      async run(context) { writeFileSync(join(context.backup, 'unsealed'), 'producer bytes'); clock += duration; } };
    const error = await store.prepare(f.adapter).catch(error => error);
    expect(error.message).toContain('declared 900000 ms deadline');
    const evidence = retainedSourceFailure(error)!;
    expect(evidence.boundary).toBe('producer-build');
    expect(evidence.producerBuild?.elapsedMs).toBe(duration);
    expect(evidence.producerBuild?.deadlineMs).toBe(900_000);
    expect(evidence.phases['producer-build']).toEqual({ elapsedMs: duration, admissionWaitMs: 0 });
    expect(evidence.preparation).toBeUndefined();
    expect(evidence.cleanup.map(entry => entry.error)).toEqual([cleanup]);
    expect(f.counts()).toEqual({ builds: 0, verifies: 0, restores: 0 });
    expect(readdirSync(root).filter(name => !name.endsWith('.lock'))).toEqual([]);
    await expect(store.select(f.adapter)).rejects.toThrow('complete manifest');
    // Cleanup released both leases; retrying the same key can publish normally.
    f.adapter.producerBuild.run = async () => { clock += 1; };
    f.adapter.remove = async () => {};
    expect((await store.prepare(f.adapter)).built).toBe(true);
  }
});

test('declared build failure preserves primary cause/stack and secondary removal/release evidence while cleaning unsealed staging', async () => {
  const f = setup();
  let clock = 0, removals = 0;
  const root = join(f.directory, 'declared-failure'), store = new RetainedSources(root, () => clock);
  const cause = new Error('producer cause'), primary = Object.freeze(new Error('producer failed', { cause }));
  const stack = primary.stack, cleanup = new Error('external volume held'), lease = new Error('lease stream failed');
  f.adapter.producerBuild = { deadlineMs: 900_000, evidence: 'Measured producer bound', async run(context) {
    writeFileSync(join(context.backup, 'unsealed'), 'producer bytes');
    clock += 750;
    context.budget.excludeAdmissionWait(700);
    throw primary;
  } };
  f.adapter.remove = async () => { if (++removals > 1) { clock += 20; throw cleanup; } };
  const release = failLeaseRelease(lease);
  try {
    const error = await store.prepare(f.adapter).catch(error => error);
    expect(error).toBe(primary);
    expect(error.cause).toBe(cause);
    expect(error.stack).toBe(stack);
    const evidence = retainedSourceFailure(error)!;
    expect(evidence.boundary).toBe('producer-build');
    expect(evidence.producerBuild).toEqual({ deadlineMs: 900_000, evidence: 'Measured producer bound',
      elapsedMs: 50, admissionWaitMs: 700 });
    expect(evidence.elapsedMs).toBe(50);
    expect(evidence.admissionWaitMs).toBe(700);
    expect(evidence.cleanup.map(entry => entry.error)).toEqual([cleanup, lease, lease]);
    expect(readdirSync(root).filter(name => !name.endsWith('.lock'))).toEqual([]);
    expect(f.counts().builds).toBe(0);
  } finally { release.mockRestore(); }
  f.adapter.producerBuild.run = async () => { clock += 1; };
  f.adapter.remove = async () => {};
  expect((await store.prepare(f.adapter)).built).toBe(true);
});

test('declared builds do not extend the physical cut, seal or either backup verification deadline', async () => {
  for (const phase of ['cut', 'seal', 'verify-staging', 'verify-published'] as const) {
    const f = setup();
    let clock = 0, verifies = 0;
    const root = join(f.directory, `cut-${phase}`), store = new RetainedSources(root, () => clock);
    f.adapter.producerBuild = { deadlineMs: 900_000, evidence: 'Measured producer bound', async run() { clock += 800_000; } };
    const build = f.adapter.build;
    f.adapter.build = async context => {
      const result = await build(context);
      if (phase === 'cut') clock += SOURCE_PREPARATION_MS;
      if (phase === 'seal') Object.defineProperty(result, 'metadata', {
        get() { clock += SOURCE_PREPARATION_MS; return { identity: 'seal timing' }; },
      });
      return result;
    };
    f.adapter.verify = async () => {
      verifies++;
      if ((phase === 'verify-staging' && verifies === 1) || (phase === 'verify-published' && verifies === 2))
        clock += SOURCE_PREPARATION_MS;
      return [];
    };
    const error = await store.prepare(f.adapter).catch(error => error);
    expect(error.message).toContain('600 seconds');
    const evidence = retainedSourceFailure(error)!;
    expect(evidence.boundary).toBe(phase === 'cut' ? 'build' : phase === 'seal' ? 'verify-staging' : phase);
    expect(evidence.producerBuild?.elapsedMs).toBe(800_000);
    expect(evidence.preparation).toEqual({ elapsedMs: SOURCE_PREPARATION_MS, admissionWaitMs: 0 });
    expect(evidence.elapsedMs).toBe(800_000 + SOURCE_PREPARATION_MS);
    expect(readdirSync(root).filter(name => !name.endsWith('.lock'))).toEqual([]);
    await expect(store.select(f.adapter)).rejects.toThrow('complete manifest');
  }
});

test('invalid producer deadlines and missing evidence cannot invoke a producer or physical cut', async () => {
  for (const declaration of [
    { deadlineMs: 0, evidence: 'measured' }, { deadlineMs: -1, evidence: 'measured' },
    { deadlineMs: Infinity, evidence: 'measured' }, { deadlineMs: NaN, evidence: 'measured' },
    { deadlineMs: 1.5, evidence: 'measured' }, { deadlineMs: 900_000, evidence: ' ' },
    { deadlineMs: 900_000, evidence: 'x'.repeat(2_001) },
  ]) {
    const f = setup();
    let producers = 0;
    f.adapter.producerBuild = { ...declaration, async run() { producers++; } };
    await expect(f.store.prepare(f.adapter)).rejects.toThrow('positive deadlineMs and bounded nonempty evidence');
    expect(producers).toBe(0);
    expect(f.counts().builds).toBe(0);
    expect(readdirSync(join(f.directory, 'sources')).filter(name => !name.endsWith('.lock'))).toEqual([]);
  }
});

test('declared producers retain the existing single builder per key and two-source retention leases', async () => {
  const f = setup();
  let producers = 0;
  const thirdProducer = Promise.withResolvers<void>();
  f.adapter.producerBuild = { deadlineMs: 900_000, evidence: 'Measured producer bound', async run() {
    if (++producers === 3) thirdProducer.resolve();
  } };
  const results = await Promise.all(Array.from({ length: 5 }, () => f.store.prepare(f.adapter)));
  expect(producers).toBe(1);
  expect(f.counts().builds).toBe(1);
  expect(results.filter(result => result.built)).toHaveLength(1);
  expect(new Set(results.map(result => result.manifest.digest)).size).toBe(1);
  const consumer = await f.store.restore(f.adapter);
  f.adapter = { ...f.adapter, specification: { ...f.inputs, version: '2' } };
  await f.store.prepare(f.adapter);
  f.adapter = { ...f.adapter, specification: { ...f.inputs, version: '3' } };
  let published = false;
  const third = f.store.prepare(f.adapter).then(result => { published = true; return result; });
  await thirdProducer.promise;
  // The candidate's actual lease remains held after the producer stage completes.
  expect(published).toBe(false);
  expect(existsSync(join(f.directory, 'sources', sourceKey(f.inputs)))).toBe(true);
  await consumer.dispose();
  await third;
  expect(producers).toBe(3);
  expect(existsSync(join(f.directory, 'sources', sourceKey(f.inputs)))).toBe(false);
  expect(readdirSync(join(f.directory, 'sources')).filter(name => name.startsWith('rs-') && !name.endsWith('.lock'))).toHaveLength(SOURCES_PER_PRODUCER);
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
