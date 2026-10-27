import { watch } from 'node:fs';

export type Watching = { close(): void };

/**
 * Calls `listener` on changes under `path` through fs.watch, or every `pollMs` when the host has no inotify
 * instance left: a spent limit (EMFILE) ended healthy workers as environment failures and killed managers' inbox
 * waits on 2026-10-27. A watcher that fails later falls back to polling as well.
 */
export function watchOrPoll(path: string, listener: () => void, pollMs: number): Watching {
  let poll: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const startPolling = () => {
    if (!poll && !closed) poll = setInterval(listener, pollMs);
  };
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(path, () => listener());
    watcher.on('error', () => {
      watcher?.close();
      startPolling();
    });
  } catch {
    startPolling();
  }
  return {
    close() {
      closed = true;
      watcher?.close();
      if (poll) clearInterval(poll);
    },
  };
}
