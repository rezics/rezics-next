import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compileFacet, facetId, renderFacetRegistry, type FacetDefinition } from './facet.ts';
import { renderProfile, type ProfileDefinition } from './ir.ts';
import { artifactDigests, buildModelOutputs } from './outputs.ts';
import { buildCommandRegistry, shapeRole, type RegistryOptions } from './registry.ts';
import { renderTypeRegistry } from './type.ts';
import { typesV1 } from '../definitions/types-v1.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';

export interface ProfileArtifact {
  id: string;
  sha256: string;
  file: string;
  shapes: string[];
  focusRoles: string[];
}

const definitionModules: readonly (readonly [file: string, exports: Record<string, unknown>])[] = await (async () => {
  const directory = join(import.meta.dir, '../definitions');
  const found: (readonly [string, Record<string, unknown>])[] = [];
  for (const file of [...new Bun.Glob('*.ts').scanSync({ cwd: directory })].sort()) {
    found.push([file, await import(join(directory, file)) as Record<string, unknown>]);
  }
  return found;
})();

const authored = <T>(suffix: string) => definitionModules.flatMap(([file, module]) =>
  Object.entries(module).flatMap(([name, value]) =>
    name.endsWith(suffix) && value && typeof value === 'object' ? [[file, value as T] as const] : []));

/**
 * Source of truth for the authored profiles: every `model/definitions/*.ts` module's exported
 * `*Profile` definitions, discovered so parallel profile work never edits one shared list.
 */
export const authoredProfiles: readonly ProfileDefinition[] = authored<ProfileDefinition>('Profile')
  .map(([, profile]) => profile);

/** Exported `*Facet` definitions, one version per `definitions/facet-<name>-v<version>.ts`. */
export const authoredFacets: readonly FacetDefinition[] = authored<FacetDefinition>('Facet').map(([file, facet]) => {
  if (file !== `${facetId(facet)}.ts`) throw new Error(`definitions/${file} must hold only ${facetId(facet)}`);
  return facet;
});

function profileShapes(source: string, id: string): string[] {
  const shapes = [...source.matchAll(/^<([^>]+)>\s+a\s+sh:NodeShape\s*;/gm)].map(match => match[1]!);
  if (!shapes.length || new Set(shapes).size !== shapes.length) {
    throw new Error(`${id} must declare distinct named NodeShapes`);
  }
  return shapes;
}

// Definitions and the command module live in this repository, whatever the output root.
const repository = resolve(import.meta.dir, '../..');

/** The pom is the only definition of the command-module version; generation copies it. */
export function commandModuleVersion(root: string): string {
  const version = /<artifactId>fuseki-command<\/artifactId><version>(\d+\.\d+\.\d+)<\/version>/
    .exec(readFileSync(join(root, 'infra/jena/command-module/pom.xml'), 'utf8'))?.[1];
  if (!version) throw new Error('Cannot read the command-module version from its pom.xml');
  return version;
}

/**
 * The directory the Fuseki command module loads: one shape file per profile and a
 * manifest with their digests and the command registry.
 */
export function commandProfiles(definitions: readonly ProfileDefinition[], options?: RegistryOptions): {
  profiles: ProfileArtifact[]; shapes: Map<string, string>; manifest: Record<string, unknown>;
} {
  const authored = new Map(definitions.map(profile => [profile.id, profile]));
  if (!authored.size || authored.size !== definitions.length) throw new Error('No unique authored profiles');
  const sorted = [...authored].sort(([a], [b]) => a.localeCompare(b));
  const registry = buildCommandRegistry(sorted.map(([, profile]) => profile), options);
  const shapes = new Map<string, string>();
  const profiles: ProfileArtifact[] = sorted.map(([id, profile]) => {
    const source = renderProfile(profile);
    const shapeFile = `shapes/${id}.ttl`;
    shapes.set(shapeFile, source);
    return {
      id,
      sha256: createHash('sha256').update(source).digest('hex'),
      file: shapeFile,
      shapes: profileShapes(source, id),
      focusRoles: profile.shapes.map(shape => shapeRole(id, shape.iri)),
    };
  });
  return {
    profiles,
    shapes,
    manifest: {
      profiles: profiles.map(({ id, sha256, file }) => {
        const binding = registry.bindings.get(id);
        return { id, sha256, file, ...(binding ? { binding } : {}) };
      }),
      canonical: registry.canonical,
      bindingDemands: registry.bindingDemands,
    },
  };
}

export function buildArtifacts(_root: string): Map<string, string> {
  const command = commandProfiles(authoredProfiles);
  const artifacts = new Map<string, string>();
  for (const [file, source] of command.shapes) artifacts.set(`generated/model/${file}`, source);
  const registry = Object.fromEntries(command.profiles.map(({ id, sha256, file, shapes, focusRoles }) =>
    [id, { sha256, file, shapes, focusRoles }]));
  artifacts.set('packages/model/src/generated/profiles.ts',
    `// Generated by task gen from authored TypeScript profiles.\n` +
    `export const profileRegistry = ${JSON.stringify(registry, null, 2)} as const;\n` +
    `export type ProfileId = keyof typeof profileRegistry;\n`);
  for (const [path, content] of buildModelOutputs(authoredProfiles)) artifacts.set(path, content);
  artifacts.set('generated/model/manifest.json', `${JSON.stringify({
    // The module refuses a manifest generated for another build of itself.
    commandModule: commandModuleVersion(repository),
    ...command.manifest,
    artifacts: artifactDigests(artifacts),
  }, null, 2)}\n`);
  // Facets are Main's query vocabulary, not command-module input: they stay out of the
  // manifest the Fuseki image copies, so a Facet change never rebuilds Fuseki.
  artifacts.set('packages/model/src/generated/facets.ts', renderFacetRegistry(authoredFacets));
  artifacts.set('packages/model/src/generated/types.ts', renderTypeRegistry(typesV1, workKindV2Profile, workTypeV2Profile));
  return artifacts;
}

interface AcceptedBinding { required: string[]; optional?: string[]; roles: string[] }
interface AcceptedProfile { sha256: string; binding?: AcceptedBinding }
interface AcceptedLock { profiles: Map<string, AcceptedProfile>; facets: Map<string, string> }

function readAcceptedDir(kind: 'profiles' | 'facets'): Map<string, unknown> {
  const directory = join(repository, 'model/accepted', kind);
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.endsWith('.json')); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read model/accepted/${kind}: ${reason}`);
  }
  const entries = new Map<string, unknown>();
  for (const name of names.sort()) {
    const id = name.slice(0, -'.json'.length);
    try { entries.set(id, JSON.parse(readFileSync(join(directory, name), 'utf8'))); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read model/accepted/${kind}/${name}: ${reason}`);
    }
  }
  return entries;
}

function acceptedLock(): AcceptedLock {
  const profiles = new Map<string, AcceptedProfile>();
  for (const [id, value] of readAcceptedDir('profiles')) profiles.set(id, value as AcceptedProfile);
  const facets = new Map<string, string>();
  for (const [id, value] of readAcceptedDir('facets')) facets.set(id, typeof value === 'string' ? value : '');
  return { profiles, facets };
}

function profileEntry(profile: { sha256: string; binding?: AcceptedBinding }): AcceptedProfile {
  return profile.binding ? { sha256: profile.sha256, binding: profile.binding } : { sha256: profile.sha256 };
}

/**
 * Accepted profiles and Facets stay at the digests under model/accepted/.
 * Generation reads those files and never writes them; a changed meaning is a new version.
 */
function assertAccepted(artifacts: Map<string, string>, facets: readonly FacetDefinition[]): void {
  const lock = acceptedLock();
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; binding?: AcceptedBinding }[];
  };
  const built = new Map(manifest.profiles.map(profile => [profile.id, profile]));
  for (const id of [...lock.profiles.keys()].sort()) {
    const profile = built.get(id);
    const locked = lock.profiles.get(id)!;
    const same = profile && profile.sha256 === locked.sha256
      && JSON.stringify(profile.binding ?? null) === JSON.stringify(locked.binding ?? null);
    if (!same) throw new Error(`Accepted profile ${id} changed; add a new version instead`);
  }
  for (const profile of [...manifest.profiles].sort((a, b) => a.id.localeCompare(b.id))) {
    if (lock.profiles.has(profile.id)) continue;
    const file = `model/accepted/profiles/${profile.id}.json`;
    const content = `${JSON.stringify(profileEntry(profile), null, 2)}\n`;
    throw new Error(`Unaccepted profile ${profile.id}: add ${file} with exactly:\n${content}`);
  }
  const digests = new Map(facets.map(facet => [facetId(facet), String(compileFacet(facet).digest)]));
  for (const id of [...lock.facets.keys()].sort()) {
    if (digests.get(id) !== lock.facets.get(id)) {
      throw new Error(`Accepted facet ${id} changed; add a new version instead`);
    }
  }
  for (const id of [...digests.keys()].sort()) {
    if (lock.facets.has(id)) continue;
    const file = `model/accepted/facets/${id}.json`;
    const content = `${JSON.stringify(digests.get(id))}\n`;
    throw new Error(`Unaccepted facet ${id}: add ${file} with exactly:\n${content}`);
  }
}

export function generate(root: string, check: boolean): void {
  const artifacts = buildArtifacts(root);
  assertAccepted(artifacts, authoredFacets);
  for (const [relative, expected] of artifacts) {
    const path = join(root, relative);
    if (check) {
      let actual: string;
      try { actual = readFileSync(path, 'utf8'); }
      catch { throw new Error(`Missing generated artifact: ${relative}`); }
      if (actual !== expected) throw new Error(`Generated artifact differs: ${relative}; run task gen`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, expected);
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('usage: task gen -- [--check]');
  }
  generate(resolve(import.meta.dir, '../..'), args[0] === '--check');
}
