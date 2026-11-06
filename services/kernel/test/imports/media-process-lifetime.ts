/** Only processes spawned with detached:true belong to these private groups. */
export function signalBoundaryGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // Exit can win the race with either cancellation signal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Bootstrap may never settle, so termination cannot depend on its promise. */
export async function stopBoundaryProcess(
  child: Pick<Bun.Subprocess, 'pid' | 'exited'>,
  graceMs = 5_000,
): Promise<void> {
  signalBoundaryGroup(child.pid, 'SIGTERM');
  const timer = setTimeout(() => signalBoundaryGroup(child.pid, 'SIGKILL'), graceMs);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
    // A compiler child may still own a pipe after its immediate parent exits.
    signalBoundaryGroup(child.pid, 'SIGKILL');
  }
}
