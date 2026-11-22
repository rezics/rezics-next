import {
  minecraftLoaderNames,
  type MinecraftLoader,
  type ModrinthProject,
  type ModrinthVersion,
} from '@rezics/launcher-contract';
import * as v from 'valibot';
import { modrinthApi, type ModrinthRequests } from './modrinth-requests.ts';

const file = v.object({
  primary: v.boolean(),
  filename: v.string(),
  url: v.string(),
  size: v.pipe(v.number(), v.safeInteger()),
  hashes: v.object({ sha512: v.pipe(v.string(), v.regex(/^[a-fA-F0-9]{128}$/)) }),
});
const dependency = v.object({
  project_id: v.nullable(v.string()),
  version_id: v.nullable(v.string()),
  dependency_type: v.picklist(['required', 'optional', 'incompatible', 'embedded']),
});
const version = v.object({
  id: v.string(),
  project_id: v.string(),
  name: v.string(),
  version_number: v.string(),
  version_type: v.picklist(['release', 'beta', 'alpha']),
  game_versions: v.array(v.string()),
  loaders: v.array(v.string()),
  files: v.array(file),
  dependencies: v.array(dependency),
});
const matches = v.object({
  hits: v.array(v.object({ project_id: v.string(), title: v.string(), description: v.string() })),
});

export type ModVersion = v.InferOutput<typeof version>;
export type MinecraftModTarget = { version: string; loader: Exclude<MinecraftLoader, 'vanilla'> };

function supports(candidate: ModVersion, target: MinecraftModTarget) {
  return candidate.game_versions.includes(target.version) && candidate.loaders.includes(target.loader);
}

export class Modrinth {
  constructor(private readonly requests: ModrinthRequests) {}

  async search(q: string, target: MinecraftModTarget): Promise<ModrinthProject[]> {
    const url = new URL(`${modrinthApi}/search`);
    url.searchParams.set('query', q.trim().slice(0, 160));
    url.searchParams.set('limit', '25');
    url.searchParams.set(
      'facets',
      JSON.stringify([
        ['project_type:mod'],
        [`categories:${target.loader}`],
        [`versions:${target.version}`],
        ['client_side:required', 'client_side:optional'],
      ]),
    );
    return v.parse(matches, await this.requests.metadata(url)).hits.map(({ project_id, title, description }) => ({
      id: project_id,
      title,
      summary: description,
    }));
  }

  private async versions(projectId: string, target: MinecraftModTarget, signal?: AbortSignal) {
    const url = new URL(`${modrinthApi}/project/${encodeURIComponent(projectId)}/version`);
    url.searchParams.set('game_versions', JSON.stringify([target.version]));
    url.searchParams.set('loaders', JSON.stringify([target.loader]));
    return v
      .parse(v.array(version), await this.requests.metadata(url, signal))
      .filter((candidate) => candidate.project_id === projectId && supports(candidate, target));
  }

  async list(projectId: string, target: MinecraftModTarget): Promise<ModrinthVersion[]> {
    return (await this.versions(projectId, target)).slice(0, 25).map((candidate) => ({
      id: candidate.id,
      projectId: candidate.project_id,
      version: candidate.version_number,
      title: candidate.name,
    }));
  }

  async exact(versionId: string, target: MinecraftModTarget, signal?: AbortSignal): Promise<ModVersion> {
    const url = new URL(`${modrinthApi}/version/${encodeURIComponent(versionId)}`);
    const candidate = v.parse(version, await this.requests.metadata(url, signal));
    if (candidate.id !== versionId || !supports(candidate, target)) {
      throw new Error(
        `The Modrinth release does not support Minecraft ${target.version} with ${minecraftLoaderNames[target.loader]}.`,
      );
    }
    return candidate;
  }

  async compatible(projectId: string, target: MinecraftModTarget, signal?: AbortSignal): Promise<ModVersion> {
    const candidates = await this.versions(projectId, target, signal);
    const candidate = candidates.find((item) => item.version_type === 'release') ?? candidates[0];
    if (!candidate) throw new Error(`No compatible release was found for required Modrinth project ${projectId}.`);
    return candidate;
  }
}
