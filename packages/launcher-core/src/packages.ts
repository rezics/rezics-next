import {
  minecraftLoaderNames,
  overlayPanelLimit,
  type CatalogInstallPreview,
  type CatalogInstallReview,
  type CatalogRelease,
  type ModrinthInstallPreview,
  type InstalledOverlayExtension,
  type OverlayPanel,
  type PackageInstallControl,
  type ReleaseRef,
} from '@rezics/launcher-contract';
import { createHash } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { satisfies, validRange } from 'semver';
import {
  downloadArtifact,
  hashArtifactFile,
  installedOverlayPanel,
  maxArtifactSize,
  overlayPanelDigest,
  readMinecraftMod,
  readOverlayPanel,
  type Artifact,
  type ArtifactFingerprint,
} from './artifact.ts';
import { Catalog, CatalogRequestError } from './catalog.ts';
import {
  InstalledStore,
  overlayPanelIssue,
  replaceInstalled,
  reportPackageInstall,
  verifyInstalled,
  type Installed,
} from './installed.ts';
import { Modrinth, type MinecraftModTarget, type ModVersion } from './modrinth.ts';
import type { ModrinthRequests } from './modrinth-requests.ts';
import { fileInfo } from './storage.ts';

const dependencyLimit = 64;
const overlayPanelArtifactLimit = 16_384;

function fingerprint({ algorithm, size, digest }: ArtifactFingerprint): ArtifactFingerprint {
  return { algorithm, size, digest: digest.toLowerCase() };
}

function sameFingerprint(left: ArtifactFingerprint, right: ArtifactFingerprint) {
  return left.algorithm === right.algorithm && left.size === right.size && left.digest === right.digest.toLowerCase();
}

async function stageOverlayPanel(
  fetcher: typeof fetch,
  id: string,
  artifact: Artifact,
  path: string,
  signal?: AbortSignal,
  onTransfer?: Parameters<typeof downloadArtifact>[4],
) {
  if (artifact.size > overlayPanelArtifactLimit) throw new Error('The Overlay panel exceeds the supported size.');
  await downloadArtifact(fetcher, artifact, path, signal, onTransfer);
  const panel = await readOverlayPanel(id, path);
  return { panel, panelDigest: overlayPanelDigest(panel), integrity: fingerprint(artifact) };
}

function catalogArtifact(release: CatalogRelease): Artifact {
  const { url, size, sha256: digest } = release.artifact;
  return { algorithm: 'sha256', url, size, digest };
}

function modrinthArtifact(version: ModVersion): Artifact {
  const jars = version.files.filter((item) => item.filename.toLowerCase().endsWith('.jar'));
  const file = jars.find((item) => item.primary) ?? jars[0];
  if (!file) throw new Error('The Modrinth release does not provide a mod JAR.');
  return { url: file.url, size: file.size, digest: file.hashes.sha512, algorithm: 'sha512' };
}

async function stageLocalMod(file: string, target: MinecraftModTarget, path: string) {
  const info = await fileInfo(file);
  if (extname(file).toLowerCase() !== '.jar' || !info?.isFile()) {
    throw new Error(`Select a local ${minecraftLoaderNames[target.loader]} mod JAR.`);
  }
  if (info.size < 1 || info.size > maxArtifactSize) throw new Error('The mod JAR is outside the supported size.');
  await copyFile(file, path);
  const mod = await readMinecraftMod(path, target.loader);
  const digest = await hashArtifactFile(path, info.size, 'sha256');
  if (!digest) throw new Error('The mod JAR changed during import.');
  return { mod, integrity: fingerprint({ algorithm: 'sha256', size: info.size, digest }) };
}

type Candidate = {
  id: string;
  releaseId: string;
  title: string;
  version: string;
  source: 'rezics' | 'modrinth';
  artifact: Artifact;
  requires: Installed['requires'];
  conflicts: Installed['conflicts'];
};

function retainedRequirements(plan: ReadonlyMap<string, Candidate>, installedById: ReadonlyMap<string, Installed>) {
  const pending = new Set<string>();
  for (const candidate of plan.values()) {
    for (const { id } of candidate.requires) pending.add(id);
  }
  const retained: Installed[] = [];
  for (const id of pending) {
    if (plan.has(id)) continue;
    // The resulting ledger has already been checked for requirements and exact releases.
    const record = installedById.get(id)!;
    retained.push(record);
    for (const dependency of record.requires) pending.add(dependency.id);
  }
  return retained;
}

const modrinthInstallOperation = 'installing this Modrinth release';

function missingCatalogRelease(error: unknown, ref: ReleaseRef, role: 'selected' | 'required' | 'installed'): never {
  if (!(error instanceof CatalogRequestError) || error.status !== 404) throw error;
  const next =
    role === 'required' ? 'Choose a release with published requirements.' : 'Review another published release.';
  throw new Error(`The ${role} REZICS release ${ref.packageId} (${ref.releaseId}) is unavailable (HTTP 404). ${next}`, {
    cause: error,
  });
}

type ModInstallTarget = MinecraftModTarget & { instanceId: string };

function installRecord({ artifact: _artifact, ...candidate }: Candidate): Installed {
  return { ...candidate, enabled: true };
}

async function installPlan(
  fetcher: typeof fetch,
  current: Installed[],
  stage: string,
  plan: Candidate[],
  format: 'panel' | MinecraftModTarget['loader'],
  control?: PackageInstallControl,
) {
  const signal = control?.signal;
  const next: Installed[] = [];
  const artifacts = new Map<string, string>();
  const installed = new Map(current.map((item) => [item.id, item]));
  for (const [index, candidate] of plan.entries()) {
    signal?.throwIfAborted();
    const { artifact } = candidate;
    const record = installRecord(candidate);
    const existing = installed.get(record.id);
    if (
      format === 'panel' &&
      existing?.releaseId === record.releaseId &&
      existing.enabled &&
      !overlayPanelIssue(existing)
    ) {
      next.push(existing);
      continue;
    }
    const path = join(stage, `artifact-${index}`);
    const onTransfer =
      control?.report &&
      ((phase: 'downloading' | 'verifying', bytes: number) =>
        reportPackageInstall(control, {
          phase,
          title: record.title.slice(0, 160),
          position: index + 1,
          total: plan.length,
          bytes,
          totalBytes: artifact.size,
        }));
    onTransfer?.('downloading', 0);
    if (format === 'panel') {
      next.push({ ...record, ...(await stageOverlayPanel(fetcher, record.id, artifact, path, signal, onTransfer)) });
    } else {
      await downloadArtifact(fetcher, artifact, path, signal, onTransfer);
      const mod = await readMinecraftMod(path, format);
      next.push({ ...record, jarIds: mod.ids, integrity: fingerprint(artifact) });
      artifacts.set(record.id, path);
    }
  }
  signal?.throwIfAborted();
  return { next: replaceInstalled(current, next), artifacts };
}

function checkRelease(launcher: string, target: MinecraftModTarget | undefined, release: CatalogRelease) {
  const compatibility = release.compatibility;
  if (
    compatibility.kind === 'overlay-panel' &&
    !target &&
    validRange(compatibility.launcherRange) &&
    satisfies(launcher, compatibility.launcherRange)
  ) {
    return;
  }
  if (
    compatibility.kind === 'minecraft-mod' &&
    target?.loader === 'fabric' &&
    target.version === compatibility.gameVersion
  ) {
    return;
  }
  throw new Error('This release is incompatible with the selected Launcher or Fabric instance.');
}

export class Packages {
  readonly catalog: Catalog;
  readonly modrinth: Modrinth;

  constructor(
    catalogUrl: string,
    private readonly launcherVersion: string,
    private readonly fetcher: typeof fetch,
    private readonly modrinthRequests: ModrinthRequests,
  ) {
    this.catalog = new Catalog(catalogUrl, fetcher);
    this.modrinth = new Modrinth(modrinthRequests);
  }

  async previewCatalog(store: InstalledStore, ref: ReleaseRef, target?: ModInstallTarget, signal?: AbortSignal) {
    return (await this.planCatalog(await store.list(), ref, target, signal)).preview;
  }

  installCatalog(store: InstalledStore, ref: ReleaseRef, target?: ModInstallTarget, review?: CatalogInstallReview) {
    return store.edit(async (installed, stage) => {
      reportPackageInstall(review, { phase: 'checking' });
      const { plan, preview } = await this.planCatalog(installed, ref, target, review?.signal);
      if (review && review.revision !== preview.revision) {
        throw new Error('The release or installed packages changed. Preview the installation again.');
      }
      return installPlan(this.fetcher, installed, stage, plan, target?.loader ?? 'panel', review);
    }, review);
  }

  private async planCatalog(installed: Installed[], ref: ReleaseRef, target?: ModInstallTarget, signal?: AbortSignal) {
    const candidates = new Map<
      string,
      Omit<Candidate, 'requires'> & { requires: { id: string; releaseId: string }[] }
    >();
    const selected = new Map<string, string>();
    async function visit(this: Packages, item: ReleaseRef) {
      signal?.throwIfAborted();
      const previous = selected.get(item.packageId);
      if (previous) {
        if (previous !== item.releaseId) throw new Error('The package requires conflicting release versions.');
        return;
      }
      if (selected.size >= dependencyLimit) throw new Error('This package requires too many releases.');
      selected.set(item.packageId, item.releaseId);
      const [release, pkg] = await Promise.all([
        this.catalog.exact(item, signal),
        this.catalog.package(item.packageId, signal),
      ]).catch((error: unknown) => missingCatalogRelease(error, item, item === ref ? 'selected' : 'required'));
      checkRelease(this.launcherVersion, target, release);
      if (pkg.kind !== release.compatibility.kind) throw new Error('The catalog has inconsistent package metadata.');
      if (release.compatibility.kind === 'overlay-panel' && release.artifact.size > overlayPanelArtifactLimit) {
        throw new Error('The Overlay panel exceeds the supported size.');
      }
      if (release.artifact.size > maxArtifactSize) throw new Error('The package exceeds the supported size.');
      for (const required of release.requires) await visit.call(this, required);
      candidates.set(item.packageId, {
        id: item.packageId,
        releaseId: release.id,
        version: release.version,
        title: pkg.title,
        source: 'rezics',
        requires: release.requires.map(({ packageId, releaseId }) => ({ id: packageId, releaseId })),
        conflicts: [],
        artifact: catalogArtifact(release),
      });
    }
    await visit.call(this, ref);
    signal?.throwIfAborted();
    const plan = [...candidates.values()];
    verifyInstalled(replaceInstalled(installed, plan.map(installRecord)));
    const installedById = new Map(installed.map((record) => [record.id, record]));
    const changes = plan.map(({ id: packageId, releaseId, title, version, artifact, requires }) => {
      const existing = installedById.get(packageId);
      if (
        !target &&
        existing?.releaseId === releaseId &&
        existing.integrity &&
        !sameFingerprint(existing.integrity, artifact)
      ) {
        throw new Error('The published artifact no longer matches the installed Overlay release.');
      }
      const action = !existing
        ? 'install'
        : existing.releaseId !== releaseId
          ? 'replace'
          : !existing.enabled
            ? 'enable'
            : target || overlayPanelIssue(existing)
              ? 'reinstall'
              : 'keep';
      return {
        packageId,
        releaseId,
        title,
        version,
        action,
        size: artifact.size,
        sha256: artifact.digest,
        requires: requires.map(({ id, releaseId }) => ({ packageId: id, releaseId })),
        ...(existing && { installedVersion: existing.version }),
        ...(action === 'replace' && existing?.enabled === false && { enables: true as const }),
      } as const;
    });
    const { packageId, releaseId } = ref;
    const revision = createHash('sha256')
      .update(JSON.stringify([packageId, releaseId, target, installed, plan]))
      .digest('hex');
    const preview: CatalogInstallPreview = {
      packageId,
      releaseId,
      changes,
      revision,
      ...(target && { instanceId: target.instanceId }),
    };
    return { plan, preview };
  }

  async previewModrinth(
    store: InstalledStore,
    installed: Installed[],
    versionId: string,
    target: ModInstallTarget,
    signal?: AbortSignal,
  ) {
    const { preview, retained } = await this.planModrinth(installed, versionId, target, signal);
    await store.requireModFiles(retained, modrinthInstallOperation, signal);
    return preview;
  }

  async installModrinth(
    store: InstalledStore,
    versionId: string,
    target: ModInstallTarget,
    revision?: string,
    control?: PackageInstallControl,
  ) {
    const signal = control?.signal;
    await store.edit(async (installed, stage) => {
      reportPackageInstall(control, { phase: 'checking' });
      const { candidates, preview, retained } = await this.planModrinth(installed, versionId, target, signal);
      if (revision !== undefined && revision !== preview.revision) {
        throw new Error('The mod installation has changed. Refresh the preview before installing.');
      }
      await store.requireModFiles(retained, modrinthInstallOperation, signal);
      const staged = await installPlan(
        this.modrinthRequests.fetch,
        installed,
        stage,
        candidates,
        target.loader,
        control,
      );
      await store.requireModFiles(retained, modrinthInstallOperation, signal);
      return staged;
    }, control);
  }

  private async planModrinth(
    installed: Installed[],
    versionId: string,
    target: ModInstallTarget,
    signal?: AbortSignal,
  ) {
    const plan = new Map<string, Candidate>();
    const selected = new Map<string, string>();
    const installedById = new Map(installed.map((item) => [item.id, item]));
    const modId = (projectId: string) => `modrinth:${projectId}`;
    async function visit(this: Packages, version: ModVersion) {
      signal?.throwIfAborted();
      const id = modId(version.project_id);
      const previous = selected.get(id);
      if (previous) {
        if (previous !== version.id) throw new Error('The mod requires conflicting dependency versions.');
        return;
      }
      if (selected.size >= dependencyLimit) throw new Error('This mod requires too many dependencies.');
      selected.set(id, version.id);

      const requires: Candidate['requires'] = [];
      const conflicts: Candidate['conflicts'] = [];
      for (const dependency of version.dependencies) {
        signal?.throwIfAborted();
        const { project_id: projectId, version_id: explicit } = dependency;
        if (dependency.dependency_type === 'incompatible' && projectId) {
          conflicts.push({ id: modId(projectId), ...(explicit && { releaseId: explicit }) });
        }
        if (dependency.dependency_type !== 'required') continue;
        const installedRelease = projectId ? installedById.get(modId(projectId)) : undefined;
        if (!explicit && !projectId) throw new Error('A required Modrinth dependency has no downloadable release.');
        if (!explicit && installedRelease?.enabled) {
          requires.push({ id: installedRelease.id });
          continue;
        }
        const releaseId = explicit ?? installedRelease?.releaseId;
        const resolved = releaseId
          ? await this.modrinth.exact(releaseId, target, signal)
          : await this.modrinth.compatible(projectId!, target, signal);
        if (projectId && resolved.project_id !== projectId) {
          throw new Error('Modrinth returned a release for a different dependency project.');
        }
        requires.push({ id: modId(resolved.project_id), ...(explicit && { releaseId: explicit }) });
        await visit.call(this, resolved);
      }
      plan.set(id, {
        id,
        title: version.name,
        releaseId: version.id,
        version: version.version_number,
        source: 'modrinth',
        requires,
        conflicts,
        artifact: modrinthArtifact(version),
      });
    }
    const root = await this.modrinth.exact(versionId, target, signal);
    await visit.call(this, root);
    signal?.throwIfAborted();
    const candidates = [...plan.values()];
    verifyInstalled(replaceInstalled(installed, candidates.map(installRecord)));

    const changes = candidates.map((candidate): ModrinthInstallPreview['changes'][number] => {
      const existing = installedById.get(candidate.id);
      return {
        id: candidate.releaseId,
        projectId: candidate.id.slice('modrinth:'.length),
        title: candidate.title,
        version: candidate.version,
        action:
          existing === undefined
            ? 'install'
            : existing.releaseId !== candidate.releaseId
              ? 'replace'
              : existing.enabled
                ? 'reinstall'
                : 'enable',
        ...(existing && { installedVersion: existing.version }),
        ...(existing?.enabled === false && existing.releaseId !== candidate.releaseId && { enables: true }),
      };
    });
    const release = { id: root.id, projectId: root.project_id, title: root.name, version: root.version_number };
    const revision = createHash('sha256')
      .update(JSON.stringify({ target, release, candidates, installed }))
      .digest('hex');
    return {
      candidates,
      retained: retainedRequirements(plan, installedById),
      preview: { release, changes, revision } satisfies ModrinthInstallPreview,
    };
  }

  importLocal(store: InstalledStore, file: string, target: MinecraftModTarget) {
    return store.edit(async (installed, stage) => {
      const artifact = join(stage, 'local.jar');
      const { mod, integrity } = await stageLocalMod(file, target, artifact);
      const id = `local:${mod.id}`;
      const record: Installed = {
        id,
        jarIds: mod.ids,
        title: mod.title,
        version: mod.version,
        releaseId: mod.version,
        source: 'local',
        integrity,
        enabled: true,
        requires: [],
        conflicts: [],
      };
      return { next: replaceInstalled(installed, [record]), artifacts: new Map([[id, artifact]]) };
    });
  }

  private async originalArtifact(record: Installed, target: MinecraftModTarget) {
    if (record.source === 'modrinth') {
      const release = await this.modrinth.exact(record.releaseId, target);
      if (`modrinth:${release.project_id}` !== record.id || release.version_number !== record.version) {
        throw new Error('Modrinth returned a different mod release.');
      }
      return modrinthArtifact(release);
    }
    return this.originalCatalogArtifact(record, target);
  }

  private async originalCatalogArtifact(record: Installed, target?: MinecraftModTarget, signal?: AbortSignal) {
    const ref = { packageId: record.id, releaseId: record.releaseId };
    const release = await this.catalog
      .exact(ref, signal)
      .catch((error: unknown) => missingCatalogRelease(error, ref, 'installed'));
    checkRelease(this.launcherVersion, target, release);
    if (release.version !== record.version) throw new Error('REZICS returned a different installed release.');
    return catalogArtifact(release);
  }

  repairOverlayExtension(store: InstalledStore, packageId: string, revision: string, signal?: AbortSignal) {
    return store.edit(async (installed, stage) => {
      const record = installed.find(({ id }) => id === packageId);
      if (record?.source !== 'rezics' || overlayExtensionRevision(record) !== revision) {
        throw new Error('The installed Overlay extension changed. Review it again.');
      }
      const artifact = await this.originalCatalogArtifact(record, undefined, signal);
      if (record.integrity && !sameFingerprint(record.integrity, artifact)) {
        throw new Error('The published artifact no longer matches the installed Overlay release.');
      }
      const content = await stageOverlayPanel(this.fetcher, record.id, artifact, join(stage, 'panel.json'), signal);
      signal?.throwIfAborted();
      return { next: replaceInstalled(installed, [{ ...record, ...content }]), artifacts: new Map() };
    });
  }

  reorderOverlayExtensions(store: InstalledStore, packageIds: string[], orderRevision: string) {
    return store.edit(async (installed) => {
      if (overlayExtensionOrderRevision(installed) !== orderRevision) {
        throw new Error('The installed Overlay extension order changed. Review it again.');
      }
      const invalid = 'Include every installed Overlay extension exactly once.';
      const records = new Map(installed.map((record) => [record.id, record]));
      if (packageIds.length !== installed.length || new Set(packageIds).size !== installed.length) {
        throw new Error(invalid);
      }
      const next = packageIds.map((id) => {
        const record = records.get(id);
        if (!record) throw new Error(invalid);
        return record;
      });
      return { next, artifacts: new Map() };
    });
  }

  repairMod(store: InstalledStore, packageId: string, target: MinecraftModTarget, localFile?: string) {
    return store.edit(async (installed, stage) => {
      const record = installed.find(({ id }) => id === packageId);
      if (!record) throw new Error('This mod is no longer installed.');
      const path = join(stage, 'repair.jar');
      let integrity: ArtifactFingerprint;
      let mod: Awaited<ReturnType<typeof readMinecraftMod>>;
      if (record.source === 'local') {
        if (!localFile) throw new Error('Choose the original JAR for this mod.');
        ({ mod, integrity } = await stageLocalMod(localFile, target, path));
        if (`local:${mod.id}` !== record.id || mod.version !== record.version) {
          throw new Error('The selected JAR is for a different mod or version.');
        }
      } else {
        const artifact = await this.originalArtifact(record, target);
        integrity = fingerprint(artifact);
        const fetcher = record.source === 'modrinth' ? this.modrinthRequests.fetch : this.fetcher;
        await downloadArtifact(fetcher, artifact, path);
        mod = await readMinecraftMod(path, target.loader);
      }
      if (record.integrity && !sameFingerprint(record.integrity, integrity)) {
        throw new Error('The original mod file does not match the installed release’s digest.');
      }
      if (
        (record.jarId && !mod.ids.includes(record.jarId)) ||
        (record.jarIds &&
          (record.jarIds.length !== mod.ids.length || record.jarIds.some((id) => !mod.ids.includes(id))))
      ) {
        throw new Error('The original JAR does not provide the installed mod IDs.');
      }
      return {
        next: replaceInstalled(installed, [{ ...record, jarIds: mod.ids, integrity }]),
        artifacts: new Map([[packageId, path]]),
      };
    });
  }
}

export function selectOverlayPanels(installed: readonly Installed[]) {
  const panels: OverlayPanel[] = [];
  for (const record of installed) {
    if (!record?.enabled || typeof record.id !== 'string') continue;
    const panel = installedOverlayPanel(record.id, record.panel, record.panelDigest);
    if (panel) panels.push(panel);
    if (panels.length === overlayPanelLimit) break;
  }
  return panels;
}

export function overlayExtensionRevision(record: Installed) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function overlayExtensionOrderRevision(installed: Installed[]) {
  return createHash('sha256')
    .update(JSON.stringify(installed.map(({ id }) => id)))
    .digest('hex');
}

export function overlayExtensionViews(installed: Installed[]): InstalledOverlayExtension[] {
  const visible = new Set(selectOverlayPanels(installed).map(({ id }) => id));
  const orderRevision = overlayExtensionOrderRevision(installed);
  return installed.map((record) => {
    const { id, releaseId, title, version, source, enabled } = record;
    const fileIssue = overlayPanelIssue(record);
    return {
      id,
      releaseId,
      title,
      version,
      source,
      enabled,
      ...(fileIssue && { fileIssue }),
      revision: overlayExtensionRevision(record),
      orderRevision,
      visible: visible.has(id),
    };
  });
}
