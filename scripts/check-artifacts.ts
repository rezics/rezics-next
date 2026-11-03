import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  KERNEL_CLIENT_OUTPUT,
  readOutputTreeFile,
  safeOutputTreePath,
  verifyPublishedOutputTree,
} from './check-output-tree.ts';
import { withCheckFence } from './check-custody.ts';

export const CHECK_ARTIFACTS_VERSION = 1 as const;
export const CHECK_ARTIFACTS_MAX_FILES = 64;
export const CHECK_ARTIFACTS_MAX_BYTES = 256 * 1024 * 1024;

export type CheckArtifactEntry = {
  path: string;
  status: 'pending' | 'returned' | 'missing' | 'oversize' | 'unsafe';
  size?: number;
  file?: string;
  sha256?: string;
};

export type CheckArtifactManifest = {
  version: 1;
  physicalRunId: string;
  declarations: string[];
  oversizePaths?: string[];
  entries: CheckArtifactEntry[];
};

type DeclaredFile = { path: string; absolute: string; size: number };

export type CheckArtifactRestore = {
  physicalRunId: string;
  restored: Array<{ path: string; size: number; sha256: string }>;
  missing: string[];
  rejected: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function artifactRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > 1024 ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    /[\0\r\n]/.test(value) ||
    value.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error(`check-artifacts: path must be a contained workspace-relative file: ${JSON.stringify(value)}`);
  }
  return value;
}

export function validateArtifactDeclarations(paths: readonly string[]): string[] {
  if (paths.length > CHECK_ARTIFACTS_MAX_FILES) {
    throw new Error(`check-artifacts: at most ${CHECK_ARTIFACTS_MAX_FILES} output paths may be declared`);
  }
  const unique = new Set<string>();
  for (const path of paths) unique.add(artifactRelativePath(path));
  return [...unique];
}

export function artifactRunRelativePath(physicalRunId: string): string {
  if (!UUID.test(physicalRunId)) throw new Error('check-artifacts: invalid physical run identity');
  return `.temp/goal/checks/artifact-returns/${physicalRunId}`;
}

function containedPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, artifactRelativePath(path));
  const relativePath = relative(absoluteRoot, absolute);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`check-artifacts: path escapes workspace: ${path}`);
  }
  return absolute;
}

function safeArtifactStage(root: string, stageRelative: string, physicalRunId: string): string {
  if (!UUID.test(physicalRunId) || stageRelative !== artifactRunRelativePath(physicalRunId)) {
    throw new Error('check-artifacts: staging directory does not match the physical run');
  }
  const absoluteRoot = resolve(root);
  let current = absoluteRoot;
  for (const component of stageRelative.split('/')) {
    current = join(current, component);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('check-artifacts: staging path contains a symlink or non-directory');
    }
  }
  const realRoot = realpathSync(absoluteRoot);
  const realStage = realpathSync(current);
  const relativeStage = relative(realRoot, realStage);
  if (relativeStage === '..' || relativeStage.startsWith(`..${sep}`) || isAbsolute(relativeStage)) {
    throw new Error('check-artifacts: staging directory escapes the workspace');
  }
  return current;
}

function enumerateDeclaredFiles(root: string, path: string): DeclaredFile[] {
  const absolute = containedPath(root, path);
  const rootAbsolute = resolve(root);
  const relativePath = relative(rootAbsolute, absolute);
  let parent = rootAbsolute;
  for (const component of relativePath.split(sep).slice(0, -1)) {
    parent = join(parent, component);
    try {
      const stats = lstatSync(parent);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`check-artifacts: unsafe output parent for ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  let targetStats;
  try {
    targetStats = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (targetStats.isSymbolicLink()) throw new Error(`check-artifacts: output declaration crosses a symlink: ${path}`);
  const files: DeclaredFile[] = [];
  let total = 0;
  const addFile = (file: string): void => {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1)
      throw new Error(`check-artifacts: unsafe declared output: ${file}`);
    const filePath = relative(rootAbsolute, file).split(sep).join('/');
    artifactRelativePath(filePath);
    total += stats.size;
    if (files.length >= CHECK_ARTIFACTS_MAX_FILES || total > CHECK_ARTIFACTS_MAX_BYTES) {
      throw new Error('check-artifacts: declared output exceeds the file-count or byte bound');
    }
    files.push({ path: filePath, absolute: file, size: stats.size });
  };
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const child = join(directory, name);
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) throw new Error(`check-artifacts: declared output crosses a symlink: ${child}`);
      if (stats.isDirectory()) visit(child);
      else if (stats.isFile()) addFile(child);
      else throw new Error(`check-artifacts: unsafe declared output: ${child}`);
    }
  };
  if (targetStats.isDirectory()) visit(absolute);
  else if (targetStats.isFile()) addFile(absolute);
  else throw new Error(`check-artifacts: unsafe declared output: ${absolute}`);
  return files;
}

/** Clear only files inside explicit return declarations, leaving the declared directories themselves in place. */
export function clearDeclaredArtifacts(root: string, paths: readonly string[]): void {
  for (const path of validateArtifactDeclarations(paths)) {
    for (const file of enumerateDeclaredFiles(root, path)) unlinkSync(file.absolute);
  }
}

function manifestPath(stage: string): string {
  return join(stage, 'manifest.json');
}

/** Shared bounded schema-1 parser; old ordinary manifests may omit declarations and hashes. */
export function parseArtifactManifest(bytes: Buffer, physicalRunId: string): CheckArtifactManifest | undefined {
  if (bytes.length > 256 * 1024) return undefined;
  try {
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) return undefined;
    const manifest = JSON.parse(raw) as CheckArtifactManifest;
    if (
      manifest.version !== CHECK_ARTIFACTS_VERSION ||
      manifest.physicalRunId !== physicalRunId ||
      (manifest.declarations !== undefined &&
        (!Array.isArray(manifest.declarations) || manifest.declarations.length > CHECK_ARTIFACTS_MAX_FILES)) ||
      (manifest.oversizePaths !== undefined &&
        (!Array.isArray(manifest.oversizePaths) || manifest.oversizePaths.length > CHECK_ARTIFACTS_MAX_FILES)) ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length > CHECK_ARTIFACTS_MAX_FILES
    ) {
      return undefined;
    }
    const seen = new Set<string>();
    for (const path of manifest.declarations ?? []) {
      artifactRelativePath(path);
      if (seen.has(path)) return undefined;
      seen.add(path);
    }
    seen.clear();
    for (const entry of manifest.entries) {
      artifactRelativePath(entry.path);
      if (seen.has(entry.path) || !['pending', 'returned', 'missing', 'oversize', 'unsafe'].includes(entry.status))
        return undefined;
      seen.add(entry.path);
      if (entry.file !== undefined && !/^files\/[0-9]{3}\.bin$/.test(entry.file)) return undefined;
      if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) return undefined;
      if (entry.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(entry.sha256)) return undefined;
    }
    for (const path of manifest.oversizePaths ?? []) {
      artifactRelativePath(path);
      if (!manifest.declarations?.includes(path)) return undefined;
    }
    return manifest;
  } catch {
    return undefined;
  }
}

function readManifest(stage: string, physicalRunId: string): CheckArtifactManifest | undefined {
  try {
    return parseArtifactManifest(readOutputTreeFile(stage, 'manifest.json', 256 * 1024), physicalRunId);
  } catch {
    return undefined;
  }
}

function writeManifest(stage: string, manifest: CheckArtifactManifest): void {
  mkdirSync(stage, { recursive: true });
  const file = manifestPath(stage);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

/** Merge declarations into the exact per-run staging directory before a nested local command starts. */
export async function registerArtifactDeclarations(
  root: string,
  stageRelative: string,
  physicalRunId: string,
  paths: readonly string[],
): Promise<void> {
  const declared = validateArtifactDeclarations(paths);
  if (!declared.length) return;
  const stage = safeArtifactStage(root, stageRelative, physicalRunId);
  await withCheckFence(root, physicalRunId, () => {
    const manifest = readManifest(stage, physicalRunId) ?? {
      version: CHECK_ARTIFACTS_VERSION,
      physicalRunId,
      declarations: [],
      entries: [],
    };
    const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const declarations = new Set(manifest.declarations ?? []);
    for (const path of declared) {
      declarations.add(path);
      const source = containedPath(root, path);
      try {
        const stats = lstatSync(source);
        if (stats.isSymbolicLink()) throw new Error(`check-artifacts: output declaration crosses a symlink: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      entries.set(path, { path, status: 'pending' });
    }
    if (declarations.size > CHECK_ARTIFACTS_MAX_FILES) {
      throw new Error('check-artifacts: output declaration set exceeds its entry bound');
    }
    if (entries.size > CHECK_ARTIFACTS_MAX_FILES)
      throw new Error('check-artifacts: output manifest exceeds its entry bound');
    writeManifest(stage, { ...manifest, declarations: [...declarations], entries: [...entries.values()] });
    clearDeclaredArtifacts(root, declared);
  });
}

/** Capture the declared outputs even when the command fails; missing and oversized outputs remain explicit. */
export async function captureArtifactReturns(
  root: string,
  stageRelative: string,
  physicalRunId: string,
  paths: readonly string[],
): Promise<void> {
  const declared = validateArtifactDeclarations(paths);
  if (!declared.length) return;
  const stage = safeArtifactStage(root, stageRelative, physicalRunId);
  await withCheckFence(root, physicalRunId, () => {
    const manifest = readManifest(stage, physicalRunId);
    if (!manifest) throw new Error('check-artifacts: physical run manifest is missing or malformed');
    const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const filesDirectory = join(stage, 'files');
    try {
      const filesStats = lstatSync(filesDirectory);
      if (filesStats.isSymbolicLink() || !filesStats.isDirectory()) {
        throw new Error('check-artifacts: unsafe staging files directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(filesDirectory);
    }
    let total = manifest.entries
      .filter(
        (entry) =>
          entry.status === 'returned' &&
          !declared.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
      )
      .reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    const usedFiles = new Set(
      manifest.entries
        .filter(
          (entry) =>
            entry.status === 'returned' &&
            !declared.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
        )
        .map((entry) => entry.file)
        .filter((file): file is string => file !== undefined),
    );
    const oversizePaths = new Set(manifest.oversizePaths ?? []);
    const captureFile = (path: string, source: string, size: number): void => {
      const previous = entries.get(path);
      if (!previous && entries.size >= CHECK_ARTIFACTS_MAX_FILES) {
        const declaration = declared.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
        if (declaration) oversizePaths.add(declaration);
        return;
      }
      if (!Number.isSafeInteger(size) || size < 0 || total + size > CHECK_ARTIFACTS_MAX_BYTES) {
        entries.set(path, { path, status: 'oversize', size });
        return;
      }
      const bytes = readOutputTreeFile(root, path, CHECK_ARTIFACTS_MAX_BYTES);
      if (bytes.length !== size) {
        entries.set(path, { path, status: 'unsafe' });
        return;
      }
      let file = previous?.file;
      if (!file) {
        let index = 0;
        do {
          file = `files/${String(index++).padStart(3, '0')}.bin`;
        } while (usedFiles.has(file));
      }
      const staged = join(stage, file);
      const temporary = `${staged}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, staged);
      usedFiles.add(file);
      total += bytes.length;
      entries.set(path, {
        path,
        status: 'returned',
        size: bytes.length,
        file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    };
    for (const path of declared) {
      const source = containedPath(root, path);
      try {
        const sourceStats = lstatSync(source);
        if (sourceStats.isSymbolicLink()) {
          entries.set(path, { path, status: 'unsafe' });
          continue;
        }
        if (sourceStats.isDirectory()) {
          for (const prior of manifest.entries.filter((entry) => entry.path.startsWith(`${path}/`))) {
            if (prior.file) {
              try {
                unlinkSync(join(stage, prior.file));
              } catch {
                /* replaced evidence is not reused */
              }
              usedFiles.delete(prior.file);
            }
            entries.delete(prior.path);
          }
          const files = enumerateDeclaredFiles(root, path);
          if (!files.length) entries.set(path, { path, status: 'missing' });
          else {
            entries.delete(path);
            if (entries.size + files.length > CHECK_ARTIFACTS_MAX_FILES) {
              entries.set(path, { path, status: 'oversize' });
              continue;
            }
            for (const file of files) captureFile(file.path, file.absolute, file.size);
          }
          continue;
        }
        if (!sourceStats.isFile()) {
          entries.set(path, { path, status: 'unsafe' });
          continue;
        }
        captureFile(path, source, sourceStats.size);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries.set(path, { path, status: 'missing' });
        else if (error instanceof Error && error.message.includes('exceeds the file-count or byte bound')) {
          entries.set(path, { path, status: 'oversize' });
        } else entries.set(path, { path, status: 'unsafe' });
      }
    }
    writeManifest(stage, { ...manifest, oversizePaths: [...oversizePaths], entries: [...entries.values()] });
  });
}

function ensureSafeDestination(root: string, path: string): string {
  const absolute = safeOutputTreePath(root, path, true);
  const rootReal = realpathSync(root);
  let parent = dirname(absolute);
  const missing: string[] = [];
  while (parent !== resolve(root)) {
    try {
      const stats = lstatSync(parent);
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new Error(`check-artifacts: unsafe destination parent for ${path}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of missing) mkdirSync(directory);
  const realParent = realpathSync(dirname(absolute));
  const relativeParent = relative(rootReal, realParent);
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
    throw new Error(`check-artifacts: destination escapes workspace: ${path}`);
  }
  return absolute;
}

function removeStaleDeclaredOutput(root: string, path: string): void {
  try {
    const target = ensureSafeDestination(root, path);
    const stats = lstatSync(target);
    if (stats.isDirectory() || stats.isSymbolicLink() || !stats.isFile()) return;
    unlinkSync(target);
  } catch {
    // A rejected or inaccessible destination is reported in the receipt and left untouched.
  }
}

/** Restore only files listed by a bounded manifest for the exact physical run. */
export function restoreArtifactReturns(
  root: string,
  stageRelative: string,
  physicalRunId: string,
  logicalCheckId?: string,
): CheckArtifactRestore {
  let stage: string;
  try {
    stage = safeArtifactStage(root, stageRelative, physicalRunId);
  } catch (error) {
    return {
      physicalRunId,
      restored: [],
      missing: [],
      rejected: [error instanceof Error ? error.message : String(error)],
    };
  }
  const manifest = readManifest(stage, physicalRunId);
  if (!manifest) return { physicalRunId, restored: [], missing: [], rejected: ['manifest missing or malformed'] };
  const result: CheckArtifactRestore = { physicalRunId, restored: [], missing: [], rejected: [] };
  if (manifest.oversizePaths?.length) {
    result.rejected.push('declared output set exceeds the file-count bound');
    result.rejected.push(...manifest.oversizePaths.map((path) => `${path}: oversize`));
    result.missing.push(...(manifest.declarations ?? []));
    if (logicalCheckId) writeArtifactCatalog(root, logicalCheckId, manifest.declarations ?? []);
    return result;
  }
  let total = 0;
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index]!;
    const path = entry.path;
    if (entry.status !== 'returned') {
      removeStaleDeclaredOutput(root, path);
      if (entry.status === 'missing' || entry.status === 'pending') result.missing.push(path);
      else result.rejected.push(`${path}: ${entry.status}`);
      continue;
    }
    const sourceRelative = entry.file ?? `files/${String(index).padStart(3, '0')}.bin`;
    if (!/^files\/[0-9]{3}\.bin$/.test(sourceRelative) || entry.file !== sourceRelative) {
      result.rejected.push(`${path}: invalid staging file`);
      removeStaleDeclaredOutput(root, path);
      continue;
    }
    const source = join(stage, sourceRelative);
    try {
      const filesStats = lstatSync(dirname(source));
      if (filesStats.isSymbolicLink() || !filesStats.isDirectory()) throw new Error('unsafe staging files directory');
      const stats = lstatSync(source);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || stats.size !== entry.size) {
        throw new Error('staged file identity or size mismatch');
      }
      total += stats.size;
      if (total > CHECK_ARTIFACTS_MAX_BYTES) throw new Error('total returned bytes exceed the bound');
      const bytes = readOutputTreeFile(stage, sourceRelative, CHECK_ARTIFACTS_MAX_BYTES);
      if (path === KERNEL_CLIENT_OUTPUT.transport) verifyPublishedOutputTree(root, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (entry.sha256 !== undefined && sha256 !== entry.sha256) throw new Error('staged file digest mismatch');
      const destination = ensureSafeDestination(root, path);
      const temporary = `${destination}.${physicalRunId}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, destination);
      result.restored.push({ path, size: bytes.length, sha256 });
    } catch (error) {
      removeStaleDeclaredOutput(root, path);
      result.rejected.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const path of manifest.declarations ?? []) {
    const represented = manifest.entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`));
    if (!represented && !(manifest.oversizePaths ?? []).includes(path)) result.missing.push(path);
  }
  if (logicalCheckId) {
    writeArtifactCatalog(
      root,
      logicalCheckId,
      manifest.declarations?.length ? manifest.declarations : manifest.entries.map((entry) => entry.path),
    );
  }
  return result;
}

function catalogPath(root: string, logicalCheckId: string): string {
  if (!UUID.test(logicalCheckId)) throw new Error('check-artifacts: invalid logical check identity');
  return join(resolve(root), '.temp', 'goal', 'checks', 'artifact-catalog', `${logicalCheckId}.json`);
}

export function readArtifactCatalog(root: string, logicalCheckId: string): string[] {
  try {
    const file = catalogPath(root, logicalCheckId);
    const raw = readFileSync(file, 'utf8');
    if (raw.length > 16 * 1024) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; paths?: unknown };
    if (parsed.version !== CHECK_ARTIFACTS_VERSION || !Array.isArray(parsed.paths)) return [];
    return validateArtifactDeclarations(parsed.paths.filter((path): path is string => typeof path === 'string'));
  } catch {
    return [];
  }
}

export function writeArtifactCatalog(root: string, logicalCheckId: string, paths: readonly string[]): void {
  const file = catalogPath(root, logicalCheckId);
  const merged = new Set([...readArtifactCatalog(root, logicalCheckId), ...validateArtifactDeclarations(paths)]);
  if (merged.size > CHECK_ARTIFACTS_MAX_FILES)
    throw new Error('check-artifacts: logical output catalog exceeds its bound');
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: CHECK_ARTIFACTS_VERSION, paths: [...merged] })}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, file);
}

export function prepareArtifactRun(root: string, physicalRunId: string): string {
  const relativePath = artifactRunRelativePath(physicalRunId);
  const stage = containedPath(root, relativePath);
  let parent = resolve(root);
  for (const component of relativePath.split('/').slice(0, -1)) {
    parent = join(parent, component);
    try {
      const stats = lstatSync(parent);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error('check-artifacts: staging parent is not a contained directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(parent);
    }
  }
  try {
    const stageStats = lstatSync(stage);
    if (stageStats.isSymbolicLink() || !stageStats.isDirectory()) {
      throw new Error('check-artifacts: staging destination is not a directory');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  writeManifest(stage, { version: CHECK_ARTIFACTS_VERSION, physicalRunId, declarations: [], entries: [] });
  return relativePath;
}

export function cleanupArtifactRun(root: string, physicalRunId: string): void {
  const relativePath = artifactRunRelativePath(physicalRunId);
  const stage = containedPath(root, relativePath);
  let parent = resolve(root);
  for (const component of relativePath.split('/').slice(0, -1)) {
    parent = join(parent, component);
    const stats = lstatSync(parent);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('check-artifacts: unsafe staging parent during cleanup');
    }
  }
  try {
    const stats = lstatSync(stage);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('check-artifacts: unsafe staging directory during cleanup');
    }
    rmSync(stage, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

if (import.meta.main) {
  const [operation, ...extra] = Bun.argv.slice(2);
  const physicalRunId = process.env.REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID;
  const stage = process.env.REZICS_CHECK_ARTIFACTS_DIR;
  if (
    operation !== 'prepare' ||
    extra.length !== 0 ||
    !physicalRunId ||
    !UUID.test(physicalRunId) ||
    stage !== artifactRunRelativePath(physicalRunId)
  ) {
    throw new Error('check-artifacts: expected the internal prepare operation for the current physical run');
  }
  prepareArtifactRun(process.cwd(), physicalRunId);
}
