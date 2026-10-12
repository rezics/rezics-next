import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, stable } from './corpus.ts';
import type { RegistryBinding, RegistryCondition } from '../../model/compiler/registry.ts';

export interface FixtureModelManifest {
  profiles: { id: string; sha256: string; file: string; binding?: RegistryBinding }[];
  canonical: { type: string; routes: { profile: string; shape: string; when: RegistryCondition[] }[] }[];
  bindingDemands: { type: string; profile: string }[];
  artifacts: Record<string, string>;
}

export function fixtureModel(root: string): { generation: string; manifest: FixtureModelManifest } {
  const bytes = readFileSync(join(root, 'generated/model/manifest.json'));
  return { generation: `urn:rezics:model-generation:${sha256(bytes)}`,
    manifest: JSON.parse(bytes.toString()) as FixtureModelManifest };
}

/** Hash the effective generated declaration: shape, bindings, canonical routes
 * and vocabulary mappings. Filter routes by their profile so unrelated additions
 * belong to alignment without changing retained-record compatibility. */
export function fixtureModelInputs(root: string, profiles: readonly string[]): Record<string, string> {
  const { manifest } = fixtureModel(root);
  return Object.fromEntries([...new Set(profiles.map(profile => profile.split('/').at(-1)!))].sort()
    .flatMap(id => {
      const profile = manifest.profiles.find(candidate => candidate.id === id);
      const context = manifest.artifacts[`contexts/${id}.jsonld`];
      if (!profile || !context) throw new Error(`Fixture model profile is absent: ${id}`);
      const canonical = manifest.canonical.flatMap(entry => {
        const routes = entry.routes.filter(route => route.profile === id);
        return routes.length ? [{ type: entry.type, routes }] : [];
      });
      const bindingDemands = manifest.bindingDemands.filter(demand => demand.profile === id);
      return [[`profile:${id}`, sha256(stable({ profile, canonical, bindingDemands, vocabulary: context }))]];
    }));
}
