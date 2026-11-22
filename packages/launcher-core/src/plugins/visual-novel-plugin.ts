import { visualNovelPlugin, type VisualNovelSettings } from '@rezics/launcher-contract';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { Instances, LocalInstance } from '../instances.ts';
import { createVisualNovelSubjects } from './visual-novel-subjects.ts';

export type VisualNovelPluginOptions = {
  instances: Pick<Instances, 'visualNovel' | 'inspectVisualNovel' | 'inspectVisualNovelAt' | 'editVisualNovel'>;
  endpoint: string;
  website: URL;
  locale?: string | undefined;
  fetch?: typeof fetch | undefined;
};

export function visualNovelSettingsRevision(instance: LocalInstance) {
  const { id, name, executable, workingDirectory, saveDirectory, renpySaveName, subjectId } = instance;
  return createHash('sha256')
    .update(JSON.stringify([id, name, executable, workingDirectory, saveDirectory, renpySaveName, subjectId]))
    .digest('hex');
}

export function createVisualNovelPlugin({ instances, endpoint, website, locale, fetch }: VisualNovelPluginOptions) {
  const subjects = createVisualNovelSubjects(endpoint, website, locale, fetch);
  return {
    manifest: visualNovelPlugin,
    inspect: instances.inspectVisualNovel.bind(instances),
    search: subjects.search,
    async linkedSubject(id: string) {
      const { subjectId } = await instances.visualNovel(id);
      return subjectId ? subjects.read(subjectId) : null;
    },
    edit: instances.editVisualNovel.bind(instances),
    async settings(id: string): Promise<VisualNovelSettings> {
      const instance = await instances.visualNovel(id);
      const { name, executable, workingDirectory, saveDirectory, renpySaveName, subjectId } = instance;
      return {
        name,
        executable,
        ...(workingDirectory !== dirname(executable) && { workingDirectory }),
        ...(saveDirectory && { saveDirectory }),
        ...(renpySaveName && { renpySaveName }),
        ...(subjectId && { subjectId }),
        revision: visualNovelSettingsRevision(instance),
        metadata: await instances.inspectVisualNovelAt(executable, workingDirectory, renpySaveName).catch(() => null),
      };
    },
  };
}
