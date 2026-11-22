import { DownloadTask, installJavaRuntimeTask, type JavaRuntimeTarget } from '@xmcl/installer';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import * as v from 'valibot';
import { checkResourceFiles } from './minecraft-files.ts';
import { isPortableSaveName } from './saved-worlds.ts';
import { checkLocalDirectory, fileInfo } from './storage.ts';

export const javaComponentPattern = /^[a-z][a-z0-9-]{0,79}$/u;
const javaExecutable = process.platform === 'win32' ? 'bin/java.exe' : 'bin/java';
const manifestName = 'manifest.json';
const manifestSizeLimit = 2 * 1024 * 1024;
const digestPattern = /^[a-f\d]{40}$/u;
const RuntimeManifest = v.object({
  files: v.record(
    v.pipe(
      v.string(),
      v.check((path) => path.split('/').every(isPortableSaveName)),
    ),
    v.variant('type', [
      v.object({ type: v.literal('directory') }),
      v.object({ type: v.literal('link'), target: v.string() }),
      v.object({
        type: v.literal('file'),
        executable: v.optional(v.boolean(), false),
        downloads: v.object({
          raw: v.object({
            sha1: v.pipe(v.string(), v.regex(digestPattern)),
            size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
            url: v.pipe(v.string(), v.url()),
          }),
        }),
      }),
    ]),
  ),
});

type RuntimeFiles = v.InferOutput<typeof RuntimeManifest>['files'];
type RuntimeLink = { name: string; target: string; directory: boolean };
type Dispatcher = NonNullable<Parameters<typeof installJavaRuntimeTask>[0]['dispatcher']>;

export function managedJavaExecutable(resources: string, runtime: string) {
  return join(resources, 'runtime', runtime, javaExecutable);
}

async function readRuntimeFiles(root: string, digest: string) {
  const path = join(root, manifestName);
  const file = await fileInfo(path);
  if (!file?.isFile() || file.size > manifestSizeLimit) throw new Error('The managed Java manifest is unavailable.');
  const bytes = await readFile(path);
  if (createHash('sha1').update(bytes).digest('hex') !== digest) {
    throw new Error('The managed Java manifest is damaged.');
  }
  const { files } = v.parse(RuntimeManifest, JSON.parse(bytes.toString('utf8')));
  if (files[javaExecutable]?.type !== 'file') throw new Error('The managed Java manifest is missing its executable.');
  return files;
}

function linkTarget(files: RuntimeFiles, name: string, target: string) {
  const visited = new Set([name]);
  for (;;) {
    if (!target.split('/').every((part) => part === '..' || part === '.' || isPortableSaveName(part))) break;
    name = posix.normalize(posix.join(posix.dirname(name), target));
    if (visited.has(name)) break;
    const entry = Object.hasOwn(files, name) ? files[name] : undefined;
    if (!entry) break;
    if (entry.type !== 'link') return entry.type;
    visited.add(name);
    target = entry.target;
  }
  throw new Error('The managed Java manifest contains an invalid link.');
}

function runtimeLayout(files: RuntimeFiles) {
  const names = new Set([manifestName]);
  const directories = new Set<string>();
  const links: RuntimeLink[] = [];
  for (const [name, entry] of Object.entries(files)) {
    const key = name.toLowerCase();
    if (names.has(key) || key.startsWith(`${manifestName}/`)) {
      throw new Error('The managed Java manifest contains a conflicting path.');
    }
    names.add(key);
    if (entry.type === 'directory') directories.add(name);
    if (entry.type === 'link') {
      links.push({ name, target: entry.target, directory: linkTarget(files, name, entry.target) === 'directory' });
    }
    for (let parent = posix.dirname(name); parent !== '.'; parent = posix.dirname(parent)) directories.add(parent);
  }
  const nonDirectories = new Set(
    Object.entries(files)
      .filter(([, entry]) => entry.type !== 'directory')
      .map(([name]) => name.toLowerCase()),
  );
  if ([...directories].some((name) => nonDirectories.has(name.toLowerCase()))) {
    throw new Error('The managed Java manifest contains a conflicting directory.');
  }
  return { directories: [...directories].sort(), links };
}

async function ensureDirectories(root: string, directories: readonly string[]) {
  for (const name of directories) {
    const path = join(root, name);
    await checkLocalDirectory(path, 'managed Java');
    await mkdir(path, { recursive: true });
  }
}

async function removeUnexpectedFileLink(path: string) {
  if ((await fileInfo(path))?.isSymbolicLink()) await rm(path);
}

async function restoreRuntimeLayout(root: string, files: RuntimeFiles, links: RuntimeLink[], signal?: AbortSignal) {
  if (process.platform !== 'win32') {
    for (const [name, entry] of Object.entries(files)) {
      if (entry.type !== 'file' || (!entry.executable && name !== javaExecutable)) continue;
      signal?.throwIfAborted();
      const path = join(root, name);
      const file = await fileInfo(path);
      if (!file?.isFile()) throw new Error('A managed Java executable is unavailable.');
      if (!(file.mode & 0o100)) await chmod(path, (file.mode & 0o777) | 0o100);
    }
  }
  for (const { name, target, directory } of links) {
    signal?.throwIfAborted();
    const path = join(root, name);
    const current = await fileInfo(path);
    if (current?.isSymbolicLink()) {
      const existing = await readlink(path);
      if ((process.platform === 'win32' ? existing.replaceAll('\\', '/') : existing) === target) continue;
    }
    const staged = join(dirname(path), `.rezics-${randomUUID()}.tmp`);
    try {
      await symlink(target, staged, directory ? 'dir' : 'file');
      await rename(staged, path);
    } finally {
      await rm(staged, { force: true });
    }
  }
}

export async function prepareManagedJava(
  resources: string,
  component: string,
  target: JavaRuntimeTarget,
  dispatcher: Dispatcher,
  signal: AbortSignal,
) {
  const runtime = `${component}-${target.manifest.sha1}`;
  const root = join(resources, 'runtime', runtime);
  await ensureDirectories(resources, ['runtime', `runtime/${runtime}`]);
  const manifest = join(root, manifestName);
  await removeUnexpectedFileLink(manifest);
  signal.throwIfAborted();
  await new DownloadTask({
    dispatcher,
    url: target.manifest.url,
    destination: manifest,
    validator: { algorithm: 'sha1', hash: target.manifest.sha1 },
  }).startAndWait();
  const files = await readRuntimeFiles(root, target.manifest.sha1);
  const { directories, links } = runtimeLayout(files);
  await ensureDirectories(root, directories);
  const downloads = Object.entries(files).filter(([, entry]) => entry.type !== 'link');
  for (const [name, entry] of downloads) {
    if (entry.type === 'file') await removeUnexpectedFileLink(join(root, name));
  }
  signal.throwIfAborted();
  await installJavaRuntimeTask({
    destination: root,
    dispatcher,
    manifest: { target: component, version: target.version, files: Object.fromEntries(downloads) },
  }).startAndWait();
  await restoreRuntimeLayout(root, files, links, signal);
  signal.throwIfAborted();
  return runtime;
}

export async function checkManagedJava(resources: string, runtime: string) {
  const separator = runtime.lastIndexOf('-');
  const digest = runtime.slice(separator + 1);
  if (!javaComponentPattern.test(runtime.slice(0, separator)) || !digestPattern.test(digest)) return false;
  const root = join(resources, 'runtime', runtime);
  await checkLocalDirectory(dirname(root), 'managed Java');
  if (!(await fileInfo(root))?.isDirectory()) return false;
  const files = await readRuntimeFiles(root, digest);
  const { directories, links } = runtimeLayout(files);
  await ensureDirectories(root, directories);
  const valid = await checkResourceFiles(
    Object.entries(files).flatMap(([name, entry]) =>
      entry.type === 'file' ? [{ path: join(root, name), ...entry.downloads.raw }] : [],
    ),
  );
  if (!valid) return false;
  await restoreRuntimeLayout(root, files, links);
  return true;
}
