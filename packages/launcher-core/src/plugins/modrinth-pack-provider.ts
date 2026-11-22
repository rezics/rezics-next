import type { ModrinthPackPreview, ModrinthPackRelease, ModrinthProject, Page } from '@rezics/launcher-contract';
import { randomUUID } from 'node:crypto';
import { mkdir, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { downloadArtifact } from '../artifact.ts';
import { modrinthApi, type ModrinthRequests } from '../modrinth-requests.ts';
import { fileInfo } from '../storage.ts';
import { maxPackArchive } from './modrinth-pack-format.ts';
import type { ModrinthPacks } from './modrinth-pack.ts';

const archiveHost = 'cdn.modrinth.com';
const pageSize = 25;
const maxOffset = 10_000;
const stagedName = /^pack-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const id = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9]{1,32}$/u));
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const archiveFile = v.object({
  filename: v.pipe(v.string(), v.minLength(1), v.maxLength(255), v.regex(/^[^/\\\x00-\x1f\x7f]+$/u)),
  url: v.pipe(v.string(), v.maxLength(4096)),
  primary: v.boolean(),
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  hashes: v.object({
    sha1: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/iu)),
    sha512: v.pipe(v.string(), v.regex(/^[a-f0-9]{128}$/iu)),
  }),
});
const version = v.object({
  id,
  project_id: id,
  name: text,
  version_number: text,
  version_type: v.picklist(['release', 'beta', 'alpha']),
  status: v.optional(v.picklist(['listed', 'archived', 'draft', 'unlisted', 'scheduled', 'unknown']), 'listed'),
  date_published: v.pipe(v.string(), v.isoTimestamp()),
  game_versions: v.pipe(v.array(text), v.minLength(1), v.maxLength(128)),
  loaders: v.pipe(v.array(text), v.maxLength(32)),
  files: v.pipe(
    v.array(archiveFile),
    v.maxLength(128),
    v.check((files) => files.filter(({ primary }) => primary).length <= 1),
  ),
});
const project = v.object({ id, project_type: v.literal('modpack') });
const searchPage = v.object({
  hits: v.pipe(
    v.array(
      v.object({
        project_id: id,
        project_type: v.literal('modpack'),
        title: text,
        description: v.pipe(v.string(), v.maxLength(2048)),
      }),
    ),
    v.maxLength(pageSize),
  ),
  offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  total_hits: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
type Version = v.InferOutput<typeof version>;

export type StagedModrinthPack = {
  source: string;
  digest: string;
  preview: ModrinthPackPreview;
  release(): Promise<void>;
};

function checked<T>(schema: v.GenericSchema<unknown, T>, value: unknown): T {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new Error('Modrinth returned invalid modpack metadata.');
  return result.output;
}

function offset(cursor?: string) {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d{0,4})$/u.test(cursor) || Number(cursor) >= maxOffset) {
    throw new Error('The Modrinth page cursor is invalid.');
  }
  return Number(cursor);
}

function nextCursor(start: number, returned: number, total: number) {
  const next = start + returned;
  return returned && next < Math.min(maxOffset, total) ? String(next) : null;
}

function preferredArchive(release: Version) {
  const preferred = release.files.find(({ primary }) => primary) ?? release.files[0];
  return preferred && /\.mrpack$/iu.test(preferred.filename) && preferred.size <= maxPackArchive
    ? preferred
    : undefined;
}

function releaseView(release: Version): ModrinthPackRelease {
  return {
    id: release.id,
    projectId: release.project_id,
    title: release.name,
    version: release.version_number,
    channel: release.version_type,
    publishedAt: release.date_published,
    gameVersions: release.game_versions,
    loaders: release.loaders,
  };
}

function archiveUrl(input: string | URL) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Modrinth returned an invalid archive download address.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== archiveHost ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('The modpack archive download must stay on the official Modrinth CDN.');
  }
  return url;
}

function matchesRelease(preview: ModrinthPackPreview, release: Version) {
  const { version: gameVersion, loader } = preview.selection;
  const loaders = release.loaders;
  const supportsLoader =
    loader === 'vanilla'
      ? !loaders.length || loaders.includes('vanilla') || loaders.includes('minecraft')
      : loaders.includes(loader);
  return supportsLoader && release.game_versions.includes(gameVersion);
}

function stageError(error: unknown, message: string) {
  return error instanceof Error && 'path' in error ? new Error(message) : error;
}

export class ModrinthPackProvider {
  private readonly downloadRoot: string;
  private startup: Promise<void> | undefined;

  constructor(
    dataDir: string,
    private readonly requests: ModrinthRequests,
    private readonly packs: Pick<ModrinthPacks, 'inspect'>,
  ) {
    this.downloadRoot = join(dataDir, 'modrinth-pack-downloads');
  }

  async search(query: string, cursor?: string): Promise<Page<ModrinthProject>> {
    const start = offset(cursor);
    const url = new URL(`${modrinthApi}/search`);
    const term = query.trim().slice(0, 160);
    url.searchParams.set('query', term);
    if (!term) url.searchParams.set('index', 'downloads');
    url.searchParams.set('facets', JSON.stringify([['project_type:modpack']]));
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(start));
    const page = checked(searchPage, await this.requests.metadata(url));
    if (page.offset !== start) throw new Error('Modrinth returned a different search page.');
    const items = page.hits.map(({ project_id, title, description }) => ({
      id: project_id,
      title,
      summary: description,
    }));
    return { items, nextCursor: nextCursor(start, items.length, page.total_hits) };
  }

  async list(projectId: string, cursor?: string): Promise<Page<ModrinthPackRelease>> {
    const start = offset(cursor);
    const canonicalId = checked(id, projectId);
    await this.requireProject(canonicalId);
    const url = new URL(`${modrinthApi}/project/${canonicalId}/version`);
    url.searchParams.set('include_changelog', 'false');
    const versions = checked(v.pipe(v.array(version), v.maxLength(4096)), await this.requests.metadata(url));
    if (versions.some((item) => item.project_id !== canonicalId)) {
      throw new Error('Modrinth returned releases for a different project.');
    }
    const releases = versions.filter((item) => item.status === 'listed' && preferredArchive(item));
    const items = releases.slice(start, start + pageSize).map(releaseView);
    return { items, nextCursor: nextCursor(start, items.length, releases.length) };
  }

  recover(): Promise<void> {
    this.startup ??= this.clearDownloads().catch((error: unknown) => {
      this.startup = undefined;
      throw stageError(error, 'Launcher could not clean up the modpack download folder.');
    });
    return this.startup;
  }

  async stage(projectId: string, versionId: string, signal?: AbortSignal): Promise<StagedModrinthPack> {
    signal?.throwIfAborted();
    const canonicalProject = checked(id, projectId);
    const canonicalVersion = checked(id, versionId);
    await this.requireProject(canonicalProject, signal);
    const exact = checked(
      version,
      await this.requests.metadata(new URL(`${modrinthApi}/version/${canonicalVersion}`), signal),
    );
    if (exact.id !== canonicalVersion || exact.project_id !== canonicalProject || exact.status !== 'listed') {
      throw new Error('Modrinth returned a different or unavailable modpack release.');
    }
    const published = preferredArchive(exact);
    if (!published) throw new Error('That Modrinth release has no supported .mrpack archive within the 512 MiB limit.');
    const url = archiveUrl(published.url);
    await this.recover();
    signal?.throwIfAborted();
    const directory = join(this.downloadRoot, `pack-${randomUUID()}`);
    const source = join(directory, 'contents.mrpack');
    try {
      await this.ensureDownloadRoot();
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      throw stageError(error, 'Launcher could not stage the Modrinth archive.');
    }
    const release = async () => {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        throw stageError(error, 'Launcher could not remove the staged Modrinth archive.');
      }
    };
    try {
      const fetchArchive = (async (input, init) => {
        const target = input instanceof URL || typeof input === 'string' ? input : input.url;
        return this.requests.fetch(archiveUrl(target), init);
      }) as typeof fetch;
      await downloadArtifact(
        fetchArchive,
        {
          url: url.href,
          size: published.size,
          algorithm: 'sha512',
          digest: published.hashes.sha512,
          sha1: published.hashes.sha1,
        },
        source,
        signal,
      );
      signal?.throwIfAborted();
      const inspected = await this.packs.inspect(source, signal);
      signal?.throwIfAborted();
      if (!matchesRelease(inspected.preview, exact)) {
        throw new Error('The archive Minecraft version or loader does not match the Modrinth release.');
      }
      return { source, ...inspected, release };
    } catch (error) {
      await release();
      throw stageError(error, 'Launcher could not stage the Modrinth archive.');
    }
  }

  private async requireProject(projectId: string, signal?: AbortSignal) {
    const url = new URL(`${modrinthApi}/project/${projectId}`);
    const found = checked(project, await this.requests.metadata(url, signal));
    if (found.id !== projectId) throw new Error('Modrinth returned a different modpack project.');
  }

  private async ensureDownloadRoot() {
    const current = await fileInfo(this.downloadRoot);
    if (current && !current.isDirectory()) throw new Error('The Modrinth download folder is unavailable or linked.');
    if (!current) await mkdir(this.downloadRoot, { recursive: true, mode: 0o700 });
  }

  private async clearDownloads() {
    const current = await fileInfo(this.downloadRoot);
    if (current && !current.isDirectory()) throw new Error('The Modrinth download folder is unavailable or linked.');
    if (!current) return;
    const entries = await opendir(this.downloadRoot);
    for await (const entry of entries) {
      if (entry.isDirectory() && stagedName.test(entry.name)) {
        await rm(join(this.downloadRoot, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
}
