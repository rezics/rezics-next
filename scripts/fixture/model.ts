import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, stable } from './corpus.ts';
import { selectCommandProfile, type RegistryBinding, type RegistryCondition } from '../../model/compiler/registry.ts';

export interface FixtureModelManifest {
  profiles: { id: string; sha256: string; file: string; binding?: RegistryBinding }[];
  canonical: { type: string; routes: { profile: string; shape: string; when: RegistryCondition[] }[] }[];
  bindingDemands: { type: string; profile: string }[];
  artifacts: Record<string, string>;
}

export interface FixtureModelUse {
  profiles: readonly string[];
  records: { types: string[]; values: Record<string, string[]> }[];
}

export function fixtureModel(root: string): { generation: string; manifest: FixtureModelManifest } {
  const bytes = readFileSync(join(root, 'generated/model/manifest.json'));
  return { generation: `urn:rezics:model-generation:${sha256(bytes)}`,
    manifest: JSON.parse(bytes.toString()) as FixtureModelManifest };
}

/** Writers supply their profile/type/property declarations. Pin owned profiles
 * and every additional route or binding demand that can validate their records;
 * unrelated types or nonmatching route predicates remain additive. */
export function fixtureModelInputs(root: string, use: FixtureModelUse): Record<string, string> {
  const { manifest } = fixtureModel(root);
  const ids = new Set(use.profiles.map(profile => profile.split('/').at(-1)!));
  const declaration = (id: string) => {
      const profile = manifest.profiles.find(candidate => candidate.id === id);
      const context = manifest.artifacts[`contexts/${id}.jsonld`];
      if (!profile || !context) throw new Error(`Fixture model profile is absent: ${id}`);
      const canonical = manifest.canonical.flatMap(entry => {
        const routes = entry.routes.filter(route => route.profile === id);
        return routes.length ? [{ type: entry.type, routes }] : [];
      });
      const bindingDemands = manifest.bindingDemands.filter(demand => demand.profile === id);
      return { profile, canonical, bindingDemands, vocabulary: context };
  };
  const inputs = Object.fromEntries([...ids].sort().map(id => [`profile:${id}`, sha256(stable(declaration(id)))]));
  for (const type of [...new Set(use.records.flatMap(record => record.types))].sort()) {
    const records = use.records.filter(record => record.types.includes(type));
    const routes = manifest.canonical.filter(entry => entry.type === type).flatMap(entry => entry.routes)
      .filter(route => !ids.has(route.profile) && records.some(record =>
        route.when.every(condition => record.values[condition.path]?.length === 1
          && record.values[condition.path]![0] === condition.value)));
    const bindingDemands = manifest.bindingDemands.filter(demand => demand.type === type && !ids.has(demand.profile));
    const dependencies = [...new Set([...routes.map(route => route.profile), ...bindingDemands.map(demand => demand.profile)])]
      .sort().map(declaration);
    // Native selection uses the first canonical type present on the whole record.
    // Per-type route hashes alone miss a precedence change between two used types.
    const selections = records.map(record => {
      const selected = selectCommandProfile(manifest, record.types, path => record.values[path] ?? []);
      return selected ? { kind: selected.kind, profile: selected.profile,
        shape: selected.shape, when: selected.when } : null;
    });
    inputs[`validation:${type}`] = sha256(stable({ routes, bindingDemands, dependencies, selections }));
  }
  return inputs;
}
