import type { Installed } from './installed.ts';

export function planModState(current: Installed[], packageId: string, enabled: boolean) {
  const byId = new Map(current.map((record) => [record.id, record]));
  const selected = byId.get(packageId);
  if (!selected) throw new Error('This mod is no longer installed.');
  if (selected.enabled === enabled) return { next: current, changes: [], required: [] };

  const dependents = enabled ? undefined : enabledDependents(current);
  const affected = new Map([[selected.id, selected]]);
  for (const record of affected.values()) {
    const related = dependents ? (dependents.get(record.id) ?? []) : requiredMods(record, byId);
    // Map iteration also visits newly added records. Keeping each id once handles dependency cycles.
    for (const mod of related) affected.set(mod.id, mod);
  }
  const changes = [...affected.values()].filter((record) => record.enabled !== enabled);
  const next = current.map((record) => (affected.has(record.id) ? { ...record, enabled } : record));
  return { next, changes, required: enabled ? [...affected.values()] : [] };
}

function requiredMods(record: Installed, byId: ReadonlyMap<string, Installed>) {
  return record.requires.map(({ id, releaseId }) => {
    const dependency = byId.get(id);
    if (!dependency || (releaseId && dependency.releaseId !== releaseId)) {
      throw new Error(`${record.title} requires ${id} at a compatible installed release.`);
    }
    return dependency;
  });
}

function enabledDependents(current: Installed[]) {
  const result = new Map<string, Installed[]>();
  for (const record of current) {
    if (!record.enabled) continue;
    for (const { id } of record.requires) {
      const dependents = result.get(id);
      if (dependents) dependents.push(record);
      else result.set(id, [record]);
    }
  }
  return result;
}
