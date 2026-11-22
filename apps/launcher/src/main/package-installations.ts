import type { PackageInstallControl, PackageInstallProgress } from '@rezics/launcher-contract';

export function createPackageInstallations(publish?: (attemptId: string, progress: PackageInstallProgress) => void) {
  const active = new Map<string, { controller: AbortController; cancellable: boolean; settled: Promise<void> }>();

  function cancel(attemptId: string) {
    const attempt = active.get(attemptId);
    if (!attempt?.cancellable) return false;
    attempt.cancellable = false;
    attempt.controller.abort(new Error('Package installation cancelled.'));
    return true;
  }

  return {
    async run(attemptId: string, install: (control: PackageInstallControl) => Promise<void>) {
      if (active.has(attemptId)) throw new Error('That package installation is already running.');
      const controller = new AbortController();
      const finished = Promise.withResolvers<void>();
      const attempt = { controller, cancellable: true, settled: finished.promise };
      const { signal } = controller;
      active.set(attemptId, attempt);
      try {
        await install({
          signal,
          beginCommit: () => {
            attempt.cancellable = false;
          },
          report(progress) {
            if (!signal.aborted) publish?.(attemptId, progress);
          },
        });
        return true;
      } catch (error) {
        if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) {
          return false;
        }
        throw error;
      } finally {
        active.delete(attemptId);
        finished.resolve();
      }
    },
    cancel,
    async abandon() {
      const pending = [...active];
      for (const [id] of pending) cancel(id);
      await Promise.all(pending.map(([, attempt]) => attempt.settled));
    },
  };
}
