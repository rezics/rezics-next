import { join } from 'node:path';
import type { EditorialAdapterModule } from './contract.ts';

/** Owner factories stay unloaded until discovery, so future wiki adapters can
 * declare their own dependencies without editing the lifecycle or a registry. */
export async function discoverEditorialAdapters(directory = import.meta.dir): Promise<Map<string, EditorialAdapterModule>> {
  const modules = new Map<string, EditorialAdapterModule>();
  for (const file of [...new Bun.Glob('*-adapter.ts').scanSync({ cwd: directory })].sort()) {
    const imported = await import(join(directory, file)) as { adapterModule?: EditorialAdapterModule };
    const module = imported.adapterModule;
    if (!module || module.kind !== file.slice(0, -'-adapter.ts'.length) || typeof module.create !== 'function'
      || modules.has(module.kind)) throw new Error(`Invalid editorial adapter module: ${file}`);
    modules.set(module.kind, module);
  }
  return modules;
}
