import { spawnSync } from 'node:child_process';

/** A compose project started with the process environment and no reap owner. */
export function bareCompose(cwd: string): void {
  spawnSync('docker', ['compose', 'up', '-d'], { cwd, env: process.env });
}
