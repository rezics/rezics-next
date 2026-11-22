import { maxVisualNovelSubjectQueryLength, type LauncherApi } from '@rezics/launcher-contract';
import { randomUUID } from 'node:crypto';
import type { DesktopVisualNovelCandidate, DesktopVisualNovelScan, Picker } from '../../shared/desktop';
import type { PluginDesktopCommand } from '../../shared/desktop-commands';
import type { LauncherHost } from '../host';
import type { DesktopPluginEntries, PickOpenPath } from '../rpc-types';
import { optionalText, record, text, visualNovelSettingsPatch, visualNovelSettingsReview } from '../rpc-values';

type VisualNovelPort = Pick<
  LauncherApi,
  Extract<PluginDesktopCommand<'visual-novel'>, keyof LauncherApi> | 'discoverVisualNovels'
>;

export function visualNovelDesktop(
  core: VisualNovelPort,
  chosen: (value: unknown, field: Picker) => string,
  clearPaths: () => void,
  pick: PickOpenPath,
  importVisualNovels: LauncherHost['importVisualNovels'],
): DesktopPluginEntries['visual-novel'] {
  const subjectSearches = new Map<string, AbortController>();
  let pendingScan: { id: string; controller: AbortController } | undefined;
  let scan:
    | { id: string; token: string; root: string; candidates: Map<number, DesktopVisualNovelCandidate> }
    | undefined;
  return {
    handlers: {
      async searchVisualNovelSubjects(query, request) {
        const input = text(query, maxVisualNovelSubjectQueryLength);
        const id = optionalText(request, 64) ?? randomUUID();
        if (subjectSearches.has(id)) throw new Error('This search is already in progress.');
        const controller = new AbortController();
        subjectSearches.set(id, controller);
        try {
          return await core.searchVisualNovelSubjects(input, controller.signal);
        } finally {
          subjectSearches.delete(id);
        }
      },
      async cancelVisualNovelSubjectSearch(request) {
        subjectSearches.get(text(request, 64))?.abort();
      },
      readLinkedVisualNovelSubject: (id) => core.readLinkedVisualNovelSubject(text(id)),
      inspectVisualNovel(value) {
        const fields = record(value);
        return core.inspectVisualNovel({
          executable: chosen(fields.executable, 'executable'),
          ...(fields.workingDirectory !== undefined && {
            workingDirectory: chosen(fields.workingDirectory, 'workingDirectory'),
          }),
        });
      },
      async scanVisualNovelFolder(request) {
        const id = text(request, 64);
        pendingScan?.controller.abort();
        const controller = new AbortController();
        pendingScan = { id, controller };
        try {
          const folder = await pick({ title: 'Choose a folder of visual novels', properties: ['openDirectory'] });
          if (!folder || controller.signal.aborted) return null;
          const discovery = await core.discoverVisualNovels(folder, controller.signal);
          if (controller.signal.aborted) return null;
          const candidates = new Map<number, DesktopVisualNovelCandidate>();
          const token = randomUUID();
          const view: DesktopVisualNovelScan = {
            ...discovery,
            token,
            installations: discovery.installations.map((installation) => ({
              ...installation,
              candidates: installation.candidates.map((candidate) => {
                const row = { ...candidate, id: candidates.size };
                candidates.set(row.id, row);
                return row;
              }),
            })),
          };
          scan = { id, token, root: discovery.root, candidates };
          return view;
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          return null;
        } finally {
          if (pendingScan?.controller === controller) pendingScan = undefined;
        }
      },
      async discardVisualNovelScan(request) {
        const id = text(request, 64);
        if (pendingScan?.id === id) pendingScan.controller.abort();
        if (scan?.id === id) scan = undefined;
      },
      async importScannedVisualNovels(token, ids) {
        const preview = scan;
        if (!preview || preview.token !== text(token, 64)) {
          throw new Error('Scan a folder before importing its visual novels.');
        }
        if (!Array.isArray(ids) || !ids.length || ids.length > preview.candidates.size) {
          throw new Error('Select games from the folder scan.');
        }
        const directories = new Set<string>();
        const batch = [];
        for (const choice of ids as unknown[]) {
          const candidate = typeof choice === 'number' ? preview.candidates.get(choice) : undefined;
          if (!candidate?.platformMatch || candidate.metadata.engine === 'unknown') {
            throw new Error('Select a detected visual novel for this platform.');
          }
          const { executable, workingDirectory } = candidate;
          if (directories.has(workingDirectory)) throw new Error('Choose one executable per game folder.');
          directories.add(workingDirectory);
          batch.push({ executable, workingDirectory });
        }
        return importVisualNovels(batch, preview.root, true);
      },
      readVisualNovelSettings: (id) => core.readVisualNovelSettings(text(id)),
      async updateVisualNovelSettings(id, value, review) {
        const revision = review === undefined ? undefined : visualNovelSettingsReview(review);
        const instance = await core.updateVisualNovelSettings(
          text(id),
          visualNovelSettingsPatch(value, chosen),
          revision,
        );
        clearPaths();
        return instance;
      },
    },
    abandonRendererRequests() {
      for (const search of subjectSearches.values()) search.abort();
      pendingScan?.controller.abort();
      scan = undefined;
    },
  };
}
