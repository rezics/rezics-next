import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  createQaStackPool, destroyHeldQaStacks, qaStackFingerprint, qaStackPoolEnabled, qaStackPoolMaxParkedMs,
  trackHeldQaStackStartup, type QaStackPoolEntry, type QaStackPoolOptions,
} from './stack-pool.ts';
import { processAlive, processIdentity, type ProcessIdentity } from './process/identity.ts';
import { terminateProcessGroupSync } from './process/terminate.ts';

const temporary: string[] = [];
afterEach(() => {
  destroyHeldQaStacks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(slots = 2) {
  const base = resolve(import.meta.dir, '../../.temp/qa-stack-pool-tests');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'pool-'));
  temporary.push(root);
  const slotDirectory = join(root, 'slots');
  const switchFile = join(root, 'qa-stack-pool');
  const state = join(root, 'qa-stack-pool-state');
  const destroyed: string[] = [];
  const live = new Set(['first', 'second']);
  const identity = (start: string): ProcessIdentity => ({ pid: 123, start, boot: 'boot', cgroup: '' });
  let time = 1_000;
  const options: QaStackPoolOptions = {
    root, slotDirectory, slots, holder: identity('first'), alive: holder => live.has(holder.start),
    now: () => time, janitor: false,
    destroy: async entry => { destroyed.push(entry.projectRunId); },
    destroySync: entry => { destroyed.push(entry.projectRunId); },
  };
  return {
    root, slotDirectory, switchFile, state, options, destroyed, live, identity,
    on() { writeFileSync(switchFile, 'on\n'); },
    advance(ms: number) { time += ms; },
    pool(overrides: Partial<QaStackPoolOptions> = {}) { return createQaStackPool({ ...options, ...overrides }); },
    saved(id: string) { return JSON.parse(readFileSync(join(state, `${id}.json`), 'utf8')) as QaStackPoolEntry; },
  };
}

const apps = { POSTGRES_URL: 'postgres://qa', S3_BUCKET: 'qa', SMTP_HOST: 'localhost' };
const compose = { REZICS_S3_PASSWORD: 'secret', REZICS_FUSEKI_MEMORY_LIMIT: '7g' };

test('pool is off unless the host switch explicitly says on; no slots are a no-op', async () => {
  const f = fixture();
  expect(qaStackPoolEnabled(undefined)).toBe(false);
  expect(qaStackPoolEnabled(f.slotDirectory)).toBe(false);
  expect(await f.pool().register('first', 'ordinary')).toBeUndefined();
  expect(await f.pool().acquire('ordinary')).toBeUndefined();
  expect(existsSync(f.state)).toBe(false);
  writeFileSync(f.switchFile, 'true');
  expect(qaStackPoolEnabled(f.slotDirectory)).toBe(false);
  f.on();
  expect(qaStackPoolEnabled(f.slotDirectory)).toBe(true);
  const absent = f.pool({ slotDirectory: undefined });
  expect(await absent.register('first', 'ordinary')).toBeUndefined();
  expect(await absent.acquire('ordinary')).toBeUndefined();
  await absent.sweep();
});

test('a clean release has no holder and a matching lease carries independent endpoint snapshots and parked duration', async () => {
  const f = fixture();
  f.on();
  const original = await f.pool().register('origin-project', 'ordinary');
  expect(original?.entry.holder).toEqual(f.identity('first'));
  const appSnapshot = { ...apps };
  const composeSnapshot = { ...compose };
  expect(await original!.park(appSnapshot, composeSnapshot)).toBe(true);
  appSnapshot.POSTGRES_URL = 'changed';
  composeSnapshot.REZICS_S3_PASSWORD = 'changed';
  expect(f.saved('origin-project').holder).toBeUndefined();
  f.advance(2_345);
  const leased = await f.pool({ root: join(f.root, 'different-worktree'), holder: f.identity('second') }).acquire('ordinary');
  expect(leased?.parkedMs).toBe(2_345);
  expect(leased?.entry.projectRunId).toBe('origin-project');
  expect(leased?.entry.apps).toEqual(apps);
  expect(leased?.entry.compose).toEqual(compose);
  expect(leased?.entry.holder).toEqual(f.identity('second'));
  expect(f.saved('origin-project').parkedAt).toBeUndefined();
  expect(f.destroyed).toEqual([]);
});

test('pool capacity includes active holders and unowned parked stacks', async () => {
  const f = fixture(2);
  f.on();
  const first = await f.pool().register('first', 'ordinary');
  const second = await f.pool().register('second', 'ordinary');
  await first!.park(apps, compose);
  expect(await f.pool().register('third', 'ordinary')).toBeUndefined();
  await second!.destroy();
  expect((await f.pool().register('third', 'ordinary'))?.entry.projectRunId).toBe('third');
  expect(readdirSync(f.state).filter(name => name.endsWith('.json'))).toHaveLength(2);
});

test('a fresh stack with a known fingerprint preserves matching parked stacks', async () => {
  const f = fixture(3);
  f.on();
  for (const project of ['parked-first', 'parked-second']) {
    const lease = await f.pool().register(project, 'ordinary');
    expect(await lease!.park(apps, compose)).toBe(true);
  }
  const saved = ['parked-first', 'parked-second'].map(project => f.saved(project));
  const fresh = await f.pool().register('fresh', 'ordinary');
  expect(fresh?.entry.fingerprint).toBe('ordinary');
  expect(fresh?.entry.holder).toEqual(f.identity('first'));
  expect(['parked-first', 'parked-second'].map(project => f.saved(project))).toEqual(saved);
  expect(f.destroyed).toEqual([]);
  expect((await f.pool().acquire('ordinary'))?.entry.projectRunId).toBe('parked-first');
});

test('refusing a fresh stack at capacity preserves matching parked stacks', async () => {
  const f = fixture(1);
  f.on();
  const parked = await f.pool().register('parked', 'ordinary');
  expect(await parked!.park(apps, compose)).toBe(true);
  const saved = f.saved('parked');
  expect(await f.pool().register('fresh', 'ordinary')).toBeUndefined();
  expect(f.saved('parked')).toEqual(saved);
  expect(existsSync(join(f.state, 'fresh.json'))).toBe(false);
  expect(f.destroyed).toEqual([]);
  expect((await f.pool().acquire('ordinary'))?.entry.projectRunId).toBe('parked');
});

test('concurrent acquisitions give the parked stack to exactly one holder', async () => {
  const f = fixture(1);
  f.on();
  const original = await f.pool().register('original', 'ordinary');
  await original!.park(apps, compose);
  const results = await Promise.all([
    f.pool().acquire('ordinary'), f.pool({ holder: f.identity('second') }).acquire('ordinary'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(f.saved('original').holder?.start).toBe(results.find(Boolean)!.entry.holder?.start);
});

test('concurrent registrations cannot exceed the host slot count', async () => {
  const f = fixture(1);
  f.on();
  const results = await Promise.all([
    f.pool().register('first', 'ordinary'), f.pool().register('second', 'ordinary'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(readdirSync(f.state).filter(name => name.endsWith('.json'))).toHaveLength(1);
});

test('a dead holder is destroyed and never turned into a reusable stack', async () => {
  const f = fixture(1);
  f.on();
  await f.pool().register('crashed', 'ordinary');
  f.live.delete('first');
  const replacement = f.pool({ holder: f.identity('second') });
  expect(await replacement.acquire('ordinary')).toBeUndefined();
  expect(f.destroyed).toEqual(['crashed']);
  expect((await replacement.register('fresh', 'ordinary'))?.entry.projectRunId).toBe('fresh');
});

test('a reused pid with a different start time does not own its old stack', async () => {
  const f = fixture();
  f.on();
  const identity = processIdentity(process.pid)!;
  await f.pool({ holder: { ...identity, start: `${identity.start}0` }, alive: undefined }).register('old-pid', 'ordinary');
  expect(await f.pool({ holder: identity, alive: undefined }).acquire('ordinary')).toBeUndefined();
  expect(f.destroyed).toEqual(['old-pid']);
});

test('fingerprint mismatches destroy parked stacks while keeping live holders', async () => {
  const f = fixture();
  f.on();
  const parked = await f.pool().register('old-parked', 'old');
  await parked!.park(apps, compose);
  await f.pool().register('old-active', 'old');
  expect(await f.pool().acquire('new')).toBeUndefined();
  expect(f.destroyed).toEqual(['old-parked']);
  expect(existsSync(join(f.state, 'old-active.json'))).toBe(true);
});

test('parked stacks expire at fifteen minutes and a sweep frees their capacity', async () => {
  const f = fixture(1);
  f.on();
  const lease = await f.pool().register('old', 'ordinary');
  await lease!.park(apps, compose);
  f.advance(qaStackPoolMaxParkedMs - 1);
  await f.pool().sweep();
  expect(f.destroyed).toEqual([]);
  f.advance(1);
  await f.pool().sweep();
  expect(f.destroyed).toEqual(['old']);
  expect((await f.pool().register('fresh', 'ordinary'))?.entry.projectRunId).toBe('fresh');
});

test('switching off destroys parked stacks and destroys a holder on its clean release', async () => {
  const f = fixture();
  f.on();
  const parked = await f.pool().register('parked', 'ordinary');
  await parked!.park(apps, compose);
  const held = await f.pool().register('held', 'ordinary');
  writeFileSync(f.switchFile, 'off');
  expect(await f.pool().acquire('ordinary')).toBeUndefined();
  expect(f.destroyed).toEqual(['parked']);
  expect(await held!.park(apps, compose)).toBe(false);
  expect(f.destroyed).toEqual(['parked', 'held']);
});

test('a former holder cannot release or destroy a newer lease', async () => {
  const f = fixture();
  f.on();
  const former = await f.pool().register('original', 'ordinary');
  await former!.park(apps, compose);
  const current = await f.pool({ holder: f.identity('second') }).acquire('ordinary');
  expect(await former!.park({ BAD: 'old data' }, {})).toBe(false);
  await former!.destroy();
  expect(f.saved('original').token).toBe(current!.entry.token);
  expect(f.saved('original').apps).toEqual(apps);
  expect(f.destroyed).toEqual([]);
  destroyHeldQaStacks();
  expect(f.destroyed).toEqual(['original']);
});

test('failed teardown preserves the ownership record and prevents reuse until retry succeeds', async () => {
  const f = fixture();
  f.on();
  const pool = f.pool({ destroy: async () => { throw new Error('Docker unavailable'); } });
  await pool.register('crashed', 'ordinary');
  f.live.delete('first');
  await expect(pool.acquire('ordinary')).rejects.toThrow('Docker unavailable');
  expect(existsSync(join(f.state, 'crashed.json'))).toBe(true);
  await f.pool().sweep();
  expect(f.destroyed).toEqual(['crashed']);
  expect(existsSync(join(f.state, 'crashed.json'))).toBe(false);
});

test('explicit failed-run destruction keeps its record when Docker fails', async () => {
  const f = fixture();
  f.on();
  const lease = await f.pool({ destroy: async () => { throw new Error('cannot remove'); } }).register('failed-run', 'ordinary');
  await expect(lease!.destroy()).rejects.toThrow('cannot remove');
  expect(f.saved('failed-run').holder).toEqual(f.identity('first'));
});

test('synchronous exit cleanup destroys held leases and leaves parked stacks alone', async () => {
  const f = fixture();
  f.on();
  const original = await f.pool().register('leased', 'ordinary');
  await original!.park(apps, compose);
  await f.pool({ holder: f.identity('second') }).acquire('ordinary');
  const parked = await f.pool().register('parked', 'ordinary');
  await parked!.park(apps, compose);
  destroyHeldQaStacks();
  expect(f.destroyed).toEqual(['leased']);
  expect(existsSync(join(f.state, 'leased.json'))).toBe(false);
  expect(f.saved('parked').holder).toBeUndefined();
});

test('synchronous cleanup failure remains registered for a later dead-holder sweep', async () => {
  const f = fixture();
  f.on();
  const messages: string[] = [];
  const originalError = console.error;
  console.error = value => { messages.push(String(value)); };
  try {
    await f.pool({ destroySync: () => { throw new Error('Docker stopped'); } }).register('held', 'ordinary');
    destroyHeldQaStacks();
    expect(messages.join('\n')).toContain('Docker stopped');
    expect(f.saved('held').holder).toEqual(f.identity('first'));
    f.live.delete('first');
    await f.pool().sweep();
    expect(f.destroyed).toEqual(['held']);
  } finally { console.error = originalError; }
});

test('malformed ownership data fails closed without deleting the record', async () => {
  const f = fixture();
  f.on();
  mkdirSync(f.state);
  writeFileSync(join(f.state, 'corrupt.json'), '{}');
  await expect(f.pool().acquire('ordinary')).rejects.toThrow('Invalid QA pool ownership record');
  expect(existsSync(join(f.state, 'corrupt.json'))).toBe(true);
});

test('infrastructure fingerprint is stable under ordering and changes with every infrastructure input', () => {
  const input = {
    files: [['infra/compose.yaml', 'compose'], ['migrations/0001.sql', 'migration']] as const,
    images: ['sha256:postgres', 'sha256:fuseki'], assembler: 'tdb2-assembler',
    environment: { MEMORY: '7g', HEAP: '1536m' },
  };
  const fingerprint = qaStackFingerprint(input);
  expect(qaStackFingerprint({ ...input, files: [...input.files].reverse(), images: [...input.images].reverse(),
    environment: { HEAP: '1536m', MEMORY: '7g' } })).toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, files: [['infra/compose.yaml', 'changed'], input.files[1]] })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, files: [input.files[0], ['migrations/0001.sql', 'changed']] })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, images: ['sha256:new'] })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, assembler: 'changed' })).not.toBe(fingerprint);
  expect(qaStackFingerprint({ ...input, environment: { ...input.environment, MEMORY: '8g' } })).not.toBe(fingerprint);
});

function checkouts(f: ReturnType<typeof fixture>) {
  const origin = join(f.root, 'checkout-a');
  const target = join(f.root, 'checkout-b');
  mkdirSync(origin);
  mkdirSync(target);
  return { origin, target, originStack: join(origin, '.temp', 'stack', 'rezics-qa-cross-checkout'),
    targetStack: join(target, '.temp', 'stack', 'rezics-qa-cross-checkout') };
}

test('cross-checkout acquisition rebases every apps and compose value and recreates only recorded reset directories', async () => {
  const f = fixture();
  f.on();
  const c = checkouts(f);
  mkdirSync(join(c.originStack, 'objects'), { recursive: true });
  for (const root of [c.origin, c.target]) {
    mkdirSync(join(root, 'infra'));
    writeFileSync(join(root, 'infra', 'fixture.ttl'), 'fixture');
    writeFileSync(join(root, 'infra', 'fixture with spaces.ttl'), 'fixture');
  }
  const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
  await lease!.park({
    ...apps,
    GENERIC_DIRECTORY: join(c.originStack, 'objects'),
    UNLISTED_ABSENT_DIRECTORY: join(c.originStack, 'candidates'),
    NEW_FIXTURE: join(c.origin, 'infra', 'fixture.ttl'),
    UNQUOTED_SPACES: join(c.origin, 'infra', 'fixture with spaces.ttl'),
    PATH_LIST: `${c.origin}/infra/fixture.ttl:${c.origin}/infra/fixture.ttl`,
    MIXED_ARGUMENTS: `--first=${c.origin}/infra/fixture.ttl; --second=file://${c.origin}/infra/fixture%20with%20spaces.ttl`,
    JSON_VALUE: JSON.stringify({ fixture: `${c.origin}/infra/fixture.ttl` }),
  }, { ...compose,
    UNLISTED_COMPOSE_DIRECTORY: join(c.originStack, 'objects'),
    QUOTED_SPACES: `"${c.origin}/infra/fixture with spaces.ttl"`,
  });
  expect(f.saved('cross-checkout').recreatableDirectories).toEqual([
    '.temp/stack/rezics-qa-cross-checkout/objects',
  ]);
  expect(f.saved('cross-checkout').absentPaths).toEqual(['.temp/stack/rezics-qa-cross-checkout/candidates']);
  rmSync(c.origin, { recursive: true });
  const receivingPool = f.pool({ root: c.target, holder: f.identity('second') });
  const acquired = await receivingPool.acquire('ordinary');
  expect(acquired).toBeDefined();
  expect(acquired!.entry.checkoutRoot).toBe(c.target);
  expect(JSON.stringify([acquired!.entry.apps, acquired!.entry.compose])).not.toContain(c.origin);
  expect(acquired!.entry.apps.PATH_LIST).toBe(`${c.target}/infra/fixture.ttl:${c.target}/infra/fixture.ttl`);
  expect(acquired!.entry.compose.QUOTED_SPACES).toBe(`"${c.target}/infra/fixture with spaces.ttl"`);
  expect(existsSync(join(c.targetStack, 'objects'))).toBe(true);
  expect(existsSync(join(c.targetStack, 'candidates'))).toBe(false);
  expect(receivingPool.rejections).toEqual([]);
  await acquired!.park(acquired!.entry.apps, acquired!.entry.compose);
  expect(f.saved('cross-checkout').checkoutRoot).toBe(c.target);
});

test('a checkout-root prefix belonging to another directory is left unchanged', async () => {
  const f = fixture();
  f.on();
  const c = checkouts(f);
  const unchanged = `${c.origin}-other/fixture.ttl`;
  const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
  await lease!.park({ OTHER_DIRECTORY: unchanged }, { EMBEDDED_OTHER_PATH: `/outside${c.origin}/fixture.ttl` });
  const acquired = await f.pool({ root: c.target }).acquire('ordinary');
  expect(acquired!.entry.apps.OTHER_DIRECTORY).toBe(unchanged);
  expect(acquired!.entry.compose.EMBEDDED_OTHER_PATH).toBe(`/outside${c.origin}/fixture.ttl`);
});

for (const kind of ['file', 'nonempty-directory'] as const) {
  test(`a missing receiving-checkout ${kind} is refused and its candidate is destroyed with the field reason`, async () => {
    const f = fixture();
    f.on();
    const c = checkouts(f);
    mkdirSync(c.originStack, { recursive: true });
    const state = join(c.originStack, 'retained-state');
    if (kind === 'file') writeFileSync(state, 'must not be copied');
    else { mkdirSync(state); writeFileSync(join(state, 'data'), 'must not be copied'); }
    const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
    await lease!.park(apps, { UNLISTED_STATE: state });
    const receivingPool = f.pool({ root: c.target });
    expect(await receivingPool.acquire('ordinary')).toBeUndefined();
    expect(f.destroyed).toEqual(['cross-checkout']);
    expect(receivingPool.rejections).toEqual([{
      projectRunId: 'cross-checkout', scope: 'compose', key: 'UNLISTED_STATE', value: state,
      reason: `rebased checkout path does not exist: ${join(c.targetStack, 'retained-state')}`,
    }]);
    expect(existsSync(join(c.targetStack, 'retained-state'))).toBe(false);
  });
}

test('an existing target file can be rebased after the origin checkout disappears', async () => {
  const f = fixture();
  f.on();
  const c = checkouts(f);
  for (const root of [c.origin, c.target]) writeFileSync(join(root, 'fixture'), 'local fixture');
  const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
  await lease!.park({ OWNER_FIXTURE: join(c.origin, 'fixture') }, {});
  rmSync(c.origin, { recursive: true });
  const acquired = await f.pool({ root: c.target }).acquire('ordinary');
  expect(acquired!.entry.apps.OWNER_FIXTURE).toBe(join(c.target, 'fixture'));
});

test('candidate validation finishes before any reset directories are created', async () => {
  const f = fixture();
  f.on();
  const c = checkouts(f);
  mkdirSync(join(c.originStack, 'objects'), { recursive: true });
  const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
  await lease!.park({ FIRST_EMPTY_STATE: join(c.originStack, 'objects'), SECOND_MISSING_FILE: join(c.origin, 'fixture') }, {});
  const receivingPool = f.pool({ root: c.target });
  expect(await receivingPool.acquire('ordinary')).toBeUndefined();
  expect(receivingPool.rejections[0]?.key).toBe('SECOND_MISSING_FILE');
  expect(existsSync(c.targetStack)).toBe(false);
});

for (const kind of ['absent', 'empty-directory'] as const) {
  test(`a reset-local ${kind} cannot expose prior state from the receiving checkout`, async () => {
    const f = fixture();
    f.on();
    const c = checkouts(f);
    const source = join(c.originStack, 'state');
    const target = join(c.targetStack, 'state');
    if (kind === 'empty-directory') mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'leftover'), 'must not be exposed');
    const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
    await lease!.park({ GENERIC_RESET_STATE: source }, {});
    const pool = f.pool({ root: c.target });
    expect(await pool.acquire('ordinary')).toBeUndefined();
    expect(pool.rejections[0]?.reason).toContain(kind === 'absent' ? 'is present' : 'is not empty');
    expect(f.destroyed).toEqual(['cross-checkout']);
    expect(readFileSync(join(target, 'leftover'), 'utf8')).toBe('must not be exposed');
  });
}

test('checkout paths that traverse outside the recorded root are refused', async () => {
  const f = fixture();
  f.on();
  const c = checkouts(f);
  const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
  await lease!.park({ GENERIC_PATH: `${c.origin}/../outside` }, {});
  const pool = f.pool({ root: c.target });
  expect(await pool.acquire('ordinary')).toBeUndefined();
  expect(pool.rejections[0]?.reason).toContain('escapes its recorded root');
  expect(f.destroyed).toEqual(['cross-checkout']);
});

test('rebased target symlinks cannot reach state outside the receiving checkout', async () => {
  const f = fixture();
  f.on();
  const c = checkouts(f);
  writeFileSync(join(c.origin, 'fixture'), 'origin only');
  symlinkSync(join(c.origin, 'fixture'), join(c.target, 'fixture'));
  const lease = await f.pool({ root: c.origin }).register('cross-checkout', 'ordinary');
  await lease!.park({ GENERIC_PATH: join(c.origin, 'fixture') }, {});
  const pool = f.pool({ root: c.target });
  expect(await pool.acquire('ordinary')).toBeUndefined();
  expect(pool.rejections[0]?.reason).toContain('leaves the target checkout');
});

test('legacy snapshots without a checkout root are destroyed rather than leased', async () => {
  const f = fixture();
  f.on();
  const lease = await f.pool().register('legacy', 'ordinary');
  await lease!.park(apps, compose);
  const saved = f.saved('legacy');
  delete saved.checkoutRoot;
  writeFileSync(join(f.state, 'legacy.json'), JSON.stringify(saved));
  const pool = f.pool();
  expect(await pool.acquire('ordinary')).toBeUndefined();
  expect(pool.rejections[0]?.reason).toContain('no recorded checkout root');
  expect(f.destroyed).toEqual(['legacy']);
});

test('unknown startup fingerprints miss parked stacks and can be recorded before parking a fresh stack', async () => {
  const f = fixture(1);
  f.on();
  const parked = await f.pool().register('old', 'ordinary');
  await parked!.park(apps, compose);
  const fresh = await f.pool().register('fresh');
  expect(fresh).toBeDefined();
  expect(f.destroyed).toEqual(['old']);
  expect(f.saved('fresh').fingerprint).toBeUndefined();
  await fresh!.recordFingerprint('resolved-after-startup');
  expect(f.saved('fresh').fingerprint).toBe('resolved-after-startup');
  expect(fresh!.entry.fingerprint).toBe('resolved-after-startup');
  expect(await fresh!.park(apps, compose)).toBe(true);
  expect((await f.pool().acquire('resolved-after-startup'))?.entry.projectRunId).toBe('fresh');
});

test('a fresh stack without a resolved fingerprint is destroyed on release', async () => {
  const f = fixture();
  f.on();
  const fresh = await f.pool().register('unresolved');
  expect(await fresh!.park(apps, compose)).toBe(false);
  expect(f.destroyed).toEqual(['unresolved']);
});

test('unresolved startup images clear the pre-startup identity before release', async () => {
  const f = fixture();
  f.on();
  const fresh = await f.pool().register('unresolved', 'before-startup');
  await fresh!.recordFingerprint(undefined);
  expect(fresh!.entry.fingerprint).toBeUndefined();
  expect(f.saved('unresolved').fingerprint).toBeUndefined();
  expect(await fresh!.park(apps, compose)).toBe(false);
  expect(f.destroyed).toEqual(['unresolved']);
});

test('normal sweeps preserve parked fingerprints and recording cannot overwrite a newer holder', async () => {
  const f = fixture();
  f.on();
  const former = await f.pool().register('original', 'ordinary');
  await former!.park(apps, compose);
  await f.pool().sweep();
  expect(f.destroyed).toEqual([]);
  const current = await f.pool({ holder: f.identity('second') }).acquire('ordinary');
  await expect(former!.recordFingerprint('wrong')).rejects.toThrow('lost its ownership record');
  expect(f.saved('original').fingerprint).toBe('ordinary');
  expect(f.saved('original').token).toBe(current!.entry.token);
});

test('reducing the slot count trims parked stacks while preserving active holders', async () => {
  const f = fixture(2);
  f.on();
  const first = await f.pool().register('first', 'ordinary');
  const second = await f.pool().register('second', 'ordinary');
  await first!.park(apps, compose);
  f.advance(1);
  await second!.park(apps, compose);
  await f.pool({ slots: 1 }).sweep();
  expect(f.destroyed).toEqual(['first']);
  expect(existsSync(join(f.state, 'second.json'))).toBe(true);
});

test('a holder releases excess capacity when the slot count falls during its run', async () => {
  const f = fixture(2);
  f.on();
  const first = await f.pool({ slots: 1 }).register('first', 'ordinary');
  await f.pool().register('second', 'ordinary');
  await f.pool({ slots: 1 }).sweep();
  expect(f.destroyed).toEqual([]);
  expect(await first!.park(apps, compose)).toBe(false);
  expect(f.destroyed).toEqual(['first']);
});

function fakeDocker(root: string, removal?: { error: string; remainingLists: number }): NodeJS.ProcessEnv {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE/commands"
case "$1:$2" in
  run:*)
    for arg in "$@"; do
      case "$arg" in rezics.reap-owner=*) printf '%s' "\${arg#*=}" > "$FAKE_DOCKER_STATE/owner" ;; esac
    done
    for kind in containers volumes networks; do printf '%s-id\\n' "$kind" > "$FAKE_DOCKER_STATE/$kind"; done
    exit 0 ;;
  ps:*) kind=containers ;;
  volume:ls) kind=volumes ;;
  network:ls) kind=networks ;;
  inspect:*) /bin/cat "$FAKE_DOCKER_STATE/owner"; exit 0 ;;
  rm:*)
    if [ -f "$FAKE_DOCKER_STATE/removal-error" ]; then
      touch "$FAKE_DOCKER_STATE/removing"
      /bin/cat "$FAKE_DOCKER_STATE/removal-error" >&2
      exit 1
    fi
    /bin/rm -f "$FAKE_DOCKER_STATE/containers"; exit 0 ;;
  volume:rm) /bin/rm -f "$FAKE_DOCKER_STATE/volumes"; exit 0 ;;
  network:rm) /bin/rm -f "$FAKE_DOCKER_STATE/networks"; exit 0 ;;
  *) exit 1 ;;
esac
case "$*" in *label=rezics.reap-owner*) [ -f "$FAKE_DOCKER_STATE/owner" ] || exit 0 ;; esac
if [ "$kind" = containers ] && [ -f "$FAKE_DOCKER_STATE/removing" ]; then
  remaining=$(/bin/cat "$FAKE_DOCKER_STATE/remaining-lists")
  if [ "$remaining" -eq 0 ]; then /bin/rm -f "$FAKE_DOCKER_STATE/containers"
  else printf '%s' "$((remaining - 1))" > "$FAKE_DOCKER_STATE/remaining-lists"; fi
fi
if [ -f "$FAKE_DOCKER_STATE/$kind" ]; then /bin/cat "$FAKE_DOCKER_STATE/$kind"; fi
`, { mode: 0o700 });
  for (const kind of ['containers', 'volumes', 'networks']) writeFileSync(join(root, kind), `${kind}-id\n`);
  if (removal) {
    writeFileSync(join(root, 'removal-error'), removal.error);
    writeFileSync(join(root, 'remaining-lists'), String(removal.remainingLists));
  }
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: root };
}

for (const mode of ['async', 'sync'] as const) {
  for (const answer of ['already removing', 'already gone', 'mixed benign answers'] as const) {
    test(`${mode} teardown accepts containers ${answer} and verifies disappearance before deleting volumes`, async () => {
      const f = fixture();
      f.on();
      const progress = 'Error response from daemon: removal of container abc123 is already in progress';
      const gone = 'Error response from daemon: No such container: gone-container';
      const remainingLists = answer === 'already gone' ? 0 : 2;
      const env = fakeDocker(f.root, { error: answer === 'already gone' ? gone
        : answer === 'already removing' ? progress : `${progress}\n${gone}`, remainingLists });
      const lease = await f.pool({ destroy: undefined, destroySync: undefined, env }).register('settling', 'ordinary');
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        if (mode === 'async') await lease!.destroy();
        else destroyHeldQaStacks();
        expect(errors).not.toHaveBeenCalled();
        expect(existsSync(join(f.state, 'settling.json'))).toBe(false);
        for (const kind of ['containers', 'volumes', 'networks']) expect(existsSync(join(f.root, kind))).toBe(false);
        const commands = readFileSync(join(f.root, 'commands'), 'utf8').trim().split('\n');
        expect(commands.filter(line => line.startsWith('ps '))).toHaveLength(remainingLists + 2);
        expect(commands.findIndex(line => line.startsWith('volume ls'))).toBe(remainingLists + 3);
      } finally { errors.mockRestore(); }
    });
  }

  for (const error of ['Error response from daemon: permission denied',
    'Error response from daemon: removal of container abc123 is already in progress\nError response from daemon: permission denied',
    '']) {
    test(`${mode} teardown preserves real removal failures (${error || 'empty stderr'}) even if the container disappears`, async () => {
      const f = fixture();
      f.on();
      const env = fakeDocker(f.root, { error, remainingLists: 0 });
      const lease = await f.pool({ destroy: undefined, destroySync: undefined, env }).register('failed-removal', 'ordinary');
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        if (mode === 'async') await expect(lease!.destroy()).rejects.toThrow('docker rm -f containers-id failed:');
        else {
          destroyHeldQaStacks();
          expect(errors).toHaveBeenCalledWith(expect.stringContaining('docker rm -f containers-id failed:'));
        }
        expect(existsSync(join(f.state, 'failed-removal.json'))).toBe(true);
        expect(readFileSync(join(f.root, 'commands'), 'utf8')).not.toContain('volume rm');
      } finally {
        rmSync(join(f.root, 'removal-error'));
        errors.mockRestore();
      }
    });
  }
}

test('exit cleanup does not duplicate an asynchronous teardown holding the pool lock', async () => {
  const f = fixture();
  f.on();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let removals = 0;
  const lease = await f.pool({ destroy: async () => { removals++; entered.resolve(); await finish.promise; } })
    .register('teardown', 'ordinary');
  const teardown = lease!.destroy();
  try {
    await entered.promise;
    destroyHeldQaStacks();
    expect(f.destroyed).toEqual([]);
    expect(removals).toBe(1);
    expect(existsSync(join(f.state, 'teardown.json'))).toBe(true);
  } finally { finish.resolve(); await teardown; }
  destroyHeldQaStacks();
  expect(f.destroyed).toEqual([]);
  expect(existsSync(join(f.state, 'teardown.json'))).toBe(false);
});

test('a parked stack survives its creator exit and orphan sweep until its pool record expires', async () => {
  const f = fixture();
  f.on();
  const env = fakeDocker(f.root);
  for (const kind of ['containers', 'volumes', 'networks']) rmSync(join(f.root, kind));
  // The CLI clears runner ancestry when pool ownership takes over startup.
  const startupEnv = { ...env, REZICS_REAP_OWNER: '', REZICS_REAP_SCOPE: '', REZICS_REAP_SCOPES: '', REZICS_REAP_STATE: '' };
  const creator = spawnSync(process.execPath, ['-e', `
    import { spawnSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { createQaStackPool } from ${JSON.stringify(resolve(import.meta.dir, 'stack-pool.ts'))};
    import { preserveReapEnvironment } from ${JSON.stringify(resolve(import.meta.dir, 'container-reaper.ts'))};
    import { processIdentity } from ${JSON.stringify(resolve(import.meta.dir, 'process/identity.ts'))};
    const pool = createQaStackPool({ root: ${JSON.stringify(f.root)}, slotDirectory: ${JSON.stringify(f.slotDirectory)},
      slots: 2, janitor: false, now: () => 1000 });
    const lease = await pool.register('exited-creator', 'ordinary');
    const result = spawnSync('docker', ['run', '--label', 'com.docker.compose.project=rezics-qa-exited-creator', 'fake-image'],
      { env: preserveReapEnvironment(process.env) });
    if (result.status !== 0) throw new Error('fake stack startup failed');
    writeFileSync(${JSON.stringify(join(f.root, 'creator.json'))}, JSON.stringify(processIdentity(process.pid)));
    if (!await lease.park(${JSON.stringify(apps)}, ${JSON.stringify(compose)})) throw new Error('stack did not park');
  `], { env: startupEnv, encoding: 'utf8', timeout: 5_000 });
  expect(creator.error).toBeUndefined();
  expect(creator.status).toBe(0);
  const identity = JSON.parse(readFileSync(join(f.root, 'creator.json'), 'utf8')) as ProcessIdentity;
  expect(processAlive(identity)).toBe(false);
  expect(f.saved('exited-creator').holder).toBeUndefined();
  expect(existsSync(join(f.root, 'owner'))).toBe(false);
  const sweep = spawnSync(process.execPath, [resolve(import.meta.dir, 'container-reaper.ts'), '--sweep-orphans'],
    { env, encoding: 'utf8', timeout: 5_000 });
  expect(sweep.error).toBeUndefined();
  expect(sweep.status).toBe(0);
  const pool = f.pool({ holder: undefined, alive: undefined, destroy: undefined, env });
  f.advance(qaStackPoolMaxParkedMs - 1);
  await pool.sweep();
  expect(existsSync(join(f.state, 'exited-creator.json'))).toBe(true);
  for (const kind of ['containers', 'volumes', 'networks']) expect(existsSync(join(f.root, kind))).toBe(true);
  f.advance(1);
  await pool.sweep();
  expect(existsSync(join(f.state, 'exited-creator.json'))).toBe(false);
  for (const kind of ['containers', 'volumes', 'networks']) expect(existsSync(join(f.root, kind))).toBe(false);
});

test('default teardown removes and verifies blank-snapshot resources by label without the origin worktree', async () => {
  const f = fixture();
  f.on();
  const pool = f.pool({ root: join(f.root, 'deleted-origin'), destroy: undefined, env: fakeDocker(f.root) });
  const lease = await pool.register('partial-startup', 'ordinary');
  await lease!.destroy();
  expect(existsSync(join(f.root, 'deleted-origin'))).toBe(false);
  expect(existsSync(join(f.state, 'partial-startup.json'))).toBe(false);
  const commands = readFileSync(join(f.root, 'commands'), 'utf8');
  expect(commands).toContain('label=com.docker.compose.project=rezics-qa-partial-startup');
  expect(commands).toContain('rm -f containers-id');
  expect(commands).toContain('volume rm -f volumes-id');
  expect(commands).toContain('network rm networks-id');
  expect(commands.split('\n').filter(line => line.startsWith('ps '))).toHaveLength(2);
});

test('tracked startup child identity is durable and default teardown stops it before removing resources', async () => {
  const f = fixture();
  f.on();
  const lease = await f.pool({ destroy: undefined, env: fakeDocker(f.root) }).register('startup', 'ordinary');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    const untrack = trackHeldQaStackStartup('startup', child.pid!);
    const identity = processIdentity(child.pid!)!;
    expect(untrack).toBeDefined();
    expect(f.saved('startup').startupChild).toEqual(identity);
    await lease!.destroy();
    expect(processAlive(identity)).toBe(false);
    expect(existsSync(join(f.state, 'startup.json'))).toBe(false);
    untrack!();
  } finally { terminateProcessGroupSync(child.pid!, 0); }
});

test('finishing startup clears only that child identity while retaining the stack holder', async () => {
  const f = fixture();
  f.on();
  await f.pool().register('startup', 'ordinary');
  const untrack = trackHeldQaStackStartup('startup', process.pid);
  expect(f.saved('startup').startupChild?.pid).toBe(process.pid);
  untrack!();
  expect(f.saved('startup').startupChild).toBeUndefined();
  expect(f.saved('startup').holder).toEqual(f.identity('first'));
});

test('the idle janitor destroys an expired parked stack without another pool operation', async () => {
  const f = fixture();
  f.on();
  const lease = await f.pool().register('idle', 'ordinary');
  await lease!.park(apps, compose);
  const saved = f.saved('idle');
  saved.parkedAt = Date.now() - qaStackPoolMaxParkedMs + 100;
  writeFileSync(join(f.state, 'idle.json'), JSON.stringify(saved));
  const child = spawn(process.execPath, [resolve(import.meta.dir, 'stack-pool.ts'), '--janitor',
    join(f.root, 'deleted-origin'), f.slotDirectory, '2'], { env: fakeDocker(f.root), stdio: 'ignore' });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Idle janitor did not finish')); }, 3_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error(`Janitor exited ${code}`)); });
  });
  expect(existsSync(join(f.state, 'idle.json'))).toBe(false);
  expect(existsSync(join(f.state, 'janitor'))).toBe(false);
  expect(existsSync(join(f.root, 'containers'))).toBe(false);
});
