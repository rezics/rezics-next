import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stopRunScript, supervisorStopProgram } from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');

async function ownedFixture() {
  const hostRoot = mkdtempSync(join(repository, '.temp', 'stop-intent-'));
  const run = 'owned-stop';
  const directory = join(hostRoot, 'runs', run);
  const retained = join(hostRoot, 'receipts', run);
  mkdirSync(join(directory, '.temp/check-host'), { recursive: true });
  writeFileSync(join(directory, '.temp/check-host/preparation-progress.json'), JSON.stringify({ phase: 'generation' }));
  const child = Bun.spawn(['python3', '-c', String.raw`import json,os,signal,sys,time
from pathlib import Path
root=Path(sys.argv[1]);retained=root.parent.parent/'receipts'/root.name
fields=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()
def stopped(number,frame):
    observed=None
    try:observed=json.loads((retained/'supervisor-stop-intents.jsonl').read_text().splitlines()[-1])
    except (OSError,ValueError,IndexError):pass
    (root/'received-signal.json').write_text(json.dumps({'signal':number,'monoNs':time.monotonic_ns(),'observed':observed}))
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stopped)
(root/'.remote-check-supervisor').write_text(json.dumps({'schema':1,'host':'a','run':root.name,
    'pid':os.getpid(),'started':fields[19],'group':os.getpgrp(),'uid':os.getuid()}))
while True:time.sleep(.01)
`, directory], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  for (let count = 0; count < 100 && !existsSync(join(directory, '.remote-check-supervisor')); count++) await Bun.sleep(10);
  expect(existsSync(join(directory, '.remote-check-supervisor'))).toBe(true);
  const marker = JSON.parse(readFileSync(join(directory, '.remote-check-supervisor'), 'utf8'));
  const program = supervisorStopProgram.replaceAll('/srv/rezics-check', hostRoot);
  const stop = (reason = 'controller-cleanup', recordOnly = false) => spawnSync('python3',
    ['-c', program, directory, reason, ...(recordOnly ? ['record-only'] : [])], { encoding: 'utf8', timeout: 3000 });
  return { hostRoot, run, directory, retained, marker, child, stop,
    async close() { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; rmSync(hostRoot, { recursive: true, force: true }); } };
}

test('owned TERM observes its exact bounded stop intent before signal delivery', async () => {
  const fixture = await ownedFixture();
  try {
    const result = fixture.stop('lease-orphan');
    expect(result.status, result.stderr).toBe(0);
    expect(await fixture.child.exited).toBe(0);
    const received = JSON.parse(readFileSync(join(fixture.directory, 'received-signal.json'), 'utf8'));
    expect(received.signal).toBe(15);
    expect(received.observed).toMatchObject({ schema: 1, host: 'a', run: fixture.run, signal: 15,
      reason: 'lease-orphan', action: 'supervisor-term', phase: 'generation',
      supervisor: { pid: fixture.marker.pid, start: fixture.marker.started, group: fixture.marker.group } });
    expect(received.observed.actor.pid).toBeGreaterThan(0);
    expect(received.observed.actor.start).toMatch(/^\d+$/);
    expect(received.observed.boot).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    expect(received.observed.monoNs).toBeLessThanOrEqual(received.monoNs);
    expect(existsSync(join(fixture.directory, 'supervisor-stop-intents.jsonl'))).toBe(false);
  } finally { await fixture.close(); }
});

test('wrong supervisor birth produces neither a stop nor a foreign stop-intent record', async () => {
  const fixture = await ownedFixture();
  try {
    writeFileSync(join(fixture.directory, '.remote-check-supervisor'), JSON.stringify({ ...fixture.marker, started: '1' }));
    expect(fixture.stop().status).toBe(0);
    expect(fixture.child.exitCode).toBeNull();
    expect(existsSync(join(fixture.retained, 'supervisor-stop-intents.jsonl'))).toBe(false);
    expect(existsSync(join(fixture.directory, 'received-signal.json'))).toBe(false);
  } finally { await fixture.close(); }
});

test('stop-intent bounds and telemetry failure never prevent the original owned stop', async () => {
  const fixture = await ownedFixture();
  try {
    for (let count = 0; count < 16; count++) expect(fixture.stop('stale-run', true).status).toBe(0);
    const file = join(fixture.retained, 'supervisor-stop-intents.jsonl');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(16);
    expect(statSync(file).size).toBeLessThanOrEqual(16384);
    const overflow = fixture.stop('controller-cleanup');
    expect(overflow.status, overflow.stderr).toBe(0);
    expect(overflow.stderr).toContain('stop-intent telemetry unavailable');
    expect(await fixture.child.exited).toBe(0);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(16);
  } finally { await fixture.close(); }
  const blocked = await ownedFixture();
  try {
    writeFileSync(join(blocked.hostRoot, 'receipts'), 'unavailable telemetry directory');
    const result = blocked.stop();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('stop-intent telemetry unavailable');
    expect(await blocked.child.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(blocked.directory, 'received-signal.json'), 'utf8')).observed).toBeNull();
  } finally { await blocked.close(); }
});

test('controller stop retains its intent before the existing systemctl stop action', async () => {
  const fixture = await ownedFixture();
  try {
    const bin = join(fixture.hostRoot, 'bin'); mkdirSync(bin);
    const systemctl = join(bin, 'systemctl');
    writeFileSync(systemctl, `#!/usr/bin/env python3\nimport json,sys,time\nfrom pathlib import Path\nroot=Path(${JSON.stringify(fixture.directory)})\nretained=Path(${JSON.stringify(fixture.retained)})\nif sys.argv[1]=='is-active':sys.exit(1)\nvalue=json.loads((retained/'supervisor-stop-intents.jsonl').read_text().splitlines()[-1])\n(root/'systemctl-observed.json').write_text(json.dumps({'record':value,'monoNs':time.monotonic_ns()}))\n`);
    chmodSync(systemctl, 0o755);
    const script = stopRunScript(fixture.run).replaceAll('/srv/rezics-check', fixture.hostRoot);
    const result = spawnSync('sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STOPPED');
    expect(await fixture.child.exited).toBe(0);
    const observed = JSON.parse(readFileSync(join(fixture.directory, 'systemctl-observed.json'), 'utf8'));
    expect(observed.record).toMatchObject({ action: 'systemctl-stop', reason: 'controller-stop',
      supervisor: { pid: fixture.marker.pid, start: fixture.marker.started } });
    expect(observed.record.monoNs).toBeLessThanOrEqual(observed.monoNs);
  } finally { await fixture.close(); }
});
