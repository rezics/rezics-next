import { defaultOverlayShortcut, isOverlayShortcut, type OverlayPreferences } from '@rezics/launcher-contract';
import { join } from 'node:path';
import { fileInfo, readJson, writeJson } from './storage.ts';

export async function openOverlayPreferences(dataDir: string) {
  const path = join(dataDir, 'overlay-preferences.json');
  const file = await fileInfo(path).catch(() => undefined);
  const stored =
    file?.isFile() && file.size <= 1024
      ? await readJson<{ enabled?: unknown; shortcut?: unknown }>(path).catch(() => undefined)
      : undefined;
  const value: OverlayPreferences = {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : true,
    shortcut: isOverlayShortcut(stored?.shortcut) ? stored.shortcut : defaultOverlayShortcut,
  };
  return {
    value,
    async save(preferences: OverlayPreferences) {
      try {
        await writeJson(path, preferences);
      } catch {
        throw new Error('Could not save Overlay settings. Try again.');
      }
    },
  };
}
