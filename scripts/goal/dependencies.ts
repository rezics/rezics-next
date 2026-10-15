import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';

function stamp(cwd: string): string { return join(cwd, 'node_modules/.rezics-dependencies'); }

/** Content, rather than checkout times, survives rebases and restored dependency trees. */
export function dependencyDigest(cwd: string): string | undefined {
  if (!existsSync(join(cwd, 'yarn.lock'))) return;
  const inventory = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'yarn.lock', 'package.json', '**/package.json', '.yarn/patches/**'], { cwd, encoding: 'utf8' });
  if (inventory.status !== 0) throw new Error(`Unable to inventory dependency inputs in ${cwd}: ${inventory.stderr}`);
  // Ignored build output and QA snapshots are not dependency inputs for this checkout.
  const files = [...new Set(inventory.stdout.split('\0').filter(file => file && existsSync(join(cwd, file))))];
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(join(cwd, file))).update('\0');
  return hash.digest('hex');
}

export function recordDependencyInstall(cwd: string): void {
  const digest = dependencyDigest(cwd);
  if (!digest) return;
  mkdirSync(join(cwd, 'node_modules'), { recursive: true });
  const temporary = `${stamp(cwd)}.${process.pid}`;
  writeFileSync(temporary, digest);
  renameSync(temporary, stamp(cwd));
}

export function dependencyInstallIsStale(cwd: string): boolean {
  const digest = dependencyDigest(cwd);
  return digest !== undefined && (!existsSync(stamp(cwd)) || readFileSync(stamp(cwd), 'utf8') !== digest);
}

/** One installer per checkout; failed installs leave the previous digest untouched. */
export function ensureDependencies(cwd: string): void {
  if (!dependencyInstallIsStale(cwd)) return;
  mkdirSync(join(cwd, '.temp'), { recursive: true });
  const deadline = Date.now() + 600_000;
  for (;;) {
    const lease = tryAcquireDirectoryLease(join(cwd, '.temp/dependency-install.lock'));
    if (lease !== 'held') {
      try {
        if (!dependencyInstallIsStale(cwd)) return;
        console.log(`Dependencies changed in ${cwd}; running task install`);
        const result = spawnSync('task', ['install'], { cwd, encoding: 'utf8', timeout: 300_000 });
        if (result.status !== 0) throw new Error(`Dependency install failed in ${cwd}:\n${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
        recordDependencyInstall(cwd);
        return;
      } finally { lease.release(); }
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for dependency install in ${cwd}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

if (import.meta.main) recordDependencyInstall(process.cwd());
