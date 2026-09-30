import { join } from 'node:path';
import { InvalidMerge, MERGE_COST, MergeUnavailable, type MergeHandler, type MergeHandlerModule } from './contract.ts';

/** Reconciliation is an owner command, not a generic incoming-edge rewrite. */
export async function discoverMergeHandlers<Dependencies>(dependencies: Dependencies,
  directory = join(import.meta.dir, '..')): Promise<MergeHandler<Dependencies>[]> {
  const handlers: MergeHandler<Dependencies>[] = [];
  for (const file of [...new Bun.Glob('*/merge-handler.ts').scanSync({ cwd: directory })].sort()) {
    const imported = await import(join(directory, file)) as { mergeHandlerModule?: MergeHandlerModule<Dependencies> };
    const module = imported.mergeHandlerModule;
    if (!module || module.owner !== file.split('/')[0] || typeof module.create !== 'function') {
      throw new InvalidMerge(`Invalid merge handler module: ${file}`);
    }
    handlers.push(module.create(dependencies));
  }
  return checkedHandlers(handlers);
}

export function checkedHandlers<Dependencies>(handlers: readonly MergeHandler<Dependencies>[]): MergeHandler<Dependencies>[] {
  if (!handlers.length || handlers.length > MERGE_COST.owners) throw new MergeUnavailable('Merge owners are not installed');
  const owners = new Set<string>(), references = new Set<string>();
  for (const handler of handlers) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(handler.owner) || owners.has(handler.owner)
      || !/^[a-zA-Z0-9._-]{1,64}$/.test(handler.version)
      || !handler.references.length || handler.references.some(ref => !ref || references.has(ref))
      || !Number.isSafeInteger(handler.cost.page) || handler.cost.page < 1 || handler.cost.page > MERGE_COST.page
      || !Number.isSafeInteger(handler.cost.callsPerItem) || handler.cost.callsPerItem < 1
      || !Number.isSafeInteger(handler.cost.bytesPerItem) || handler.cost.bytesPerItem < 1
      || typeof handler.preview !== 'function' || typeof handler.plan !== 'function'
      || typeof handler.apply !== 'function' || typeof handler.compensate !== 'function') {
      throw new InvalidMerge(`Invalid or duplicate merge owner: ${handler.owner}`);
    }
    owners.add(handler.owner);
    for (const ref of handler.references) {
      if (references.has(ref)) throw new InvalidMerge(`Reference has multiple handlers: ${ref}`);
      references.add(ref);
    }
  }
  return [...handlers].sort((a, b) => a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0);
}

/** Discovery feeds this guard. Every discovered reference needs an owner or a
 * specific exclusion with its reason; exclusions cannot stand in for handlers. */
export function assertMergeCoverage(references: readonly string[], handlers: readonly MergeHandler[],
  exclusions: Readonly<Record<string, string>>): void {
  const covered = new Set(checkedHandlers(handlers).flatMap(handler => handler.references));
  for (const [ref, reason] of Object.entries(exclusions)) {
    if (!reason.trim() || covered.has(ref)) throw new InvalidMerge(`Invalid merge exclusion: ${ref}`);
  }
  const missing = [...new Set(references)].filter(ref => !covered.has(ref) && !Object.hasOwn(exclusions, ref)).sort();
  if (missing.length) throw new MergeUnavailable(`Identity references lack merge coverage: ${missing.join(', ')}`);
}
