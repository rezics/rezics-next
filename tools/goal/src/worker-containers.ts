import { spawnSync } from 'node:child_process';

const ATTEMPT_LABEL = 'rezics.worker.attempt';
function logRemovalError(message: string): void {
  try {
    console.error(message);
  } catch {
    // Even a closed diagnostic stream must not keep an attempt from settling.
  }
}

/** Remove only containers owned by this exact worker attempt. Docker failures are diagnostic, not settlement failures. */
export function removeAttemptContainers(taskId: string, attempt: number): void {
  const label = `${ATTEMPT_LABEL}=${taskId}/${attempt}`;
  try {
    const listed = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8' });
    if (listed.error || listed.status !== 0) {
      logRemovalError(`Could not list worker containers for ${label}: ${listed.error ?? listed.stderr ?? listed.status}`);
      return;
    }
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return;
    const removed = spawnSync('docker', ['rm', '-f', ...ids], { encoding: 'utf8' });
    if (removed.error || removed.status !== 0)
      logRemovalError(`Could not remove worker containers for ${label}: ${removed.error ?? removed.stderr ?? removed.status}`);
  } catch (error) {
    logRemovalError(`Could not remove worker containers for ${label}: ${String(error)}`);
  }
}
