import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const managerModule = pathToFileURL(join(import.meta.dir, 'manager-commands.ts')).href;
const cwd = join(import.meta.dir, '../..');

function fixture() {
  const parent = join(cwd, '.temp/coordinator-pass-tests');
  mkdirSync(parent, {recursive:true});
  const dir = mkdtempSync(join(parent, 'case-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const launcher = join(bin, 'systemd-run');
  // This binary stands in for the host facility, never for a Goal module.
  writeFileSync(launcher, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  chmodSync(launcher, 0o755);
  const module = join(dir, 'pass.ts');
  const entry = join(dir, 'supervisor.ts');
  const calls = join(dir, 'calls');
  const env = {...process.env, PATH:`${bin}:${process.env.PATH}`, GOAL_MAIL_STATE_DIR:dir};
  let child: ChildProcess | undefined;
  let output = '';
  let error = '';
  let notify: (() => void) | undefined;
  let exit: Promise<number | null> | undefined;
  return {dir,module,calls,launcher,
    writePass(source: string) { writeFileSync(module, source); },
    launch(source: string) {
      writeFileSync(entry, source);
      child = spawn(process.execPath, [entry], {cwd,env,stdio:['ignore','pipe','pipe']});
      child.stdout!.on('data', chunk => { output += String(chunk); notify?.(); });
      child.stderr!.on('data', chunk => { error += String(chunk); notify?.(); });
      exit = new Promise((resolveExit, reject) => {
        child!.once('error', reject);
        child!.once('exit', code => { resolveExit(code); notify?.(); });
      });
    },
    supervisor(interval = 100) {
      this.launch(`import { coordinatorSupervisor } from ${JSON.stringify(managerModule)};
        await coordinatorSupervisor(${JSON.stringify(dir)}, {interval:${interval},module:${JSON.stringify(module)}});`);
    },
    async waitForSecondPass() {
      await new Promise<void>((resolveReady,reject) => {
        const timer = setTimeout(() => { notify = undefined; reject(new Error(`No second pass: ${output}\n${error}`)); },5000);
        notify = () => {
          if (output.includes('second pass')) { clearTimeout(timer); notify = undefined; resolveReady(); }
          else if (child!.exitCode !== null) { clearTimeout(timer); notify = undefined; reject(new Error(`Supervisor exited: ${error}`)); }
        };
        notify();
      });
    },
    async stop() { child!.kill('SIGTERM'); return await exit; },
    async exited() { return await exit; },
    output: () => output,
    error: () => error,
    async close() {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
      rmSync(dir, {recursive:true,force:true});
    },
  };
}

for (const ending of ['exit', 'signal'] as const) {
  test(`the supervisor reports a pass ${ending}, runs the next pass, and stops during the interval`, async () => {
    const f = fixture();
    try {
      f.writePass(`import { readFileSync, writeFileSync, existsSync } from 'node:fs';
        export function coordinatorPass() {
          const file = ${JSON.stringify(f.calls)};
          const n = existsSync(file) ? Number(readFileSync(file,'utf8')) + 1 : 1;
          writeFileSync(file,String(n));
          if (n === 1) {
            console.error('earlier detail'); console.error('last failure detail');
            ${ending === 'exit' ? 'process.exit(1);' : "process.kill(process.pid,'SIGTERM');"}
          }
          console.log('second pass');
        }`);
      f.supervisor(1000);
      await f.waitForSecondPass();
      // A long interval makes an uninterruptible sleep fail this assertion.
      const start = Date.now();
      expect(await f.stop()).toBe(0);
      expect(Date.now() - start).toBeLessThan(750);
      expect(readFileSync(f.calls,'utf8')).toBe('2');
      const code = ending === 'exit' ? 1 : 143;
      const line = `Coordinator pass exited ${code}: last failure detail`;
      expect(f.error().split('\n').filter(value => value.startsWith('Coordinator pass exited'))).toEqual([line]);
      const stored = JSON.parse(readFileSync(join(f.dir,'coordinator-last-failed-pass.json'),'utf8')) as {at:string;line:string};
      expect(stored.line).toBe(line);
      expect(Number.isFinite(Date.parse(stored.at))).toBe(true);
      f.launch(`import { coordinatorCommand } from ${JSON.stringify(managerModule)}; await coordinatorCommand(['status']);`);
      expect(await f.exited()).toBe(0);
      // Capture only status; the earlier pass output remains in this fixture's buffer.
      const status = JSON.parse(f.output().slice(f.output().indexOf('{'))) as {lastFailedPass:unknown};
      expect(status.lastFailedPass).toEqual(stored);
    } finally { await f.close(); }
  },10000);
}

test('a scope startup failure falls back once and reports why', async () => {
  const f = fixture();
  try {
    writeFileSync(f.launcher,'#!/bin/sh\necho "user bus unavailable" >&2\nexit 1\n');
    f.writePass(`import { writeFileSync } from 'node:fs'; export function coordinatorPass() { writeFileSync(${JSON.stringify(f.calls)},'ran'); }`);
    f.launch(`import { freshCoordinatorPass } from ${JSON.stringify(managerModule)};
      console.log(JSON.stringify(await freshCoordinatorPass(${JSON.stringify(f.dir)},${JSON.stringify(f.module)},'0::/example.service')));`);
    expect(await f.exited()).toBe(0);
    expect(readFileSync(f.calls,'utf8')).toBe('ran');
    expect(f.error()).toContain('Coordinator pass scope unavailable; running in supervisor group: user bus unavailable');
    expect(JSON.parse(f.output()).code).toBe(0);
  } finally { await f.close(); }
});

test('a scoped pass failure is returned without retrying its work', async () => {
  const f = fixture();
  try {
    f.writePass(`import { appendFileSync } from 'node:fs'; export function coordinatorPass() { appendFileSync(${JSON.stringify(f.calls)},${JSON.stringify('ran\n')}); console.error('pass failed'); process.exit(1); }`);
    f.launch(`import { freshCoordinatorPass } from ${JSON.stringify(managerModule)};
      console.log(JSON.stringify(await freshCoordinatorPass(${JSON.stringify(f.dir)},${JSON.stringify(f.module)},'0::/example.service')));`);
    expect(await f.exited()).toBe(0);
    expect(readFileSync(f.calls,'utf8')).toBe('ran\n');
    expect(JSON.parse(f.output())).toEqual({code:1,lastError:'pass failed'});
    expect(f.error()).not.toContain('scope unavailable');
  } finally { await f.close(); }
});

test('an ordinary shell launches directly without invoking a scope launcher', async () => {
  const f = fixture();
  try {
    writeFileSync(f.launcher,'#!/bin/sh\necho "unexpected scope" >&2\nexit 1\n');
    f.writePass(`export function coordinatorPass() { console.log('direct'); }`);
    f.launch(`import { freshCoordinatorPass } from ${JSON.stringify(managerModule)};
      await freshCoordinatorPass(${JSON.stringify(f.dir)},${JSON.stringify(f.module)},'0::/');`);
    expect(await f.exited()).toBe(0);
    expect(f.output()).toBe('direct\n');
    expect(f.error()).toBe('');
    expect(existsSync(join(f.dir,'coordinator-last-failed-pass.json'))).toBe(false);
  } finally { await f.close(); }
});
