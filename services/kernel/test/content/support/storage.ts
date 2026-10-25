import { createHash } from 'node:crypto';
import type { MediaStorage } from '../../../src/content/media-storage.ts';

export class StorageDeleteFailure extends Error {}

/** External bytes only. No database or media lifecycle knowledge belongs here. */
export function createMediaStorage() {
  const objects = new Map<string, Uint8Array>();
  const failures = new Set<string>();
  const storage: MediaStorage = {
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? Uint8Array.from(bytes) : null;
    },
    async put(key, bytes) {
      objects.set(key, Uint8Array.from(bytes));
    },
    async deletePrefix(prefix) {
      const failed = [...failures].find((key) => key.startsWith(prefix));
      if (failed) {
        failures.delete(failed);
        throw new StorageDeleteFailure(`Storage deletion failed for ${failed}`);
      }
      for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
    },
  };
  return {
    storage,
    failDelete(key: string) {
      failures.add(key);
    },
    inspect() {
      return [...objects]
        .map(([key, bytes]) => ({ key, sha256: createHash('sha256').update(bytes).digest('hex') }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    close() {
      objects.clear();
      failures.clear();
    },
  };
}
