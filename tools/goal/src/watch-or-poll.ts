import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';

export type Watching = { close(): void };

/**
 * Calls `listener` on changes under `path` through fs.watch, or every `pollMs` when the host has no inotify
 * instance left: a spent limit (EMFILE) ended healthy workers as environment failures and killed managers' inbox
 * waits on 2026-10-27. A watcher that fails later falls back to polling as well. The parent is watched so a replaced
 * path is re-attached; fs.watch otherwise stays on the old inode without an error.
 */
export function watchOrPoll(path: string, listener: () => void, pollMs: number): Watching {
  let poll: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let watcher: ReturnType<typeof watch> | undefined;
  let parent: ReturnType<typeof watch> | undefined;
  const name = basename(path);
  const emit = () => {
    if (!closed) listener();
  };
  const startPolling = () => {
    if (!poll && !closed) poll = setInterval(emit, pollMs);
  };
  const watchPath = () => {
    if (closed || poll) return;
    watcher?.close();
    watcher = undefined;
    try {
      watcher = watch(path, emit);
      if (closed) {
        watcher.close();
        watcher = undefined;
        return;
      }
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
        watchPath();
        if (!watcher && !parent) startPolling();
      });
    } catch {
      /* Parent events re-attach when the path exists again. */
    }
  };
  try {
    parent = watch(dirname(path), (_event, filename) => {
      if (filename != null && `${filename}` !== name) return;
      watchPath();
      emit();
    });
    if (closed) {
      parent.close();
      parent = undefined;
    } else {
      parent.on('error', () => {
        parent?.close();
        parent = undefined;
        if (!watcher) startPolling();
      });
    }
  } catch {
    /* Poll if the path also cannot be watched. */
  }
  watchPath();
  if (!watcher && !parent) startPolling();
  return {
    close() {
      closed = true;
      watcher?.close();
      parent?.close();
      watcher = undefined;
      parent = undefined;
      if (poll) clearInterval(poll);
    },
  };
}
