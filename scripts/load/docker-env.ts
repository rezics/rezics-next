import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Match stack:up's Docker-first selection before inspecting its containers. */
export function loadDockerEnvironment(env: NodeJS.ProcessEnv = process.env,
  probe: (candidate: NodeJS.ProcessEnv) => boolean = candidate =>
    spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
      { env: candidate, encoding: 'utf8', timeout: 10_000 }).status === 0,
  socketExists: (path: string) => boolean = existsSync): NodeJS.ProcessEnv {
  const selected = { ...env };
  if (probe(selected)) return selected;
  const socket = join(env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
    'podman/podman.sock');
  if (!socketExists(socket)) throw new Error('No Docker-compatible daemon is available');
  const fallback = { ...selected, DOCKER_HOST: `unix://${socket}` };
  if (!probe(fallback)) throw new Error('Podman socket is not responding');
  return fallback;
}

/**
 * How a container reaches a service bound to the host's loopback. Docker Desktop
 * runs containers in a VM whose host network is not this machine's, so it uses
 * its host-gateway alias; native engines and rootless Podman share host networking.
 */
export function hostLoopbackAccess(env: NodeJS.ProcessEnv,
  operatingSystem: (candidate: NodeJS.ProcessEnv) => string = candidate =>
    spawnSync('docker', ['info', '--format', '{{.OperatingSystem}}'],
      { env: candidate, encoding: 'utf8', timeout: 10_000 }).stdout.trim()): { args: string[]; host: string } {
  return operatingSystem(env).includes('Docker Desktop')
    ? { args: ['--add-host=host.docker.internal:host-gateway'], host: 'host.docker.internal' }
    : { args: ['--network', 'host'], host: '127.0.0.1' };
}
