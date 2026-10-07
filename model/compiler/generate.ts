import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { facetId, renderFacetRegistry, type FacetDefinition } from './facet.ts';
import { profileSnapshot, type ProfileDefinition } from './ir.ts';
import { artifactDigests, buildModelOutputs } from './outputs.ts';
import { buildCommandRegistry, shapeRole, type RegistryOptions } from './registry.ts';
import { renderTypeRegistry } from './type.ts';
import { isTurtleProfile, parseTurtleProfile, profileSource, type TurtleDeclaration } from './shacl.ts';
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
 * Discover `*.ttl` constraints and TS `*Profile` definitions in one namespace.
 * Turtle's optional companion `*Declaration` exports carry only command metadata.
 */
export function discoverProfiles(directory: string,
  modules: readonly (readonly [string, Record<string, unknown>])[]): ProfileDefinition[] {
  const turtleFiles = [...new Bun.Glob('*.ttl').scanSync({ cwd: directory })].sort();
  const turtleSources = new Map<string, string>(turtleFiles.map(file => [file.slice(0, -4),
    readFileSync(join(directory, file), 'utf8')] as const));
  const declarations = new Map<string, TurtleDeclaration>();
  for (const [file, module] of modules) for (const [name, value] of Object.entries(module)) {
    if (!name.endsWith('Declaration') || !value || typeof value !== 'object') continue;
    const declaration = value as TurtleDeclaration;
    if (file !== `${declaration.id}.ts` || declarations.has(declaration.id)) {
      throw new Error(`Duplicate or misplaced Turtle declaration ${declaration.id}`);
    }
    declarations.set(declaration.id, declaration);
  }
  const profiles = modules.flatMap(([file, module]) => Object.entries(module)
    .filter(([name, value]) => name.endsWith('Profile') && value && typeof value === 'object')
    .map(([, value]) => value as ProfileDefinition)
    .filter(profile => {
      const source = turtleSources.get(profile.id);
      if (source === undefined) return true;
      if (file !== `${profile.id}.ts` || !declarations.has(profile.id)
        || !isTurtleProfile(profile) || profileSource(profile) !== source)
        throw new Error(`Duplicate profile ID ${profile.id}`);
      return false;
    }));
  for (const [id, source] of turtleSources) {
    if (profiles.some(profile => profile.id === id)) throw new Error(`Duplicate profile ID ${id}`);
    profiles.push(parseTurtleProfile(id, source, declarations.get(id)));
    declarations.delete(id);
  }
  if (declarations.size) throw new Error(`Turtle source is missing for ${[...declarations.keys()].join(', ')}`);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Duplicate profile ID');
  for (const profile of profiles) profileSnapshot(profile);
  // Source language does not change output order or canonical precedence.
  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

export const authoredProfiles: readonly ProfileDefinition[] = discoverProfiles(
  join(import.meta.dir, '../definitions'), definitionModules);

/** Exported `*Facet` definitions, one version per `definitions/facet-<name>-v<version>.ts`. */
export const authoredFacets: readonly FacetDefinition[] = authored<FacetDefinition>('Facet').map(([file, facet]) => {
  if (file !== `${facetId(facet)}.ts`) throw new Error(`definitions/${file} must hold only ${facetId(facet)}`);
  return facet;
});

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
    const source = profileSource(profile);
    const shapeFile = `shapes/${id}.ttl`;
    shapes.set(shapeFile, source);
    return {
      id,
      sha256: createHash('sha256').update(source).digest('hex'),
      file: shapeFile,
      shapes: profile.shapes.map(shape => shape.iri),
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
    `// Generated by task gen from authored profiles.\n` +
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

export function generate(root: string, check: boolean): void {
  const artifacts = buildArtifacts(root);
  // Definitions may be removed in review; their old generated shapes and contexts
  // must not remain available beside the current manifest.
  for (const directory of ['generated/model/shapes', 'generated/model/contexts']) {
    const path = join(root, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      const relative = `${directory}/${name}`;
      if (artifacts.has(relative)) continue;
      if (check) throw new Error(`Unexpected generated artifact: ${relative}; run task gen`);
      unlinkSync(join(root, relative));
    }
  }
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
