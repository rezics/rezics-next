import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { rewritePrincipalSubjectFormat } from '../../services/main/src/operations/format-upgrade.ts';
import { projectName, readEnv, stackDirectory, type StackOptions } from './config.ts';
import { readFormatMarker, saveFormatMarker } from './install.ts';

const root = resolve(import.meta.dir, '../..');

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker format fence failed: ${(result.stderr || result.error?.message || '').slice(-500)}`);
  }
  return result.stdout.trim();
}

function stopGraphWriter(options: StackOptions): void {
  const filter = [`label=com.docker.compose.project=${projectName(options)}`,
    'label=com.docker.compose.service=fuseki'];
  const container = docker(['ps', '-q', '--filter', filter[0]!, '--filter', filter[1]!]);
  if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('Fuseki writer is not running');
  docker(['stop', '--time', '10', container]);
  if (docker(['ps', '-q', '--filter', filter[0]!, '--filter', filter[1]!])) {
    throw new Error('Fuseki writer did not stop');
  }
}

/** Operator-only offline step. The caller must retain a stopped recovery cut
 * and stop application writers before invoking it. The failed candidate remains
 * fenced and is never admitted by the version-one installer. */
export async function upgradeAccessSubjectFormat(options: StackOptions,
  failurePoint?: 'after-rewrite-commit'): Promise<void> {
  const marker = readFormatMarker(options);
  if (!marker || marker.state !== 'ready' || marker.formatVersion !== 1) {
    throw new Error('No qualified version-one release to upgrade');
  }
  const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
  await rewritePrincipalSubjectFormat({ accessUrl: apps.ACCESS_DATABASE_URL! }, async () => {
    saveFormatMarker(options, { ...marker, state: 'upgrade-pending', targetFormatVersion: 2 });
    stopGraphWriter(options);
  },
  failurePoint);
}
