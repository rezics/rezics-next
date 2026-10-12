import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './corpus.ts';

export interface FixtureModelManifest {
  profiles: { id: string; sha256: string; file: string }[];
  artifacts: Record<string, string>;
}

export function fixtureModel(root: string): { generation: string; manifest: FixtureModelManifest } {
  const bytes = readFileSync(join(root, 'generated/model/manifest.json'));
  return { generation: `urn:rezics:model-generation:${sha256(bytes)}`,
    manifest: JSON.parse(bytes.toString()) as FixtureModelManifest };
}

/** The loader declares its profile use; each shape digest includes its vocabulary
 * constraints, and its context digest pins the term mappings. Other definitions
 * belong to model alignment, never to retained-record compatibility. */
export function fixtureModelInputs(root: string, profiles: readonly string[]): Record<string, string> {
  const { manifest } = fixtureModel(root);
  return Object.fromEntries([...new Set(profiles.map(profile => profile.split('/').at(-1)!))].sort()
    .flatMap(id => {
      const profile = manifest.profiles.find(candidate => candidate.id === id);
      const context = manifest.artifacts[`contexts/${id}.jsonld`];
      if (!profile || !context) throw new Error(`Fixture model profile is absent: ${id}`);
      return [[`profile:${id}`, profile.sha256], [`vocabulary:${id}`, context]];
    }));
}
