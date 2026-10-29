import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { startPostgresContainer } from '../services/kernel/scripts/check.ts';
import { onCheckHost } from './stack-run.ts';
import {
  CHECK_SLOT_MEMORY_BYTES,
  CHECK_SLOT_PROCESSORS,
  CHECK_HOST_MIN_TMP_BYTES,
  CHECK_HOST_MIN_TMP_INODES,
  BASE_REFRESH_INTERVAL_SECONDS,
  BASE_RETENTION_SECONDS,
  controlSocketDirectoryPath,
  installedPackageCacheCheck,
  returnsProbe,
  readHosts,
  runScript,
  selectSlotClass,
  slotScript,
  workspaceFiles,
  parseCommandPhases,
} from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');
const kernel = join(repository, 'services/kernel');
const remoteCheck = join(repository, 'scripts/remote-check.ts');
const checkHost = join(repository, 'scripts/check-host');
const kernelFiles = ['test/access-hook.test.ts', 'test/admission.test.ts'];

setDefaultTimeout(60_000);

test('ledger command phases pair monotonic markers and report malformed or unpaired lines', () => {
  expect(
    parseCommandPhases('migrations\tstart\t1000000000\nmigrations\tend\t3500000000\nbad\ncompile\tstart\t4000000000'),
  ).toEqual({
    durations: { migrations: 2.5 },
    problems: ['line 3: malformed', 'unmatched start for compile'],
  });
});

function generatedHostRun(): string {
  return runScript('cache-test', '/srv/rezics-check/runs/cache-test', '.', ['true'], 'check-a');
}

test('importing remote-check.ts in a checkout without node_modules starts no process and does not throw', () => {
  const checkout = mkdtempSync(join(root, 'import-without-deps-'));
  mkdirSync(join(checkout, 'scripts/check-host'), { recursive: true });
  copyFileSync(remoteCheck, join(checkout, 'scripts/remote-check.ts'));
  copyFileSync(join(repository, 'scripts/check-host/docker'), join(checkout, 'scripts/check-host/docker'));
  copyFileSync(join(repository, 'package.json'), join(checkout, 'package.json'));
  const result = spawnSync(
    process.execPath,
    [
      '--eval',
      `Bun.spawn = Bun.spawnSync = () => { throw new Error('import started a process'); };
       const module = await import(${JSON.stringify(join(checkout, 'scripts/remote-check.ts'))});
       try { module.runScript('test', '/run', '.', ['true'], 'host'); process.exit(1); }
       catch (error) { if (!error.message.includes('bun install')) throw error; }`,
    ],
    {
      cwd: checkout,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
});

// Execute the generated runtime setup with a local host root and a registry archive served by a curl fixture.
// The rest of systemd, installation and command execution is outside this cache boundary.
function pinnedRuntimeFixture(cachedRevision?: 'verified' | 'stale', concurrent = false) {
  const directory = mkdtempSync(join(root, 'pinned-runtime-'));
  const script = generatedHostRun();
  const encoded = script.slice(script.indexOf('  sh -c ') + '  sh -c '.length, script.lastIndexOf(' sh '));
  const body = encoded.slice(1, -1).replaceAll("'\\''", "'").replaceAll('/srv/rezics-check', directory);
  const setup = body.slice(0, body.indexOf('    "$bun" install --frozen-lockfile'));
  const revision = setup.match(/expected_revision=([a-f0-9]+)/)![1]!;
  const bin = join(directory, 'bin');
  const archive = join(directory, 'archive');
  const log = join(directory, 'events');
  mkdirSync(bin);
  mkdirSync(join(archive, 'package/bin'), { recursive: true });
  function binary(path: string, value: string) {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = --eval ]; then
  printf 'verify:%s:%s\\n' "$0" '${value}' >> "$CACHE_TEST_LOG"
  [ "$3" = '${value}' ]
else
  printf 'use:%s:%s\\n' "$0" '${value}' >> "$CACHE_TEST_LOG"
fi
`,
    );
    chmodSync(path, 0o755);
  }
  binary(join(archive, 'package/bin/bun'), revision);
  const packed = spawnSync('tar', ['-czf', join(directory, 'bun.tgz'), '-C', archive, 'package'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\n echo aarch64\n');
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
printf 'download:%s\\n' "$*" >> "$CACHE_TEST_LOG"
if [ "$CACHE_TEST_CONCURRENT" = 1 ]; then
  touch "$CACHE_TEST_DIR/ready-$$"
  for attempt in $(seq 1 1000); do
    set -- "$CACHE_TEST_DIR"/ready-*
    [ "$#" -ge 2 ] && break
    sleep 0.01
  done
  [ "$#" -ge 2 ] || exit 1
fi
cat "$CACHE_TEST_DIR/bun.tgz"
`,
  );
  chmodSync(join(bin, 'uname'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const entry = join(
    directory,
    'pinned-bun',
    `${JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).packageManager.slice(4)}-aarch64`,
  );
  const cached = join(entry, 'package/bin/bun');
  if (cachedRevision) binary(cached, cachedRevision === 'verified' ? revision : 'stale');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REMOTE_CHECK_PINNED_BUN_PATH: '',
    CACHE_TEST_LOG: log,
    CACHE_TEST_DIR: directory,
    CACHE_TEST_CONCURRENT: concurrent ? '1' : '',
  };
  const command = `${setup}\n"$bun" use`;
  return {
    script,
    cached,
    entry,
    revision,
    directory,
    env,
    command,
    run: () => spawnSync('sh', ['-c', command], { env, encoding: 'utf8', timeout: 20_000 }),
    events: () => readFileSync(log, 'utf8').trim().split('\n'),
    complete() {
      expect(existsSync(cached)).toBe(true);
      expect(readdirSync(join(directory, 'pinned-bun'))).toEqual([entry.split('/').at(-1)!]);
      expect(readFileSync(cached, 'utf8')).toContain(revision);
    },
  };
}

test('a run on a host whose cache already holds the verified pinned Bun for this version and build does not download Bun', () => {
  const fixture = pinnedRuntimeFixture('verified');
  expect(fixture.script).toContain('pinned_cache=/srv/rezics-check/pinned-bun/$expected_bun-$build');
  expect(fixture.script).toContain('bun="$pinned_cache/package/bin/bun"');
  expect(fixture.script).toContain('REMOTE_CHECK_PINNED_BUN_PATH');
  expect(fixture.script).not.toContain('.temp/pinned-bun');
  const result = fixture.run();
  expect(result.status, result.stderr).toBe(0);
  expect(fixture.events()).toEqual([
    `verify:${fixture.cached}:${fixture.revision}`,
    `use:${fixture.cached}:${fixture.revision}`,
  ]);
  fixture.complete();
});

test('a run on a host without a cached pinned Bun downloads it once, verifies its revision and places it in the host cache by an atomic rename', () => {
  const fixture = pinnedRuntimeFixture();
  const { script } = fixture;
  const download = script.indexOf('curl -fsSL');
  const verify = script.indexOf('"$pinned_download/package/bin/bun" --eval');
  const publish = script.indexOf('mv -T "$pinned_download" "$pinned_cache"');
  expect(download).toBeGreaterThan(-1);
  expect(verify).toBeGreaterThan(download);
  expect(publish).toBeGreaterThan(verify);
  expect(script).toContain('mktemp -d /srv/rezics-check/pinned-bun/.download.XXXXXX');
  expect(script.match(/curl -fsSL/g)).toHaveLength(1);
  const result = fixture.run();
  expect(result.status, result.stderr).toBe(0);
  const events = fixture.events();
  expect(events.filter((event) => event.startsWith('download:'))).toHaveLength(1);
  expect(events[0]).toContain('--retry 5 --retry-all-errors --retry-delay 2');
  expect(events[1]).toContain('/.download.');
  expect(events[1]).toEndWith(`:${fixture.revision}`);
  expect(events.slice(2)).toEqual([
    `verify:${fixture.cached}:${fixture.revision}`,
    `use:${fixture.cached}:${fixture.revision}`,
  ]);
  fixture.complete();
});

test('two runs that miss the cache at the same time leave one complete cached Bun and both use a verified binary', async () => {
  const fixture = pinnedRuntimeFixture(undefined, true);
  const children = [0, 1].map(() =>
    Bun.spawn(['sh', '-c', fixture.command], {
      env: fixture.env,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  const results = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  const events = fixture.events();
  expect(events.filter((event) => event.startsWith('download:'))).toHaveLength(2);
  expect(events.filter((event) => event.startsWith('verify:') && event.includes('/.download.'))).toHaveLength(2);
  expect(
    events.filter((event) => event === `verify:${fixture.cached}:${fixture.revision}`).length,
  ).toBeGreaterThanOrEqual(2);
  expect(events.filter((event) => event === `use:${fixture.cached}:${fixture.revision}`)).toHaveLength(2);
  fixture.complete();
}, 20_000);

test('a cached Bun whose revision does not match is not used, and the run downloads and verifies a fresh one', () => {
  const fixture = pinnedRuntimeFixture('stale');
  expect(fixture.script).toContain('if ! cache_matches; then');
  expect(fixture.script).toContain('mv -T "$pinned_download/package/bin/bun" "$pinned_cache/package/bin/bun"');
  expect(fixture.script).toContain('Bun.revision === process.argv[1]');
  expect(fixture.script).toContain(
    'if ! cache_matches; then echo "remote-check: cached Bun does not match packageManager',
  );
  const staleInode = statSync(fixture.cached).ino;
  const result = fixture.run();
  expect(result.status, result.stderr).toBe(0);
  const events = fixture.events();
  expect(events[0]).toBe(`verify:${fixture.cached}:stale`);
  expect(events.filter((event) => event.startsWith('download:'))).toHaveLength(1);
  expect(events.find((event) => event.startsWith('verify:') && event.includes('/.download.'))).toEndWith(
    `:${fixture.revision}`,
  );
  expect(events.filter((event) => event.startsWith('use:'))).toEqual([`use:${fixture.cached}:${fixture.revision}`]);
  expect(statSync(fixture.cached).ino).not.toBe(staleInode);
  fixture.complete();
  const second = fixture.run();
  expect(second.status, second.stderr).toBe(0);
  expect(fixture.events().filter((event) => event.startsWith('download:'))).toHaveLength(1);
});

// A fake ssh answers each kind of remote script by what it contains, so the tests see which host was chosen, what ran
// there and what was released, without a network.
const fakeSsh = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR!;
const args = process.argv.slice(2);
const script = args.at(-1)!;
const address = args.at(-2)!;
const options = args.slice(0, -2);
const hostConfigs = JSON.parse(readFileSync(dir + '/config.json', 'utf8'));
const knownHost = Object.hasOwn(hostConfigs, address);
const config = hostConfigs[address] ?? {};
const controlPath = options.find((option) => option.startsWith('ControlPath='));
const updateConfig = (updates: Record<string, unknown>) => {
  const file = dir + '/config.json';
  const all = JSON.parse(readFileSync(file, 'utf8'));
  all[address] = { ...all[address], ...updates };
  writeFileSync(file, JSON.stringify(all));
};
const hostKey = address.replace(/[^a-z0-9]/gi, '_');
const multiMarkerPrefix = hostKey + '.multi-marker.';
const multiMarkerIndex = dir + '/' + hostKey + '.multi-markers-present';
const landingMarkerPrefix = hostKey + '.landing-marker.';
const landingMarkerIndex = dir + '/' + hostKey + '.landing-markers-present';
const readMultiMarkers = () => readdirSync(dir)
  .filter((name) => name.startsWith(multiMarkerPrefix))
  .map((name) => JSON.parse(readFileSync(dir + '/' + name, 'utf8')) as { id: string; slots: number; beganAt: number; sequence: number })
  .sort((left, right) => left.beganAt - right.beganAt || left.sequence - right.sequence);
const readLandingMarkers = () => readdirSync(dir)
  .filter((name) => name.startsWith(landingMarkerPrefix))
  .map((name) => JSON.parse(readFileSync(dir + '/' + name, 'utf8')) as { id: string; slots: number; beganAt: number; arrivalOrder: string; sequence: number })
  .sort((left, right) => Number(left.sequence) - Number(right.sequence));
const count = (name: string) => {
  const file = dir + '/' + hostKey + '.' + name;
  const seen = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeFileSync(file, String(seen + 1));
  return seen;
};
const connectionNumber = count('connection');
const refusedControlSession = Boolean(config.refuseControlSession && controlPath && connectionNumber > 0);
// OpenSSH 10.2 retries a refused multiplexed session over a new connection in the same ssh process.
const transport = refusedControlSession ? 'standalone-fallback' : controlPath ? 'control-master' : 'standalone';
const log = (event: Record<string, unknown>) => appendFileSync(dir + '/log.jsonl', JSON.stringify({ address, options, transport, ...event }) + '\\n');
if (refusedControlSession) {
  log({ kind: 'master-session-refused' });
  log({ kind: 'standalone-fallback' });
}
if (script.includes('/proc/loadavg')) {
  if (!knownHost || config.down) process.exit(255);
  const configuredMaximum = config.memoryMax ?? Math.max(16 * 2 ** 30, config.available ?? 16 * 2 ** 30);
  const memoryMaximum = config.memoryUnreadable ? '-' : configuredMaximum;
  const memoryCurrent = config.memoryUnreadable
    ? '-'
    : (config.memoryCurrent ?? Math.max(0, configuredMaximum - (config.memoryHeadroom ?? config.available ?? configuredMaximum)));
  const memoryHeadroom = config.memoryUnreadable
    ? (config.available ?? 0)
    : configuredMaximum - Number(memoryCurrent);
  const processors = config.processors ?? 16;
  const sliceProcessors = config.cpuMaxUnreadable || config.cpuMaxIsMax
    ? (config.cpuQuotaPercent ?? 800) / 100
    : (config.sliceProcessors ?? (config.cpuQuotaPercent ?? 800) / 100);
  const load = config.load ?? 0;
  const available = config.available ?? 16 * 2 ** 30;
  const slots = config.slots ?? 2;
  const ordinaryCapacity = Math.max(0, slots - 1);
  const memoryReserved = Array.from({ length: ordinaryCapacity }, (_, index) => index)
    .filter((index) => existsSync(dir + '/' + hostKey + '.slot.' + index))
    .reduce((sum, index) => sum + Number(readFileSync(dir + '/' + hostKey + '.slot.' + index + '.memory', 'utf8') || 0), 0)
    + (existsSync(dir + '/' + hostKey + '.slot.express') ? Number(readFileSync(dir + '/' + hostKey + '.slot.express.memory', 'utf8') || 0) : 0);
  const ordinarySlotsUsed = Array.from({ length: ordinaryCapacity }, (_, index) => existsSync(dir + '/' + hostKey + '.slot.' + index)).filter(Boolean).length;
  const expressSlotUsed = existsSync(dir + '/' + hostKey + '.slot.express');
  const gateWaiting = existsSync(dir + '/' + hostKey + '.gate-marker');
  const multiMarkers = readMultiMarkers();
  const multiWaitingSlots = multiMarkers[0]?.slots ?? 0;
  const multiWaitingId = multiMarkers[0]?.id ?? '-';
  const landingMarkers = readLandingMarkers();
  const landingWaitingSlots = landingMarkers[0]?.slots ?? 0;
  const landingWaitingId = landingMarkers[0]?.id ?? '-';
  const probeScriptFile = dir + '/' + hostKey + '.probe-script-recorded';
  const probeEvent = {
    kind: 'probe',
    ...(existsSync(probeScriptFile) ? {} : { script }),
    processors,
    sliceProcessors,
    load,
    tmpBytes: config.tmpBytes ?? 16 * 2 ** 30,
    tmpInodes: config.tmpInodes ?? 1_000_000,
    memoryCurrent,
    memoryMaximum,
    memoryHeadroom,
    memoryReserved,
    ordinarySlotsUsed,
    expressSlotUsed,
    gateWaiting,
    multiWaitingSlots,
    multiWaitingId,
    landingWaitingSlots,
    landingWaitingId,
    landingMarkers,
    landingMarkerFiles: readdirSync(dir).filter((name) => name.startsWith(landingMarkerPrefix)),
  };
  log(probeEvent);
  writeFileSync(probeScriptFile, '1');
  console.log('MEMORY_CURRENT ' + memoryCurrent);
  console.log('MEMORY_MAX ' + memoryMaximum);
  console.log('MEMORY_HEADROOM ' + memoryHeadroom);
  console.log('MEMORY_RESERVED ' + memoryReserved);
  console.log('PROCESSORS ' + processors);
  console.log('SLICE_PROCESSORS ' + sliceProcessors);
  console.log('LOAD ' + load);
  console.log('AVAILABLE ' + available);
  if (!config.omitTmpBytes) console.log('TMP_BYTES ' + (config.tmpBytes ?? 16 * 2 ** 30));
  if (!config.omitTmpInodes) console.log('TMP_INODES ' + (config.tmpInodes ?? 1_000_000));
  console.log('ORDINARY_SLOTS_USED ' + ordinarySlotsUsed);
  console.log('EXPRESS_SLOT_USED ' + (expressSlotUsed ? 1 : 0));
  console.log('GATE_WAITING ' + (gateWaiting ? 1 : 0));
  console.log('MULTI_SLOT_WAITING_SLOTS ' + multiWaitingSlots);
  console.log('MULTI_SLOT_WAITING_ID ' + multiWaitingId);
  console.log('LANDING_WAITING_SLOTS ' + landingWaitingSlots);
  console.log('LANDING_WAITING_ID ' + landingWaitingId);
} else if (script.includes('REMOTE_CHECK_GATE_MARKER')) {
  const lock = dir + '/' + hostKey + '.gate-marker';
  if (existsSync(lock)) process.exit(75);
  mkdirSync(lock);
  log({ kind: 'gate-marker', fakeStartedAt: Number(readFileSync(dir + '/clock', 'utf8')) });
  console.log('GATE_MARKER');
  const release = (reason = 'stdin-end') => {
    rmSync(lock, { recursive: true, force: true });
    log({ kind: 'gate-marker-release', reason });
    process.exit(0);
  };
  process.stdin.on('end', () => release('stdin-end'));
  process.stdin.on('data', () => {});
  process.on('SIGTERM', () => release('SIGTERM'));
  process.on('SIGHUP', () => release('SIGHUP'));
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (script.includes('REMOTE_CHECK_MULTI_SLOT_MARKER')) {
  const id = script.match(/# REMOTE_CHECK_MULTI_SLOT_ID ([a-zA-Z0-9-]+)/)?.[1] ?? 'unknown';
  const slots = Number(script.match(/# REMOTE_CHECK_MULTI_SLOT_COUNT (\\d+)/)?.[1] ?? 0);
  const marker = dir + '/' + hostKey + '.multi-marker.' + id;
  if (existsSync(marker)) process.exit(75);
  const sequence = count('multi-marker-sequence');
  const beganAt = Number(readFileSync(dir + '/clock', 'utf8'));
  writeFileSync(marker, JSON.stringify({ id, slots, beganAt, sequence }));
  writeFileSync(multiMarkerIndex, '1');
  log({ kind: 'multi-marker', id, slots, fakeStartedAt: beganAt, sequence });
  console.log('MULTI_SLOT_MARKER');
  const release = (reason = 'stdin-end') => {
    rmSync(marker, { force: true });
    if (!readdirSync(dir).some((name) => name.startsWith(multiMarkerPrefix))) rmSync(multiMarkerIndex, { force: true });
    log({ kind: 'multi-marker-release', id, reason });
    process.exit(0);
  };
  process.stdin.on('end', () => release('stdin-end'));
  process.stdin.on('data', () => {});
  process.on('SIGTERM', () => release('SIGTERM'));
  process.on('SIGHUP', () => release('SIGHUP'));
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (script.includes('REMOTE_CHECK_LANDING_MARKER')) {
  const id = script.match(/# REMOTE_CHECK_LANDING_ID ([a-zA-Z0-9-]+)/)?.[1] ?? 'unknown';
  const slots = Number(script.split('\\n').find((line) => line.startsWith('# REMOTE_CHECK_LANDING_COUNT '))?.split(' ').at(-1) ?? 0);
  const arrivalOrder = script.split('\\n').find((line) => line.startsWith('# REMOTE_CHECK_LANDING_ARRIVAL '))?.split(' ').at(-1) ?? '0';
  const marker = dir + '/' + landingMarkerPrefix + id;
  if (existsSync(marker)) process.exit(75);
  const sequence = count('landing-marker-sequence');
  const beganAt = Number(readFileSync(dir + '/clock', 'utf8'));
  writeFileSync(marker, JSON.stringify({ id, slots, beganAt, arrivalOrder, sequence }));
  writeFileSync(landingMarkerIndex, '1');
  log({ kind: 'landing-marker', id, slots, arrivalOrder, fakeStartedAt: beganAt, sequence });
  console.log('LANDING_MARKER');
  const release = (reason = 'stdin-end') => {
    rmSync(marker, { force: true });
    if (!readdirSync(dir).some((name) => name.startsWith(landingMarkerPrefix))) rmSync(landingMarkerIndex, { force: true });
    log({ kind: 'landing-marker-release', id, reason });
    process.exit(0);
  };
  process.stdin.on('end', () => release('stdin-end'));
  process.stdin.on('data', () => {});
  process.on('SIGTERM', () => release('SIGTERM'));
  process.on('SIGHUP', () => release('SIGHUP'));
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (script.includes('REMOTE_CHECK_SLOT_TAKE')) {
  const requested = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\\d+)/)?.[1] ?? 1);
  const reservationBytes = Number(script.match(/# REMOTE_CHECK_MEMORY_RESERVATION_BYTES (\\d+)/)?.[1] ?? Math.round(2.5 * 2 ** 30));
  const slotClass = script.match(/# REMOTE_CHECK_SLOT_CLASS (ordinary|short)/)?.[1] ?? 'ordinary';
  const call = count('slot');
  if (call < (config.busy ?? 0)) {
    log({ kind: 'slot', granted: false, reason: 'busy', requested, call, slotClass, script });
    process.exit(75);
  }
  const grants = existsSync(dir + '/' + hostKey + '.granted')
    ? Number(readFileSync(dir + '/' + hostKey + '.granted', 'utf8'))
    : 0;
  if (config.grantOnly !== undefined && grants >= config.grantOnly) {
    log({ kind: 'slot', granted: false, reason: 'grant-limit', requested, call, slotClass, script });
    process.exit(75);
  }
  const capacity = config.slots ?? 2;
  const ordinaryCapacity = Number(
    script.match(/# REMOTE_CHECK_ORDINARY_COUNT (\\d+)/)?.[1] ?? Math.max(0, capacity - 1),
  );
  const ordinaryAdmissionLimit = Number(
    script.match(/# REMOTE_CHECK_ORDINARY_ADMISSION_LIMIT (\\d+)/)?.[1] ?? ordinaryCapacity,
  );
  const isGate = script.includes('# REMOTE_CHECK_GATE_REQUEST 1');
  const priority = script.match(/# REMOTE_CHECK_PRIORITY (landing|ordinary)/)?.[1] ?? 'ordinary';
  const waiterIdValue = script.match(/# REMOTE_CHECK_MULTI_SLOT_WAITER_ID ([a-zA-Z0-9-]+)/)?.[1];
  const waiterId = waiterIdValue && waiterIdValue !== '-' ? waiterIdValue : undefined;
  const landingIdValue = script.match(/# REMOTE_CHECK_LANDING_WAITER_ID ([a-zA-Z0-9-]+)/)?.[1];
  const landingId = landingIdValue && landingIdValue !== '-' ? landingIdValue : undefined;
  if (waiterId && existsSync(dir + '/' + hostKey + '.hold-multi-grant')) {
    log({ kind: 'slot', granted: false, reason: 'held-multi-grant', requested, call, slotClass, script });
    process.exit(75);
  }
  const gateWaiting = existsSync(dir + '/' + hostKey + '.gate-marker');
  const landingMarkers = readLandingMarkers();
  const oldestLanding = landingMarkers[0];
  const multiMarkers = readMultiMarkers();
  let actualAdmissionLimit = ordinaryAdmissionLimit;
  let waitBehindOlderMulti = false;
  if (gateWaiting) {
    actualAdmissionLimit = isGate ? ordinaryCapacity : ordinaryCapacity - Math.max(0, ordinaryCapacity - 1);
  } else if (!isGate && oldestLanding) {
    if (priority === 'landing' && landingId === oldestLanding.id) actualAdmissionLimit = ordinaryCapacity;
    else actualAdmissionLimit = 0;
  } else if (!isGate && multiMarkers.length > 0) {
    const oldest = multiMarkers[0]!;
    if (waiterId === oldest.id) actualAdmissionLimit = ordinaryCapacity;
    else {
      actualAdmissionLimit = ordinaryCapacity - oldest.slots;
      waitBehindOlderMulti = requested > 1 && waiterId !== undefined;
    }
  }
  const slotLimit = Number(script.match(/# REMOTE_CHECK_SLOT_LIMIT (\\d+)/)?.[1] ?? ordinaryCapacity);
  const reserved = Array.from({ length: ordinaryCapacity }, (_, index) => index)
    .filter((index) => existsSync(dir + '/' + hostKey + '.slot.' + index))
    .reduce((sum, index) => sum + Number(readFileSync(dir + '/' + hostKey + '.slot.' + index + '.memory', 'utf8') || 0), 0)
    + (existsSync(dir + '/' + hostKey + '.slot.express') ? Number(readFileSync(dir + '/' + hostKey + '.slot.express.memory', 'utf8') || 0) : 0);
  if (reserved + requested * reservationBytes > (config.memoryMax ?? (16 * 2 ** 30))) {
    log({ kind: 'slot', granted: false, reason: 'memory', reserved, requestedBytes: reservationBytes, script });
    process.exit(75);
  }
  const occupied = Array.from({ length: ordinaryCapacity }, (_, index) => index).filter((index) => existsSync(dir + '/' + hostKey + '.slot.' + index));
  const expressOccupied = existsSync(dir + '/' + hostKey + '.slot.express');
  const taking = dir + '/' + hostKey + '.taking';
  if (existsSync(taking)) {
    log({ kind: 'slot', granted: false, reason: 'reserved', requested, call, slotClass, script });
    process.exit(75);
  }
  mkdirSync(taking);
  const hasBusyCountPass = script.includes('# REMOTE_CHECK_ORDINARY_BUSY_COUNT_PASS');
  const selected: Array<number | 'express'> = [];
  let occupiedCount = hasBusyCountPass ? occupied.length : 0;
  let ordinaryUsed = hasBusyCountPass ? occupied.length : 0;
  for (let index = 0; index < ordinaryCapacity; index += 1) {
    if (occupied.includes(index)) {
      if (!hasBusyCountPass) {
        occupiedCount += 1;
        ordinaryUsed += 1;
      }
    } else if (
      selected.length < requested &&
      (hasBusyCountPass ? ordinaryUsed + selected.length : ordinaryUsed) < actualAdmissionLimit
    ) {
      selected.push(index);
      if (!hasBusyCountPass) ordinaryUsed += 1;
    }
  }
  if (slotClass === 'short' && selected.length < requested) {
    if (expressOccupied) occupiedCount += 1;
    else selected.push('express');
  }
  if (waitBehindOlderMulti || (priority === 'landing' && (gateWaiting || (oldestLanding && landingId !== oldestLanding.id))) || occupiedCount + selected.length > slotLimit || selected.length < requested) {
    rmSync(taking, { recursive: true, force: true });
    log({ kind: 'slot', granted: false, reason: 'capacity', requested, slotClass, script, occupied: occupiedCount, slotLimit, call });
    process.exit(75);
  }
  for (const slot of selected) {
    mkdirSync(dir + '/' + hostKey + '.slot.' + slot);
    writeFileSync(dir + '/' + hostKey + '.slot.' + slot + '.memory', String(reservationBytes));
  }
  writeFileSync(dir + '/' + hostKey + '.granted', String(grants + selected.length));
  rmSync(taking, { recursive: true, force: true });
  for (const slot of selected) log({ kind: 'slot', granted: true, requested, slotClass, script, call, slot, actualAdmissionLimit, landingMarkerIds: landingMarkers.map(({ id }) => id) });
  console.log('SLOTS ' + requested);
  const release = () => {
    for (const slot of selected) {
      rmSync(dir + '/' + hostKey + '.slot.' + slot, { recursive: true, force: true });
      rmSync(dir + '/' + hostKey + '.slot.' + slot + '.memory', { force: true });
      log({ kind: 'release', slot });
    }
    process.exit(0);
  };
  process.stdin.on('end', () => release('stdin-end'));
  process.stdin.on('data', () => {});
  process.on('SIGTERM', release);
  process.on('SIGHUP', release);
  process.stdin.resume();
} else if (script.includes('REMOTE_CHECK_STATUS')) {
  log({ kind: 'status' });
  const statusFile = dir + '/' + hostKey + '.status';
  if (existsSync(statusFile)) console.log(readFileSync(statusFile, 'utf8'));
  else {
    const runCount = Number(existsSync(dir + '/' + hostKey + '.run') ? readFileSync(dir + '/' + hostKey + '.run', 'utf8') : '0');
    console.log(runCount > 0 && runCount <= (config.preCommandFailures ?? 0) ? 'NOT_STARTED' : 'STARTED');
  }
} else if (script.includes('REMOTE_CHECK_RETURNS')) {
  const paths = [...script.matchAll(/^# PATH (.*)$/gm)].map((match) => match[1]);
  log({ kind: 'returns', paths });
  const present = new Set(config.present ?? []);
  for (const path of paths) console.log((present.has(path) ? 'PRESENT ' : 'ABSENT ') + path);
} else if (script.includes('REMOTE_CHECK_BASE_STATE')) {
  console.log('BASE ' + (config.base ?? '-'));
  console.log('AGE ' + (config.baseAgeSeconds === undefined ? '-' : String(config.baseAgeSeconds)));
  console.log('ZSTD ' + (config.zstd === false ? '0' : '1'));
} else if (script.includes('systemd-run')) {
  const runNumber = count('run');
  if (runNumber < (config.preCommandFailures ?? 0)) {
    log({ kind: 'pre-command-transport-failure' });
    process.exit(255);
  }
  const hang = Boolean(config.hang && runNumber < (config.hangRuns ?? Number.POSITIVE_INFINITY));
  if (hang && config.memoryHeadroomOnHang !== undefined) updateConfig({ memoryHeadroom: config.memoryHeadroomOnHang });
  const fakeStartedAt = config.runDurationMs === undefined ? undefined : Number(readFileSync(dir + '/clock', 'utf8'));
  log({ kind: 'run', script, identity: args[args.indexOf('-i') + 1], fakeStartedAt });
  const host = address.slice(address.indexOf('@') + 1).replace(/\\.test$/, '');
  const statusFile = dir + '/' + hostKey + '.status';
  if (runNumber < (config.transportFailures ?? 0)) {
    rmSync(statusFile, { force: true });
    process.exit(255);
  }
  const result = config.exit ?? 0;
  writeFileSync(statusFile, String(result));
  if (script.includes('remote-check: bun install') && script.includes('remote-check: command')) {
    console.error('remote-check: bun install 0.125 s on ' + host);
    console.error('remote-check: command 0.250 s on ' + host);
  }
  if (config.stdout) console.log(config.stdout);
  if (config.stderr) console.error(config.stderr);
  if (hang) {
    console.log('started');
    process.on('SIGTERM', () => {
      if (config.memoryHeadroomAfterHang !== undefined) updateConfig({ memoryHeadroom: config.memoryHeadroomAfterHang });
      process.exit(143);
    });
    setInterval(() => {}, 1000);
  } else if (config.runDurationMs !== undefined) {
    const clock = dir + '/clock';
    const finishAt = fakeStartedAt! + config.runDurationMs;
    while (Number(readFileSync(clock, 'utf8')) < finishAt) await Bun.sleep(2);
    process.exit(result);
  } else process.exit(result);
} else {
  log({ kind: 'cleanup', script });
}
`;

const fakeRsync = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('rsync version 3.3.0\\nCapabilities: zstd zlib');
  process.exit(0);
}
const input = await Bun.stdin.text();
const remote = args.find((argument) => /ops@[^:]+\\.test:/.test(argument));
const address = remote?.slice(0, remote.indexOf(':'));
const config = address ? JSON.parse(readFileSync(process.env.FAKE_DIR + '/config.json', 'utf8'))[address] ?? {} : {};
const rshIndex = args.indexOf('-e');
const isBack = args.at(-1)?.endsWith('/') && !args.at(-1)?.startsWith('ops@');
const hostKey = (address ?? '').replace(/[^a-z0-9]/gi, '_');
const attemptFile = process.env.FAKE_DIR + '/' + hostKey + '.rsync-attempt';
const attempt = Number((await import('node:fs')).existsSync(attemptFile) ? readFileSync(attemptFile, 'utf8') : '0');
const { writeFileSync } = await import('node:fs');
writeFileSync(attemptFile, String(attempt + 1));
const code = isBack
  ? (config.rsyncBackExit ?? 0)
  : attempt < (config.rsyncFailures ?? 0)
    ? (config.rsyncFailureCode ?? 12)
    : (config.rsyncExit ?? 0);
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  args,
  destination: args.at(-1),
  rsh: rshIndex >= 0 ? args[rshIndex + 1] : undefined,
  files: input.split('\\0').filter(Boolean),
  code,
}) + '\\n');
console.error('sent 1,234 bytes 10,000 bytes/sec');
for (const file of config.vanishedFiles ?? []) console.error('rsync: [sender] file has vanished: ' + file);
process.exit(code);
`;

const fakeDocker = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({ kind: 'docker', args: process.argv.slice(2) }) + '\\n');
process.exit(99);
`;

type Event = { kind: string; address?: string; [key: string]: unknown };
type HostConfig = {
  available?: number;
  tmpBytes?: number;
  tmpInodes?: number;
  omitTmpBytes?: boolean;
  omitTmpInodes?: boolean;
  memoryCurrent?: number;
  memoryMax?: number;
  memoryHeadroom?: number;
  memoryUnreadable?: boolean;
  processors?: number;
  sliceProcessors?: number;
  cpuMaxUnreadable?: boolean;
  cpuMaxIsMax?: boolean;
  memoryHeadroomOnHang?: number;
  memoryHeadroomAfterHang?: number;
  load?: number;
  cpuQuotaPercent?: number;
  memoryMaxGiB?: number;
  busy?: number;
  grantOnly?: number;
  slots?: number;
  processorsPerSlot?: number;
  ordinaryBusy?: number;
  busyMemoryGiB?: number;
  expressBusy?: boolean;
  down?: boolean;
  exit?: number;
  transportFailures?: number;
  rsyncExit?: number;
  rsyncBackExit?: number;
  vanishedFiles?: string[];
  rsyncFailures?: number;
  rsyncFailureCode?: number;
  preCommandFailures?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
  hangRuns?: number;
  runDurationMs?: number;
  present?: string[];
  ordinaryBusySlots?: number[];
  base?: string;
  baseAgeSeconds?: number;
  zstd?: boolean;
  baseRefreshExit?: number;
  fallback?: boolean;
};

let root: string;
let counter = 0;
const inheritedCheckEnvironment = { ...process.env };

function cleanTestEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete clean[key];
  }
  return clean;
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete process.env[key];
  }
  mkdirSync(join(repository, '.temp'), { recursive: true });
  root = mkdtempSync(join(repository, '.temp/remote-check-test-'));
  mkdirSync(join(root, 'bin'));
  for (const [name, source] of [
    ['ssh', fakeSsh],
    ['rsync', fakeRsync],
    ['docker', fakeDocker],
  ] as const) {
    const file = join(root, 'bin', name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    )
      delete process.env[key];
  }
  for (const [key, value] of Object.entries(inheritedCheckEnvironment)) {
    if (
      key.startsWith('REZICS_CHECK_') ||
      key.startsWith('REZICS_STACK_') ||
      key === 'KERNEL_CHECK_REMOTE' ||
      key === 'KERNEL_CHECK_ON_REMOTE'
    ) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});

test('nested remote checks start with default placement environment', () => {
  const environment = cleanTestEnvironment({
    ...process.env,
    REZICS_CHECK_SLICE: 'outer.slice',
    REZICS_CHECK_RUN: 'outer-run',
    KERNEL_CHECK_REMOTE: '/outer/hosts.json',
    KERNEL_CHECK_ON_REMOTE: '1',
  });
  expect(environment.REZICS_CHECK_SLICE).toBeUndefined();
  expect(environment.REZICS_CHECK_RUN).toBeUndefined();
  expect(environment.KERNEL_CHECK_REMOTE).toBeUndefined();
  expect(environment.KERNEL_CHECK_ON_REMOTE).toBeUndefined();
});

function scenario(hosts: Record<string, HostConfig>): { env: Record<string, string>; events: () => Event[] } {
  const dir = join(root, `scenario-${counter++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'clock'), '0');
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(Object.fromEntries(Object.entries(hosts).map(([name, config]) => [`ops@${name}.test`, config]))),
  );
  writeFileSync(
    join(dir, 'hosts.json'),
    JSON.stringify({
      hosts: Object.keys(hosts).map((name) => ({
        name,
        address: `ops@${name}.test`,
        identity: `/keys/${name}`,
        memoryMaxGiB: hosts[name].memoryMaxGiB ?? 16,
        cpuQuotaPercent: hosts[name].cpuQuotaPercent ?? 800,
        slots: hosts[name].slots ?? 2,
        ...(hosts[name].fallback ? { fallback: true } : {}),
        ...(hosts[name].processorsPerSlot === undefined ? {} : { processorsPerSlot: hosts[name].processorsPerSlot }),
      })),
    }),
  );
  for (const [name, config] of Object.entries(hosts)) {
    const hostKey = `ops@${name}.test`.replace(/[^a-z0-9]/gi, '_');
    const occupiedSlots =
      config.ordinaryBusySlots ?? Array.from({ length: config.ordinaryBusy ?? 0 }, (_, index) => index);
    for (const index of occupiedSlots) {
      mkdirSync(join(dir, `${hostKey}.slot.${index}`));
      writeFileSync(join(dir, `${hostKey}.slot.${index}.memory`), String((config.busyMemoryGiB ?? 2.5) * 2 ** 30));
    }
    if (config.expressBusy) mkdirSync(join(dir, `${hostKey}.slot.express`));
  }
  const env: Record<string, string> = {
    ...cleanTestEnvironment(process.env as Record<string, string>),
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    FAKE_DIR: dir,
    XDG_RUNTIME_DIR: join(dir, 'runtime'),
    KERNEL_CHECK_REMOTE: join(dir, 'hosts.json'),
    REMOTE_CHECK_POLL_MS: '20',
  };
  delete env.GOAL_CHECK_WAIT_FILE;
  return {
    env,
    events: () => {
      const file = join(dir, 'log.jsonl');
      if (!existsSync(file)) return [];
      const contents = readFileSync(file, 'utf8');
      const completeContents = contents.endsWith('\n') ? contents : contents.slice(0, contents.lastIndexOf('\n') + 1);
      return completeContents
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event);
    },
  };
}

function slotScriptFor(rootPath: string, slots: number, shortRun = false, gate = false, count = 1): string {
  return slotScript(
    {
      name: 'test',
      address: 'test',
      identity: 'test',
      memoryMaxGiB: 16,
      cpuQuotaPercent: 800,
      slots,
      processorsPerSlot: 2,
    },
    count,
    slots,
    slots - 1,
    slots - 1,
    shortRun,
    shortRun ? 40 : undefined,
    gate,
    undefined,
  ).replaceAll('/srv/rezics-check', rootPath);
}

function slotScriptEnvironment(testRoot: string, tasksCurrent = 0): Record<string, string> {
  const bin = join(testRoot, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'systemctl'),
    '#!/bin/sh\ncase "$1" in show) printf "%s\\n" "${TASKS_CURRENT:-0}" ;; list-units) ;; esac\n',
  );
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'systemctl'), 0o755);
  chmodSync(join(bin, 'docker'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, TASKS_CURRENT: String(tasksCurrent) };
}

async function waitForSlotToken(holder: ReturnType<typeof Bun.spawn>, count: number): Promise<void> {
  const reader = holder.stdout.getReader();
  let output = '';
  while (!new RegExp(`SLOTS ${count}\\n`).test(output)) {
    const part = await reader.read();
    if (part.done) throw new Error(`slot script exited before granting: ${output}`);
    output += new TextDecoder().decode(part.value);
  }
  reader.releaseLock();
}

test('generated slot scripts use only slot locks in their reserved descriptor range', () => {
  for (const slots of [1, 3, 5]) {
    for (const [shortRun, gate] of [[false, false], [true, false], [false, true]] as const) {
      const script = slotScriptFor('/tmp/descriptor-check', slots, shortRun, gate);
      const firstSlotFd = 10;
      const lastSlotFd = firstSlotFd + slots - 1;
      for (const match of script.matchAll(/^exec (\d+)[<>](.*)$/gm)) {
        const fd = Number(match[1]);
        if (fd >= firstSlotFd && fd <= lastSlotFd && !match[2]!.startsWith('&-')) {
          expect(match[2]).toMatch(/"[^\n]*\/slots\/(?:\d+|express)\.lock"/);
        }
      }
      expect(script).toContain('exec 9>"/tmp/descriptor-check/bases/.lock"');
    }
  }
});

test('ordinary and express slot locks stay held until the slot holder input closes', async () => {
  const testRoot = mkdtempSync(join(root, 'slot-locks-'));
  const hostRoot = join(testRoot, 'host');
  const environment = slotScriptEnvironment(testRoot);
  mkdirSync(testRoot, { recursive: true });
  for (const slots of [1, 3, 5]) {
    const ordinaryCount = slots - 1;
    for (let target = 0; target < ordinaryCount; target += 1) {
      const blockers: ReturnType<typeof spawn>[] = [];
      for (let index = 0; index < target; index += 1) {
        const lock = join(hostRoot, 'slots', `${index}.lock`);
        mkdirSync(join(hostRoot, 'slots'), { recursive: true });
        const blocker = spawn('flock', ['-n', lock, 'sh', '-c', 'sleep 30']);
        blockers.push(blocker);
        await Bun.sleep(25);
        expect(blocker.exitCode).toBeNull();
      }
      const script = slotScriptFor(hostRoot, slots);
      const holder = Bun.spawn(['sh', '-c', script], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: environment,
      });
      try {
        holder.stdin.write(`ordinary-${slots}-${target}\n`);
        await holder.stdin.flush();
        await waitForSlotToken(holder, 1);
        const selectedLock = join(hostRoot, 'slots', `${target}.lock`);
        expect(existsSync(join(hostRoot, 'runs', `ordinary-${slots}-${target}`, 'slots'))).toBe(true);
        expect(spawnSync('flock', ['-n', selectedLock, '-c', 'true']).status).not.toBe(0);
        await holder.stdin.end();
        expect(await holder.exited).toBe(0);
        expect(spawnSync('flock', ['-n', selectedLock, '-c', 'true']).status).toBe(0);
      } finally {
        try { await holder.stdin.end(); } catch {}
        for (const blocker of blockers) blocker.kill();
      }
    }

    const blockers: ReturnType<typeof spawn>[] = [];
    for (let index = 0; index < ordinaryCount; index += 1) {
      const lock = join(hostRoot, 'slots', `${index}.lock`);
      mkdirSync(join(hostRoot, 'slots'), { recursive: true });
      const blocker = spawn('flock', ['-n', lock, 'sh', '-c', 'sleep 30']);
      blockers.push(blocker);
      await Bun.sleep(25);
      expect(blocker.exitCode).toBeNull();
    }
    const holder = Bun.spawn(['sh', '-c', slotScriptFor(hostRoot, slots, true)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: environment,
    });
    try {
      holder.stdin.write(`express-${slots}\n`);
      await holder.stdin.flush();
      await waitForSlotToken(holder, 1);
      const expressLock = join(hostRoot, 'slots', 'express.lock');
      expect(spawnSync('flock', ['-n', expressLock, '-c', 'true']).status).not.toBe(0);
      await holder.stdin.end();
      expect(await holder.exited).toBe(0);
      expect(spawnSync('flock', ['-n', expressLock, '-c', 'true']).status).toBe(0);
    } finally {
      try { await holder.stdin.end(); } catch {}
      for (const blocker of blockers) blocker.kill();
    }
  }
});

test('live runs with recorded slots bound admission when all slot locks are free', async () => {
  const testRoot = mkdtempSync(join(root, 'live-slot-count-'));
  const hostRoot = join(testRoot, 'host');
  const liveRun = join(hostRoot, 'runs', 'live-run');
  mkdirSync(liveRun, { recursive: true });
  writeFileSync(join(liveRun, '.remote-check-slot-count'), '2\n');
  const run = Bun.spawn(['sh', '-c', slotScriptFor(hostRoot, 3, false, false, 2)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: slotScriptEnvironment(testRoot, 4),
  });
  expect(await run.exited).toBe(75);
  expect(existsSync(join(hostRoot, 'slots', '0.lock'))).toBe(false);
  expect(existsSync(join(hostRoot, 'slots', '1.lock'))).toBe(false);
});

function workspace(): string {
  const directory = mkdtempSync(join(root, 'workspace-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'node_modules/x'), { recursive: true });
  mkdirSync(join(directory, '.temp'));
  writeFileSync(join(directory, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(directory, 'src/tracked.ts'), 'export {};\n');
  writeFileSync(join(directory, 'src/gone.ts'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  rmSync(join(directory, 'src/gone.ts'));
  writeFileSync(join(directory, 'src/untracked.ts'), 'export {};\n');
  writeFileSync(join(directory, 'ignored.txt'), 'x');
  writeFileSync(join(directory, 'node_modules/x/index.js'), 'x');
  writeFileSync(join(directory, '.temp/scratch'), 'x');
  return directory;
}

async function remote(
  environment: Record<string, string>,
  directory: string,
  command: string[] = ['bun', 'test'],
  options: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = startRemote(environment, directory, command, options);
  const [code, stdout, stderr] = await Promise.all([run.child.exited, run.stdout, run.stderr]);
  return { code, stdout, stderr };
}

function startRemote(
  environment: Record<string, string>,
  directory: string,
  command: string[] = ['bun', 'test'],
  options: string[] = [],
): { child: ReturnType<typeof Bun.spawn>; stdout: Promise<string>; stderr: Promise<string> } {
  const child = Bun.spawn(['bun', remoteCheck, ...options, directory, '--', ...command], {
    cwd: repository,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(10);
}

async function kernelCheck(
  environment: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', 'scripts/check.ts', ...kernelFiles], {
    cwd: kernel,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test('a queue of long runs never delays a short run beyond one short run', () => {
  const shortDurationMs = 120_000;
  for (const queueLength of [1, 10, 100]) {
    const host = { ordinaryCapacity: 2, ordinaryUsed: 2, expressBusyUntil: shortDurationMs, now: 0 };
    const waitingLongRuns = Array.from({ length: queueLength }, () => ({
      slots: 1,
      estimateMs: undefined as number | undefined,
    }));

    for (const run of waitingLongRuns) {
      expect(selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, true, run.slots, run.estimateMs)).toBeNull();
    }

    const shortStartedAt = host.now;
    expect(
      selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, host.now >= host.expressBusyUntil, 1, shortDurationMs),
    ).toBeNull();
    host.now = host.expressBusyUntil;
    for (const run of waitingLongRuns) {
      expect(selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, true, run.slots, run.estimateMs)).toBeNull();
    }
    expect(
      selectSlotClass(host.ordinaryCapacity - host.ordinaryUsed, host.now >= host.expressBusyUntil, 1, shortDurationMs),
    ).toBe('express');
    expect(host.now - shortStartedAt).toBeLessThanOrEqual(shortDurationMs);
  }
});

test('a long or unestimated run never takes the express slot', async () => {
  for (const options of [[], ['--estimate-ms', '120001']]) {
    const ordinary = scenario({ a: { available: 20e9, slots: 2 } });
    expect((await remote(ordinary.env, workspace(), ['true'], options)).code).toBe(0);
    const admitted = ordinary.events().find((event) => event.kind === 'slot' && event.granted)!;
    expect(admitted.slotClass).toBe('ordinary');
    expect(admitted.script).not.toContain('/slots/express.lock');

    const { env, events } = scenario({ a: { available: 20e9, slots: 2, ordinaryBusy: 1 } });
    const pending = startRemote(env, workspace(), ['true'], options);
    try {
      await waitFor(() => events().some((event) => event.kind === 'probe'));
      await Bun.sleep(50);
      expect(events().filter((event) => event.kind === 'slot' && event.granted)).toEqual([]);
      expect(events().filter((event) => event.kind === 'run')).toEqual([]);
    } finally {
      pending.child.kill('SIGTERM');
      await pending.child.exited;
      await Promise.all([pending.stdout, pending.stderr]);
    }
  }
});

test('the gate never takes the express slot', async () => {
  const { env, events } = scenario({ a: { available: 20e9, slots: 4 } });
  const result = await remote(env, workspace(), ['true'], ['--gate', '--slots', '2']);
  expect(result.code).toBe(0);
  const takes = events().filter((event) => event.kind === 'slot' && event.granted);
  expect(takes).toHaveLength(2);
  expect(takes.every((event) => event.slotClass === 'ordinary')).toBe(true);
  expect(takes.every((event) => event.slot !== 'express')).toBe(true);
  expect(takes.every((event) => !String(event.script).includes('/slots/express.lock'))).toBe(true);
  expect(takes[0]?.script).toContain('# REMOTE_CHECK_SLOT_LIMIT 2');
});

test('a short run takes an ordinary free slot before the express slot', async () => {
  const ordinary = scenario({ a: { available: 20e9, slots: 2 } });
  expect((await remote(ordinary.env, workspace(), ['true'], ['--estimate-ms', '40'])).code).toBe(0);
  expect(ordinary.events().find((event) => event.kind === 'slot' && event.granted)).toMatchObject({
    slotClass: 'short',
    slot: 0,
  });
  expect(String(ordinary.events().find((event) => event.kind === 'probe')?.script)).toContain('ORDINARY_SLOTS_USED');
  expect(String(ordinary.events().find((event) => event.kind === 'probe')?.script)).toContain('EXPRESS_SLOT_USED');

  const express = scenario({ a: { available: 20e9, slots: 2, ordinaryBusy: 1 } });
  expect((await remote(express.env, workspace(), ['true'], ['--estimate-ms', '40'])).code).toBe(0);
  expect(express.events().find((event) => event.kind === 'slot' && event.granted)).toMatchObject({
    slotClass: 'short',
    slot: 'express',
  });
  expect(String(express.events().find((event) => event.kind === 'slot' && event.granted)?.script)).toContain(
    '/slots/express.lock',
  );
});

test('--estimate-ms is a non-negative integer of milliseconds', async () => {
  const valid = scenario({ a: { available: 20e9 } });
  const completed = await remote(valid.env, workspace(), ['true'], ['--estimate-ms', '0']);
  expect(completed.code).toBe(0);
  expect(valid.events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_ESTIMATE_MS 0',
  );

  for (const estimate of ['-1', '1.5', '9007199254740992', 'Infinity']) {
    const invalid = scenario({ a: { available: 20e9 } });
    const refused = await remote(invalid.env, workspace(), ['true'], ['--estimate-ms', estimate]);
    expect(refused.code, estimate).not.toBe(0);
    expect(refused.stderr, estimate).toContain('--estimate-ms');
    expect(invalid.events(), estimate).toEqual([]);
  }

  const missing = scenario({ a: { available: 20e9 } });
  const refused = await remote(missing.env, workspace(), ['true'], ['--estimate-ms']);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('--estimate-ms');
  expect(missing.events()).toEqual([]);
});

test('compile cache: each remote run keeps Node compile cache inside its own run directory', async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  const work = workspace();

  expect((await remote(env, work, ['true'])).code).toBe(0);
  expect((await remote(env, work, ['true'])).code).toBe(0);

  const seen = events();
  const runDirectories = seen
    .filter((event) => event.kind === 'rsync')
    .map((event) => String(event.destination).match(/:(\/srv\/rezics-check\/runs\/[^/]+)\/$/)?.[1]);
  const scripts = seen.filter((event) => event.kind === 'run').map((event) => String(event.script));
  expect(runDirectories).toHaveLength(2);
  expect(runDirectories[0]).not.toBe(runDirectories[1]);
  expect(scripts).toHaveLength(2);

  for (const [index, script] of scripts.entries()) {
    const cachePath = script.match(/(?:^|\s)BUN_RUNTIME_TRANSPILER_CACHE_PATH=([^\s]+)/)?.[1];
    expect(cachePath).toBe(`${runDirectories[index]}/bun-runtime-transpiler-cache`);
    expect(script).toContain(`export NODE_COMPILE_CACHE=${runDirectories[index]}/.temp/node-compile-cache`);
    expect(script).not.toContain('/tmp/node-compile-cache');
    expect(script.indexOf('export NODE_COMPILE_CACHE')).toBeLessThan(
      script.indexOf('"$bun" install --frozen-lockfile'),
    );
  }
});

test('an in-place write to a shared installed package fails and removes its host cache entry', () => {
  for (const scoped of [false, true]) {
    const directory = mkdtempSync(join(root, 'package-cache-'));
    const cache = join(directory, 'cache');
    const run = join(directory, 'run');
    const packageEntry = scoped ? '@scope/pkg@3.0.0@@@1' : 'pkg@1.0.0@@@1';
    const cacheFile = join(cache, packageEntry, scoped ? 'b.js' : 'src/a.js');
    const runFile = join(run, 'node_modules/.bun', packageEntry, scoped ? 'b.js' : 'src/a.js');
    const otherEntry = join(cache, scoped ? 'other@2.0.0@@@1' : '@scope/pkg@3.0.0@@@1');
    mkdirSync(join(cache, packageEntry, scoped ? '' : 'src'), { recursive: true });
    mkdirSync(join(cache, 'other@2.0.0@@@1'), { recursive: true });
    mkdirSync(join(cache, '@scope/pkg@3.0.0@@@1'), { recursive: true });
    mkdirSync(join(runFile, '..'), { recursive: true });
    writeFileSync(cacheFile, 'original');
    writeFileSync(join(cache, 'other@2.0.0@@@1/index.js'), 'other');
    if (!scoped) writeFileSync(join(cache, '@scope/pkg@3.0.0@@@1/b.js'), 'scoped');
    linkSync(cacheFile, runFile);
    if (!scoped) {
      const scopedRunFile = join(run, 'node_modules/.bun/@scope/pkg@3.0.0@@@1/b.js');
      mkdirSync(join(scopedRunFile, '..'), { recursive: true });
      linkSync(join(cache, '@scope/pkg@3.0.0@@@1/b.js'), scopedRunFile);
    }
    const installedTime = new Date(Date.now() - 5_000);
    utimesSync(cacheFile, installedTime, installedTime);
    if (!scoped) {
      const scopedCacheFile = join(cache, '@scope/pkg@3.0.0@@@1/b.js');
      utimesSync(scopedCacheFile, installedTime, installedTime);
    }
    const marker = join(run, '.bun-install-complete');
    writeFileSync(marker, '');
    const markerTime = new Date(Date.now() - 2_000);
    utimesSync(marker, markerTime, markerTime);

    const script = `code=0\nprintf changed > ${JSON.stringify(runFile)}\n${installedPackageCacheCheck(run, 'check-a', cache)}\nprintf '%s\\n' "$code"`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('1');
    expect(result.stderr).toContain('modified 1 installed package files shared with the host package cache on check-a');
    expect(result.stderr).toContain(`node_modules/.bun/${packageEntry}/${scoped ? 'b.js' : 'src/a.js'}`);
    expect(existsSync(join(cache, packageEntry))).toBe(false);
    expect(existsSync(join(cache, 'other@2.0.0@@@1'))).toBe(true);
    if (!scoped) expect(existsSync(otherEntry)).toBe(true);
  }
});

test('cache-shared installed package files use one host package cache walk', () => {
  const directory = mkdtempSync(join(root, 'package-cache-walk-'));
  const cache = join(directory, 'cache');
  const run = join(directory, 'run');
  const bin = join(directory, 'bin');
  const findLog = join(directory, 'find.log');
  mkdirSync(bin);
  const findWrapper = join(bin, 'find');
  writeFileSync(
    findWrapper,
    '#!/bin/sh\nif [ "$1" = "$CACHE_ROOT" ]; then printf "%s\\n" "$*" >> "$FIND_LOG"; fi\nexec /usr/bin/find "$@"\n',
  );
  chmodSync(findWrapper, 0o755);

  const entries: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const scoped = index % 2 === 0;
    const entry = scoped ? `@scope${index}/pkg${index}@1.0.0@@@1` : `pkg${index}@1.0.0@@@1`;
    const cacheFile = join(cache, entry, 'file.js');
    const runFile = join(run, 'node_modules/.bun', entry, 'file.js');
    mkdirSync(join(cacheFile, '..'), { recursive: true });
    mkdirSync(join(runFile, '..'), { recursive: true });
    writeFileSync(cacheFile, 'original');
    linkSync(cacheFile, runFile);
    entries.push(scoped ? join(cache, entry.split('/')[0], entry.split('/')[1]) : join(cache, entry));
  }

  const installedTime = new Date(Date.now() - 5_000);
  for (const entry of entries) {
    const cacheFile = join(entry, 'file.js');
    utimesSync(cacheFile, installedTime, installedTime);
  }
  const marker = join(run, '.bun-install-complete');
  writeFileSync(marker, '');
  const markerTime = new Date(Date.now() - 2_000);
  utimesSync(marker, markerTime, markerTime);
  const runFiles = entries.map((entry) => join(run, 'node_modules/.bun', entry.slice(cache.length + 1), 'file.js'));
  const script = `code=0\n${runFiles.map((file) => `printf changed > ${JSON.stringify(file)}`).join('\n')}\n${installedPackageCacheCheck(run, 'check-a', cache)}\nprintf '%s\\n' "$code"`;
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CACHE_ROOT: cache, FIND_LOG: findLog },
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('1');
  expect(result.stderr).toContain('modified 20 installed package files shared with the host package cache on check-a');
  expect(readFileSync(findLog, 'utf8').trim().split('\n')).toHaveLength(1);
  for (const entry of entries) expect(existsSync(entry)).toBe(false);
});

test('new package files and files replaced by a new inode do not fail or evict cache entries', () => {
  const directory = mkdtempSync(join(root, 'package-cache-'));
  const cache = join(directory, 'cache');
  const run = join(directory, 'run');
  const cacheFile = join(cache, '@scope/pkg@3.0.0@@@1/b.js');
  const runFile = join(run, 'node_modules/.bun/@scope/pkg@3.0.0@@@1/b.js');
  mkdirSync(join(cache, '@scope/pkg@3.0.0@@@1'), { recursive: true });
  mkdirSync(join(runFile, '..'), { recursive: true });
  writeFileSync(cacheFile, 'original');
  linkSync(cacheFile, runFile);
  writeFileSync(join(run, '.bun-install-complete'), '');

  const replacement = `${runFile}.replacement`;
  const script = `code=0\nprintf added > ${JSON.stringify(join(run, 'node_modules/.bun/new-file.js'))}\nprintf replaced > ${JSON.stringify(replacement)}\nmv ${JSON.stringify(replacement)} ${JSON.stringify(runFile)}\n${installedPackageCacheCheck(run, 'check-a', cache)}\nprintf '%s\\n' "$code"`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('0');
  expect(result.stderr).toBe('');
  expect(existsSync(join(cache, '@scope/pkg@3.0.0@@@1'))).toBe(true);
});

test('the package cache failure lists at most ten changed run-relative paths', () => {
  const directory = mkdtempSync(join(root, 'package-cache-'));
  const cache = join(directory, 'cache');
  const run = join(directory, 'run');
  const runPackages = join(run, 'node_modules/.bun');
  mkdirSync(runPackages, { recursive: true });
  for (let index = 0; index < 11; index += 1) {
    const name = `pkg${index}@1.0.0@@@1`;
    mkdirSync(join(cache, name), { recursive: true });
    mkdirSync(join(runPackages, name), { recursive: true });
    writeFileSync(join(cache, name, 'file.js'), 'original');
    linkSync(join(cache, name, 'file.js'), join(runPackages, name, 'file.js'));
  }
  const installedTime = new Date(Date.now() - 5_000);
  for (let index = 0; index < 11; index += 1) {
    const name = `pkg${index}@1.0.0@@@1`;
    utimesSync(join(cache, name, 'file.js'), installedTime, installedTime);
  }
  const marker = join(run, '.bun-install-complete');
  writeFileSync(marker, '');
  const markerTime = new Date(Date.now() - 2_000);
  utimesSync(marker, markerTime, markerTime);
  const script = `code=0\nfor file in ${JSON.stringify(runPackages)}/*/file.js; do printf changed > "$file"; done\n${installedPackageCacheCheck(run, 'check-a', cache)}\nprintf '%s\\n' "$code"`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('1');
  expect(result.stderr).toContain('modified 11 installed package files shared with the host package cache');
  expect(result.stderr.trim().split('\n').slice(1)).toHaveLength(10);
  expect(result.stderr).toContain('node_modules/.bun/');
});

test('with KERNEL_CHECK_REMOTE set the kernel check selects its files locally and runs them on the host with the most free capacity', async () => {
  const { env, events } = scenario({ a: { available: 4.5e9 }, b: { available: 30e9 } });
  const result = await kernelCheck(env);
  if (onCheckHost(kernel)) {
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('stack-run: kernel check local, already on a check host');
    expect(events().filter((event) => event.kind === 'run')).toEqual([]);
    return;
  }

  expect(result.code, result.stderr).toBe(0);
  const seen = events();
  expect(seen.filter((event) => event.kind === 'docker')).toEqual([]);
  const sync = seen.find((event) => event.kind === 'rsync')!;
  expect(sync.destination).toStartWith('ops@b.test:/srv/rezics-check/runs/');
  const run = seen.find((event) => event.kind === 'run')!;
  expect(run.address).toBe('ops@b.test');
  expect(run.identity).toBe('/keys/b');
  const script = run.script as string;
  expect(script).toContain('systemd-run --scope');
  expect(script).toMatch(/--slice=rezics-check-[a-z0-9_]+\.slice/);
  expect(script).toContain('KERNEL_CHECK_ON_REMOTE=1');
  expect(script).toContain('"$bun" install --frozen-lockfile');
  expect(script).toContain(`bun scripts/check.ts ${kernelFiles.join(' ')}`);
  expect(script).toContain('services/kernel');
  expect(script.indexOf('"$bun" install --frozen-lockfile')).toBeLessThan(script.indexOf('scripts/check.ts'));
  expect(script.indexOf('curl -fsSL')).toBeLessThan(script.indexOf('Bun.revision'));
  expect(script.indexOf('Bun.revision')).toBeLessThan(script.indexOf('"$bun" install --frozen-lockfile'));
  // The slot is released and the run directory removed.
  const kinds = seen.filter((event) => event.address === 'ops@b.test').map((event) => event.kind);
  expect(kinds.slice(-2)).toEqual(['cleanup', 'release']);
});

test('among hosts that pass load and available-memory admission, free slots and memory headroom choose the host', async () => {
  const { env, events } = scenario({
    memory: {
      available: 64 * 2 ** 30,
      memoryMax: 2 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: CHECK_SLOT_MEMORY_BYTES - 1,
      cpuQuotaPercent: 200,
      processors: 16,
      load: 0,
      slots: 4,
    },
    full: {
      available: 64 * 2 ** 30,
      memoryMax: 2 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: 2 * CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 800,
      processors: 16,
      load: 8 - CHECK_SLOT_PROCESSORS + 0.01,
      slots: 4,
      ordinaryBusy: 3,
    },
    ready: {
      available: 4 * 2 ** 30,
      memoryMax: 2 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 400,
      processors: 16,
      load: 0,
      slots: 4,
    },
  });
  const result = await remote(env, workspace());

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@ready.test:');
  const probe = events().find((event) => event.kind === 'probe')!.script as string;
  for (const reportedValue of [
    'nproc',
    '/proc/loadavg',
    'systemctl show --property=ControlGroup',
    'memory.current',
    'memory.max',
    'cpu.max',
    '/proc/meminfo',
  ])
    expect(probe).toContain(reportedValue);
  expect(
    events()
      .filter((event) => event.kind === 'slot')
      .map((event) => event.address),
  ).toEqual(['ops@ready.test']);
});

test('configured slots and slice resources bound the admission capacity', async () => {
  const { env, events } = scenario({
    a: {
      available: 64 * 2 ** 30,
      memoryMax: 64 * 2 ** 30,
      memoryHeadroom: 64 * 2 ** 30,
      cpuQuotaPercent: 1600,
      processors: 16,
      load: 0,
      slots: 1,
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--slots', '2']);

  expect(result.code).toBe(64);
  expect(result.stderr).toContain('cap of 1');
  expect(events().filter((event) => event.kind === 'probe')).toHaveLength(1);
  expect(events().some((event) => event.kind === 'slot')).toBe(false);
});

test('a host with 1.5 processors per slot and 11 slice processors offers 7 slots', async () => {
  const { env, events } = scenario({
    a: {
      available: 30 * 2 ** 30,
      memoryMax: 30 * 2 ** 30,
      memoryHeadroom: 30 * 2 ** 30,
      sliceProcessors: 11,
      processors: 11,
      processorsPerSlot: 1.5,
      slots: 8,
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--slots', '3']);

  expect(result.code).toBe(0);
  const slotScript = String(events().find((event) => event.kind === 'slot')?.script);
  expect(slotScript).toContain('# REMOTE_CHECK_ORDINARY_COUNT 6');
  expect(slotScript).toContain('# REMOTE_CHECK_SLOT_LIMIT 6');
});

test('a processor-bounded host does not lose slots to its memoryMaxGiB', async () => {
  const { env, events } = scenario({
    a: {
      available: 16 * 2 ** 30,
      memoryMax: 4 * 2 ** 30,
      memoryMaxGiB: 4,
      memoryHeadroom: 4 * 2 ** 30,
      sliceProcessors: 12,
      slots: 8,
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--slots', '3', '--memory-gib', '1']);
  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'slot')?.script).toContain('# REMOTE_CHECK_ORDINARY_COUNT 5');
});

test('memory reservations that exceed a host limit queue with the host and both amounts', async () => {
  const { env } = scenario({
    a: { slots: 3, memoryMax: 8 * 2 ** 30, memoryMaxGiB: 8, ordinaryBusy: 1, busyMemoryGiB: 6 },
  });
  const directory = workspace();
  const run = startRemote(env, directory, ['true'], ['--memory-gib', '4']);
  await waitFor(() => existsSync(join(env.FAKE_DIR!, 'ops_a_test.connection')));
  await Bun.sleep(80);
  const hostKey = 'ops_a_test';
  rmSync(join(env.FAKE_DIR!, `${hostKey}.slot.0`), { recursive: true, force: true });
  rmSync(join(env.FAKE_DIR!, `${hostKey}.slot.0.memory`), { force: true });
  expect(await run.child.exited).toBe(0);
  const waiting = await run.stderr;
  expect(waiting).toContain('a 0/2 free');
  expect(waiting).toContain('6 GiB reserved + 4 GiB requested of 8 GiB');
});

test('a request fits beside held reservations when their total equals the host memory limit', async () => {
  const { env, events } = scenario({
    a: {
      slots: 3,
      memoryMax: 8 * 2 ** 30,
      memoryMaxGiB: 8,
      memoryHeadroom: 8 * 2 ** 30,
      ordinaryBusy: 1,
      busyMemoryGiB: 4,
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--memory-gib', '4']);
  expect(result.code).toBe(0);
  expect(events().filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(1);
});

test('releasing a slot frees its memory reservation for a queued run', async () => {
  const { env, events } = scenario({
    a: { slots: 4, memoryMax: 8 * 2 ** 30, memoryMaxGiB: 8, memoryHeadroom: 8 * 2 ** 30, runDurationMs: 100 },
  });
  const directory = workspace();
  const holder = startRemote(env, directory, ['true'], ['--memory-gib', '6']);
  await waitFor(() => events().some((event) => event.kind === 'run'));
  const waiting = startRemote(env, directory, ['true'], ['--memory-gib', '4']);
  await Bun.sleep(80);
  expect(waiting.child.exitCode).toBeNull();
  writeFileSync(join(env.FAKE_DIR!, 'clock'), '100');
  expect(await holder.child.exited).toBe(0);
  await waitFor(() => events().filter((event) => event.kind === 'run').length === 2);
  writeFileSync(join(env.FAKE_DIR!, 'clock'), '200');
  expect(await waiting.child.exited).toBe(0);
  expect(events().filter((event) => event.kind === 'run')).toHaveLength(2);
});

test('a caller without a memory request keeps the 2.5 GiB reservation', async () => {
  const { env, events } = scenario({ a: {} });
  const result = await remote(env, workspace(), ['true']);
  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'slot')?.script).toContain(
    `# REMOTE_CHECK_MEMORY_RESERVATION_BYTES ${CHECK_SLOT_MEMORY_BYTES}`,
  );
});

test('real slot locks enforce reservations, ignore stale files and free memory on release', async () => {
  const scripts = new Map<number, string>();
  for (const memoryGiB of [4, 6]) {
    const { env, events } = scenario({ a: { slots: 3, memoryMaxGiB: 8 } });
    expect((await remote(env, workspace(), ['true'], ['--memory-gib', String(memoryGiB)])).code).toBe(0);
    const script = String(events().find((event) => event.kind === 'slot')!.script);
    // Exercise the generated admission and holder with real flock, without running host-wide stale-run cleanup.
    scripts.set(memoryGiB, script.slice(script.indexOf('REMOTE_CHECK_SLOT_TAKE=1')));
  }
  for (const heldGiB of [4, 6]) {
    const directory = mkdtempSync(join(root, 'memory-locks-'));
    mkdirSync(join(directory, 'slots'));
    mkdirSync(join(directory, 'bases'));
    // An unlocked slot's old reservation must not count, even when it exceeds the entire host limit.
    writeFileSync(join(directory, 'slots/0.memory'), String(100 * 2 ** 30));
    const localScript = (memoryGiB: number) => scripts.get(memoryGiB)!.replaceAll('/srv/rezics-check', directory);
    const output = join(directory, 'holder-output');
    const holder = Bun.spawn(['bash', '-c', localScript(heldGiB)], {
      stdin: 'pipe',
      stdout: Bun.file(output),
      stderr: 'pipe',
    });
    const stderr = new Response(holder.stderr).text();
    holder.stdin.write('\n');
    try {
      await waitFor(() => existsSync(output) && readFileSync(output, 'utf8').includes('SLOTS 1'));
      expect(readFileSync(join(directory, 'slots/0.memory'), 'utf8').trim()).toBe(String(heldGiB * 2 ** 30));
      const contender = spawnSync('bash', ['-c', localScript(4)], { input: '\n', encoding: 'utf8', timeout: 5_000 });
      expect(contender.status, contender.stderr).toBe(heldGiB === 4 ? 0 : 75);
      if (heldGiB === 4) expect(contender.stdout).toContain('SLOTS 1');
    } finally {
      holder.stdin.end();
      expect(await holder.exited, await stderr).toBe(0);
    }
    expect(existsSync(join(directory, 'slots/0.memory'))).toBe(false);
    const next = spawnSync('bash', ['-c', localScript(4)], { input: '\n', encoding: 'utf8', timeout: 5_000 });
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toContain('SLOTS 1');
  }
});

test('try-once callers apply their memory request when ranking and acquiring hosts', async () => {
  for (const memoryGiB of [4, 2]) {
    const { env, events } = scenario({
      a: { slots: 3, memoryMaxGiB: 8, memoryMax: 8 * 2 ** 30, ordinaryBusy: 1, busyMemoryGiB: 6 },
    });
    const options = {
      hosts: readHosts(env.KERNEL_CHECK_REMOTE!),
      workspace: workspace(),
      command: ['true'],
      memoryGiB,
    };
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `const { tryRemoteCheck } = await import(${JSON.stringify(remoteCheck)});
       console.log(JSON.stringify(await tryRemoteCheck(${JSON.stringify(options)}, new AbortController().signal)));`,
      ],
      { env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout).status).toBe(memoryGiB === 4 ? 'no-slot' : 'ran');
    const granted = events().find((event) => event.kind === 'slot' && event.granted);
    if (memoryGiB === 4) expect(granted).toBeUndefined();
    else expect(granted?.script).toContain(`# REMOTE_CHECK_MEMORY_RESERVATION_BYTES ${2 * 2 ** 30}`);
  }
});

test('memory requests must be positive integers before any host is contacted', async () => {
  for (const value of ['0', '-1', '2.5', 'NaN', 'Infinity']) {
    const { env, events } = scenario({ a: {} });
    const result = await remote(env, workspace(), ['true'], ['--memory-gib', value]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--memory-gib must be a positive integer');
    expect(events()).toEqual([]);
  }
});

test('a host without processorsPerSlot keeps 2 processors per slot', () => {
  const { env } = scenario({ a: {} });
  expect(readHosts(env.KERNEL_CHECK_REMOTE!)[0]?.processorsPerSlot).toBe(CHECK_SLOT_PROCESSORS);
});

test('a non-positive or non-finite processorsPerSlot fails host loading with the host name', () => {
  const { env } = scenario({ namedHost: {} });
  const hostsFile = env.KERNEL_CHECK_REMOTE!;
  const contents = readFileSync(hostsFile, 'utf8');
  for (const invalid of ['null', '0', '-1', '1e999']) {
    writeFileSync(hostsFile, contents.replace('"slots":2', `"slots":2,"processorsPerSlot":${invalid}`));
    expect(() => readHosts(hostsFile)).toThrow('host namedHost: bad processorsPerSlot');
  }
});

test('a request above half the smallest answering host capacity is refused before waiting', async () => {
  const { env, events } = scenario({
    small: { slots: 4, memoryMax: 16 * 2 ** 30, memoryHeadroom: 16 * 2 ** 30, cpuQuotaPercent: 800 },
    large: { slots: 8, memoryMax: 48 * 2 ** 30, memoryHeadroom: 48 * 2 ** 30, cpuQuotaPercent: 1600 },
  });
  const directory = workspace();
  const result = await remote(env, directory, ['true'], ['--slots', '3']);
  expect(result.code).toBe(64);
  expect(result.stderr).toContain('cap of 2');
  expect(result.stderr).toContain("lower the run's concurrency to match");
  expect(result.stderr).not.toContain('waiting for a free one');
  expect(events().filter((event) => event.kind === 'probe')).toHaveLength(2);
  expect(events().some((event) => event.kind === 'slot')).toBe(false);

  const libraryCall = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { readHosts, remoteCheck, SlotRequestTooLarge } from ${JSON.stringify(remoteCheck)};
try {
  await remoteCheck({ hosts: readHosts(process.env.KERNEL_CHECK_REMOTE), workspace: ${JSON.stringify(directory)}, command: ['true'], slots: 3, pollMs: 20 }, new AbortController().signal);
  process.exit(2);
} catch (error) {
  if (error instanceof SlotRequestTooLarge) process.exit(0);
  console.error(error);
  process.exit(1);
}`,
    ],
    { cwd: repository, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  );
  const [libraryCode, libraryError] = await Promise.all([libraryCall.exited, new Response(libraryCall.stderr).text()]);
  expect(libraryCode, libraryError).toBe(0);
});

test('a remote slot wait is appended to GOAL_CHECK_WAIT_FILE while it is still waiting', async () => {
  const { env, events } = scenario({ a: { available: 8 * 2 ** 30, slots: 2, busy: 12 } });
  const waitFile = join(env.FAKE_DIR!, 'goal-check-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  env.REMOTE_CHECK_POLL_MS = '20';
  env.REMOTE_CHECK_WAIT_REPEAT_MS = '10';
  const run = startRemote(env, workspace(), ['true']);

  await waitFor(
    () => existsSync(waitFile) && events().filter((event) => event.kind === 'slot' && !event.granted).length > 0,
  );
  const whileWaiting = readFileSync(waitFile, 'utf8');
  expect(run.child.exitCode).toBeNull();
  await Bun.sleep(60);
  const whileStillWaiting = readFileSync(waitFile, 'utf8');
  expect(whileStillWaiting.length).toBeGreaterThanOrEqual(whileWaiting.length);

  const [code, , stderr] = await Promise.all([run.child.exited, run.stdout, run.stderr]);
  expect(code).toBe(0);
  const slotWaitLines = stderr.split('\n').filter((line) => line.includes('every check slot is busy'));
  expect(slotWaitLines.length).toBeGreaterThanOrEqual(2);
  expect(slotWaitLines.every((line) => /a \d+\/\d+ free/.test(line))).toBe(true);
  const lines = readFileSync(waitFile, 'utf8').trim().split('\n');
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((line) => /^\d+$/.test(line) && Number(line) > 0 && Number(line) <= 60_000)).toBe(true);
});

test('without GOAL_CHECK_WAIT_FILE no wait is recorded', async () => {
  const { env } = scenario({ a: { available: 8 * 2 ** 30, slots: 2, busy: 4 } });
  const waitFile = join(env.FAKE_DIR!, 'goal-check-wait-ms');
  delete env.GOAL_CHECK_WAIT_FILE;
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(existsSync(waitFile)).toBe(false);
});

test('acquisition prefers the host with the most free capacity', async () => {
  const { env, events } = scenario({
    a: {
      available: 64 * 2 ** 30,
      memoryMax: 8 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: 8 * CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 800,
      processors: 16,
      ordinaryBusy: 2,
      slots: 4,
    },
    b: {
      available: 4 * 2 ** 30,
      memoryMax: 4 * CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroom: 4 * CHECK_SLOT_MEMORY_BYTES,
      cpuQuotaPercent: 800,
      processors: 16,
      load: 0,
      slots: 4,
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--slots', '2']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@b.test:');
  expect(events().filter((event) => event.kind === 'probe')).toHaveLength(2);
  const granted = events().filter((event) => event.kind === 'slot' && event.address === 'ops@b.test' && event.granted);
  expect(granted).toHaveLength(2);
  expect(new Set(granted.map((event) => event.call)).size).toBe(1);
});

test('a host over 1.5 times its slice processors in load is skipped and logged with its load limit', async () => {
  const { env, events } = scenario({
    loaded: { available: 16 * 2 ** 30, load: 13, sliceProcessors: 8 },
    ready: { available: 16 * 2 ** 30, load: 0 },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@ready.test');
  expect(result.stderr).toContain('skipped loaded: load 13 exceeds limit 12');
});

test('a host with less than 4 GiB MemAvailable is skipped and logged with its available memory', async () => {
  const { env, events } = scenario({
    low: { available: 3 * 2 ** 30, memoryMax: 16 * 2 ** 30, memoryHeadroom: 16 * 2 ** 30 },
    ready: { available: 16 * 2 ** 30 },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@ready.test');
  expect(result.stderr).toContain(`skipped low: MemAvailable ${3 * 2 ** 30} bytes is under ${4 * 2 ** 30} bytes`);
});

test('tmp floor: the probe reports free /tmp bytes and inodes, and missing values make it invalid', async () => {
  const { env, events } = scenario({
    a: { available: 16 * 2 ** 30, tmpBytes: CHECK_HOST_MIN_TMP_BYTES, tmpInodes: CHECK_HOST_MIN_TMP_INODES },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  const probe = events().find((event) => event.kind === 'probe')!.script as string;
  expect(probe).toContain('df -P -B1 /tmp');
  expect(probe).toContain('df -P -i /tmp');
  expect(probe).toContain('TMP_BYTES');
  expect(probe).toContain('TMP_INODES');

  for (const missing of ['omitTmpBytes', 'omitTmpInodes'] as const) {
    const invalid = scenario({
      invalid: { available: 16 * 2 ** 30, [missing]: true },
      ready: { available: 16 * 2 ** 30 },
    });
    const admitted = await remote(invalid.env, workspace(), ['true']);
    expect(admitted.code).toBe(0);
    expect(invalid.events().find((event) => event.kind === 'run')?.address).toBe('ops@ready.test');
    expect(
      invalid
        .events()
        .filter((event) => event.kind === 'slot')
        .map((event) => event.address),
    ).not.toContain('ops@invalid.test');
  }
});

test('tmp floor: a host under the free byte floor is skipped for a ready host', async () => {
  const freeBytes = CHECK_HOST_MIN_TMP_BYTES - 1;
  const { env, events } = scenario({
    low: { available: 16 * 2 ** 30, tmpBytes: freeBytes, tmpInodes: CHECK_HOST_MIN_TMP_INODES },
    ready: { available: 16 * 2 ** 30 },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@ready.test');
  expect(result.stderr).toContain(
    `skipped low: /tmp ${freeBytes} free bytes is under ${CHECK_HOST_MIN_TMP_BYTES} required bytes`,
  );
  expect(
    events()
      .filter((event) => event.kind === 'slot')
      .map((event) => event.address),
  ).not.toContain('ops@low.test');
});

test('tmp floor: a host under the free inode floor is skipped even with enough free bytes', async () => {
  const freeInodes = CHECK_HOST_MIN_TMP_INODES - 1;
  const { env, events } = scenario({
    low: { available: 16 * 2 ** 30, tmpBytes: CHECK_HOST_MIN_TMP_BYTES + 1, tmpInodes: freeInodes },
    ready: { available: 16 * 2 ** 30 },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@ready.test');
  expect(result.stderr).toContain(
    `skipped low: /tmp ${freeInodes} free inodes is under ${CHECK_HOST_MIN_TMP_INODES} required inodes`,
  );
  expect(
    events()
      .filter((event) => event.kind === 'slot')
      .map((event) => event.address),
  ).not.toContain('ops@low.test');
});

test('tmp floor: a host at the byte and inode floors is admitted', async () => {
  const { env, events } = scenario({
    a: { available: 16 * 2 ** 30, tmpBytes: CHECK_HOST_MIN_TMP_BYTES, tmpInodes: CHECK_HOST_MIN_TMP_INODES },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@a.test');
  expect(result.stderr).not.toContain('skipped a: /tmp');
});

test('when every host is skipped for load or memory the check waits and names both reasons', async () => {
  const { env, events } = scenario({
    loaded: { available: 16 * 2 ** 30, load: 13, sliceProcessors: 8 },
    low: { available: 3 * 2 ** 30, memoryMax: 16 * 2 ** 30, memoryHeadroom: 16 * 2 ** 30 },
  });
  const waitFile = join(env.FAKE_DIR!, 'admission-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const run = startRemote(env, workspace(), ['true']);
  await waitFor(() => existsSync(waitFile) && events().filter((event) => event.kind === 'probe').length >= 2);
  run.child.kill('SIGTERM');
  const [, , stderr] = await Promise.all([run.child.exited, run.stdout, run.stderr]);

  expect(stderr).toContain('every check slot is busy; waiting for a free one');
  expect(stderr).toContain('loaded: load 13 exceeds limit 12');
  expect(stderr).toContain(`low: MemAvailable ${3 * 2 ** 30} bytes is under ${4 * 2 ** 30} bytes`);
  expect(events().some((event) => event.kind === 'slot')).toBe(false);
});

test('non-gate runs prefer any startable non-fallback host over a fallback host', async () => {
  const { env, events } = scenario({ a: { available: 8e9 }, c: { available: 8e9, fallback: true } });
  const directory = workspace();
  try {
    const result = await remote(env, directory, ['echo', 'preferred']);
    expect(result.code).toBe(0);
    expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@a.test');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a fallback host starts a non-gate run only when every non-fallback host is unable to start it', async () => {
  const { env, events } = scenario({ a: { available: 8e9, ordinaryBusy: 1 }, c: { available: 8e9, fallback: true } });
  const directory = workspace();
  try {
    const result = await remote(env, directory, ['echo', 'fallback']);
    expect(result.code).toBe(0);
    expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@c.test');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('when no host can start a non-gate run, fallback entries do not change the existing soonest-start choice', async () => {
  const { env, events } = scenario({
    a: { available: 8e9, slots: 4, ordinaryBusySlots: [0, 1] },
    c: { available: 16e9, slots: 4, ordinaryBusySlots: [0, 1], fallback: true },
  });
  const directory = workspace();
  const waitFile = join(env.FAKE_DIR!, 'soonest-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const run = startRemote(env, directory, ['echo', 'soonest'], ['--slots', '2']);
  try {
    await waitFor(() => events().some((event) => event.kind === 'multi-marker'));
    await waitFor(() => existsSync(waitFile));
    expect(events().filter((event) => event.kind === 'run')).toHaveLength(0);
    expect(events().find((event) => event.kind === 'multi-marker')?.address).toBe('ops@c.test');

    rmSync(join(env.FAKE_DIR!, 'ops_c_test.slot.1'), { recursive: true });
    await waitFor(() => events().some((event) => event.kind === 'run'));
    expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@c.test');
    expect(await run.child.exited).toBe(0);
  } finally {
    try {
      run.child.kill('SIGTERM');
    } catch {}
    await run.child.exited;
    await Promise.all([run.stdout, run.stderr]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gate runs ignore the fallback preference', async () => {
  const { env, events } = scenario({
    a: { available: 12e9, slots: 4 },
    c: { available: 12e9, slots: 4, ordinaryBusy: 1, fallback: true },
  });
  const directory = workspace();
  try {
    const result = await remote(env, directory, ['echo', 'gate'], ['--gate']);
    expect(result.code).toBe(0);
    expect(events().find((event) => event.kind === 'run')?.address).toBe('ops@a.test');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unreadable check slice memory limit falls back to MemAvailable', async () => {
  const { env, events } = scenario({
    a: {
      available: 4 * 2 ** 30,
      memoryUnreadable: true,
      cpuQuotaPercent: 800,
      processors: 16,
      load: 0,
    },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'probe')).toMatchObject({
    memoryCurrent: '-',
    memoryMaximum: '-',
    memoryHeadroom: 4 * 2 ** 30,
  });
  expect(events().find((event) => event.kind === 'run')!.address).toBe('ops@a.test');
});

test('remote admission stops stale liveness slices but preserves fresh runs and removes empty slices', async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  const result = await remote(env, workspace(), ['true']);
  expect(result.code).toBe(0);
  const admission = events().find((event) => event.kind === 'slot')!.script as string;
  expect(admission).toContain('age="$((now - touched))"');
  expect(admission).toContain('[ "$age" -gt 600 ]');
  expect(admission).toContain('systemctl stop "$run_slice"');
  expect(admission).toContain('remote-check: stopped stale run');
  expect(admission).toContain('TasksCurrent');
  expect(admission).toContain('[ "$tasks" = 0 ]');
  const run = events().find((event) => event.kind === 'run')!.script as string;
  expect(run).toContain('.alive');
});

test('a run whose client stops renewing liveness is stopped by the next host run with its containers', async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  expect((await remote(env, workspace(), ['true'])).code).toBe(0);
  const slot = events().find((event) => event.kind === 'slot')!.script as string;
  expect(slot).toContain('age="$((now - touched))"');
  expect(slot).toContain('[ "$age" -gt 600 ]');
  expect(slot).toContain('systemctl stop "$run_slice"');
  expect(slot).toContain('docker ps -aq --filter "label=rezics.check.run=$run_id"');
  expect(slot).toContain('remote-check: stopped stale run $run_id (alive file age $age s)');
});

test('a run whose client remains alive is preserved by another host run within its deadline', async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  expect((await remote(env, workspace(), ['true'])).code).toBe(0);
  const run = events().find((event) => event.kind === 'run')!.script as string;
  const slot = events().find((event) => event.kind === 'slot')!.script as string;
  expect(run).toContain('.alive');
  expect(slot).toContain('if [ "$age" -gt 600 ]; then');
  expect(run).not.toContain('systemctl stop "$run_slice"');
});

test('an empty leftover run slice is removed by the next host run', async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  expect((await remote(env, workspace(), ['true'])).code).toBe(0);
  const slot = events().find((event) => event.kind === 'slot')!.script as string;
  expect(slot).toContain('systemctl list-units --all --type=slice');
  expect(slot).toContain('systemctl show --property=TasksCurrent --value "$unit"');
  expect(slot).toContain('[ "$tasks" = 0 ]');
  expect(slot).toContain('systemctl stop "$unit"');
});

test('a run that reaches its deadline stops its slice and returns a distinct deadline code', async () => {
  const { env } = scenario({ a: { available: 8e9, hang: true } });
  const result = await remote(env, workspace(), ['true'], ['--max-ms', '25']);
  expect(result.code).toBe(124);
  expect(result.stderr).toContain('remote-check: deadline reached after 25 ms');
});

test('deadline, command failure and transport failure keep distinct exit codes', async () => {
  const commandFailure = scenario({ a: { available: 8e9, exit: 7 } });
  expect((await remote(commandFailure.env, workspace(), ['true'])).code).toBe(7);

  const transportFailure = scenario({ a: { available: 8e9, transportFailures: 1 } });
  expect((await remote(transportFailure.env, workspace(), ['true'])).code).toBe(75);

  const deadline = scenario({ a: { available: 8e9, hang: true } });
  expect((await remote(deadline.env, workspace(), ['true'], ['--max-ms', '25'])).code).toBe(124);
});

test("the remote run's output streams back and its exit code becomes the local exit code", async () => {
  const { env, events } = scenario({
    a: { available: 8e9, exit: 7, stdout: 'remote says hello', stderr: 'remote complains' },
  });
  const directory = workspace();
  const result = await remote(env, directory, ['bun', 'test'], ['--cwd', 'src']);

  expect(result.code).toBe(7);
  expect(result.stdout).toContain('remote says hello');
  expect(result.stderr).toContain('remote complains');
  const seen = events();
  const script = seen.find((event) => event.kind === 'run')!.script as string;
  expect(script).toMatch(/\/srv\/rezics-check\/runs\/[a-z0-9-]+/);
  expect(script).toContain('src bun test');
  const files = (seen.find((event) => event.kind === 'rsync')!.files as string[]).sort();
  expect(files).toEqual(['.gitignore', 'src/tracked.ts', 'src/untracked.ts']);
  const cleanup = seen.find((event) => event.kind === 'cleanup')!.script as string;
  expect(cleanup).toContain('rm -rf');
  expect(cleanup).toMatch(/\/srv\/rezics-check\/runs\/[a-z0-9-]+/);
});

test("a remote run whose connection drops before the command's exit status arrives ends with the transport failure code", async () => {
  const { env, events } = scenario({ a: { available: 8e9, transportFailures: 1 } });
  const result = await remote(env, workspace());

  expect(result.code).toBe(75);
  expect(result.stderr).toContain('connection to a failed during remote command before a result');
  expect(events().filter((event) => event.kind === 'status')).toHaveLength(1);
});

test('a remote command that itself exits 255 keeps its exit code', async () => {
  const { env, events } = scenario({ a: { available: 8e9, exit: 255 } });
  const result = await remote(env, workspace());

  expect(result.code).toBe(255);
  expect(result.stderr).not.toContain('before a result');
  expect(events().filter((event) => event.kind === 'status')).toHaveLength(1);
});

test('rsync connection errors retry on another host before the command runs', async () => {
  for (const exit of [10, 12, 30, 35, 255]) {
    const { env, events } = scenario({
      a: { available: 8e9, rsyncFailures: 1, rsyncFailureCode: exit },
      b: { available: 8e9 },
    });
    env.REMOTE_CHECK_POLL_MS = '1';
    env.REMOTE_CHECK_RETRY_BACKOFF_MS = '1';
    const result = await remote(env, workspace(), ['true']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`retrying transport failure on a with code ${exit}`);
    expect(
      events()
        .filter((event) => event.kind === 'run')
        .map((event) => event.address),
    ).toEqual(['ops@b.test']);
  }
});

test('an upload with vanished source files runs and reports the vanished count', async () => {
  const { env, events } = scenario({
    a: { available: 8e9, rsyncExit: 24, vanishedFiles: ['src/one.ts', 'src/two.ts'] },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  expect(result.stderr).toContain('remote-check: rsync to a: 2 files vanished during transfer');
  expect(events().filter((event) => event.kind === 'run')).toHaveLength(1);
});

test('the workspace upload compresses with zstd and sends only what differs from the host base tree', async () => {
  const { env, events } = scenario({
    a: { available: 8e9, base: '/srv/rezics-check/bases/base-one', baseAgeSeconds: 60 },
  });
  const directory = workspace();
  const result = await remote(env, directory, ['true']);

  expect(result.code).toBe(0);
  const upload = events().find((event) => event.kind === 'rsync')!;
  const args = upload.args as string[];
  expect(args).toContain('--compress-choice=zstd');
  expect(args).toContain('--compress-level=3');
  expect(args).toContain('--checksum');
  expect(args).toContain('--copy-dest=/srv/rezics-check/bases/current');
  expect(args).toContain('--stats');
  expect(result.stderr).toContain('remote-check: rsync 0.');
  expect(result.stderr).toContain('1234 bytes sent');
});

test("a host without zstd support uses rsync's default compression", async () => {
  const { env, events } = scenario({ a: { available: 8e9, zstd: false } });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  const args = events().find((event) => event.kind === 'rsync')!.args as string[];
  expect(args).toContain('--compress');
  expect(args).not.toContain('--compress-choice=zstd');
  expect(result.stderr).toContain('rsync zstd unavailable on a; using default compression');
});

test("a run whose upload finds no base on the host uploads the whole workspace and the run sees exactly the workspace's files", async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  const directory = workspace();
  const expected = workspaceFiles(directory).sort();
  const result = await remote(env, directory, ['true']);

  expect(result.code).toBe(0);
  const seen = events();
  const upload = seen.find((event) => event.kind === 'rsync')!;
  const args = upload.args as string[];
  expect(args).not.toContain('--checksum');
  expect(args.some((argument) => argument.startsWith('--copy-dest='))).toBe(false);
  expect((upload.files as string[]).sort()).toEqual(expected);
  expect(seen.find((event) => event.kind === 'run')!.script).toContain('"$bun" install --frozen-lockfile');
  expect(seen.find((event) => event.kind === 'run')!.script).toContain('REMOTE_CHECK_BASE_REFRESH');
});

test('after a successful upload the host refreshes an old base atomically without disturbing a run that reads it', async () => {
  const { env, events } = scenario({
    a: { available: 8e9, base: '/srv/rezics-check/bases/base-old', baseAgeSeconds: BASE_REFRESH_INTERVAL_SECONDS + 1 },
  });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  const seen = events();
  const upload = seen.find((event) => event.kind === 'rsync')!;
  const args = upload.args as string[];
  expect(args).toContain('--rsync-path=flock -s /srv/rezics-check/bases/.lock rsync');
  const refresh = seen.find((event) => event.kind === 'run')!.script as string;
  expect(refresh).toContain(`-ge ${BASE_REFRESH_INTERVAL_SECONDS}`);
  expect(refresh).toContain('flock -x 9');
  expect(refresh).toContain('cp -a');
  expect(refresh).toContain('mv -Tf');
  expect(refresh.indexOf('REMOTE_CHECK_BASE_REFRESH')).toBeLessThan(refresh.indexOf('systemd-run'));
});

test('bases older than the retention period are removed by host cleanup while the current base is kept', async () => {
  const { env, events } = scenario({ a: { available: 8e9 } });
  await remote(env, workspace(), ['true']);

  const slot = events().find((event) => event.kind === 'slot' && event.granted === true)!;
  const cleanup = slot.script as string;
  expect(cleanup).toContain(`mmin +${BASE_RETENTION_SECONDS / 60}`);
  expect(cleanup).toContain('current=$(readlink -f /srv/rezics-check/bases/current');
  expect(cleanup).toContain('[ "$base" = "$current" ] && continue');
  expect(cleanup).toContain('flock -x 9');
});

test('an rsync exit 24 completes the upload and changing build outputs stay out of the upload', async () => {
  const { env, events } = scenario({ a: { available: 8e9, rsyncExit: 24 } });
  const directory = workspace();
  mkdirSync(join(directory, 'dist'), { recursive: true });
  mkdirSync(join(directory, '.next/cache'), { recursive: true });
  mkdirSync(join(directory, 'build'), { recursive: true });
  writeFileSync(join(directory, 'dist/output.js'), 'generated');
  writeFileSync(join(directory, '.next/cache/data'), 'generated');
  writeFileSync(join(directory, 'build/intermediate'), 'generated');

  const result = await remote(env, directory, ['true']);

  expect(result.code).toBe(0);
  expect(events().filter((event) => event.kind === 'run')).toHaveLength(1);
  const files = events().find((event) => event.kind === 'rsync')!.files as string[];
  expect(files).not.toContain('dist/output.js');
  expect(files).not.toContain('.next/cache/data');
  expect(files).not.toContain('build/intermediate');
});

test('pre-command SSH and rsync transport failures retry with backoff on another host', async () => {
  const retryCases = [10, 12, 30, 35].map((code) => {
    const { env, events } = scenario({
      a: { available: 8e9, rsyncFailures: 1, rsyncFailureCode: code },
      b: { available: 8e9 },
    });
    env.REMOTE_CHECK_POLL_MS = '1';
    env.REMOTE_CHECK_RETRY_BACKOFF_MS = '1';
    const result = remote(env, workspace(), ['true']);
    return { code, env, events, result };
  });
  const ssh = scenario({
    a: { available: 8e9, preCommandFailures: 1 },
    b: { available: 8e9 },
  });
  ssh.env.REMOTE_CHECK_POLL_MS = '1';
  ssh.env.REMOTE_CHECK_RETRY_BACKOFF_MS = '1';
  const sshResult = remote(ssh.env, workspace(), ['true']);
  const exhausted = scenario({ a: { available: 8e9, rsyncFailures: 5, rsyncFailureCode: 30 } });
  exhausted.env.REMOTE_CHECK_POLL_MS = '1';
  exhausted.env.REMOTE_CHECK_RETRY_BACKOFF_MS = '1';
  const exhaustedResult = remote(exhausted.env, workspace(), ['true']);
  await Promise.all([...retryCases.map(({ result }) => result), sshResult, exhaustedResult]);

  for (const { code, events, result: resultPromise } of retryCases) {
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(
      events()
        .filter((event) => event.kind === 'rsync')
        .map((event) => event.destination),
    ).toEqual([expect.stringContaining('ops@a.test:'), expect.stringContaining('ops@b.test:')]);
    expect(result.stderr).toContain(`retrying transport failure on a with code ${code}`);
    expect(
      events()
        .filter((event) => event.kind === 'run')
        .map((event) => event.address),
    ).toEqual(['ops@b.test']);
  }

  const result = await sshResult;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('retrying transport failure on a with code 255');
  expect(
    ssh
      .events()
      .filter((event) => event.kind === 'run')
      .map((event) => event.address),
  ).toEqual(['ops@b.test']);

  const failed = await exhaustedResult;
  expect(failed.code).toBe(75);
  expect(exhausted.events().filter((event) => event.kind === 'rsync')).toHaveLength(3);
  expect(failed.stderr.match(/retrying transport failure on a with code 30/g)).toHaveLength(2);
  expect(exhausted.events().filter((event) => event.kind === 'run')).toHaveLength(0);
});

test('a host with no free slot is skipped and with none free the check waits', async () => {
  const skipped = scenario({ a: { available: 4.5e9 }, b: { available: 30e9, busy: 1000 } });
  const first = await remote(skipped.env, workspace());
  expect(first.code).toBe(0);
  expect(first.stderr).not.toContain('waiting');
  const seen = skipped.events();
  expect(seen.find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@a.test:');
  expect(
    seen
      .filter((event) => event.kind === 'slot' && event.address === 'ops@b.test')
      .map(({ kind, granted }) => ({ kind, granted })),
  ).toEqual([{ kind: 'slot', granted: false }]);

  const waiting = scenario({ a: { available: 4.5e9, busy: 3 }, b: { available: 30e9, busy: 3 } });
  const second = await remote(waiting.env, workspace());
  expect(second.code).toBe(0);
  expect(second.stderr.match(/waiting/gi)?.length).toBe(1);
  const waited = waiting.events();
  expect(waited.filter((event) => event.kind === 'slot' && event.granted === false).length).toBe(6);
  expect(waited.filter((event) => event.kind === 'run').length).toBe(1);
});

test('a host that cannot be reached is skipped', async () => {
  const { env, events } = scenario({ a: { available: 4.5e9 }, b: { down: true } });
  const result = await remote(env, workspace());
  expect(result.code).toBe(0);
  expect(events().find((event) => event.kind === 'rsync')!.destination).toStartWith('ops@a.test:');
});

test('all ssh and rsync connections to a host share one control master', async () => {
  const { env, events } = scenario({ a: { available: 4.5e9, exit: 255, present: ['result.txt'] } });
  expect(controlSocketDirectoryPath(undefined, 124)).toBe('/tmp/rezics-ssh-124');
  expect(controlSocketDirectoryPath(undefined, undefined, 124)).toBe('/tmp/rezics-ssh-124');
  expect(controlSocketDirectoryPath(env.XDG_RUNTIME_DIR, 124)).toBe(join(env.XDG_RUNTIME_DIR!, 'rezics-ssh'));
  const result = await remote(env, workspace(), ['true'], ['--returns', 'result.txt']);
  expect(result.code).toBe(255);

  const sshEvents = events().filter((event) => event.kind !== 'rsync');
  const expectedControlPath = `ControlPath=${env.XDG_RUNTIME_DIR}/rezics-ssh/%C`;
  expect(sshEvents.map((event) => event.kind)).toEqual([
    'probe',
    'slot',
    'run',
    'status',
    'returns',
    'cleanup',
    'release',
  ]);
  for (const event of sshEvents) {
    const options = event.options as string[];
    expect(options).toContain('ControlMaster=auto');
    expect(options).toContain('ControlPersist=10m');
    expect(options.filter((option) => option.startsWith('ControlPath='))).toEqual([expectedControlPath]);
  }

  const rsyncEvents = events().filter((event) => event.kind === 'rsync');
  expect(rsyncEvents).toHaveLength(2);
  for (const event of rsyncEvents) {
    expect(event.rsh as string).toContain('ControlMaster=auto');
    expect(event.rsh as string).toContain('ControlPersist=10m');
    expect(event.rsh as string).toContain(expectedControlPath);
  }

  const controlDirectory = join(env.XDG_RUNTIME_DIR!, 'rezics-ssh');
  expect(statSync(controlDirectory).mode & 0o777).toBe(0o700);
  await remote(env, workspace(), ['true']);
  const repeated = events()
    .filter((event) => event.kind === 'probe')
    .at(-1)!;
  expect((repeated.options as string[]).filter((option) => option.startsWith('ControlPath='))).toEqual([
    expectedControlPath,
  ]);
});

test('a control master session refusal falls back to its own connection', async () => {
  const { env, events } = scenario({ a: { available: 4.5e9, refuseControlSession: true } });
  const result = await remote(env, workspace(), ['true']);

  expect(result.code).toBe(0);
  const seen = events();
  const probe = seen.find((event) => event.kind === 'probe')!;
  const refusedAt = seen.findIndex((event) => event.kind === 'master-session-refused');
  const fallbackAt = seen.findIndex((event) => event.kind === 'standalone-fallback');
  expect(probe.transport).toBe('control-master');
  expect(refusedAt).toBeGreaterThan(seen.indexOf(probe));
  expect(fallbackAt).toBeGreaterThan(refusedAt);
  expect(seen.find((event) => event.kind === 'run')!.transport).toBe('standalone-fallback');
  expect(seen.find((event) => event.kind === 'cleanup')!.transport).toBe('standalone-fallback');
});

function provisionScenario(existing?: string) {
  const directory = mkdtempSync(join(root, 'provision-'));
  const bin = join(directory, 'bin');
  const config = join(directory, '90-rezics-checks.conf');
  const log = join(directory, 'events.jsonl');
  mkdirSync(bin);
  mkdirSync(join(directory, 'work'));
  const identity = join(directory, 'identity');
  writeFileSync(identity, 'fake identity');
  if (existing !== undefined) writeFileSync(config, existing);
  const commands = {
    ssh: `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const source = await Bun.stdin.text();
writeFileSync(process.env.PROVISION_RECEIVED!, source);
const start = source.indexOf('if [ "$loopback" -eq 1 ]; then');
const end = source.indexOf('\\necho "chromium', start);
const block = source.slice(start, end).replace('sshd_config_dir=/etc/ssh/sshd_config.d', 'sshd_config_dir=$PROVISION_DIRECTORY');
const args = process.argv.slice(2);
const destination = args.findIndex((arg) => /^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(arg));
if (destination < 0) throw new Error('expected ssh destination');
const remoteCommand = args.slice(destination + 1).join(' ');
const testRemoteScript = [
  'set -euo pipefail',
  'bun_version=$1',
  'node_version=$2',
  'memory=$3',
  'cpu=$4',
  'playwright_version=$5',
  'penalty_exemptions=\${6-}',
  'loopback=\${7-0}',
  'sshd_service=sshd.service',
  block,
].join('\\n');
const result = spawnSync('bash', ['-c', remoteCommand], { env: process.env, input: testRemoteScript, encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
    sshd: `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.PROVISION_LOG!, JSON.stringify({ command: 'sshd', args: process.argv.slice(2), config: readFileSync(process.env.PROVISION_CONFIG!, 'utf8') }) + '\\n');
process.exit(Number(process.env.PROVISION_VALIDATION_EXIT ?? 0));
`,
    systemctl: `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PROVISION_LOG!, JSON.stringify({ command: 'systemctl', args: process.argv.slice(2) }) + '\\n');
`,
  };
  for (const [name, source] of Object.entries(commands)) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const received = join(directory, 'received');
  return {
    config,
    received,
    events: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    run: (exemptions?: string, validationExit = 0) =>
      spawnSync(
        'bash',
        [
          join(repository, 'scripts/provision-check-host.sh'),
          'root@check.test',
          identity,
          '16',
          '800',
          ...(exemptions === undefined ? [] : [exemptions]),
        ],
        {
          cwd: repository,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            PROVISION_DIRECTORY: directory,
            PROVISION_CONFIG: config,
            PROVISION_LOG: log,
            PROVISION_RECEIVED: received,
            PROVISION_VALIDATION_EXIT: String(validationExit),
            work: join(directory, 'work'),
          },
          encoding: 'utf8',
          timeout: 20_000,
        },
      ),
  };
}

test('provision-check-host installs and validates the sshd limits before reloading sshd', () => {
  const identity = join(root, 'provision-identity');
  const bin = join(root, 'provision-bin');
  const received = join(root, 'provision-remote-script');
  mkdirSync(bin, { recursive: true });
  writeFileSync(identity, 'fake identity');
  const ssh = join(bin, 'ssh');
  writeFileSync(
    ssh,
    `#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const destination = args.findIndex((arg) => /^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(arg));
if (destination < 0) throw new Error('expected ssh destination');
const remoteCommand = args.slice(destination + 1).join(' ');
const source = await Bun.stdin.text();
const result = spawnSync('/bin/bash', ['-c', remoteCommand], {
  env: { ...process.env, PATH: process.env.PROVISION_BIN + ':' + process.env.PATH },
  input: source,
  encoding: 'utf8',
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
`,
  );
  chmodSync(ssh, 0o755);
  const remoteBash = join(bin, 'bash');
  writeFileSync(
    remoteBash,
    `#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '-s') {
  writeFileSync(process.env.PROVISION_SCRIPT_FILE!, await Bun.stdin.text());
  process.exit(0);
}
const result = spawnSync('/bin/bash', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
  );
  chmodSync(remoteBash, 0o755);
  const result = spawnSync(
    '/bin/bash',
    [join(repository, 'scripts/provision-check-host.sh'), 'root@check.test', identity, '16', '800'],
    {
      cwd: repository,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROVISION_BIN: bin, PROVISION_SCRIPT_FILE: received },
      encoding: 'utf8',
      timeout: 20_000,
    },
  );

  expect(result.status).toBe(0);
  const sent = readFileSync(received, 'utf8');
  expect(sent).toContain('sshd_dropin=$sshd_config_dir/90-rezics-checks.conf');
  expect(sent).toContain("sshd_wanted=$(printf 'MaxStartups 100:30:300\\nMaxSessions 64')");
  expect(sent).toContain('sshd_candidate=$(mktemp "$sshd_config_dir/.90-rezics-checks.XXXXXX")');
  expect(sent).toContain('if sshd -t; then');
  const validationStart = sent.indexOf('if sshd -t; then');
  const validationElse = sent.indexOf('\n  else\n', validationStart);
  const validationEnd = sent.indexOf('\n  fi\n', validationElse);
  expect(validationElse).toBeGreaterThan(validationStart);
  expect(validationEnd).toBeGreaterThan(validationElse);
  expect(sent.slice(validationStart, validationElse)).toContain('systemctl reload "$sshd_service"');
  expect(sent.slice(validationElse, validationEnd)).not.toContain('systemctl reload "$sshd_service"');
  expect(sent).toContain('sshd configuration validation failed; sshd was not reloaded');
});

test('provision-check-host removes and reports the old shared runtime transpiler caches', () => {
  const fixture = provisionScenario();
  expect(fixture.run().status).toBe(0);

  const sent = readFileSync(fixture.received, 'utf8');
  expect(sent).toContain('/root/.bun/install/cache/@t@');
  expect(sent).toContain('/srv/rezics-check/bun-cache/@t@');
  expect(sent).toContain('rm -rf -- "$cache"');
  expect(sent).toContain('removed legacy Bun runtime transpiler caches (if present)');
  expect(sent.indexOf('legacy_transpiler_caches=')).toBeLessThan(sent.indexOf('bun x "playwright@'));
});

test('provision-check-host writes the whole sshd drop-in with the penalty exemptions it is given', () => {
  const previous = 'MaxStartups 10:30:100\nPerSourcePenaltyExemptList 192.0.2.0/24\n# obsolete\n';
  const fixture = provisionScenario(previous);
  const exemptions = '192.0.2.1/32,2001:db8::/32';
  const wanted = `MaxStartups 100:30:300\nMaxSessions 64\nPerSourcePenaltyExemptList ${exemptions}\n`;
  expect(fixture.run(exemptions).status).toBe(0);
  expect(readFileSync(fixture.config, 'utf8')).toBe(wanted);
  expect(statSync(fixture.config).mode & 0o777).toBe(0o644);
  expect(fixture.events()).toEqual([
    { command: 'sshd', args: ['-t'], config: wanted },
    { command: 'systemctl', args: ['reload', 'sshd.service'] },
  ]);
  expect(fixture.run(exemptions).status).toBe(0);
  expect(fixture.events().filter((event) => event.command === 'systemctl')).toHaveLength(1);

  writeFileSync(fixture.config, previous);
  expect(fixture.run(exemptions, 1).status).toBe(1);
  expect(readFileSync(fixture.config, 'utf8')).toBe(previous);
  expect(fixture.events().filter((event) => event.command === 'systemctl')).toHaveLength(1);
  const absent = provisionScenario();
  expect(absent.run(exemptions, 1).status).toBe(1);
  expect(existsSync(absent.config)).toBe(false);
});

test('provision-check-host keeps an existing penalty exemption list when it is given none', () => {
  const exemptionLine = '\tPeRsOuRcEpEnAlTyExEmPtLiSt  192.0.2.0/24,2001:db8::/32 # access\t';
  const fixture = provisionScenario(`MaxStartups 10:30:100\n${exemptionLine}\n# obsolete\n`);
  const wanted = `MaxStartups 100:30:300\nMaxSessions 64\n${exemptionLine}\n`;
  expect(fixture.run().status).toBe(0);
  expect(readFileSync(fixture.config, 'utf8')).toBe(wanted);
  expect(fixture.events()).toEqual([
    { command: 'sshd', args: ['-t'], config: wanted },
    { command: 'systemctl', args: ['reload', 'sshd.service'] },
  ]);
  expect(fixture.run().status).toBe(0);
  expect(fixture.events().filter((event) => event.command === 'systemctl')).toHaveLength(1);

  const absent = provisionScenario();
  expect(absent.run().status).toBe(0);
  expect(readFileSync(absent.config, 'utf8')).toBe('MaxStartups 100:30:300\nMaxSessions 64\n');
});

test('provision-check-host validates every penalty exemption CIDR before connecting', () => {
  for (const exemptions of [
    '',
    '192.0.2.0',
    '192.0.2.256/24',
    '192.0.02.0/24',
    '192.0.2.0/33',
    '192.0.2.0/-1',
    '2001:db8::/129',
    '2001:db8::/x',
    '2001:db8:::1/32',
    '2001::db8::1/32',
    '2001:db8/32',
    '2001:db8:0:0:0:0:0:0:1/32',
    '2001:db8::g/32',
    '::ffff:192.0.2.256/128',
    '192.0.2.0/24,',
    ',192.0.2.0/24',
    '192.0.2.0/24,,2001:db8::/32',
    '192.0.2.0/24,2001:db8::/129',
    '192.0.2.0/24\nMaxSessions 1',
    '192.0.2.0/24/1',
  ]) {
    const fixture = provisionScenario();
    const result = fixture.run(exemptions);
    expect(result.status, exemptions).toBe(2);
    expect(result.stderr).toContain('bad penalty exemption CIDR:');
    expect(existsSync(fixture.received)).toBe(false);
  }
  for (const exemptions of [
    '192.0.2.0/0',
    '192.0.2.1/32',
    '2001:db8::/0',
    '2001:db8::1/128',
    '2001:DB8:0:0:0:0:0:1/128',
    '::/128',
    '::ffff:192.0.2.1/128',
    '2001:db8:0:0:0:0:192.0.2.1/128',
  ]) {
    const fixture = provisionScenario();
    const result = fixture.run(exemptions);
    expect(result.status, `${exemptions}: ${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.config, 'utf8')).toContain(`PerSourcePenaltyExemptList ${exemptions}\n`);
  }
});

test('SIGTERM stops the run, removes its directory and releases the slot', async () => {
  const { env, events } = scenario({ a: { available: 4.5e9, hang: true } });
  const child = Bun.spawn(['bun', remoteCheck, workspace(), '--', 'bun', 'test'], {
    cwd: repository,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('started')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  expect(text).toContain('started');
  child.kill('SIGTERM');
  expect(await child.exited).toBe(143);
  const kinds = events()
    .filter((event) => event.address === 'ops@a.test')
    .map((event) => event.kind);
  expect(kinds.slice(-2)).toEqual(['cleanup', 'release']);
  expect(events().find((event) => event.kind === 'cleanup')!.script as string).toContain('systemctl stop');
});

test('containers started on a check host run under its capped cgroup slice', () => {
  const previous = process.env.KERNEL_CHECK_ON_REMOTE;
  const previousSlice = process.env.REZICS_CHECK_SLICE;
  process.env.KERNEL_CHECK_ON_REMOTE = '1';
  try {
    for (const slice of [undefined, 'rezics-check-test_run.slice']) {
      if (slice === undefined) delete process.env.REZICS_CHECK_SLICE;
      else process.env.REZICS_CHECK_SLICE = slice;
      const expected = `--cgroup-parent=${slice ?? 'rezics-check.slice'}`;
      let args: string[] = [];
      startPostgresContainer((given) => ((args = given), 'id'));
      expect(args).toContain(expected);
      const search = spawnSync(
        'bun',
        [
          '-e',
          "import { searchRunArgs } from './services/kernel/scripts/search.ts'; console.log(JSON.stringify(searchRunArgs('image')))",
        ],
        {
          cwd: repository,
          env: { ...process.env, KERNEL_CHECK_ON_REMOTE: '1' },
          encoding: 'utf8',
        },
      );
      expect(JSON.parse(search.stdout) as string[]).toContain(expected);
    }
  } finally {
    if (previous === undefined) delete process.env.KERNEL_CHECK_ON_REMOTE;
    else process.env.KERNEL_CHECK_ON_REMOTE = previous;
    if (previousSlice === undefined) delete process.env.REZICS_CHECK_SLICE;
    else process.env.REZICS_CHECK_SLICE = previousSlice;
  }
});

test('a remote run takes all requested slots in one session on one host and releases them all', async () => {
  // a and b each have room for one legacy slot reservation; c is reachable after three injected take failures.
  const { env, events } = scenario({
    a: { available: 4.5e9, memoryMax: 4 * 2 ** 30, memoryMaxGiB: 4, slots: 4 },
    b: { available: 4.5e9, memoryMax: 4 * 2 ** 30, memoryMaxGiB: 4, slots: 4 },
    c: { available: 30e9, memoryMax: 30 * 2 ** 30, memoryMaxGiB: 30, slots: 4, busy: 3 },
  });
  const result = await remote(env, workspace(), ['bun', 'test'], ['--slots', '2']);
  expect(result.code).toBe(0);

  const seen = events();
  const on = (host: string) => seen.filter((event) => event.address === `ops@${host}.test`);
  // b and a cannot serve this run; c takes both slots in one SSH session after its injected busy responses.
  expect(on('b').filter((event) => event.kind === 'slot')).toEqual([]);
  expect(on('c').filter((event) => event.kind === 'reservation')).toHaveLength(0);
  expect(on('c').filter((event) => event.kind === 'slot' && event.granted === false)).toHaveLength(3);
  expect(on('c').filter((event) => event.kind === 'slot' && event.granted === true)).toHaveLength(2);
  // c holds both slots for the whole run and drops them after the run directory is removed.
  const kinds = on('c').map((event) => event.kind);
  expect(
    on('c')
      .filter((event) => event.kind === 'slot')
      .map((event) => event.granted),
  ).toEqual([false, false, false, true, true]);
  const successfulTakes = on('c').filter((event) => event.kind === 'slot' && event.granted);
  expect(new Set(successfulTakes.map((event) => event.call)).size).toBe(1);
  expect(kinds.indexOf('run')).toBeGreaterThan(kinds.lastIndexOf('slot'));
  expect(kinds.slice(-3)).toEqual(['cleanup', 'release', 'release']);
  expect(seen.filter((event) => event.kind === 'run')).toHaveLength(1);

  // Without the flag a run holds one slot, and a count no host can serve is refused rather than waited for.
  const single = scenario({ a: { available: 4.5e9 } });
  expect((await remote(single.env, workspace())).code).toBe(0);
  expect(single.events().filter((event) => event.kind === 'slot')).toHaveLength(1);
  const tooMany = scenario({ a: { available: 4.5e9 } });
  const refused = await remote(tooMany.env, workspace(), ['bun', 'test'], ['--slots', '3']);
  expect(refused.code).toBe(64);
  expect(refused.stderr).toContain("lower the run's concurrency to match");
  expect(tooMany.events().some((event) => event.kind === 'slot')).toBe(false);
});

test('a multi-slot reservation blocks new runs when existing work already fills its remainder', async () => {
  const { env, events } = scenario({
    a: { available: 0, slots: 4, cpuQuotaPercent: 800 },
    b: {
      available: 20e9,
      memoryMax: 6 * 2 ** 30,
      memoryMaxGiB: 6,
      slots: 4,
      cpuQuotaPercent: 800,
      hang: true,
      hangRuns: 1,
    },
  });
  const waitFile = join(env.FAKE_DIR!, 'multi-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const first = startRemote(env, workspace(), ['sleep', '120']);
  let multi: ReturnType<typeof startRemote> | undefined;
  let laterSingle: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run' && event.address === 'ops@b.test'));
    multi = startRemote(env, workspace(), ['true'], ['--slots', '2']);
    await waitFor(() => existsSync(waitFile));
    await waitFor(() => events().some((event) => event.kind === 'multi-marker'));
    const multiMarker = events().find((event) => event.kind === 'multi-marker')!;
    expect(multiMarker.slots).toBe(2);

    const singleWaitFile = join(env.FAKE_DIR!, 'single-wait-ms');
    laterSingle = startRemote({ ...env, GOAL_CHECK_WAIT_FILE: singleWaitFile }, workspace(), ['true']);
    await waitFor(() => existsSync(singleWaitFile));
    await waitFor(() => events().some((event) => event.kind === 'probe' && event.multiWaitingId === multiMarker.id));
    expect(events().filter((event) => event.kind === 'run' && event.address === 'ops@b.test')).toHaveLength(1);
    expect(
      events().filter((event) => event.kind === 'slot' && event.address === 'ops@b.test' && event.granted),
    ).toHaveLength(1);

    first.child.kill('SIGTERM');
    await first.child.exited;
    expect(await multi.child.exited).toBe(0);
    expect(await laterSingle.child.exited).toBe(0);
    const onB = events().filter((event) => event.address === 'ops@b.test');
    expect(onB.filter((event) => event.kind === 'run')).toHaveLength(3);
    expect(onB.some((event) => event.kind === 'multi-marker-release' && event.id === multiMarker.id)).toBe(true);
  } finally {
    for (const run of [laterSingle, multi, first]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('while a multi-slot run waits for a host, runs there use only the slots it leaves free', async () => {
  const { env, events } = scenario({
    b: {
      available: 20e9,
      memoryHeadroom: 20e9,
      slots: 6,
      cpuQuotaPercent: 1200,
      hang: true,
      hangRuns: 4,
    },
  });
  const workspaceDirectory = workspace();
  let multi: ReturnType<typeof startRemote> | undefined;
  const singles: ReturnType<typeof startRemote>[] = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      singles.push(startRemote(env, workspaceDirectory, ['sh', '-c', `echo single-${index}`]));
    }
    await waitFor(
      () => events().filter((event) => event.kind === 'run' && /echo single-/.test(String(event.script))).length === 4,
    );
    multi = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo multi-run'], ['--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'multi-marker'));
    const blockedSingle = startRemote(
      { ...env, GOAL_CHECK_WAIT_FILE: join(env.FAKE_DIR!, 'blocked-single-wait-ms') },
      workspaceDirectory,
      ['sh', '-c', 'echo blocked-single'],
    );
    singles.push(blockedSingle);
    await waitFor(() => existsSync(join(env.FAKE_DIR!, 'blocked-single-wait-ms')));
    expect(events().some((event) => event.kind === 'run' && String(event.script).includes('echo blocked-single'))).toBe(
      false,
    );
    expect(events().some((event) => event.kind === 'run' && String(event.script).includes('echo multi-run'))).toBe(
      false,
    );

    singles[0]!.child.kill('SIGTERM');
    await singles[0]!.child.exited;
    singles[1]!.child.kill('SIGTERM');
    await singles[1]!.child.exited;
    await waitFor(() =>
      events().some((event) => event.kind === 'run' && String(event.script).includes('echo multi-run')),
    );
    expect(await multi.child.exited).toBe(0);
    expect(events().filter((event) => event.kind === 'run' && /echo single-/.test(String(event.script)))).toHaveLength(
      4,
    );
    expect(events().some((event) => event.kind === 'run' && String(event.script).includes('echo blocked-single'))).toBe(
      false,
    );
  } finally {
    for (const run of [...singles, multi]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
    }
    for (const run of [...singles, multi]) {
      if (!run) continue;
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('a multi-slot waiter that stops waiting releases its reservation', async () => {
  const { env, events } = scenario({
    a: {
      available: 20e9,
      memoryMax: 6 * 2 ** 30,
      memoryMaxGiB: 6,
      slots: 4,
      hang: true,
      hangRuns: 1,
    },
  });
  const waitFile = join(env.FAKE_DIR!, 'multi-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const first = startRemote(env, workspace(), ['sleep', '120']);
  let multi: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run'));
    multi = startRemote(env, workspace(), ['true'], ['--slots', '2']);
    await waitFor(() => existsSync(waitFile));
    await waitFor(() => events().some((event) => event.kind === 'multi-marker'));
    const waiting = events();
    expect(waiting.filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(1);
    expect(waiting.filter((event) => event.kind === 'slot' && event.requested === 2)).toHaveLength(0);
    expect(waiting.filter((event) => event.kind === 'multi-marker')).toHaveLength(1);
    multi.child.kill('SIGTERM');
    expect(await multi.child.exited).toBe(143);
    await waitFor(() => events().some((event) => event.kind === 'multi-marker-release'));
    expect(events().filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(1);
    expect(readdirSync(env.FAKE_DIR!).filter((name) => name.includes('.multi-marker.'))).toHaveLength(0);
    first.child.kill('SIGTERM');
    await first.child.exited;
  } finally {
    for (const run of [multi, first]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('a waiting gate keeps priority over a waiting multi-slot run on the same host', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 4, hang: true, hangRuns: 1 } });
  const workspaceDirectory = workspace();
  const holder = startRemote(env, workspaceDirectory, ['true'], ['--slots', '2']);
  let gate: ReturnType<typeof startRemote> | undefined;
  let multi: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'run'));
    gate = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo gate-run'], ['--gate', '--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'gate-marker'));
    multi = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo multi-run'], ['--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'multi-marker'));
    await waitFor(() =>
      events().some((event) => event.kind === 'probe' && event.gateWaiting && event.multiWaitingSlots === 2),
    );
    expect(events().filter((event) => event.kind === 'run')).toHaveLength(1);

    holder.child.kill('SIGTERM');
    await holder.child.exited;
    await waitFor(
      () =>
        events().some((event) => event.kind === 'run' && String(event.script).includes('echo gate-run')) &&
        events().some((event) => event.kind === 'run' && String(event.script).includes('echo multi-run')),
    );
    const started = events()
      .filter((event) => event.kind === 'run' && /echo (?:gate|multi)-run/.test(String(event.script)))
      .map((event) => (String(event.script).includes('echo gate-run') ? 'gate' : 'multi'));
    expect(started).toEqual(['gate', 'multi']);
    expect(await gate.child.exited).toBe(0);
    expect(await multi.child.exited).toBe(0);
  } finally {
    for (const run of [multi, gate, holder]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('multi-slot waiters on one host start in the order they began waiting', async () => {
  const durationMs = 10;
  const { env, events } = scenario({
    b: {
      available: 20e9,
      memoryMax: 20 * 2 ** 30,
      memoryMaxGiB: 20,
      slots: 6,
      cpuQuotaPercent: 1200,
      runDurationMs: durationMs,
    },
  });
  const workspaceDirectory = workspace();
  const holders = [
    startRemote(env, workspaceDirectory, ['sh', '-c', 'echo holder-one'], ['--slots', '2']),
    startRemote(env, workspaceDirectory, ['sh', '-c', 'echo holder-two'], ['--slots', '2']),
  ];
  let older: ReturnType<typeof startRemote> | undefined;
  let younger: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(
      () => events().filter((event) => event.kind === 'run' && /echo holder-/.test(String(event.script))).length === 2,
    );
    const holderRuns = events().filter((event) => event.kind === 'run' && /echo holder-/.test(String(event.script)));
    const latestHolderFinish = Math.max(...holderRuns.map((event) => Number(event.fakeStartedAt) + durationMs));

    older = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo older'], ['--slots', '2']);
    await waitForCondition(() => events().filter((event) => event.kind === 'multi-marker').length === 1);
    const olderMarker = events().find((event) => event.kind === 'multi-marker')!;
    younger = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo younger'], ['--slots', '2']);
    await waitForCondition(() => events().filter((event) => event.kind === 'multi-marker').length === 2);
    const youngerMarker = events().find((event) => event.kind === 'multi-marker' && event.id !== olderMarker.id)!;
    await waitForCondition(() =>
      events().some(
        (event) => event.kind === 'probe' && event.multiWaitingId === olderMarker.id && event.multiWaitingSlots === 2,
      ),
    );

    writeFileSync(join(env.FAKE_DIR!, 'clock'), String(latestHolderFinish));
    await waitForCondition(
      () =>
        events().some((event) => event.kind === 'run' && String(event.script).includes('echo older')) &&
        events().some((event) => event.kind === 'run' && String(event.script).includes('echo younger')),
    );
    const grantedWaiterOrder = events()
      .filter((event) => event.kind === 'slot' && event.granted && event.requested === 2)
      .map((event) => String(event.script).match(/# REMOTE_CHECK_MULTI_SLOT_WAITER_ID ([a-zA-Z0-9-]+)/)?.[1])
      .filter((id): id is string => Boolean(id) && id !== '-');
    expect([...new Set(grantedWaiterOrder.filter((id) => id === olderMarker.id || id === youngerMarker.id))]).toEqual([
      String(olderMarker.id),
      String(youngerMarker.id),
    ]);
    writeFileSync(join(env.FAKE_DIR!, 'clock'), String(latestHolderFinish + durationMs));
    await Promise.all([older.child.exited, younger.child.exited]);
  } finally {
    for (const run of [younger, older, ...holders]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
    }
    for (const run of [younger, older, ...holders]) {
      if (!run) continue;
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
}, 30_000);

test('while a gate waits for a host, runs there use only the slots the gate leaves free', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 4, hang: true, hangRuns: 1 } });
  mkdirSync(join(env.FAKE_DIR!, 'ops_b_test.gate-marker'));
  const workspaceDirectory = workspace();
  const multi = startRemote(env, workspaceDirectory, ['true'], ['--slots', '2']);
  let remainder: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().some((event) => event.kind === 'probe'));
    expect(events().some((event) => event.kind === 'run')).toBe(false);

    remainder = startRemote(env, workspaceDirectory, ['true']);
    await waitFor(() => events().some((event) => event.kind === 'run'));
    await waitFor(() => events().filter((event) => event.kind === 'probe').length >= 5);
    expect(events().filter((event) => event.kind === 'run')).toHaveLength(1);
    expect(events().filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(1);
    expect(remainder.child.exitCode).toBeNull();
    expect(multi.child.exitCode).toBeNull();
  } finally {
    for (const run of [remainder, multi]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('while a gate waits for a host, a short run may take its express slot', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 4, ordinaryBusy: 1 } });
  mkdirSync(join(env.FAKE_DIR!, 'ops_b_test.gate-marker'));
  const result = await remote(env, workspace(), ['true'], ['--estimate-ms', '120000']);
  expect(result.code).toBe(0);
  const admitted = events().find((event) => event.kind === 'slot' && event.granted)!;
  expect(admitted.slotClass).toBe('short');
  expect(admitted.slot).toBe('express');
});

test('a short run never takes an ordinary slot beyond the remainder on a gated host, whichever slot index is free', async () => {
  for (const freeSlot of [0, 1, 2, 3, 4]) {
    const { env, events } = scenario({
      b: {
        available: 20e9,
        cpuQuotaPercent: 1600,
        slots: 6,
        ordinaryBusySlots: [0, 1, 2, 3, 4].filter((index) => index !== freeSlot),
      },
    });
    mkdirSync(join(env.FAKE_DIR!, 'ops_b_test.gate-marker'));
    const result = await remote(env, workspace(), ['true'], ['--estimate-ms', '120000']);
    expect(result.code).toBe(0);
    const admitted = events().find((event) => event.kind === 'slot' && event.granted)!;
    expect(admitted).toMatchObject({ slotClass: 'short', slot: 'express' });
    expect(admitted.script).toContain('# REMOTE_CHECK_ORDINARY_ADMISSION_LIMIT 1');
  }
});

test('gates waiting on every host still drain their hosts', async () => {
  const { env, events } = scenario({
    a: { available: 20e9, slots: 4, hang: true, hangRuns: 1 },
    b: { available: 20e9, slots: 4, hang: true, hangRuns: 1 },
  });
  for (const host of ['a', 'b']) mkdirSync(join(env.FAKE_DIR!, `ops_${host}_test.gate-marker`));
  const runs = Array.from({ length: 4 }, () => startRemote(env, workspace(), ['true']));
  try {
    await waitFor(() => events().filter((event) => event.kind === 'run').length === 2);
    await waitFor(() => events().filter((event) => event.kind === 'probe').length >= 12);
    const started = events().filter((event) => event.kind === 'run');
    expect(started.map((event) => event.address).sort()).toEqual(['ops@a.test', 'ops@b.test']);
    expect(events().filter((event) => event.kind === 'slot' && event.granted)).toHaveLength(2);
  } finally {
    for (const run of runs) {
      try {
        run.child.kill('SIGTERM');
      } catch {}
    }
    for (const run of runs) {
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('a gate wait is bounded by its original slot holders with 1, 10 and 100 queued runs', async () => {
  const durationMs = 10;
  for (const queueLength of [1, 10, 100]) {
    const { env, events } = scenario({
      b: { available: 20e9, slots: 4, runDurationMs: durationMs },
    });
    env.REMOTE_CHECK_POLL_MS = '1';
    const workspaceDirectory = workspace();
    const holders = Array.from({ length: 2 }, () => startRemote(env, workspaceDirectory, ['sh', '-c', 'echo holder']));
    let gate: ReturnType<typeof startRemote> | undefined;
    const queued: ReturnType<typeof startRemote>[] = [];
    try {
      await waitFor(
        () =>
          events().filter((event) => event.kind === 'run' && String(event.script).includes('echo holder')).length === 2,
        15_000,
      );
      const originalHolders = events().filter(
        (event) => event.kind === 'run' && String(event.script).includes('echo holder'),
      );
      const latestOriginalFinish = Math.max(
        ...originalHolders.map((event) => Number(event.fakeStartedAt) + durationMs),
      );

      gate = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo gate-run'], ['--gate', '--slots', '2']);
      await waitFor(() => events().some((event) => event.kind === 'gate-marker' && event.address === 'ops@b.test'));
      const marker = events().find((event) => event.kind === 'gate-marker')!;
      const gateWaitingBeganAt = Number(marker.fakeStartedAt);
      await waitFor(() =>
        events().some((event) => event.kind === 'probe' && event.address === 'ops@b.test' && event.gateWaiting),
      );

      for (let index = 0; index < queueLength; index += 1) {
        const queueEnv = {
          ...env,
          REMOTE_CHECK_POLL_MS: '100',
          GOAL_CHECK_WAIT_FILE: join(env.FAKE_DIR!, `queued-${index}-wait-ms`),
        };
        queued.push(startRemote(queueEnv, workspaceDirectory, ['sh', '-c', 'echo queued']));
      }
      await waitFor(
        () => queued.every((_, index) => existsSync(join(env.FAKE_DIR!, `queued-${index}-wait-ms`))),
        30_000,
      );
      expect(events().filter((event) => event.kind === 'run')).toHaveLength(2);

      writeFileSync(join(env.FAKE_DIR!, 'clock'), String(latestOriginalFinish));
      await waitFor(
        () => events().some((event) => event.kind === 'run' && String(event.script).includes('echo gate-run')),
        15_000,
      );
      const gateStart = events().find(
        (event) => event.kind === 'run' && String(event.script).includes('echo gate-run'),
      )!;
      expect(Number(gateStart.fakeStartedAt)).toBeLessThanOrEqual(latestOriginalFinish);
      expect(Number(gateStart.fakeStartedAt) - gateWaitingBeganAt).toBeLessThanOrEqual(durationMs);
    } finally {
      for (const run of [...queued, gate, ...holders]) {
        if (!run) continue;
        try {
          run.child.kill('SIGTERM');
        } catch {}
      }
      for (const run of [...queued, gate, ...holders]) {
        if (!run) continue;
        await run.child.exited;
        await Promise.all([run.stdout, run.stderr]);
      }
    }
  }
});

test('a multi-slot wait is bounded by its original slot holders with 1, 10 and 100 queued single-slot runs', async () => {
  const durationMs = 10;
  for (const queueLength of [1, 10, 100]) {
    const { env, events } = scenario({
      b: { available: 20e9, slots: 4, runDurationMs: durationMs },
    });
    env.REMOTE_CHECK_POLL_MS = '1';
    const workspaceDirectory = workspace();
    const holders = Array.from({ length: 2 }, () => startRemote(env, workspaceDirectory, ['sh', '-c', 'echo holder']));
    let multi: ReturnType<typeof startRemote> | undefined;
    const queued: ReturnType<typeof startRemote>[] = [];
    try {
      await waitFor(
        () =>
          events().filter((event) => event.kind === 'run' && String(event.script).includes('echo holder')).length === 2,
        15_000,
      );
      const originalHolders = events().filter(
        (event) => event.kind === 'run' && String(event.script).includes('echo holder'),
      );
      const latestOriginalFinish = Math.max(
        ...originalHolders.map((event) => Number(event.fakeStartedAt) + durationMs),
      );

      multi = startRemote(env, workspaceDirectory, ['sh', '-c', 'echo multi-run'], ['--slots', '2']);
      await waitFor(() => events().some((event) => event.kind === 'multi-marker' && event.address === 'ops@b.test'));
      const marker = events().find((event) => event.kind === 'multi-marker')!;
      const multiWaitingBeganAt = Number(marker.fakeStartedAt);
      await waitFor(() =>
        events().some(
          (event) => event.kind === 'probe' && event.address === 'ops@b.test' && event.multiWaitingId === marker.id,
        ),
      );

      for (let index = 0; index < queueLength; index += 1) {
        const queueEnv = {
          ...env,
          REMOTE_CHECK_POLL_MS: '1',
          GOAL_CHECK_WAIT_FILE: join(env.FAKE_DIR!, `multi-queued-${index}-wait-ms`),
        };
        queued.push(startRemote(queueEnv, workspaceDirectory, ['sh', '-c', 'echo queued']));
      }
      await waitFor(
        () => queued.every((_, index) => existsSync(join(env.FAKE_DIR!, `multi-queued-${index}-wait-ms`))),
        30_000,
      );
      expect(events().filter((event) => event.kind === 'run')).toHaveLength(2);

      writeFileSync(join(env.FAKE_DIR!, 'clock'), String(latestOriginalFinish));
      await waitFor(
        () => events().some((event) => event.kind === 'run' && String(event.script).includes('echo multi-run')),
        15_000,
      );
      const multiStart = events().find(
        (event) => event.kind === 'run' && String(event.script).includes('echo multi-run'),
      )!;
      expect(Number(multiStart.fakeStartedAt)).toBeLessThanOrEqual(latestOriginalFinish);
      expect(Number(multiStart.fakeStartedAt) - multiWaitingBeganAt).toBeLessThanOrEqual(durationMs);
    } finally {
      for (const run of [...queued, multi, ...holders]) {
        if (!run) continue;
        try {
          run.child.kill('SIGTERM');
        } catch {}
      }
      for (const run of [...queued, multi, ...holders]) {
        if (!run) continue;
        await run.child.exited;
        await Promise.all([run.stdout, run.stderr]);
      }
    }
  }
}, 30_000);

test('while a gate waits for a host, single-slot runs prefer other hosts', async () => {
  const { env, events } = scenario({
    a: { available: 20e9, slots: 2, cpuQuotaPercent: 400 },
    b: {
      available: 20e9,
      slots: 6,
      memoryMax: 10 * 2 ** 30,
      memoryMaxGiB: 10,
      cpuQuotaPercent: 1200,
      hang: true,
      hangRuns: 3,
      memoryHeadroomOnHang: CHECK_SLOT_MEMORY_BYTES,
      memoryHeadroomAfterHang: 20e9,
    },
  });
  const waitFile = join(env.FAKE_DIR!, 'gate-wait-ms');
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  const holders = Array.from({ length: 3 }, () => startRemote(env, workspace(), ['sleep', '120']));
  let gateRun: ReturnType<typeof startRemote> | undefined;
  let single: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(
      () => events().filter((event) => event.kind === 'run' && event.address === 'ops@b.test').length === 3,
    );
    gateRun = startRemote(env, workspace(), ['true'], ['--gate', '--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'gate-marker' && event.address === 'ops@b.test'));
    await waitFor(() =>
      events().some((event) => event.kind === 'probe' && event.address === 'ops@b.test' && event.gateWaiting === true),
    );
    await waitFor(() => existsSync(waitFile));

    single = startRemote(env, workspace(), ['true']);
    await waitFor(() => events().some((event) => event.kind === 'run' && event.address === 'ops@a.test'));
    expect(await single.child.exited).toBe(0);
    expect(
      events().find((event) => event.kind === 'rsync' && String(event.destination).startsWith('ops@a.test:')),
    ).toBeDefined();

    gateRun.child.kill('SIGTERM');
    expect(await gateRun.child.exited).toBe(143);
    await waitFor(() =>
      events().some((event) => event.kind === 'gate-marker-release' && event.address === 'ops@b.test'),
    );
    for (const holder of holders) holder.child.kill('SIGTERM');
    await Promise.all(holders.map((holder) => holder.child.exited));
  } finally {
    for (const run of [single, gateRun, ...holders]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
});

test('a remote run reports how long it waited, synced, installed and ran', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 2 } });
  const result = await remote(env, workspace(), ['true']);
  expect(result.code).toBe(0);
  for (const phase of ['slot wait', 'rsync', 'bun install', 'command']) {
    expect(result.stderr).toMatch(new RegExp(`remote-check: ${phase} \\d+(?:\\.\\d+)? s on b`));
  }
  const script = events().find((event) => event.kind === 'run')!.script as string;
  expect(script).toContain('remote-check: run used');
});

/** Executes generated host scripts with local cgroup files and command fakes, never SSH or the real Docker daemon. */
function runFixture(systemdMode: 'systemd-259' | 'old' = 'systemd-259') {
  const directory = mkdtempSync(join(root, 'run-'));
  const bin = join(directory, 'bin');
  const pinnedBunDirectory = join(directory, 'pinned-bun');
  mkdirSync(bin);
  mkdirSync(pinnedBunDirectory);
  const source = `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const directory = process.env.RUN_FIXTURE!;
const command = process.argv[1]!.split('/').at(-1);
const args = process.argv.slice(2);
appendFileSync(directory + '/events', JSON.stringify({ command, args, slice: process.env.REZICS_CHECK_SLICE, run: process.env.REZICS_CHECK_RUN }) + '\\n');
const stateFile = directory + '/state';
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const cgroup = (slice: string) => directory + '/cgroup/rezics-check.slice/' + slice;
if (command === 'systemd-run') {
  if (args.includes('--help')) {
    if (process.env.SYSTEMD_MODE === 'systemd-259') console.log('--expand-environment');
    process.exit(0);
  }
  if (process.env.SYSTEMD_MODE === 'old' && args.some((argument) => argument.startsWith('--expand-environment'))) {
    console.error('systemd-run: unrecognized option --expand-environment=no');
    process.exit(1);
  }
  if (process.env.SYSTEMD_MODE === 'systemd-259' && !args.includes('--expand-environment=no')) {
    const start = args.indexOf('sh');
    const expanded = args.slice(start).map((argument) =>
      argument.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_reference, plain, braced) =>
        process.env[plain ?? braced] ?? '',
      ),
    );
    args.splice(start, args.length - start, ...expanded);
  }
  const path = cgroup(process.env.REZICS_CHECK_SLICE!);
  mkdirSync(path, { recursive: true });
  writeFileSync(path + '/cpu.stat', 'usage_usec 500000\\nuser_usec 400000\\nsystem_usec 100000\\n');
  writeFileSync(path + '/memory.peak', String(64 * 1048576));
  const start = args.indexOf('sh');
  const result = spawnSync(args[start]!, args.slice(start + 1), { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'systemctl') {
  if (args[0] === 'list-units') {
    for (const slice of Object.keys(state.slices ?? {})) console.log(slice + ' loaded active active');
  }
  if (args[0] === 'show') {
    if (args.includes('--property=TasksCurrent')) console.log(state.slices?.[args.at(-1)!] ?? 1);
    else console.log('/rezics-check.slice/' + args.at(-1));
  }
  if (args[0] === 'stop' && state.slices) delete state.slices[args[1]!];
  if (args[0] === 'is-active') process.exit(args.at(-1) === 'rezics-check-active-run.scope' ? 0 : 3);
} else if (command === 'date') {
  console.log(args[0] === '+%s' ? (state.now ?? Math.floor(Date.now() / 1000)) : state.ticks++ * 1000000000);
} else if (command === 'sleep') {
  appendFileSync(directory + '/sleep-pids', process.pid + '\\n');
  const increment = Number(process.env.PROGRESS_INCREMENT ?? 0);
  if (increment) {
    const path = cgroup(process.env.REZICS_CHECK_SLICE!);
    const previous = Number(readFileSync(path + '/cpu.stat', 'utf8').match(/usage_usec (\\d+)/)![1]);
    writeFileSync(path + '/cpu.stat', 'usage_usec ' + (previous + increment) + '\\n');
  }
  const waiting = spawn('/bin/sleep', args, { stdio: 'ignore' });
  process.on('SIGTERM', () => waiting.kill('SIGTERM'));
  process.on('SIGINT', () => waiting.kill('SIGINT'));
  process.exit(await new Promise<number>((resolve) => waiting.on('exit', (code) => resolve(code ?? 0))));
} else if (command === 'bun') {
  process.exit(args[0] === '--eval' ? 0 : Number(process.env.INSTALL_EXIT ?? 0));
} else if (command === 'docker') {
  if (args[0] === 'run' || args[0] === 'create' || (args[0] === 'container' && ['run', 'create'].includes(args[1]!))) {
    const id = 'container-' + state.containers.length;
    const run = args[args.indexOf('--label') + 1]?.replace('rezics.check.run=', '');
    state.containers.push({ id, run });
    state.volumes.push(id);
    const parent = args.filter((arg) => arg.startsWith('--cgroup-parent=')).at(-1)!.split('=')[1]!;
    const path = cgroup(parent);
    mkdirSync(path, { recursive: true });
    const previous = existsSync(path + '/cpu.stat') ? Number(readFileSync(path + '/cpu.stat', 'utf8').match(/usage_usec (\\d+)/)![1]) : 0;
    writeFileSync(path + '/cpu.stat', 'usage_usec ' + (previous + 3000000) + '\\n');
    writeFileSync(path + '/memory.peak', String(768 * 1048576));
    console.log(id);
  } else if (args[0] === 'ps') {
    const run = args[args.indexOf('--filter') + 1]!.replace('label=rezics.check.run=', '');
    for (const container of state.containers) if (container.run === run) console.log(container.id);
  } else if (args[0] === 'rm') {
    const id = args.at(-1);
    state.containers = state.containers.filter((container) => container.id !== id);
    if (args.includes('-v')) state.volumes = state.volumes.filter((volume) => volume !== id);
  }
}
writeFileSync(stateFile, JSON.stringify(state));
`;
  for (const command of ['systemd-run', 'systemctl', 'docker', 'date', 'sleep']) {
    writeFileSync(join(bin, command), source);
    chmodSync(join(bin, command), 0o755);
  }
  writeFileSync(join(pinnedBunDirectory, 'bun'), source);
  chmodSync(join(pinnedBunDirectory, 'bun'), 0o755);
  const stateFile = join(directory, 'state');
  writeFileSync(
    stateFile,
    JSON.stringify({ ticks: 0, containers: [{ id: 'unrelated', run: 'other-run' }], volumes: ['unrelated'] }),
  );
  return {
    directory,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    update: (updates: Record<string, unknown>) =>
      writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), ...updates })),
    events: () =>
      readFileSync(join(directory, 'events'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    execute: (script: string, env: Record<string, string> = {}, input = '') =>
      spawnSync(
        'sh',
        [
          '-c',
          script
            .replaceAll('/srv/rezics-check', directory)
            .replaceAll('/sys/fs/cgroup', `${directory}/cgroup`)
            .replaceAll(':/usr/local/bin:', ':'),
        ],
        {
          cwd: repository,
          env: {
            ...process.env,
            ...env,
            SYSTEMD_MODE: systemdMode,
            REMOTE_CHECK_PINNED_BUN_PATH: join(pinnedBunDirectory, 'bun'),
            PATH: `${bin}:${process.env.PATH}`,
            RUN_FIXTURE: directory,
          },
          input,
          encoding: 'utf8',
          timeout: 10_000,
        },
      ),
  };
}

async function generatedRun(command = ['sh', '-c', 'docker run database; docker container create search; exit 7']) {
  const { env, events } = scenario({ a: { available: 20e9 } });
  expect((await remote(env, workspace(), command)).code).toBe(0);
  const script = (kind: string) => String(events().find((event) => event.kind === kind)!.script);
  return { run: script('run'), cleanup: script('cleanup'), slot: script('slot') };
}

test('systemd 259 keeps the run script parameter expansions intact', async () => {
  const { run } = await generatedRun([
    'sh',
    '-c',
    'NAME=suffix; value=${1#prefix}; test "$value" = suffix; test "$NAME" = suffix; test "${NAME}" = suffix; printf "%s" "$value"',
    'sh',
    'prefixsuffix',
  ]);
  const fixture = runFixture('systemd-259');
  const result = fixture.execute(run);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('suffix');
});

test('older systemd starts the command without --expand-environment support', async () => {
  const { run } = await generatedRun(['sh', '-c', 'printf old-systemd-started']);
  const fixture = runFixture('old');
  const result = fixture.execute(run);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('old-systemd-started');
  const scope = fixture.events().find((event) => event.command === 'systemd-run' && !event.args.includes('--help'));
  expect(scope.args).not.toContain('--expand-environment=no');
});

test('the run checks installed packages after the command and before recording its exit status', async () => {
  const { run } = await generatedRun();
  const install = run.indexOf('"$bun" install --frozen-lockfile');
  const marker = run.indexOf('.bun-install-complete');
  const command = run.indexOf('\n        "$@"');
  const packageCheck = run.indexOf('modified_files=$(find');
  const exitStatus = run.indexOf('exit-status');
  expect(install).toBeGreaterThanOrEqual(0);
  expect(marker).toBeGreaterThan(install);
  expect(command).toBeGreaterThan(marker);
  expect(packageCheck).toBeGreaterThan(command);
  expect(exitStatus).toBeGreaterThan(packageCheck);
});

test('a quiet remote command reports CPU progress and the progress loop exits with it', () => {
  const fixture = runFixture();
  const script = runScript(
    'remote-progress',
    '/srv/rezics-check/runs/remote-progress',
    '.',
    ['/bin/sleep', '0.35'],
    'check-a',
    10,
  );
  const result = fixture.execute(script, { PROGRESS_INCREMENT: '1200000', REMOTE_CHECK_HOST: 'check-a' });
  expect(result.status).toBe(0);
  expect(result.stderr).toMatch(/remote-check: running on check-a, \d+ CPU seconds/);
  const pids = readFileSync(join(fixture.directory, 'sleep-pids'), 'utf8').trim().split('\n').map(Number);
  expect(pids.every((pid) => !existsSync(`/proc/${pid}`))).toBe(true);
});

test('a quiet remote command without CPU progress writes no progress line', () => {
  const fixture = runFixture();
  const script = runScript(
    'remote-idle',
    '/srv/rezics-check/runs/remote-idle',
    '.',
    ['/bin/sleep', '0.3'],
    'check-a',
    10,
  );
  const result = fixture.execute(script, { REMOTE_CHECK_HOST: 'check-a' });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('remote-check: running on check-a');
  const pids = readFileSync(join(fixture.directory, 'sleep-pids'), 'utf8').trim().split('\n').map(Number);
  expect(pids.every((pid) => !existsSync(`/proc/${pid}`))).toBe(true);
});

test('a quiet remote command reports every interval with at least one CPU second of progress', () => {
  const fixture = runFixture();
  const command = [
    'sh',
    '-c',
    'until [ -f "$1" ] && [ "$(wc -l < "$1")" -ge 7 ]; do /bin/sleep 0.005; done',
    'progress-command',
    '/srv/rezics-check/sleep-pids',
  ];
  const result = fixture.execute(
    runScript('remote-each-interval', '/srv/rezics-check/runs/remote-each-interval', '.', command, 'check-a', 10),
    { PROGRESS_INCREMENT: '1200000' },
  );
  expect(result.status, result.stderr).toBe(0);
  const reports = [...result.stderr.matchAll(/remote-check: running on check-a, (\d+) CPU seconds/g)];
  const pids = readFileSync(join(fixture.directory, 'sleep-pids'), 'utf8').trim().split('\n').map(Number);
  // Each new sleeper proves the preceding interval finished sampling and reporting.
  expect(reports.length).toBeGreaterThanOrEqual(6);
  expect(reports.length).toBeGreaterThanOrEqual(pids.length - 1);
  expect(reports.map((report) => Number(report[1]))).toEqual(
    reports.map((_, index) => Math.floor((500_000 + (index + 1) * 1_200_000) / 1_000_000)),
  );
  expect(pids.every((pid) => !existsSync(`/proc/${pid}`))).toBe(true);
  expect(result.stderr.lastIndexOf('remote-check: running on')).toBeLessThan(
    result.stderr.indexOf('remote-check: command'),
  );
});

test('remote CPU reports accumulate subsecond work across intervals', () => {
  const fixture = runFixture();
  // End after six completed samples, independent of process startup time on a loaded host.
  const command = [
    'sh',
    '-c',
    'until [ -f "$1" ] && [ "$(wc -l < "$1")" -ge 7 ]; do /bin/sleep 0.005; done',
    'progress-command',
    '/srv/rezics-check/sleep-pids',
  ];
  const script = runScript(
    'remote-fractional',
    '/srv/rezics-check/runs/remote-fractional',
    '.',
    command,
    'check-a',
    10,
  );
  const result = fixture.execute(script, { PROGRESS_INCREMENT: '400000', REMOTE_CHECK_HOST: 'check-a' });
  expect(result.status, result.stderr).toBe(0);
  const reports = [...result.stderr.matchAll(/remote-check: running on check-a, (\d+) CPU seconds/g)].map((match) =>
    Number(match[1]),
  );
  expect(reports.length).toBeGreaterThanOrEqual(2);
  expect(reports.every((seconds, index) => index === 0 || seconds > reports[index - 1]!)).toBe(true);
  expect(result.stderr.lastIndexOf('remote-check: running on')).toBeLessThan(
    result.stderr.indexOf('remote-check: command'),
  );
});

test('a signal to the remote command wrapper reaps its progress loop and sleeper', () => {
  const fixture = runFixture();
  const script = runScript(
    'remote-signal',
    '/srv/rezics-check/runs/remote-signal',
    '.',
    ['sh', '-c', '/bin/sleep 0.15; kill -TERM "$PPID"; exec /bin/sleep 0.5'],
    'check-a',
    10,
  );
  const result = fixture.execute(script, { PROGRESS_INCREMENT: '1200000', REMOTE_CHECK_HOST: 'check-a' });
  expect(result.status, result.stderr).toBe(143);
  const pids = readFileSync(join(fixture.directory, 'sleep-pids'), 'utf8').trim().split('\n').map(Number);
  expect(pids.length).toBeGreaterThan(0);
  expect(pids.every((pid) => !existsSync(`/proc/${pid}`))).toBe(true);
});

test('each run and every container it starts share one run slice', async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  const result = fixture.execute(scripts.run);
  expect(result.status, result.stderr).toBe(7);
  const bunInvocations = fixture
    .events()
    .filter((event) => event.command === 'bun')
    .map((event) => event.args);
  expect(bunInvocations).toHaveLength(2);
  expect(bunInvocations[0]).toEqual(['--eval', expect.any(String), expect.any(String)]);
  expect(bunInvocations[1]).toEqual(['install', '--frozen-lockfile']);
  // The run script first asks systemd-run --help whether --expand-environment exists.
  const scope = fixture.events().find((event) => event.command === 'systemd-run' && !event.args.includes('--help'));
  expect(scope.run).toMatch(/^[a-z0-9-]+$/);
  expect(scope.slice).toBe(`rezics-check-${scope.run.replaceAll('-', '_')}.slice`);
  expect(scope.args).toContain(`--slice=${scope.slice}`);
  const containers = fixture.events().filter((event) => event.command === 'docker');
  expect(containers).toHaveLength(2);
  for (const container of containers) {
    expect(container.args).toContain(`--cgroup-parent=${scope.slice}`);
    expect(container.args).toContain(`rezics.check.run=${scope.run}`);
  }
});

test('a run reports its CPU seconds, average cores and peak memory including its containers', async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  const result = fixture.execute(scripts.run);
  expect(result.status, result.stderr).toBe(7);
  expect(
    result.stderr.split('\n').filter((line) => line.startsWith('remote-check: run used')),
    result.stderr,
  ).toEqual(['remote-check: run used 6.500 CPU seconds over 4.000 s (1.62 cores), peak memory 768 MiB on a']);
  expect(result.stderr).not.toContain('peak memory of the run');
  const failedInstall = runFixture();
  const failure = failedInstall.execute(scripts.run, { INSTALL_EXIT: '9' });
  expect(failure.status).toBe(9);
  expect(failure.stderr).toContain('run used 0.500 CPU seconds over 2.000 s (0.25 cores), peak memory 64 MiB on a');
});

test('cleaning up a run removes its containers and their volumes', async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  expect(fixture.execute(scripts.run).status).toBe(7);
  expect(fixture.state().containers).toHaveLength(3);
  expect(fixture.execute(scripts.cleanup).status).toBe(0);
  expect(fixture.state().containers).toEqual([{ id: 'unrelated', run: 'other-run' }]);
  expect(fixture.state().volumes).toEqual(['unrelated']);
  const events = fixture.events();
  const stops = events.filter((event) => event.command === 'systemctl' && event.args[0] === 'stop');
  const removals = events.filter((event) => event.command === 'docker' && event.args[0] === 'rm');
  expect(stops).toHaveLength(2);
  expect(stops[0].args[1]).toEndWith('.scope');
  expect(stops[1].args[1]).toEndWith('.slice');
  expect(removals).toHaveLength(2);
  for (const removal of removals) {
    expect(removal.args.slice(0, 3)).toEqual(['rm', '-f', '-v']);
    expect(events.indexOf(removal)).toBeGreaterThan(events.indexOf(stops[0]));
    expect(events.indexOf(removal)).toBeLessThan(events.indexOf(stops[1]));
  }
  const id = scripts.run.match(/REZICS_CHECK_RUN=([^\s]+)/)![1]!;
  expect(existsSync(join(fixture.directory, 'runs', id))).toBe(false);
  // Retrying cleanup with no matching containers is harmless.
  expect(fixture.execute(scripts.cleanup).status).toBe(0);
  expect(fixture.state().volumes).toEqual(['unrelated']);
});

test("a slot holder cleans its run's systemd units and labelled containers before its lock session ends", async () => {
  const { run, slot } = await generatedRun();
  const id = run.match(/REZICS_CHECK_RUN=([^\s]+)/)![1]!;
  const fixture = runFixture();
  const directory = join(fixture.directory, 'runs', id);
  mkdirSync(directory, { recursive: true });
  expect(fixture.execute(run).status).toBe(7);
  rmSync(join(directory, 'exit-status'));
  const result = fixture.execute(slot, {}, `${id}\n`);

  expect(result.status, result.stderr).toBe(0);
  const events = fixture.events();
  const scopeStop = events.findIndex((event) => event.command === 'systemctl' && event.args[0] === 'stop');
  const removals = events.filter((event) => event.command === 'docker' && event.args[0] === 'rm');
  const sliceStop = events.findIndex(
    (event) => event.command === 'systemctl' && event.args[0] === 'stop' && event.args[1]?.endsWith('.slice'),
  );
  expect(scopeStop).toBeGreaterThanOrEqual(0);
  expect(removals).toHaveLength(2);
  expect(sliceStop).toBeGreaterThan(events.indexOf(removals.at(-1)!));
  expect(existsSync(directory)).toBe(false);
  expect(fixture.state().containers).toEqual([{ id: 'unrelated', run: 'other-run' }]);
});

test('a slot holder whose run already wrote exit-status leaves normal cleanup alone', async () => {
  const { run, slot } = await generatedRun();
  const id = run.match(/REZICS_CHECK_RUN=([^\s]+)/)![1]!;
  const fixture = runFixture();
  const directory = join(fixture.directory, 'runs', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'exit-status'), '0\n');

  const result = fixture.execute(slot, {}, `${id}\n`);
  expect(result.status, result.stderr).toBe(0);
  expect(fixture.events().filter((event) => event.command === 'systemctl' && event.args[0] === 'stop')).toEqual([]);
  expect(fixture.events().filter((event) => event.command === 'docker' && event.args[0] === 'rm')).toEqual([]);
  expect(existsSync(directory)).toBe(true);
});

test("a stale run directory's containers are removed with it", async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  expect(fixture.execute(scripts.run).status).toBe(7);
  const id = scripts.run.match(/REZICS_CHECK_RUN=([^\s]+)/)![1]!;
  const stale = join(fixture.directory, 'runs', id);
  const active = join(fixture.directory, 'runs/active-run');
  const fresh = join(fixture.directory, 'runs/fresh-run');
  mkdirSync(active);
  mkdirSync(fresh);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(join(stale, '.alive'), old, old);
  utimesSync(stale, old, old);
  utimesSync(active, old, old);
  expect(fixture.execute(scripts.slot).status).toBe(0);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(active)).toBe(true);
  expect(existsSync(fresh)).toBe(true);
  expect(fixture.state().containers).toEqual([{ id: 'unrelated', run: 'other-run' }]);
  expect(fixture.state().volumes).toEqual(['unrelated']);
  const events = fixture.events();
  const scopeStop = events.findIndex(
    (event) => event.command === 'systemctl' && event.args.join(' ') === `stop rezics-check-${id}.scope`,
  );
  const sliceStop = events.findIndex(
    (event) =>
      event.command === 'systemctl' && event.args.join(' ') === `stop rezics-check-${id.replaceAll('-', '_')}.slice`,
  );
  const removals = events.filter((event) => event.command === 'docker' && event.args[0] === 'rm');
  expect(removals).toHaveLength(2);
  for (const removal of removals) {
    expect(removal.args.slice(0, 3)).toEqual(['rm', '-f', '-v']);
    expect(events.indexOf(removal)).toBeGreaterThan(scopeStop);
    expect(events.indexOf(removal)).toBeLessThan(sliceStop);
  }
});

test('a run whose client stops renewing its liveness file is stopped by the next run that starts on the host, with its slice and containers', async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  expect(fixture.execute(scripts.run).status).toBe(7);
  const id = scripts.run.match(/REZICS_CHECK_RUN=([^\s]+)/)![1]!;
  const directory = join(fixture.directory, 'runs', id);
  const now = Math.floor(Date.now() / 1000);
  const expired = new Date((now - 601) * 1000);
  utimesSync(join(directory, '.alive'), expired, expired);
  fixture.update({ now });

  const result = fixture.execute(scripts.slot);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain(`remote-check: stopped stale run ${id} (alive file age 601 s)`);
  // Liveness stops resources promptly; directory retention still uses the 60-minute rule.
  expect(existsSync(directory)).toBe(true);
  expect(fixture.state().containers).toEqual([{ id: 'unrelated', run: 'other-run' }]);
  expect(fixture.state().volumes).toEqual(['unrelated']);
  expect(fixture.events()).toContainEqual(
    expect.objectContaining({ command: 'systemctl', args: ['stop', `rezics-check-${id.replaceAll('-', '_')}.slice`] }),
  );
});

test('a run whose client is alive is never stopped by another run, however long it lasts within its deadline', async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  expect(fixture.execute(scripts.run).status).toBe(7);
  const id = scripts.run.match(/REZICS_CHECK_RUN=([^\s]+)/)![1]!;
  const directory = join(fixture.directory, 'runs', id);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(directory, old, old);
  const containers = fixture.state().containers;
  // The command has ended, so its scope is inactive. Its live client may still be copying results back.
  for (const elapsed of [0, 60, 600, 1800]) {
    const now = Math.floor(Date.now() / 1000) + elapsed;
    const renewed = new Date(now * 1000);
    utimesSync(join(directory, '.alive'), renewed, renewed);
    fixture.update({ now });
    expect(fixture.execute(scripts.slot).status).toBe(0);
    expect(existsSync(directory)).toBe(true);
    expect(fixture.state().containers).toEqual(containers);
  }
  expect(fixture.events().filter((event) => event.command === 'systemctl' && event.args[0] === 'stop')).toEqual([]);
});

test('a run directory without a liveness file keeps the older inactive-directory cleanup rule', async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  expect(fixture.execute(scripts.run).status).toBe(7);
  const id = scripts.run.match(/REZICS_CHECK_RUN=([^\s]+)/)![1]!;
  const directory = join(fixture.directory, 'runs', id);
  rmSync(join(directory, '.alive'));
  const recentlyAbandoned = new Date(Date.now() - 30 * 60 * 1000);
  utimesSync(directory, recentlyAbandoned, recentlyAbandoned);
  expect(fixture.execute(scripts.slot).status).toBe(0);
  expect(existsSync(directory)).toBe(true);
  expect(fixture.state().containers).toHaveLength(3);
  expect(fixture.events().filter((event) => event.command === 'systemctl' && event.args[0] === 'stop')).toEqual([]);

  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(directory, old, old);
  expect(fixture.execute(scripts.slot).status).toBe(0);
  expect(existsSync(directory)).toBe(false);
  expect(fixture.state().containers).toEqual([{ id: 'unrelated', run: 'other-run' }]);
});

test('an empty leftover run slice is removed by the next run that starts on the host', async () => {
  const scripts = await generatedRun();
  const fixture = runFixture();
  fixture.update({ slices: { 'rezics-check-empty.slice': 0, 'rezics-check-busy.slice': 2 } });
  expect(fixture.execute(scripts.slot).status).toBe(0);
  expect(fixture.state().slices).toEqual({ 'rezics-check-busy.slice': 2 });
  expect(fixture.events().filter((event) => event.command === 'systemctl' && event.args[0] === 'stop')).toEqual([
    expect.objectContaining({ args: ['stop', 'rezics-check-empty.slice'] }),
  ]);
});

test("a run that passes its deadline is stopped and the client exits with the deadline exit code, distinct from the command's own failure and from transport failures", async () => {
  const { env, events } = scenario({ a: { available: 8e9, hang: true } });
  const result = await remote(env, workspace(), ['true'], ['--max-ms', '100']);
  expect(result.code).toBe(124);
  expect(result.stderr).toContain('remote-check: deadline reached after 100 ms');
  const run = String(events().find((event) => event.kind === 'run')!.script);
  const slice = run.match(/REZICS_CHECK_SLICE=([^\s]+)/)![1]!;
  const stopAt = events().findIndex((event) => String(event.script).startsWith(`systemctl stop ${slice} `));
  const releaseAt = events().findIndex((event) => event.kind === 'release');
  expect(stopAt).toBeGreaterThanOrEqual(0);
  expect(releaseAt).toBeGreaterThan(stopAt);
  const failure = scenario({ a: { available: 8e9, exit: 7 } });
  expect((await remote(failure.env, workspace(), ['true'])).code).toBe(7);
  const transport = scenario({ a: { available: 8e9, transportFailures: 1 } });
  expect((await remote(transport.env, workspace(), ['true'])).code).toBe(75);
});

test('every container a check host run starts is in its run slice', () => {
  const { env, events } = scenario({ a: { available: 4.5e9 } });
  const wrapper = join(checkHost, 'docker');
  const docker = (...args: string[]) =>
    spawnSync(wrapper, args, {
      env: {
        ...env,
        PATH: `${checkHost}:${env.PATH}`,
        REZICS_CHECK_SLICE: 'rezics-check-test_run.slice',
        REZICS_CHECK_RUN: 'test-run',
      },
      encoding: 'utf8',
    });

  for (const args of [
    ['run', '-d', '--name', 'database', 'postgres:18'],
    ['create', '--name', 'database', 'postgres:18'],
    ['container', 'run', '--rm', 'postgres:18', 'run', 'create'],
    ['container', 'create', 'postgres:18'],
  ]) {
    // The fake behind it exits 99, which passes through along with its arguments.
    expect(docker(...args).status).toBe(99);
  }
  for (const args of [
    ['ps', '-aq'],
    ['rm', '-f', 'run'],
    ['port', 'create', '5432/tcp'],
    ['volume', 'create', 'run'],
  ])
    docker(...args);

  const calls = events()
    .filter((event) => event.kind === 'docker')
    .map((event) => event.args as string[]);
  expect(calls).toEqual([
    [
      'run',
      '--cgroup-parent=rezics-check-test_run.slice',
      '--label',
      'rezics.check.run=test-run',
      '-d',
      '--name',
      'database',
      'postgres:18',
    ],
    [
      'create',
      '--cgroup-parent=rezics-check-test_run.slice',
      '--label',
      'rezics.check.run=test-run',
      '--name',
      'database',
      'postgres:18',
    ],
    [
      'container',
      'run',
      '--cgroup-parent=rezics-check-test_run.slice',
      '--label',
      'rezics.check.run=test-run',
      '--rm',
      'postgres:18',
      'run',
      'create',
    ],
    [
      'container',
      'create',
      '--cgroup-parent=rezics-check-test_run.slice',
      '--label',
      'rezics.check.run=test-run',
      'postgres:18',
    ],
    ['ps', '-aq'],
    ['rm', '-f', 'run'],
    ['port', 'create', '5432/tcp'],
    ['volume', 'create', 'run'],
  ]);
});

test('a remote run copies the declared output paths back after it ends, also when it fails', async () => {
  const failed = scenario({ a: { available: 8e9, exit: 7, present: ['.temp/screenshots'] } });
  const failedWorkspace = workspace();
  const failure = await remote(
    failed.env,
    failedWorkspace,
    ['bun', 'test'],
    ['--returns', '.temp/screenshots', '--returns', '.temp/missing'],
  );

  expect(failure.code).toBe(7);
  expect(failure.stderr.split('\n').filter((line) => line.includes(', skipping'))).toEqual([
    'remote-check: .temp/missing is not on a, skipping',
  ]);
  const failedEvents = failed.events();
  const syncs = failedEvents.filter((event) => event.kind === 'rsync');
  expect(syncs).toHaveLength(2);
  expect(String(syncs[0]!.destination)).toStartWith('ops@a.test:/srv/rezics-check/runs/');
  expect(String(syncs[1]!.destination)).toBe(`${failedWorkspace}/`);
  expect(syncs[1]!.files).toEqual(['.temp/screenshots']);
  const kinds = failedEvents.map((event) => event.kind);
  const runAt = kinds.indexOf('run');
  expect(runAt).toBeGreaterThanOrEqual(0);
  expect(kinds.indexOf('returns')).toBeGreaterThan(runAt);
  expect(kinds.lastIndexOf('rsync')).toBeGreaterThan(kinds.indexOf('returns'));
  expect(kinds.indexOf('cleanup')).toBeGreaterThan(kinds.lastIndexOf('rsync'));

  const succeeded = scenario({
    a: { available: 8e9, present: ['.temp/screenshots', 'apps/web/src/kernel/recorded'] },
  });
  const success = await remote(
    succeeded.env,
    workspace(),
    ['true'],
    ['--returns', '.temp/screenshots', '--returns', 'apps/web/src/kernel/recorded'],
  );
  expect(success.code).toBe(0);
  expect(success.stderr).not.toContain('skipping');
  const copied = succeeded.events().filter((event) => event.kind === 'rsync');
  expect(copied).toHaveLength(2);
  expect(copied[1]!.files).toEqual(['.temp/screenshots', 'apps/web/src/kernel/recorded']);
});

test('copying outputs back accepts vanished files and reports their count', async () => {
  const { env, events } = scenario({
    a: {
      available: 8e9,
      present: ['.temp/screenshots'],
      rsyncBackExit: 24,
      vanishedFiles: ['.temp/screenshots/old.png'],
    },
  });
  const result = await remote(env, workspace(), ['true'], ['--returns', '.temp/screenshots']);

  expect(result.code).toBe(0);
  expect(result.stderr).toContain('remote-check: rsync from a: 1 files vanished during transfer');
  expect(events().filter((event) => event.kind === 'rsync')).toHaveLength(2);
});

test('the returns probe runs under bash with nothing on stderr and lists present and absent outputs', () => {
  const temporaryDirectory = join(root, '.temp');
  mkdirSync(temporaryDirectory, { recursive: true });
  const directory = mkdtempSync(join(temporaryDirectory, 'returns-probe-'));
  try {
    writeFileSync(join(directory, 'present.txt'), 'present');
    const result = spawnSync('bash', ['-c', returnsProbe(directory, ['present.txt', 'absent.txt'])], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('PRESENT present.txt\nABSENT absent.txt\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the docker wrapper calls the docker behind it, not a shim that called the wrapper', () => {
  const { env, events } = scenario({ a: { available: 4.5e9 } });
  const shims = join(root, 'shims');
  mkdirSync(shims, { recursive: true });
  const shim = join(shims, 'docker');
  writeFileSync(shim, `#!/bin/sh\necho shim >> "$FAKE_DIR/shim.log"\nexec ${join(checkHost, 'docker')} "$@"\n`);
  chmodSync(shim, 0o755);
  const result = spawnSync(shim, ['run', 'image'], {
    env: { ...env, PATH: `${shims}:${checkHost}:${env.PATH}` },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.status).toBe(99);
  expect(readFileSync(join(env.FAKE_DIR, 'shim.log'), 'utf8')).toBe('shim\n');
  expect(events().filter((event) => event.kind === 'docker')).toEqual([
    { kind: 'docker', args: ['run', '--cgroup-parent=rezics-check.slice', 'image'] },
  ]);
});

test('a remote run puts the docker wrapper first on the path', async () => {
  const { env, events } = scenario({ a: { available: 4.5e9 } });
  await remote(env, workspace());
  const script = events().find((event) => event.kind === 'run')!.script as string;
  const path = script.match(/export PATH=(\S+)/)![1];
  expect(path).toMatch(/^\/srv\/rezics-check\/runs\/[a-z0-9-]+\/\.temp\/check-host:/);
  expect(script).toContain(readFileSync(join(checkHost, 'docker'), 'utf8'));
});

test('without KERNEL_CHECK_REMOTE the kernel check runs locally as before', async () => {
  const { env, events } = scenario({ a: { available: 4.5e9 } });
  const local = { ...env };
  delete local.KERNEL_CHECK_REMOTE;
  const result = await kernelCheck(local);
  expect(result.code).not.toBe(0);
  const seen = events();
  expect(seen.some((event) => event.kind === 'docker')).toBe(true);
  // An unset name falls back to the shared hosts file. Those hosts do not answer this fake ssh, so the check still
  // runs locally; the probes are the only remote traffic.
  expect(seen.filter((event) => event.kind !== 'docker' && event.kind !== 'probe')).toEqual([]);

  // An unreadable hosts file does not fall back and does not hand off.
  const missing = scenario({ a: { available: 4.5e9 } });
  await kernelCheck({ ...missing.env, KERNEL_CHECK_REMOTE: join(root, 'no-such-hosts.json') });
  expect(missing.events().some((event) => event.kind === 'docker')).toBe(true);
  expect(missing.events().filter((event) => event.kind !== 'docker')).toEqual([]);

  // The flag does not itself force local placement; actual check-host location still takes precedence.
  const onRemote = scenario({ a: { available: 4.5e9 } });
  const placed = await kernelCheck({ ...onRemote.env, KERNEL_CHECK_ON_REMOTE: '1' });
  if (onCheckHost(kernel)) {
    expect(placed.code).not.toBe(0);
    expect(placed.stderr).toContain('stack-run: kernel check local, already on a check host');
    expect(onRemote.events().some((event) => event.kind === 'docker')).toBe(true);
    expect(onRemote.events().some((event) => event.kind === 'run')).toBe(false);
    return;
  }
  expect(placed.code, placed.stderr).toBe(0);
  expect(placed.stderr).toContain('stack-run: kernel check on a');
  expect(onRemote.events().some((event) => event.kind === 'docker')).toBe(false);
  expect(onRemote.events().some((event) => event.kind === 'run')).toBe(true);
});

test('landing priority: a waiting landing run starts before ordinary and multi-slot waiters when its slots free', async () => {
  const { env, events } = scenario({
    b: { available: 20e9, slots: 6, cpuQuotaPercent: 1200, ordinaryBusySlots: [0, 1, 2, 3, 4] },
  });
  const directory = workspace();
  const busySlots = [0, 1, 2, 3, 4].map((slot) => join(env.FAKE_DIR!, 'ops_b_test.slot.' + slot));
  let landing: ReturnType<typeof startRemote> | undefined;
  let ordinary: ReturnType<typeof startRemote> | undefined;
  let multi: ReturnType<typeof startRemote> | undefined;
  try {
    ordinary = startRemote(env, directory, ['sh', '-c', 'echo ordinary'], ['--estimate-ms', '999999']);
    multi = startRemote(env, directory, ['sh', '-c', 'echo multi'], ['--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'multi-marker'));
    landing = startRemote(
      { ...env, REMOTE_CHECK_PRIORITY: 'landing' },
      directory,
      ['sh', '-c', 'echo landing'],
      ['--slots', '3'],
    );
    await waitFor(() => events().some((event) => event.kind === 'landing-marker'));
    for (const slot of busySlots) rmSync(slot, { recursive: true, force: true });
    const landingDeadline = Date.now() + 5_000;
    while (
      !events().some((event) => event.kind === 'run' && String(event.script).includes('echo landing')) &&
      Date.now() < landingDeadline
    ) {
      await Bun.sleep(10);
    }
    expect(
      events().some((event) => event.kind === 'run' && String(event.script).includes('echo landing')),
      JSON.stringify(
        events().map(
          ({ kind, requested, granted, reason, landingWaitingSlots, landingMarkerFiles, landingMarkers }) => ({
            kind,
            requested,
            granted,
            reason,
            landingWaitingSlots,
            landingMarkerFiles,
            landingMarkers,
          }),
        ),
      ),
    ).toBe(true);
    await waitFor(
      () =>
        events().some(
          (event) =>
            event.kind === 'slot' &&
            event.granted &&
            String(event.script).includes('# REMOTE_CHECK_PRIORITY ordinary') &&
            String(event.script).includes('# REMOTE_CHECK_SLOT_COUNT 1'),
        ),
      10_000,
    );
    const grants = events().filter((event) => event.kind === 'slot' && event.granted);
    const landingGrant = grants.findIndex((event) => String(event.script).includes('# REMOTE_CHECK_PRIORITY landing'));
    const ordinaryGrant = grants.findIndex(
      (event) =>
        String(event.script).includes('# REMOTE_CHECK_PRIORITY ordinary') &&
        String(event.script).includes('# REMOTE_CHECK_SLOT_COUNT 1'),
    );
    const multiGrant = grants.findIndex(
      (event, index) => index > landingGrant && String(event.script).includes('# REMOTE_CHECK_SLOT_COUNT 2'),
    );
    expect(landingGrant).toBeGreaterThanOrEqual(0);
    expect(
      ordinaryGrant,
      JSON.stringify({
        landingExit: landing.child.exitCode,
        landingStderr: landing.child.exitCode === null ? undefined : await landing.stderr,
        ordinary: grants
          .filter((event) => String(event.script).includes('# REMOTE_CHECK_ESTIMATE_MS 999999'))
          .map(({ actualAdmissionLimit, landingMarkerIds, slotClass }) => ({
            actualAdmissionLimit,
            landingMarkerIds,
            slotClass,
          })),
        order: grants.map((event) => ({
          priority: String(event.script).match(/# REMOTE_CHECK_PRIORITY (\w+)/)?.[1],
          estimate: String(event.script).match(/# REMOTE_CHECK_ESTIMATE_MS (\w+)/)?.[1],
        })),
        timeline: events().map(
          ({ kind, id, requested, actualAdmissionLimit, landingMarkerIds, arrivalOrder, sequence, reason }) => ({
            kind,
            id,
            requested,
            actualAdmissionLimit,
            landingMarkerIds,
            arrivalOrder,
            sequence,
            reason,
          }),
        ),
      }),
    ).toBeGreaterThan(landingGrant);
    expect(multiGrant).toBeGreaterThan(landingGrant);
    await waitFor(
      () => events().some((event) => event.kind === 'run' && String(event.script).includes('echo ordinary')),
      10_000,
    );
    await Promise.all([ordinary.child.exited, multi.child.exited]);
    expect(ordinary.child.exitCode).toBe(0);
    expect(multi.child.exitCode).toBe(0);
  } finally {
    for (const run of [multi, ordinary, landing]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
}, 30_000);

test('landing priority: ordinary and multi-slot runs leave its slots free while short runs may use express', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 4, hang: true, hangRuns: 2 } });
  const directory = workspace();
  const holders = [startRemote(env, directory, ['true'], ['--slots', '2']), startRemote(env, directory, ['true'])];
  let landing: ReturnType<typeof startRemote> | undefined;
  let ordinary: ReturnType<typeof startRemote> | undefined;
  let multi: ReturnType<typeof startRemote> | undefined;
  try {
    await waitFor(() => events().filter((event) => event.kind === 'run').length === 2);
    landing = startRemote({ ...env, REMOTE_CHECK_PRIORITY: 'landing' }, directory, ['true']);
    await waitFor(() => events().some((event) => event.kind === 'landing-marker'));
    ordinary = startRemote(env, directory, ['true']);
    multi = startRemote(env, directory, ['true'], ['--slots', '2']);
    await waitFor(() => events().some((event) => event.kind === 'multi-marker'));
    const short = await remote(env, directory, ['true'], ['--estimate-ms', '120000']);
    expect(short.code).toBe(0);
    expect(events().some((event) => event.kind === 'slot' && event.granted && event.slot === 'express')).toBe(true);
    expect(events().filter((event) => event.kind === 'run')).toHaveLength(3);
    const grants = events().filter((event) => event.kind === 'slot' && event.granted);
    expect(grants).toHaveLength(4);
    expect(grants.at(-1)?.slot).toBe('express');
    expect(grants.some((event) => String(event.script).includes('# REMOTE_CHECK_PRIORITY landing'))).toBe(false);
  } finally {
    for (const run of [multi, ordinary, landing, ...holders]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
}, 30_000);

test('landing priority: a waiting gate starts first and landing runs on one host keep arrival order', async () => {
  const { env, events } = scenario({ b: { available: 20e9, slots: 4, ordinaryBusySlots: [0, 1, 2] } });
  const directory = workspace();
  const busySlots = [0, 1, 2].map((slot) => join(env.FAKE_DIR!, 'ops_b_test.slot.' + slot));
  let gate: ReturnType<typeof startRemote> | undefined;
  let first: ReturnType<typeof startRemote> | undefined;
  let second: ReturnType<typeof startRemote> | undefined;
  try {
    first = startRemote({ ...env, REMOTE_CHECK_PRIORITY: 'landing' }, directory, ['sh', '-c', 'echo landing-one']);
    await waitFor(() => events().some((event) => event.kind === 'landing-marker'));
    second = startRemote({ ...env, REMOTE_CHECK_PRIORITY: 'landing' }, directory, ['sh', '-c', 'echo landing-two']);
    await waitFor(() => events().filter((event) => event.kind === 'landing-marker').length === 2);
    gate = startRemote(env, directory, ['sh', '-c', 'echo gate'], ['--gate']);
    await waitFor(() => events().some((event) => event.kind === 'gate-marker'));
    for (const slot of busySlots) rmSync(slot, { recursive: true, force: true });
    await waitFor(() => events().some((event) => event.kind === 'run' && String(event.script).includes('echo gate')));
    await waitFor(
      () =>
        events().filter(
          (event) =>
            event.kind === 'slot' && event.granted && String(event.script).includes('# REMOTE_CHECK_PRIORITY landing'),
        ).length === 2,
    );
    const grants = events().filter((event) => event.kind === 'slot' && event.granted);
    const gateGrant = grants.findIndex((event) => String(event.script).includes('# REMOTE_CHECK_GATE_REQUEST 1'));
    const landingGrantIds = grants
      .filter((event) => String(event.script).includes('# REMOTE_CHECK_PRIORITY landing'))
      .map((event) => String(event.script).match(/# REMOTE_CHECK_LANDING_WAITER_ID ([a-zA-Z0-9-]+)/)?.[1]);
    const arrivalIds = events()
      .filter((event) => event.kind === 'landing-marker')
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .map((event) => String(event.id))
      .filter((id, index, ids) => ids.indexOf(id) === index);
    expect(gateGrant).toBeGreaterThanOrEqual(0);
    expect(
      landingGrantIds,
      JSON.stringify(
        events().map(({ kind, id, sequence, arrivalOrder, requested }) => ({
          kind,
          id,
          sequence,
          arrivalOrder,
          requested,
        })),
      ),
    ).toEqual(arrivalIds);
    expect(grants.findIndex((event) => String(event.script).includes(landingGrantIds[0]!))).toBeGreaterThan(gateGrant);
    expect(grants.findIndex((event) => String(event.script).includes(landingGrantIds[1]!))).toBeGreaterThan(
      grants.findIndex((event) => String(event.script).includes(landingGrantIds[0]!)),
    );
  } finally {
    for (const run of [gate, second, first]) {
      if (!run) continue;
      try {
        run.child.kill('SIGTERM');
      } catch {}
      await run.child.exited;
      await Promise.all([run.stdout, run.stderr]);
    }
  }
}, 30_000);

test('landing priority: invalid values are usage errors and direct CLI admission carries the class', async () => {
  const bad = scenario({ a: { available: 8e9 } });
  const invalid = await remote({ ...bad.env, REMOTE_CHECK_PRIORITY: 'urgent' }, workspace());
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('REMOTE_CHECK_PRIORITY must be landing');
  expect(bad.events()).toEqual([]);

  const valid = scenario({ a: { available: 8e9 } });
  const result = await remote({ ...valid.env, REMOTE_CHECK_PRIORITY: 'landing' }, workspace());
  expect(result.code).toBe(0);
  expect(valid.events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_PRIORITY landing',
  );
  const runScript = String(valid.events().find((event) => event.kind === 'run')?.script);
  expect(runScript).toContain('remote-check: run priority %s on %s');
  expect(runScript).toContain('landing a');
});

test('critical priority: critical direct runs carry their class through admission and records', async () => {
  const valid = scenario({ a: { available: 8e9 } });
  const result = await remote({ ...valid.env, REMOTE_CHECK_PRIORITY: 'critical' }, workspace());
  expect(result.code).toBe(0);
  expect(valid.events().find((event) => event.kind === 'slot' && event.granted)?.script).toContain(
    '# REMOTE_CHECK_PRIORITY critical',
  );
  expect(String(valid.events().find((event) => event.kind === 'run')?.script)).toContain('critical a');
  const invalid = scenario({ a: { available: 8e9 } });
  const refused = await remote({ ...invalid.env, REMOTE_CHECK_PRIORITY: 'urgent' }, workspace());
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('REMOTE_CHECK_PRIORITY must be landing or critical');
});
