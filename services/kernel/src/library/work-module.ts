import type { WorkModule } from '../work/registry.ts';

export const libraryWorkModule: WorkModule = {
  name: 'library',
  async register(context) {
    const { registerLibraryWork } = await import('./work.ts');
    registerLibraryWork(context);
    const { registerLibraryEntryRetentionWork } = await import('./entry-due-work.ts');
    await registerLibraryEntryRetentionWork(context);
  },
};
