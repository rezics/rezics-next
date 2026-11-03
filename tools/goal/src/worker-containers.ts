import { spawnSync } from 'node:child_process';
import { defaultPolicy } from './policy.ts';

const ATTEMPT_LABEL = 'rezics.worker.attempt';
function logRemovalError(message: string): void {
  try {
    console.error(message);
  } catch {
    // Even a closed diagnostic stream must not keep an attempt from settling.
  }
}

/** Remove only containers owned by this exact worker attempt. Docker failures are diagnostic, not settlement failures. */
export function removeAttemptContainers(taskId: string, attempt: number, policy = defaultPolicy.containers): void {
  const label = `${ATTEMPT_LABEL}=${taskId}/${attempt}`;
  try {
    const listed = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], {
      encoding: 'utf8',
      timeout: policy.commandTimeoutMs,
    });
    if (listed.error || listed.status !== 0) {
      const reason =
        listed.error?.message || listed.stderr?.trim() || (listed.status === null ? 'timed out' : listed.status);
      logRemovalError(`Could not list worker containers for ${label}: ${reason}`);
      return;
    }
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return;
    const removed = spawnSync('docker', ['rm', '-f', '-v', ...ids], {
      encoding: 'utf8',
      timeout: policy.commandTimeoutMs,
    });
    if (removed.error || removed.status !== 0) {
      const reason =
        removed.error?.message || removed.stderr?.trim() || (removed.status === null ? 'timed out' : removed.status);
      logRemovalError(`Could not remove worker containers for ${label}: ${reason}`);
    }
  } catch (error) {
    logRemovalError(`Could not remove worker containers for ${label}: ${String(error)}`);
  }
}
