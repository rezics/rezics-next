import type {
  InstalledPackage,
  MinecraftModStatePreview,
  OverlayPanel,
  PackageInstallControl,
  PackageInstallProgress,
} from '@rezics/launcher-contract';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { hashArtifactFile, installedOverlayPanel, type ArtifactFingerprint } from './artifact.ts';
import { planModState } from './mod-state.ts';
import type { MinecraftModTarget } from './modrinth.ts';
import { checkLocalDirectory, fileInfo, readJson, writeJson } from './storage.ts';

export function reportPackageInstall(control: PackageInstallControl | undefined, progress: PackageInstallProgress) {
  try {
    control?.report?.(progress);
  } catch {
    // The progress observer may have disconnected while the install was running.
  }
}

type Constraint = { id: string; releaseId?: string };
export type Installed = InstalledPackage & {
  releaseId: string;
  requires: Constraint[];
  conflicts: Constraint[];
  jarId?: string;
  jarIds?: string[];
  integrity?: ArtifactFingerprint;
  panel?: OverlayPanel;
  panelDigest?: string;
};

type Ledger = { transaction?: string; packages: Installed[] };
const journalSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  changes: v.array(
    v.strictObject({
      file: v.pipe(v.string(), v.regex(/^rezics-[a-f0-9]{64}\.jar(?:\.disabled)?$/u)),
      previous: v.boolean(),
      next: v.boolean(),
    }),
  ),
});
type Journal = v.InferOutput<typeof journalSchema>;
type Change = Journal['changes'][number];
type FileIssue = NonNullable<InstalledPackage['fileIssue']>;
type ModStateTarget = MinecraftModTarget & { instanceId: string };
const invalidJournal = 'The interrupted mod change could not be verified. Its files were kept.';

export function overlayPanelIssue(record: Installed): FileIssue | undefined {
  if (record.panel === undefined) return 'missing';
  if (!installedOverlayPanel(record.id, record.panel, record.panelDigest)) return 'damaged';
}

function installedView(record: Installed, fileIssue?: FileIssue): InstalledPackage {
  const { id, title, version, source, enabled, releaseId } = record;
  return {
    id,
    title,
    version,
    source,
    enabled,
    ...(source !== 'local' && { releaseId }),
    ...(fileIssue && { fileIssue }),
  };
}

function jarFile(record: Installed) {
  const hash = createHash('sha256').update(record.id).digest('hex');
  return `rezics-${hash}.jar${record.enabled ? '' : '.disabled'}`;
}

function modStateRevision(current: Installed[], target: ModStateTarget, packageId: string, enabled: boolean) {
  return createHash('sha256').update(JSON.stringify({ target, packageId, enabled, current })).digest('hex');
}

function applies(constraint: Constraint, record?: Installed) {
  return record?.enabled && (!constraint.releaseId || record.releaseId === constraint.releaseId);
}

export function verifyInstalled(packages: Installed[]) {
  const lookup = new Map(packages.map((record) => [record.id, record]));
  const identifiers = new Map<string, string>();
  for (const record of packages) {
    if (!record.enabled) continue;
    for (const id of record.jarIds ?? (record.jarId ? [record.jarId] : [])) {
      const already = identifiers.get(id);
      if (already !== undefined) throw new Error(`${record.title} and ${already} both provide mod ${id}.`);
      identifiers.set(id, record.title);
    }
    for (const required of record.requires) {
      if (!applies(required, lookup.get(required.id))) {
        throw new Error(`${record.title} requires ${required.id} at a compatible installed release.`);
      }
    }
    for (const conflict of record.conflicts) {
      if (applies(conflict, lookup.get(conflict.id))) {
        throw new Error(`${record.title} conflicts with ${lookup.get(conflict.id)?.title ?? conflict.id}.`);
      }
    }
  }
}

export class InstalledStore {
  private readonly ledger: string;
  private readonly stage: string;

  constructor(
    private readonly root: string,
    private readonly mods?: string,
  ) {
    this.ledger = join(root, 'installed.json');
    this.stage = join(root, 'install-staging');
  }

  private async read() {
    const info = await fileInfo(this.ledger);
    if (info && !info.isFile()) throw new Error('The installed package ledger is unavailable or is a link.');
    return (await readJson<Ledger>(this.ledger)) ?? { packages: [] };
  }

  async list() {
    await this.recover();
    return (await this.read()).packages;
  }

  async readCommitted() {
    await checkLocalDirectory(this.root, 'installed packages');
    return (await this.read()).packages;
  }

  async committedModNames(): Promise<string[]> {
    return (await this.readCommitted()).map(jarFile);
  }

  private async inspectFile(record: Installed, signal?: AbortSignal): Promise<FileIssue | undefined> {
    if (!this.mods) return overlayPanelIssue(record);
    const path = join(this.mods, jarFile(record));
    try {
      const info = await fileInfo(path);
      if (!info) return 'missing';
      if (!info.isFile()) return 'unavailable';
      const integrity = record.integrity;
      if (
        integrity &&
        (info.size !== integrity.size ||
          (await hashArtifactFile(path, integrity.size, integrity.algorithm, signal)) !== integrity.digest)
      ) {
        return 'damaged';
      }
    } catch {
      signal?.throwIfAborted();
      return 'unavailable';
    }
  }

  async views(): Promise<InstalledPackage[]> {
    const result = [];
    for (const record of await this.list()) result.push(installedView(record, await this.inspectFile(record)));
    return result;
  }

  async firstEnabledFileIssue(): Promise<InstalledPackage | undefined> {
    for (const record of await this.list()) {
      if (!record.enabled) continue;
      const issue = await this.inspectFile(record);
      if (issue) return installedView(record, issue);
    }
  }

  async requireModFiles(records: readonly Installed[], operation: string, signal?: AbortSignal) {
    for (const record of records) {
      signal?.throwIfAborted();
      const issue = await this.inspectFile(record, signal);
      signal?.throwIfAborted();
      if (issue) throw new Error(`Repair ${record.title} before ${operation}.`);
    }
  }

  async previewModState(
    target: ModStateTarget,
    packageId: string,
    enabled: boolean,
  ): Promise<MinecraftModStatePreview> {
    const current = await this.list();
    const { changes } = await this.prepareModState(current, packageId, enabled);
    return {
      revision: modStateRevision(current, target, packageId, enabled),
      enabled,
      changes: changes.map(({ id, title, version }) => ({ id, title, version })),
    };
  }

  async applyModState(target: ModStateTarget, packageId: string, enabled: boolean, revision: string): Promise<void> {
    await this.edit(async (current) => {
      if (modStateRevision(current, target, packageId, enabled) !== revision) {
        throw new Error('The installed mods changed. Review the mod change again.');
      }
      const { next } = await this.prepareModState(current, packageId, enabled);
      return { next, artifacts: new Map() };
    });
  }

  private async prepareModState(current: Installed[], packageId: string, enabled: boolean) {
    const plan = planModState(current, packageId, enabled);
    verifyInstalled(plan.next);
    await this.requireModFiles(plan.required, 'enabling these mods');
    return plan;
  }

  private async intoGame(source: string, destination: string) {
    const temporary = join(this.stage, `copy-${randomUUID()}.tmp`);
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await rename(temporary, destination);
  }

  private async restoreChanges(mods: string, changes: Change[], installed: Installed[]) {
    const owned = new Set(installed.map(jarFile));
    const seen = new Set<string>();
    const operations: { destination: string; live: Stats | undefined; previous?: string }[] = [];
    const previousFolder = join(this.stage, 'previous');
    const nextFolder = join(this.stage, 'next');
    await checkLocalDirectory(previousFolder, 'package recovery');
    await checkLocalDirectory(nextFolder, 'package staging');
    for (const change of changes) {
      if (seen.has(change.file) || ((change.previous || !change.next) && !owned.has(change.file))) {
        throw new Error(invalidJournal);
      }
      seen.add(change.file);
      const destination = join(mods, change.file);
      const previous = change.previous ? join(previousFolder, change.file) : undefined;
      const next = change.next ? join(nextFolder, change.file) : undefined;
      const oldInfo = previous ? await fileInfo(previous) : undefined;
      const newInfo = next ? await fileInfo(next) : undefined;
      if ((previous && !oldInfo?.isFile()) || (next && !newInfo?.isFile())) throw new Error(invalidJournal);
      const live = await fileInfo(destination);
      if (live && !live.isFile()) throw new Error(invalidJournal);
      if (live) {
        if (oldInfo?.size !== live.size && newInfo?.size !== live.size) throw new Error(invalidJournal);
        const digest = await hashArtifactFile(destination, live.size, 'sha256');
        if (!digest) throw new Error(invalidJournal);
        if (
          previous &&
          oldInfo?.size === live.size &&
          (await hashArtifactFile(previous, live.size, 'sha256')) === digest
        ) {
          continue;
        }
        if (!next || newInfo?.size !== live.size || (await hashArtifactFile(next, live.size, 'sha256')) !== digest) {
          throw new Error(invalidJournal);
        }
      }
      if (previous || live) operations.push({ destination, live, ...(previous && { previous }) });
    }
    for (const { destination, live, previous } of operations) {
      const current = await fileInfo(destination);
      if (
        current?.dev !== live?.dev ||
        current?.ino !== live?.ino ||
        current?.size !== live?.size ||
        current?.mtimeMs !== live?.mtimeMs ||
        current?.ctimeMs !== live?.ctimeMs
      ) {
        throw new Error(invalidJournal);
      }
      if (previous) await this.intoGame(previous, destination);
      else await rm(destination, { force: true });
    }
  }

  async recover() {
    await checkLocalDirectory(this.root, 'installed packages');
    await checkLocalDirectory(this.stage, 'package staging');
    if (this.mods) {
      await checkLocalDirectory(dirname(this.mods), 'Minecraft game');
      await checkLocalDirectory(this.mods, 'instance mods');
    }
    const journalPath = join(this.stage, 'journal.json');
    const info = await fileInfo(journalPath);
    if (info) {
      if (!info.isFile()) throw new Error('The package recovery journal is unavailable or is a link.');
      if (info.size > 1_048_576) throw new Error(invalidJournal);
      const parsed = v.safeParse(journalSchema, await readJson<unknown>(journalPath).catch(() => undefined));
      if (!parsed.success) throw new Error(invalidJournal);
      if (this.mods) {
        const ledger = await this.read();
        if (ledger.transaction !== parsed.output.id)
          await this.restoreChanges(this.mods, parsed.output.changes, ledger.packages);
      }
      await rm(journalPath, { force: true });
    }
    await rm(this.stage, { force: true, recursive: true });
  }

  async edit(
    work: (current: Installed[], staging: string) => Promise<{ next: Installed[]; artifacts: Map<string, string> }>,
    control?: PackageInstallControl,
  ) {
    const signal = control?.signal;
    signal?.throwIfAborted();
    const current = await this.list();
    signal?.throwIfAborted();
    await mkdir(this.stage, { recursive: true });
    try {
      const { next, artifacts } = await work(current, this.stage);
      verifyInstalled(next);
      const id = randomUUID();
      reportPackageInstall(control, { phase: 'staging' });
      const changes = await this.prepareChanges(current, next, artifacts, signal);
      signal?.throwIfAborted();
      control?.beginCommit?.();
      reportPackageInstall(control, { phase: 'publishing' });
      await writeJson(join(this.stage, 'journal.json'), { id, changes } satisfies Journal);
      if (this.mods) {
        for (const change of changes) {
          const destination = join(this.mods, change.file);
          if (change.next) await this.intoGame(join(this.stage, 'next', change.file), destination);
          else await rm(destination, { force: true });
        }
      }
      await writeJson(this.ledger, { transaction: id, packages: next } satisfies Ledger);
      return next;
    } finally {
      await this.recover();
    }
  }

  private async prepareChanges(
    current: Installed[],
    next: Installed[],
    artifacts: Map<string, string>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const mods = this.mods;
    if (!mods) return [];

    const directory = await fileInfo(mods);
    if (directory && !directory.isDirectory()) throw new Error('The instance mods folder is unavailable or is a link.');
    await mkdir(mods, { recursive: true });
    const folders = ['previous', 'next'].map((name) => join(this.stage, name));
    await Promise.all(folders.map((folder) => mkdir(folder, { recursive: true })));
    const oldFiles = new Map(current.map((item) => [item.id, { file: jarFile(item), record: item }]));
    const newFiles = new Map(next.map((item) => [item.id, jarFile(item)]));
    const ownedFiles = new Set([...oldFiles.values()].map(({ file }) => file));
    const touched = new Map<string, string | null>();
    for (const [id, { file }] of oldFiles) {
      if (file !== newFiles.get(id)) touched.set(file, null);
    }
    for (const [id, file] of newFiles) {
      signal?.throwIfAborted();
      const artifact = artifacts.get(id);
      const old = oldFiles.get(id);
      if (!artifact && old?.file === file) continue;
      if (!artifact && !old) throw new Error('The new installation has no file.');
      if (!artifact && old) {
        const existing = await this.inspectFile(old.record);
        if (existing && !file.endsWith('.disabled')) throw new Error('Repair this mod before enabling it.');
        if (existing === 'missing') continue;
        if (existing === 'unavailable') throw new Error('A managed mod file is unavailable or is a link.');
      }
      touched.set(file, artifact ?? join(mods, old!.file));
    }
    const result: Change[] = [];
    for (const [file, source] of touched) {
      signal?.throwIfAborted();
      const destination = join(mods, file);
      const info = await fileInfo(destination);
      if (info && !info.isFile()) throw new Error('A managed mod file is unavailable or is a link.');
      if (info && !ownedFiles.has(file)) {
        throw new Error('An unmanaged file already occupies the mod installation path.');
      }
      if (info) await copyFile(destination, join(this.stage, 'previous', file));
      if (source) await copyFile(source, join(this.stage, 'next', file));
      result.push({ file, previous: !!info, next: !!source });
    }
    return result;
  }
}

export function replaceInstalled(current: Installed[], replacements: Installed[]) {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const replacement of replacements) records.set(replacement.id, replacement);
  return [...records.values()];
}
