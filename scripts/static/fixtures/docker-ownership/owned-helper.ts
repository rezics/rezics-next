import { spawnSync } from 'node:child_process';
import { preserveReapEnvironment } from '../../../qa/container-reaper.ts';

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', env: preserveReapEnvironment(process.env) });
  return result.stdout;
}

export function listContainers(): string {
  return docker(['ps', '-a']);
}
