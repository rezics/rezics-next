import type { ApplyIntent, ApplyProgress, ImportApi } from '../import-api.ts';

const POLL_INTERVAL_MS = 1000;
const waitForProgress = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** Accepted work stays pending until Main completes it or refuses it. Leaving the import stops polling. */
export async function pollLibraryApply(api: Pick<ImportApi, 'apply'>, id: string, intent: ApplyIntent, {
  onProgress, active, wait = waitForProgress,
}: {
  onProgress: (progress: ApplyProgress) => void;
  active: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<ApplyProgress | null> {
  while (active()) {
    const progress = await api.apply(id, intent);
    if (!active()) return null;
    onProgress(progress);
    if (!progress.pending) return progress;
    // An unchanged count can mean an owner command is still running; it is not a refusal.
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}
