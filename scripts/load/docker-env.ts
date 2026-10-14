import { spawnSync } from 'node:child_process';
import { preserveReapEnvironment } from '../qa/container-reaper.ts';

type DockerInfoProbe = (candidate: NodeJS.ProcessEnv, timeoutMs: number) => string | undefined;

export interface DockerProbeClock {
  now?: () => number;
  sleep?: (milliseconds: number) => void;
}

const unavailableMessage = 'Docker is unavailable; start it with `systemctl --user start docker-desktop`';

function dockerInfo(field: string): DockerInfoProbe {
  return (candidate, timeoutMs) => {
    const info = spawnSync('docker', ['info', '--format', `{{.${field}}}`],
      { env: candidate, encoding: 'utf8', timeout: timeoutMs });
    return info.status === 0 ? info.stdout.trim() : undefined;
  };
}

/** A busy engine may outlast one client request. Every request and backoff shares
 * one deadline; an answered empty field is a stopped engine, not a slow request. */
function waitForDockerInfo(env: NodeJS.ProcessEnv, probe: DockerInfoProbe, clock: DockerProbeClock): string {
  const now = clock.now ?? (() => performance.now());
  const sleep = clock.sleep ?? (milliseconds => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  });
  const deadline = now() + 60_000;
  let backoffMs = 250;
  while (true) {
    const remainingMs = Math.floor(deadline - now());
    if (remainingMs <= 0) throw new Error(unavailableMessage);
    const value = probe(env, Math.min(10_000, remainingMs));
    if (value !== undefined) {
      if (value.trim() === '') throw new Error(unavailableMessage);
      return value;
    }
    const waitMs = Math.min(backoffMs, deadline - now());
    if (waitMs <= 0) throw new Error(unavailableMessage);
    sleep(waitMs);
    backoffMs = Math.min(backoffMs * 2, 2_000);
  }
}

/** Match stack:up's Docker selection before inspecting its containers. Docker
 * Desktop 4.90.0 exits 0 with an empty version while its engine is down. */
export function loadDockerEnvironment(env: NodeJS.ProcessEnv = process.env,
  probe: (candidate: NodeJS.ProcessEnv, timeoutMs: number) => boolean | string | undefined = dockerInfo('ServerVersion'),
  clock: DockerProbeClock = {}): NodeJS.ProcessEnv {
  const selected = preserveReapEnvironment(env);
  waitForDockerInfo(selected, (candidate, timeoutMs) => {
    const result = probe(candidate, timeoutMs);
    if (typeof result === 'boolean') return result ? 'available' : undefined;
    return result;
  }, clock);
  return selected;
}

/**
 * How a container reaches a service bound to the host's loopback. Docker Desktop
 * runs containers in a VM whose host network is not this machine's, so it uses
 * its host-gateway alias; a native engine shares host networking.
 */
export function hostLoopbackAccess(env: NodeJS.ProcessEnv,
  operatingSystem: DockerInfoProbe = dockerInfo('OperatingSystem'),
  clock: DockerProbeClock = {}): { args: string[]; host: string } {
  return waitForDockerInfo(env, operatingSystem, clock).includes('Docker Desktop')
    ? { args: ['--add-host=host.docker.internal:host-gateway'], host: 'host.docker.internal' }
    : { args: ['--network', 'host'], host: '127.0.0.1' };
}
