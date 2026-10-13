import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const processes = 16;
const iterations = 200;

for (const kind of ['directory', 'ledger', 'shares'] as const) {
  test(`${kind} lease tolerates concurrent readers and releases while excluding writers`, async () => {
    const scratch = join(import.meta.dir, '../../.temp/lease-contention');
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, `${kind}-`));
    const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];
    try {
      // withLedger derives its state directory from Git; never use the live ledger.
      expect(spawnSync('git', ['init', '-q', directory]).status).toBe(0);
      const counter = join(directory, 'counter');
      writeFileSync(counter, '0');
      const source = join(directory, 'contender.ts');
      writeFileSync(source, `
        import { existsSync, readFileSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { directoryLeaseHeld, readDirectoryLease, tryAcquireDirectoryLease }
          from ${JSON.stringify(join(import.meta.dir, '../qa/process/lease.ts'))};
        const kind = ${JSON.stringify(kind)};
        const { withLedger } = kind === 'ledger'
          ? await import(${JSON.stringify(join(import.meta.dir, 'ledger.ts'))}) : {};
        const { tryAcquireQaSlot } = kind === 'shares'
          ? await import(${JSON.stringify(join(import.meta.dir, 'admission.ts'))}) : {};
        const directory = process.cwd();
        const slotDirectory = join(directory, 'slots');
        const lock = kind === 'ledger' ? join(directory, '.temp/goal-orchestration/ledger.lock')
          : kind === 'shares' ? join(slotDirectory, 'shares') : join(directory, 'lease');
        const id = Number(process.argv[2]);
        const counter = join(directory, 'counter');
        const increment = () => {
          const value = Number(readFileSync(counter, 'utf8'));
          if (!Number.isSafeInteger(value)) throw new Error('invalid counter');
          writeFileSync(counter, String(value + 1));
        };
        const inspect = () => {
          if (id % 2 === 0) {
            directoryLeaseHeld(lock);
            readDirectoryLease(lock);
            if (kind === 'shares') readDirectoryLease(join(slotDirectory, '0'));
          }
        };
        writeFileSync(join(directory, 'ready-' + id), 'ready');
        while (!existsSync(join(directory, 'start'))) await Bun.sleep(1);
        const deadline = Date.now() + 90_000;
        for (let iteration = 0; iteration < ${iterations}; iteration++) {
          inspect();
          if (kind === 'ledger') {
            await withLedger(ledger => {
              increment();
              ledger.contentionCount = (ledger.contentionCount ?? 0) + 1;
            });
            continue;
          }
          for (;;) {
            if (Date.now() > deadline) throw new Error('contention timed out');
            inspect();
            const lease = kind === 'shares'
              ? tryAcquireQaSlot(slotDirectory, 1, 0, { env: { GOAL_ID: 'program' }, workerGoals: () => [] })
              : tryAcquireDirectoryLease(lock);
            if (lease === 'held') continue;
            try { increment(); } finally { lease.release(); }
            break;
          }
        }
      `);
      for (let index = 0; index < processes; index++) {
        children.push(Bun.spawn([process.execPath, source, String(index)], {
          cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        }));
      }
      const deadline = Date.now() + 30_000;
      while (!children.every((_child, index) => existsSync(join(directory, `ready-${index}`)))) {
        if (Date.now() > deadline || children.some(child => child.exitCode !== null))
          throw new Error('contenders failed to reach the start barrier');
        await Bun.sleep(10);
      }
      writeFileSync(join(directory, 'start'), 'start');
      const results = await Promise.all(children.map(async child => {
        const [code, stderr, stdout] = await Promise.all([
          child.exited, new Response(child.stderr).text(), new Response(child.stdout).text(),
        ]);
        return { code, stderr, stdout };
      }));
      expect(results.filter(result => result.code !== 0)).toEqual([]);
      expect(Number(readFileSync(counter, 'utf8'))).toBe(processes * iterations);
      if (kind === 'ledger') {
        const ledger = JSON.parse(readFileSync(join(directory, '.temp/goal-orchestration/ledger.json'), 'utf8')) as { contentionCount: number };
        expect(ledger.contentionCount).toBe(processes * iterations);
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map(child => child.exited));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
}
