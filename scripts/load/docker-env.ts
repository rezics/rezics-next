import { spawnSync } from 'node:child_process';

/** Match stack:up's Docker selection before inspecting its containers. */
export function loadDockerEnvironment(env: NodeJS.ProcessEnv = process.env,
  probe: (candidate: NodeJS.ProcessEnv) => boolean = candidate =>
    spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
      { env: candidate, encoding: 'utf8', timeout: 10_000 }).status === 0): NodeJS.ProcessEnv {
  const selected = { ...env };
  if (!probe(selected)) throw new Error('Docker is unavailable; start it with `systemctl --user start docker-desktop`');
  return selected;
}

/**
 * How a container reaches a service bound to the host's loopback. Docker Desktop
 * runs containers in a VM whose host network is not this machine's, so it uses
 * its host-gateway alias; a native engine shares host networking.
 */
export function hostLoopbackAccess(env: NodeJS.ProcessEnv,
  operatingSystem: (candidate: NodeJS.ProcessEnv) => string = candidate =>
    spawnSync('docker', ['info', '--format', '{{.OperatingSystem}}'],
      { env: candidate, encoding: 'utf8', timeout: 10_000 }).stdout.trim()): { args: string[]; host: string } {
  return operatingSystem(env).includes('Docker Desktop')
    ? { args: ['--add-host=host.docker.internal:host-gateway'], host: 'host.docker.internal' }
    : { args: ['--network', 'host'], host: '127.0.0.1' };
}
