import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupScript, leaseCustodyCheckScript, leaseHolderProgram, slotScript, supervisorStopProgram } from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');
const ownerProgram = String.raw`import json,os,signal,sys,time
from pathlib import Path
root=Path(sys.argv[5]);host=sys.argv[3];run=sys.argv[4];group=Path(os.environ['FIXTURE_CGROUP'])
fields=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()
marker={'schema':1,'host':host,'run':run,'pid':os.getpid(),'started':fields[19],'group':os.getpgrp(),'uid':os.getuid()}
(root/'.remote-check-supervisor').write_text(json.dumps(marker))
info=group.stat();relative='/rezics.slice/rezics-check.slice/rezics-check-'+run.replace('-','_')+'.slice'
resource={'schema':1,'host':host,'run':run,'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
 'supervisor':{'pid':os.getpid(),'start':fields[19],'group':os.getpgrp()},'startedMonoMs':time.monotonic()*1000,
 'commandStartedMonoMs':None,'cgroup':{'path':relative,'device':info.st_dev,'inode':info.st_ino,'invocation':'fixture'}}
retained=root.parent.parent/'receipts'/run;retained.mkdir(parents=True,exist_ok=True)
(retained/'physical-resources.json').write_text(json.dumps(resource))
(group/'cgroup.events').write_text('populated 1\n')
stop=[]
def signal_stop(number,frame):stop.append(number)
for number in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(number,signal_stop)
(root/'owner-ready').touch()
while not stop and not (root/'finish').exists():time.sleep(.01)
(root/'signals.json').write_text(json.dumps(stop))
if not stop:(root/'command-started').touch()
(group/'cgroup.events').write_text('populated 0\n')
(root/'exit-status').write_text('143\n' if stop else '7\n')
`;

async function until(predicate: () => boolean) {
  for (let count = 0; count < 200 && !predicate(); count++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

async function fixture(actualSlot = false, bound = 10_000, slots = ['0', 'express']) {
  const hostRoot = mkdtempSync(join(repository, '.temp', 'retained-lease-'));
  const run = 'lease-fixture'; const directory = join(hostRoot, 'runs', run);
  const retained = join(hostRoot, 'receipts', run); const cgroups = join(hostRoot, 'cgroups');
  const group = join(cgroups, 'rezics.slice/rezics-check.slice/rezics-check-lease_fixture.slice');
  mkdirSync(join(directory, '.temp/check-host'), { recursive: true }); mkdirSync(group, { recursive: true });
  mkdirSync(join(hostRoot, 'slots')); writeFileSync(join(directory, '.alive'), '');
  writeFileSync(join(directory, '.temp/check-host/preparation-progress.json'), JSON.stringify({ phase: 'generation' }));
  const prepare = join(directory, '.temp/check-host/prepare.py'); writeFileSync(prepare, ownerProgram);
  const owner = Bun.spawn(['python3', prepare, 'lifetime', String(bound), 'a', run, directory, 'fixture', '900000', 'ordinary'],
    { detached: true, env: { ...process.env, FIXTURE_CGROUP: group }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  await until(() => existsSync(join(directory, 'owner-ready')));
  const holderProgram = leaseHolderProgram.replaceAll('/srv/rezics-check', hostRoot).replaceAll('/sys/fs/cgroup', cgroups);
  const stop = supervisorStopProgram.replaceAll('/srv/rezics-check', hostRoot);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const cleanup = `test ! -e ${quote(join(directory, 'cleanup-fail'))} || exit 1\npython3 -c ${quote(stop)} ${quote(directory)} lease-orphan\n`;
  let script = slots.map((name) => `exec ${name === 'express' ? 11 : 10}>${quote(join(hostRoot, 'slots', `${name}.lock`))}\nflock -n ${name === 'express' ? 11 : 10}\nprintf '4294967296\\n' > ${quote(join(hostRoot, 'slots', `${name}.memory`))}`).join('\n');
  script += `\necho $$ > ${quote(join(directory, 'before-exec-pid'))}\nexec python3 -c ${quote(holderProgram)} ${quote(directory)} a ${quote(slots.join(' '))} 11 ${quote(cleanup)}\n`;
  if (actualSlot) {
    const bin = join(hostRoot, 'bin'); mkdirSync(bin);
    const systemctl = join(bin, 'systemctl');
    writeFileSync(systemctl, `#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\ngroup=Path(${JSON.stringify(group)})\nlive='populated 1' in (group/'cgroup.events').read_text()\nargs=sys.argv[1:]\nif 'is-active' in args:sys.exit(0 if live else 1)\nif 'show' in args and any('TasksCurrent' in x for x in args):print(1 if live else 0)\n`); chmodSync(systemctl, 0o755);
    script = slotScript({ name: 'a', address: 'fixture', identity: 'fixture', slots: 3, memoryMaxGiB: 24, cpuQuotaPercent: 600, processorsPerSlot: 2 }, 1, 3, 2, 2, false, undefined, false)
      .replaceAll('/srv/rezics-check', hostRoot).replaceAll('/sys/fs/cgroup', cgroups)
      .replaceAll('update_host_pressure(sys.argv[1])[0]', 'False');
    // The actual SSH transport still carries slotScript as one argv string.
    expect(Buffer.byteLength(script)).toBeLessThan(120_000);
    writeFileSync(join(hostRoot, 'actual-slot-script.sh'), script);
  }
  const entry = join(hostRoot, 'holder.sh'); writeFileSync(entry, script);
  const holder = Bun.spawn(['bash', entry], { detached: true, env: { ...process.env, PATH: `${join(hostRoot, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const stdout = new Response(holder.stdout).text(); const stderr = new Response(holder.stderr).text();
  if (actualSlot) { holder.stdin.write(run+'\n'); await holder.stdin.flush(); }
  await until(() => existsSync(join(retained, 'lease-custody.json')) || holder.exitCode !== null);
  expect(holder.exitCode, await (holder.exitCode === null ? Promise.resolve('holder started') : stderr)).toBeNull();
  const proof = () => spawnSync('sh', ['-c', leaseCustodyCheckScript(quote(directory)).replaceAll('/srv/rezics-check', hostRoot)], { encoding: 'utf8' });
  return { hostRoot, run, directory, retained, cgroups, group, holder, owner, stdout, stderr, proof,
    async close() { for (const child of [holder, owner]) { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
      await Promise.all([stdout, stderr]); rmSync(hostRoot, { recursive: true, force: true }); } };
}

// These numeric .memory readers retain the old ordinary/express flock-only algorithm. No custody metadata is read.
function oldReader(root: string) {
  const script = String.raw`ordinary_slots_used=0
memory_reserved=0
i=0
while [ "$i" -lt 1 ]; do
 lock="$1/slots/$i.lock"
 if [ -e "$lock" ]; then
  exec 9<"$lock"
  if flock -n 9; then flock -u 9; else
   ordinary_slots_used=$((ordinary_slots_used + 1))
   reservation="$1/slots/$i.memory"
   if [ -r "$reservation" ]; then read -r amount < "$reservation" || amount=0; case "$amount" in ''|*[!0-9]*) amount=0 ;; esac; memory_reserved=$((memory_reserved + amount)); fi
  fi
  exec 9<&-
 fi
 i=$((i + 1))
done
express_slot_used=0
if [ -e "$1/slots/express.lock" ]; then
 exec 9<"$1/slots/express.lock"
 if flock -n 9; then flock -u 9; else
  express_slot_used=1
  reservation="$1/slots/express.memory"
  if [ -r "$reservation" ]; then read -r amount < "$reservation" || amount=0; case "$amount" in ''|*[!0-9]*) amount=0 ;; esac; memory_reserved=$((memory_reserved + amount)); fi
 fi
 exec 9<&-
fi
printf '%s %s %s' "$ordinary_slots_used" "$express_slot_used" "$memory_reserved"`;
  const value = spawnSync('bash', ['-c', script, 'old-reader', root], { encoding: 'utf8' });
  expect(value.status, value.stderr).toBe(0); return value.stdout;
}

test('same-PID exec keeps original ordinary/express locks and numeric bytes across live generation EOF', async () => {
  const f = await fixture();
  try {
    const record = JSON.parse(readFileSync(join(f.retained, 'lease-custody.json'), 'utf8'));
    expect(record.holder.pid).toBe(Number(readFileSync(join(f.directory, 'before-exec-pid'), 'utf8')));
    expect(record.holder.pid).toBe(f.holder.pid);
    expect(f.proof().status).toBe(0);
    expect(oldReader(f.hostRoot)).toBe('1 1 8589934592');
    await f.holder.stdin.end(); await Bun.sleep(80);
    expect(f.owner.exitCode).toBeNull(); expect(f.holder.exitCode).toBeNull();
    expect(oldReader(f.hostRoot)).toBe('1 1 8589934592');
    writeFileSync(join(f.directory, 'finish'), ''); await f.owner.exited;
    expect(await f.holder.exited, await f.stderr).toBe(0);
    expect(readFileSync(join(f.directory, 'signals.json'), 'utf8')).toBe('[]');
    expect(readFileSync(join(f.directory, 'exit-status'), 'utf8')).toBe('7\n');
    expect(oldReader(f.hostRoot)).toBe('0 0 0'); expect(f.proof().status).not.toBe(0);
  } finally { await f.close(); }
});

test('actual slotScript EOF preserves the same generation and terminal physical identity', async () => {
  const f = await fixture(true);
  try {
    await f.holder.stdin.end(); await Bun.sleep(80);
    expect(f.owner.exitCode).toBeNull(); expect(f.proof().status).toBe(0);
    writeFileSync(join(f.directory, 'finish'), ''); await f.owner.exited;
    expect(await f.holder.exited, await f.stderr).toBe(0);
    expect(readFileSync(join(f.directory, 'signals.json'), 'utf8')).toBe('[]');
  } finally { await f.close(); }
});

test('explicit TERM INT HUP and the original deadline stop owned work while reservations remain held until termination', async () => {
  for (const requested of ['SIGTERM', 'SIGINT', 'SIGHUP', 'deadline'] as const) {
    const deadline = requested === 'deadline';
    const f = await fixture(false, deadline ? 60 : 10_000);
    try {
      if (deadline) await f.holder.stdin.end(); else f.holder.kill(requested);
      const expected = requested === 'SIGINT' ? 130 : requested === 'SIGHUP' ? 129 : 143;
      expect(await f.holder.exited, await f.stderr).toBe(expected);
      await f.owner.exited;
      expect(JSON.parse(readFileSync(join(f.directory, 'signals.json'), 'utf8'))).toContain(15);
      expect(oldReader(f.hostRoot)).toBe('0 0 0');
    } finally { await f.close(); }
  }
});

test('failed cleanup retains original reservations until later kernel-proved terminal settlement', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.directory, 'cleanup-fail'), ''); f.holder.kill('SIGTERM'); await Bun.sleep(80);
    expect(f.holder.exitCode).toBeNull(); expect(f.owner.exitCode).toBeNull();
    expect(oldReader(f.hostRoot)).toBe('1 1 8589934592');
    writeFileSync(join(f.directory, 'finish'), ''); await f.owner.exited;
    expect(await f.holder.exited).toBe(143);
    expect(oldReader(f.hostRoot)).toBe('0 0 0');
  } finally { await f.close(); }
});

test('custody JSON alone cannot replace boot, process birth or the original kernel lock descriptors', async () => {
  const f = await fixture();
  try {
    const file = join(f.retained, 'lease-custody.json'); const original = JSON.parse(readFileSync(file, 'utf8'));
    for (const patch of [ { ...original, boot: 'foreign' }, { ...original, holder: { ...original.holder, start: '1' } },
      { ...original, slots: original.slots.map((slot: unknown) => ({ ...(slot as object), fd: 999 })) } ]) {
      writeFileSync(file, JSON.stringify(patch)); expect(f.proof().status).not.toBe(0);
    }
    writeFileSync(file, JSON.stringify(original)); expect(f.proof().status).toBe(0);
    writeFileSync(join(f.directory, 'finish'), ''); await f.owner.exited; await f.holder.stdin.end(); await f.holder.exited;
    expect(f.proof().status).not.toBe(0);
  } finally { await f.close(); }
});

test('a replaced memory path is never removed as though it were the original reservation', async () => {
  const f = await fixture();
  try {
    const memory = join(f.hostRoot, 'slots/0.memory'); renameSync(memory, memory+'.original'); writeFileSync(memory, 'foreign\n');
    expect(f.proof().status).not.toBe(0); await f.holder.stdin.end(); await Bun.sleep(80);
    expect(f.holder.exitCode).toBeNull(); expect(readFileSync(memory, 'utf8')).toBe('foreign\n');
  } finally { await f.close(); }
});


test('stale sweep and ordinary client-final cleanup preserve kernel-proved live lease custody', async () => {
  const f = await fixture(true);
  try {
    const old = (Date.now() - 700_000) / 1000;
    utimesSync(join(f.directory, '.alive'), old, old);
    const swept = spawnSync('bash', [join(f.hostRoot, 'actual-slot-script.sh')], {
      env: { ...process.env, PATH: `${join(f.hostRoot, 'bin')}:${process.env.PATH}` },
      input: '', encoding: 'utf8', timeout: 3000,
    });
    expect(swept.status, swept.stderr).toBe(0);
    expect(f.owner.exitCode).toBeNull();
    expect(f.proof().status).toBe(0);
    const final = cleanupScript(f.run, f.directory).replaceAll('/srv/rezics-check', f.hostRoot);
    const refused = spawnSync('bash', ['-c', final], { encoding: 'utf8', timeout: 3000 });
    expect(refused.status).toBe(75);
    expect(refused.stderr).toContain('live reservation remains owned');
    expect(f.owner.exitCode).toBeNull();
    expect(f.proof().status).toBe(0);
    await f.holder.stdin.end(); writeFileSync(join(f.directory, 'finish'), ''); await f.owner.exited;
    expect(await f.holder.exited, await f.stderr).toBe(0);
  } finally { await f.close(); }
});


test('terminal release does not unlink a symlink installed over the original byte record while waiting', async () => {
  const f = await fixture();
  try {
    await f.holder.stdin.end(); await Bun.sleep(50);
    const memory = join(f.hostRoot, 'slots/0.memory');
    renameSync(memory, memory+'.original'); symlinkSync(memory+'.original', memory);
    writeFileSync(join(f.directory, 'finish'), ''); await f.owner.exited;
    expect(await f.holder.exited, await f.stderr).toBe(75);
    expect(existsSync(memory)).toBe(true);
    expect(readFileSync(memory, 'utf8')).toBe('4294967296\n');
  } finally { await f.close(); }
});
