import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync } from 'node:fs';

interface ComposeMount { type: string; source?: string }
interface ComposeConfig { services: Record<string, { volumes?: ComposeMount[] }> }

/** Native containers read checkout files as their own users. Resolve the active
 * overlays so new file binds receive the same preparation without a second list.
 * Directory binds and files outside the mount list retain their permissions. */
export function prepareComposeFileMounts(root: string, args: string[], env: NodeJS.ProcessEnv): void {
  const up = args.indexOf('up');
  if (args[0] !== 'compose' || up < 0) return;
  const result = spawnSync('docker', [...args.slice(0, up), 'config', '--format', 'json'], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  });
  // Compose output can contain interpolated secrets; never include it in errors.
  if (result.error || result.status !== 0) throw new Error('Unable to resolve Compose file bind mounts');
  const config = JSON.parse(result.stdout) as ComposeConfig;
  const sources = new Set(Object.values(config.services).flatMap(service =>
    (service.volumes ?? []).filter(mount => mount.type === 'bind' && mount.source)
      .map(mount => mount.source!)));
  for (const source of sources) {
    if (!statSync(source).isFile()) continue;
    const script = source.endsWith('.sh') || readFileSync(source).subarray(0, 2).toString() === '#!';
    chmodSync(source, script ? 0o755 : 0o644);
  }
}
