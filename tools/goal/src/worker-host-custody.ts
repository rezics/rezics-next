import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { processIdentity, type ProcessIdentity } from './process.ts';
import type { WorkerStore } from './store.ts';
import type { AttemptRef } from './contracts.ts';

export type WorkerHost = { hostname: string; machineHash: string };
export type WorkerBootCustody = 'current-boot' | 'previous-local-boot' | 'unknown-host';
export const HOST_INTERRUPTION_EVENT = 'worker-host-interrupted';
export const HOST_INTERRUPTION_RETAINED = 'Worker host interruption retained:';
export const HOST_INTERRUPTION_RESUME_PROMPT =
  'The previous worker was interrupted by a confirmed reboot of this same host. Continue this same session from its existing branch and worktree. Preserve completed commands, committed and uncommitted source, and registered checks; inspect their retained outcomes before repeating work. Finish with the required exit object.';

function validHost(value: unknown): value is WorkerHost {
  const host = value as WorkerHost | null;
  return Boolean(host && typeof host.hostname === 'string' && host.hostname && /^[a-f0-9]{64}$/.test(host.machineHash));
}
function sameHost(left: WorkerHost, right: WorkerHost): boolean {
  return left.hostname === right.hostname && left.machineHash === right.machineHash;
}
export function localWorkerHost(): WorkerHost | null {
  try {
    const machine = readFileSync('/etc/machine-id', 'utf8').trim();
    if (!/^[a-f0-9]{32}$/.test(machine)) return null;
    return { hostname: hostname(), machineHash: createHash('sha256').update(machine).digest('hex') };
  } catch {
    return null;
  }
}
const journalHosts = new Map<string, WorkerHost | null>();
/** A bounded local journal observation can establish legacy boot provenance without trusting PID numbers. */
function journalHost(boot: string): WorkerHost | null {
  if (!/^[a-f0-9-]{36}$/i.test(boot)) return null;
  if (journalHosts.has(boot)) return journalHosts.get(boot) ?? null;
  const run = spawnSync(
    'journalctl',
    [
      `--boot=${boot.replaceAll('-', '')}`,
      '-n',
      '1',
      '--no-pager',
      '-o',
      'json',
      '--output-fields=_BOOT_ID,_MACHINE_ID,_HOSTNAME',
    ],
    { encoding: 'utf8', timeout: 1000, maxBuffer: 16_384 },
  );
  if (run.status !== 0) {
    journalHosts.set(boot, null);
    return null;
  }
  try {
    const row = JSON.parse(run.stdout);
    if (row._BOOT_ID !== boot.replaceAll('-', '') || !/^[a-f0-9]{32}$/.test(row._MACHINE_ID) || !row._HOSTNAME)
      return null;
    const host = {
      hostname: String(row._HOSTNAME),
      machineHash: createHash('sha256').update(row._MACHINE_ID).digest('hex'),
    };
    journalHosts.set(boot, host);
    return host;
  } catch {
    journalHosts.set(boot, null);
    return null;
  }
}
export function workerBootCustody(
  identity: ProcessIdentity | null,
  recordedHost: unknown,
  currentBoot: string | null,
  currentHost: WorkerHost | null = localWorkerHost(),
  legacyHost: (boot: string) => WorkerHost | null = journalHost,
): WorkerBootCustody {
  if (!identity || !currentBoot) return 'unknown-host';
  if (
    recordedHost !== undefined &&
    recordedHost !== null &&
    (!validHost(recordedHost) || !currentHost || !sameHost(recordedHost, currentHost))
  )
    return 'unknown-host';
  if (identity.boot === currentBoot) return 'current-boot';
  if (!currentHost) return 'unknown-host';
  const origin = validHost(recordedHost) ? recordedHost : legacyHost(identity.boot);
  return origin && sameHost(origin, currentHost) ? 'previous-local-boot' : 'unknown-host';
}

/** Observe before waiting on or signaling a PID that may now belong to another boot/host. */
export function recordedWorkerBootCustody(
  store: WorkerStore,
  ref: AttemptRef & { process: ProcessIdentity | null },
): WorkerBootCustody {
  const event = store.events(ref.taskId, ref.attempt).findLast((event) => event.kind === 'worker-run-started');
  let host: unknown;
  try {
    host = event ? JSON.parse(event.body).workerHost : undefined;
  } catch {
    /* Unknown provenance stays unknown. */
  }
  return workerBootCustody(ref.process, host, processIdentity()?.boot ?? null);
}

export function pendingHostInterruption(
  store: WorkerStore,
  ref: AttemptRef,
): { nextResumeAt: string; line: string } | null {
  const events = store.events(ref.taskId, ref.attempt);
  const lastRun = events.findLast((event) => event.kind === 'worker-run-started');
  const interrupted = events.findLast((event) => event.kind === HOST_INTERRUPTION_EVENT);
  if (!interrupted || (lastRun && lastRun.sequence > interrupted.sequence)) return null;
  try {
    const value = JSON.parse(interrupted.body);
    return value.resume === true && typeof value.nextResumeAt === 'string' && typeof value.line === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

/** rmcp's transport worker is not the Codex CLI; preserve its raw stderr without inventing a CLI/OOM cause. */
export function primaryWorkerStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !/rmcp::transport::worker: worker quit with fatal: Transport channel closed/i.test(line))
    .join('\n');
}
