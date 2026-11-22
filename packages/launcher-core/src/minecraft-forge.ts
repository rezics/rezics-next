import { checksum, MinecraftFolder, type ResolvedVersion, Version } from '@xmcl/core';
import { DownloadTask, type InstallProfile, postProcess, resolveProcessors } from '@xmcl/installer';
import { open, readAllEntries, readEntry } from '@xmcl/unzip';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import * as v from 'valibot';
import { javaEnvironment } from './java-runtime.ts';
import type { MinecraftInstallation } from './minecraft-launch-metadata.ts';
import { installMinecraftLibraries } from './minecraft-libraries.ts';
import type { ForgeSelection, LoaderInstaller } from './minecraft-versions.ts';
import { fileInfo, reclaimLocalTree, writeJson } from './storage.ts';

type TransferDispatcher = NonNullable<ConstructorParameters<typeof DownloadTask>[0]['dispatcher']>;
type Processor = ReturnType<typeof resolveProcessors>[number];
const Sha1 = /^[a-f\d]{40}$/u;
const Sha256 = /^[a-f\d]{64}$/u;
const processorStageId = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/u;
const OutputHashes = v.record(v.string(), v.pipe(v.string(), v.regex(Sha1)));
const MavenLibrary = v.looseObject({
  name: v.string(),
  downloads: v.looseObject({
    artifact: v.looseObject({ path: v.string(), url: v.string(), sha1: v.string(), size: v.number() }),
  }),
});
const LoaderProfile = v.looseObject({
  spec: v.literal(1),
  version: v.string(),
  profile: v.string(),
  minecraft: v.string(),
  json: v.literal('/version.json'),
  path: v.nullish(v.string(), ''),
  libraries: v.array(MavenLibrary),
  data: v.record(v.string(), v.object({ client: v.string(), server: v.string() })),
  processors: v.array(
    v.object({
      jar: v.string(),
      args: v.array(v.string()),
      classpath: v.array(v.string()),
      sides: v.optional(v.array(v.picklist(['client', 'server'])), ['client', 'server']),
      outputs: v.optional(v.record(v.string(), v.string()), {}),
    }),
  ),
});
const LaunchProfile = v.looseObject({
  id: v.string(),
  inheritsFrom: v.string(),
  mainClass: v.string(),
  libraries: v.array(MavenLibrary),
});
const outputOptions = ['--output', '--out-jar', '--slim', '--extra'];

function under(root: string, path: string): string {
  const name = relative(root, path);
  if (!name || isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`)) {
    throw new Error('The loader installer addressed a file outside its shared libraries.');
  }
  return name;
}

async function digest(file: string): Promise<string | undefined> {
  const entry = await fileInfo(file);
  if (!entry?.isFile() || !entry.size) return undefined;
  return checksum(file, 'sha1');
}

function outputRecordPath(versionRoot: string, sha256?: string) {
  return join(versionRoot, sha256 === undefined ? 'outputs.json' : `outputs-${sha256}.json`);
}

async function readOutputHashes(versionRoot: string, sha256?: string) {
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !Sha256.test(sha256))) return undefined;
  const file = outputRecordPath(versionRoot, sha256);
  const info = await fileInfo(file);
  if (!info?.isFile() || info.size > 1_000_000) return undefined;
  const bytes = await readFile(file);
  if (sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== sha256) return undefined;
  try {
    const parsed = v.safeParse(OutputHashes, JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.output : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

export async function verifyGeneratedLoaderFiles(
  folder: MinecraftFolder,
  installation: MinecraftInstallation,
): Promise<boolean> {
  const { versionId, loaderOutputsSha256 } = installation;
  const recorded = await readOutputHashes(folder.getVersionRoot(versionId), loaderOutputsSha256);
  const outputs = Object.entries(recorded ?? {});
  for (const [name, expected] of outputs) {
    if (isAbsolute(name) || /[\\:\x00]/u.test(name)) return false;
    const path = join(folder.libraries, name);
    if (under(folder.libraries, path).split(sep).join('/') !== name || (await digest(path)) !== expected) return false;
  }
  return outputs.length > 0;
}

async function invokeProcessor(processor: Processor, folder: MinecraftFolder, java: string, signal: AbortSignal) {
  let closed: Promise<void> | undefined;
  try {
    const { jar, classpath, args, outputs } = processor;
    await postProcess([{ jar, classpath, args, outputs }], folder, {
      java,
      spawn(command, args) {
        signal.throwIfAborted();
        const child = spawn(command, args ?? [], {
          cwd: folder.root,
          env: javaEnvironment(),
          stdio: 'ignore',
          windowsHide: true,
          signal,
          killSignal: 'SIGKILL',
        });
        closed = new Promise((resolve) => child.once('close', () => resolve()));
        return child;
      },
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`The loader could not run ${processor.jar}.`, { cause: error });
  } finally {
    await closed;
  }
}

async function processLoader(
  profile: InstallProfile,
  folder: MinecraftFolder,
  java: string,
  dispatcher: TransferDispatcher,
  vanilla: ResolvedVersion,
  record: { versionRoot: string; previousSha256: string | undefined },
  signal: AbortSignal,
) {
  const { versionRoot, previousSha256 } = record;
  const staging = join(folder.root, 'processor-staging');
  const stagingInfo = await fileInfo(staging);
  if (stagingInfo) {
    if (!stagingInfo.isDirectory()) throw new Error('The loader staging folder is unavailable or linked.');
    // Preparation holds the shared Minecraft resource lock. Only an earlier attempt can own these stages.
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (entry.isDirectory() && processorStageId.test(entry.name)) await reclaimLocalTree(join(staging, entry.name));
    }
  }
  const cache = outputRecordPath(versionRoot);
  const previous = (await readOutputHashes(versionRoot, previousSha256)) ?? {};
  const verified: Record<string, string> = {};
  for (const processor of resolveProcessors('client', profile, folder)) {
    signal.throwIfAborted();
    const files = new Map(Object.entries(processor.outputs));
    for (const option of outputOptions) {
      const index = processor.args.indexOf(option);
      const path = index < 0 ? undefined : processor.args[index + 1];
      if (path && !files.has(path)) files.set(path, '');
    }
    if (!files.size) throw new Error(`The loader did not declare output files for ${processor.jar}.`);

    const rawMappings = processor.args.includes('DOWNLOAD_MOJMAPS') && !processor.args.includes('--sanitize');
    const mappings = rawMappings ? vanilla.downloads.client_mappings : undefined;
    if (rawMappings && (!mappings || files.size !== 1)) {
      throw new Error('Mojang did not supply verifiable client mappings for this loader.');
    }
    const stageRoot = join(staging, randomUUID());
    const extractionOption = processor.args.indexOf('--extract-libraries-to');
    const extraction = extractionOption < 0 ? undefined : join(stageRoot, 'extracted-libraries');
    if (extraction && (!processor.args.includes('PROCESS_MINECRAFT_JAR') || !processor.args[extractionOption + 1])) {
      throw new Error('The loader requested an unsupported library extraction.');
    }
    const outputs = [...files].map(([path, sha1]) => {
      const name = under(folder.libraries, path).split(sep).join('/');
      const authoritative = mappings?.sha1 || sha1;
      if (authoritative && !Sha1.test(authoritative))
        throw new Error('The loader supplied an invalid output checksum.');
      const expected = authoritative || verified[name] || previous[name];
      return {
        path,
        name,
        expected,
        authoritative,
        stage: join(stageRoot, name),
      };
    });
    const healthy = await Promise.all(
      outputs.map(async ({ path, expected }) => (expected && (await digest(path)) === expected ? expected : undefined)),
    );
    if (healthy.every((hash): hash is string => hash !== undefined)) {
      for (const [index, output] of outputs.entries()) verified[output.name] = healthy[index]!;
      continue;
    }

    try {
      for (const { stage } of outputs) await mkdir(dirname(stage), { recursive: true });
      const byPath = new Map(outputs.map(({ path, stage }) => [path, stage]));
      if (mappings) {
        await new DownloadTask({
          url: mappings.url,
          destination: outputs[0]!.stage,
          validator: { algorithm: 'sha1', hash: mappings.sha1 },
          dispatcher,
        }).startAndWait();
      } else {
        const args = processor.args.map((arg) => byPath.get(arg) ?? arg);
        if (extraction) {
          await mkdir(extraction, { recursive: true });
          args[extractionOption + 1] = extraction;
        }
        await invokeProcessor({ ...processor, args }, folder, java, signal);
        if (extraction && (await readdir(extraction)).length) {
          throw new Error('The loader produced unexpected bundled libraries from the client JAR.');
        }
      }
      for (const output of outputs) {
        signal.throwIfAborted();
        const actual = await digest(output.stage);
        if (!actual) throw new Error(`The loader processor ${processor.jar} did not create ${basename(output.path)}.`);
        if (output.authoritative && actual !== output.authoritative) {
          const javaHint = processor.jar.startsWith('net.minecraftforge:')
            ? ` This Forge build may require a different Java ${vanilla.javaVersion.majorVersion} distribution. Choose a compatible Java executable and retry.`
            : '';
          throw new Error(
            `The loader output ${basename(output.path)} did not match its published SHA-1 (${output.authoritative}, received ${actual}).${javaHint}`,
          );
        }
        verified[output.name] = actual;
      }
      signal.throwIfAborted();
      for (const { stage, path } of outputs) {
        await mkdir(dirname(path), { recursive: true });
        await rename(stage, path);
      }
      await writeJson(cache, { ...previous, ...verified });
    } finally {
      // The Windows standalone runtime can fail on recursive removal of these Maven paths.
      await reclaimLocalTree(stageRoot);
    }
  }
  await writeJson(cache, verified);
  return verified;
}

export async function prepareForgeLoader({
  selection,
  source,
  vanilla,
  folder,
  java,
  dispatcher,
  signal,
  previousInstallation,
}: {
  selection: ForgeSelection;
  source: LoaderInstaller;
  vanilla: ResolvedVersion;
  folder: MinecraftFolder;
  java: string;
  dispatcher: TransferDispatcher;
  signal: AbortSignal;
  previousInstallation: MinecraftInstallation | undefined;
}) {
  const expectedId =
    selection.loader === 'forge'
      ? `${selection.version}-forge-${selection.forgeVersion}`
      : `neoforge-${selection.neoForgeVersion}`;
  if (!Sha1.test(source.sha1)) throw new Error('The loader installer checksum is invalid.');
  const id = `${expectedId}-${source.sha1.slice(0, 20)}`;
  const versionRoot = folder.getVersionRoot(id);
  const installer = join(versionRoot, 'installer.jar');
  signal.throwIfAborted();
  await new DownloadTask({
    url: source.url,
    destination: installer,
    validator: { algorithm: 'sha1', hash: source.sha1 },
    dispatcher,
  }).startAndWait();
  signal.throwIfAborted();

  const installerInfo = await fileInfo(installer);
  if (!installerInfo?.isFile() || installerInfo.size > 32_000_000)
    throw new Error('The loader installer is too large.');
  // Back the ZIP with checked bytes. The pinned ZIP reader can stall on large file-backed entries in Node 26.
  const archive = await readFile(installer, { signal });
  const zip = await open(archive, { lazyEntries: true, autoClose: false });
  let profile: InstallProfile;
  let launch: v.InferOutput<typeof LaunchProfile>;
  try {
    const entries = new Map((await readAllEntries(zip)).map((entry) => [entry.fileName, entry]));
    const installEntry = entries.get('install_profile.json');
    const versionEntry = entries.get('version.json');
    if (
      !installEntry ||
      !versionEntry ||
      installEntry.uncompressedSize > 2_000_000 ||
      versionEntry.uncompressedSize > 2_000_000
    ) {
      throw new Error('The loader archive does not contain supported installation metadata.');
    }
    profile = v.parse(LoaderProfile, JSON.parse((await readEntry(zip, installEntry)).toString('utf8')));
    launch = v.parse(LaunchProfile, JSON.parse((await readEntry(zip, versionEntry)).toString('utf8')));
    if (
      launch.id !== expectedId ||
      launch.inheritsFrom !== selection.version ||
      profile.minecraft !== selection.version ||
      profile.version !== expectedId
    ) {
      throw new Error('The loader installer does not match the selected game and loader versions.');
    }
    if (profile.data) {
      profile.data.INSTALLER = { client: installer, server: installer };
      const patch = entries.get('data/client.lzma');
      if (patch) {
        if (patch.uncompressedSize > 32_000_000) throw new Error('The loader client patch is too large.');
        const file = join(versionRoot, 'client.lzma');
        const bytes = await readEntry(zip, patch);
        signal.throwIfAborted();
        const expected = createHash('sha1').update(bytes).digest('hex');
        if ((await digest(file)) !== expected) await writeFile(file, bytes);
        profile.data.BINPATCH = { client: file, server: '' };
      }
      if (profile.data.PATCHED_SHA) {
        const processor = profile.processors?.find(({ args }) => args.includes('{PATCHED}'));
        if (processor) processor.outputs = { ...processor.outputs, '{PATCHED}': '{PATCHED_SHA}' };
      }
    }
  } finally {
    zip.close();
  }

  const libraries = Version.resolveLibraries(profile.libraries);
  for (let start = 0; start < libraries.length; start += 16) {
    signal.throwIfAborted();
    const batch = libraries.slice(start, start + 16);
    await installMinecraftLibraries(batch, folder, dispatcher, signal);
  }
  const previousSha256 = previousInstallation?.versionId === id ? previousInstallation.loaderOutputsSha256 : undefined;
  const outputs = await processLoader(
    profile,
    folder,
    java,
    dispatcher,
    vanilla,
    { versionRoot, previousSha256 },
    signal,
  );
  const loaderOutputsSha256 = createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
  if (!(await readOutputHashes(versionRoot, loaderOutputsSha256))) {
    await writeJson(outputRecordPath(versionRoot, loaderOutputsSha256), outputs);
  }
  signal.throwIfAborted();
  await writeJson(folder.getVersionJson(id), { ...launch, id });
  return { version: await Version.parse(folder, id), loaderOutputsSha256 };
}
