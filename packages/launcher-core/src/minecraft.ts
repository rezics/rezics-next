import type {
  MinecraftJavaPolicy,
  MinecraftJavaStatus,
  MinecraftSelection,
  MinecraftSettings,
} from '@rezics/launcher-contract';
import {
  diagnoseAssetIndex,
  diagnoseFile,
  getPlatform,
  launch,
  type LaunchOption,
  LaunchPrecheck,
  MinecraftFolder,
  type ResolvedVersion,
  Version,
} from '@xmcl/core';
import { DEFAULT_RUNTIME_ALL_URL, DownloadTask, installResolvedAssetsTask, installVersionTask } from '@xmcl/installer';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, interceptors } from 'undici/index.js';
import * as v from 'valibot';
import { javaEnvironment, probeJavaRuntime } from './java-runtime.ts';
import { LaunchFailure, launchIssues } from './launch-issues.ts';
import { materializeVirtualAssets, readMinecraftAssetIndex, uniqueMinecraftAssets } from './minecraft-assets.ts';
import { AuthFailure } from './minecraft-auth-provider.ts';
import type { MinecraftAuth } from './minecraft-auth.ts';
import { checkResourceFiles } from './minecraft-files.ts';
import { prepareForgeLoader, verifyGeneratedLoaderFiles } from './minecraft-forge.ts';
import {
  checkManagedJava,
  javaComponentPattern,
  managedJavaExecutable,
  prepareManagedJava,
} from './minecraft-java-runtime.ts';
import { pinLaunchMetadata, readLaunchVersion, type MinecraftInstallation } from './minecraft-launch-metadata.ts';
import { installMinecraftLibraries } from './minecraft-libraries.ts';
import { extractMinecraftNatives } from './minecraft-natives.ts';
import type { MinecraftVersions } from './minecraft-versions.ts';
import type { MinecraftPreparationJob } from './plugins/minecraft-preparation.ts';
import { fileInfo, readJson, writeJson } from './storage.ts';

type TransferDispatcher = NonNullable<NonNullable<Parameters<typeof installVersionTask>[2]>['dispatcher']>;

const Sha1 = v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u));
const resourceBatchSize = 32;
const RuntimeTarget = v.object({
  availability: v.object({ group: v.number(), progress: v.number() }),
  manifest: v.object({
    url: v.pipe(v.string(), v.url()),
    sha1: Sha1,
    size: v.number(),
  }),
  version: v.object({ name: v.string(), released: v.string() }),
});

function javaPlatform() {
  const platform = getPlatform();
  if (platform.name === 'windows') {
    return ['arm64', 'x86'].includes(platform.arch) ? `windows-${platform.arch}` : 'windows-x64';
  }
  if (platform.name === 'linux') {
    return ['ia32', 'x86'].includes(platform.arch) ? 'linux-i386' : 'linux';
  }
  if (platform.name === 'osx') return platform.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  throw new Error('This system does not have a managed Minecraft Java runtime.');
}

function usesNamedAssets(version: ResolvedVersion) {
  return /^(?:legacy|pre-[a-z\d.-]+)$/iu.test(version.assets);
}

async function checkLaunchResource(summary: string, check: () => Promise<boolean | void>) {
  try {
    if ((await check()) !== false) return;
  } catch {
    // Dependency errors can include local paths and other details the report does not need.
  }
  throw new LaunchFailure({ ...launchIssues.installation, summary });
}

async function checkLaunchAssets(folder: MinecraftFolder, version: ResolvedVersion) {
  const index = version.assetIndex;
  if (!index) return false;
  let useHash = false;
  let assets: Awaited<ReturnType<typeof readMinecraftAssetIndex>> = { objects: {} };
  await checkLaunchResource(
    'The Minecraft asset index is missing or damaged. Verify and repair the instance.',
    async () => {
      useHash = !usesNamedAssets(version) && Boolean(await fileInfo(folder.getAssetsIndex(v.parse(Sha1, index.sha1))));
      if (await diagnoseAssetIndex(version, folder, useHash)) return false;
      assets = await readMinecraftAssetIndex(folder.getAssetsIndex(useHash ? index.sha1 : version.assets));
    },
  );
  await checkLaunchResource(
    'One or more Minecraft assets are missing or damaged. Verify and repair the instance.',
    () =>
      checkResourceFiles(
        uniqueMinecraftAssets(assets).map(({ hash, size }) => ({ path: folder.getAsset(hash), sha1: hash, size })),
      ),
  );
  if (assets.virtual || usesNamedAssets(version)) {
    await checkLaunchResource('Minecraft legacy assets could not be prepared. Verify and repair the instance.', () =>
      materializeVirtualAssets(folder, version.assets, assets),
    );
  }
  return useHash;
}

async function checkLaunchClasspath(folder: MinecraftFolder, version: ResolvedVersion, options: LaunchOption) {
  await checkLaunchResource('The Minecraft client is missing or damaged. Verify and repair the instance.', async () => {
    const jar = await fileInfo(folder.getVersionJar(version.minecraftVersion));
    if (!jar?.isFile() || jar.size === 0) return false;
    await LaunchPrecheck.checkVersion(folder, version, options);
  });
  await checkLaunchResource(
    'One or more Minecraft libraries are missing or damaged. Verify and repair the instance.',
    () => LaunchPrecheck.checkLibraries(folder, version, options),
  );
  const logging = version.logging?.client?.file;
  if (logging) {
    await checkLaunchResource(
      'The Minecraft logging configuration is missing or damaged. Verify and repair the instance.',
      async () =>
        !(await diagnoseFile({
          file: folder.getLogConfig(logging.id),
          expectedChecksum: logging.sha1,
          role: 'logging',
          hint: '',
        })),
    );
  }
}

async function prepareFiles(label: 'libraries' | 'assets', signal: AbortSignal, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `Minecraft ${label} could not be downloaded or verified. Check your connection and available storage, then retry.`,
      { cause: error },
    );
  }
}

export class Minecraft {
  private readonly resources: string;

  constructor(
    root: string,
    private readonly auth: MinecraftAuth,
    private readonly versions: Pick<
      MinecraftVersions,
      'gameMetadata' | 'resourceJson' | 'loaderInstaller' | 'fabricProfile'
    >,
    private readonly probe = probeJavaRuntime,
  ) {
    this.resources = join(root, 'minecraft-resources');
  }

  private async fabricProfile(selection: Extract<MinecraftSelection, { loader: 'fabric' }>, signal: AbortSignal) {
    const profile = await this.versions.fabricProfile(selection, signal);
    signal.throwIfAborted();
    const revision = createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 20);
    const id = `${selection.version}-fabric${selection.fabricVersion}-${revision}`;
    const folder = new MinecraftFolder(this.resources);
    await writeJson(folder.getVersionJson(id), { ...profile, id });
    return Version.parse(folder, id);
  }

  private async javaTarget(component: string, signal: AbortSignal) {
    if (!javaComponentPattern.test(component)) {
      throw new Error('Minecraft reported an invalid managed Java runtime component.');
    }

    const index = v.parse(
      v.record(v.string(), v.record(v.string(), v.unknown())),
      await this.versions.resourceJson(DEFAULT_RUNTIME_ALL_URL, signal),
    );
    const releases = index[javaPlatform()]?.[component];
    const result = v.safeParse(v.array(RuntimeTarget), releases);
    const target = result.success ? result.output[0] : undefined;
    if (!target) throw new Error('Mojang does not offer the Java runtime required by this release on this system.');
    return target;
  }

  private async prepareAssets(version: ResolvedVersion, dispatcher: TransferDispatcher, job: MinecraftPreparationJob) {
    const { signal } = job;
    const folder = new MinecraftFolder(this.resources);
    const { assetIndex, logging } = version;
    if (!assetIndex) throw new Error('This Minecraft release is missing its asset index.');
    const hash = v.parse(Sha1, assetIndex.sha1);
    const index = folder.getAssetsIndex(usesNamedAssets(version) ? version.assets : hash);
    await new DownloadTask({
      dispatcher,
      url: assetIndex.url,
      destination: index,
      validator: { algorithm: 'sha1', hash },
    }).startAndWait();
    signal.throwIfAborted();
    if (logging?.client?.file) {
      const file = logging.client.file;
      await new DownloadTask({
        dispatcher,
        url: file.url,
        destination: folder.getLogConfig(file.id),
        validator: { algorithm: 'sha1', hash: file.sha1 },
      }).startAndWait();
    }
    signal.throwIfAborted();
    const assetIndexData = await readMinecraftAssetIndex(index);
    const assets = uniqueMinecraftAssets(assetIndexData);
    if (assets.length) await job.report('assets', { completed: 0, total: assets.length });
    for (let start = 0; start < assets.length; start += resourceBatchSize) {
      signal.throwIfAborted();
      const batch = assets.slice(start, start + resourceBatchSize);
      await installResolvedAssetsTask(batch, folder, { dispatcher }).startAndWait();
      await job.report('assets', { completed: start + batch.length, total: assets.length });
    }
    if (assetIndexData.virtual || usesNamedAssets(version)) {
      await materializeVirtualAssets(folder, version.assets, assetIndexData, signal);
    }
  }

  async prepare(
    selection: MinecraftSelection & { settings?: MinecraftSettings },
    job: MinecraftPreparationJob,
    previousInstallation?: MinecraftInstallation,
  ): Promise<MinecraftInstallation> {
    const { signal } = job;
    signal.throwIfAborted();
    const connection = new Agent({ connections: 6, headersTimeout: 30_000, bodyTimeout: 30_000 });
    // The interceptor consumes XMCL's legacy maxRedirections option before dispatch.
    const dispatcher = connection.compose(
      interceptors.redirect({ maxRedirections: 5 }),
    ) as unknown as TransferDispatcher;
    let aborted: Promise<void> | undefined;
    const abort = () => {
      aborted = connection.destroy(new Error('Game preparation was cancelled.'));
      void aborted.catch(() => {});
    };

    signal.addEventListener('abort', abort, { once: true });
    try {
      await job.report('version');
      await mkdir(this.resources, { recursive: true });
      const listed = await this.versions.gameMetadata(selection.version, signal);
      signal.throwIfAborted();
      let version = await installVersionTask(listed, this.resources, { dispatcher }).startAndWait();

      if (selection.loader === 'fabric') {
        await job.report('loader');
        version = await this.fabricProfile(selection, signal);
      }

      await job.report('java');
      const { component, majorVersion } = version.javaVersion;
      let javaRuntime: string | undefined;
      let executable: string;
      if (selection.settings?.java.kind === 'custom') {
        executable = selection.settings.java.executable;
      } else {
        const target = await this.javaTarget(component, signal);
        javaRuntime = await prepareManagedJava(this.resources, component, target, dispatcher, signal);
        executable = managedJavaExecutable(this.resources, javaRuntime);
      }
      const java = await this.probe(executable, { signal, requiredMajor: majorVersion });

      let loaderOutputsSha256: string | undefined;
      if (selection.loader === 'forge' || selection.loader === 'neoforge') {
        await job.report('loader');
        const prepared = await prepareForgeLoader({
          selection,
          source: await this.versions.loaderInstaller(selection, signal),
          vanilla: version,
          folder: new MinecraftFolder(this.resources),
          java: java.executable,
          dispatcher,
          signal,
          previousInstallation,
        });
        version = prepared.version;
        loaderOutputsSha256 = prepared.loaderOutputsSha256;
        if (version.javaVersion.majorVersion !== java.major) {
          throw new Error('The loader profile requires a different Java runtime.');
        }
      }

      const folder = new MinecraftFolder(this.resources);
      const pinned = await pinLaunchMetadata(folder, version);
      version = pinned.version;
      const total = version.libraries.length;
      await job.report('libraries', total ? { completed: 0, total } : undefined);
      await prepareFiles('libraries', signal, async () => {
        // XMCL's public cancel can settle before child transfers close. Wait each batch before advancing.
        for (let start = 0; start < total; start += 16) {
          signal.throwIfAborted();
          const libraries = version.libraries.slice(start, start + 16);
          await installMinecraftLibraries(libraries, folder, dispatcher, signal);
          await job.report('libraries', { completed: start + libraries.length, total });
        }
      });
      await job.report('assets');
      await prepareFiles('assets', signal, () => this.prepareAssets(version, dispatcher, job));

      await job.report('verify');
      signal.throwIfAborted();
      return {
        versionId: version.id,
        javaMajor: java.major,
        launchMetadata: pinned.launchMetadata,
        ...(loaderOutputsSha256 && { loaderOutputsSha256 }),
        ...(javaRuntime && { javaRuntime }),
      };
    } finally {
      signal.removeEventListener('abort', abort);
      if (aborted) await aborted;
      else await connection.close();
    }
  }

  async requiredJavaMajor(target: string | MinecraftInstallation, signal?: AbortSignal) {
    const folder = new MinecraftFolder(this.resources);
    if (typeof target !== 'string') {
      if (target.javaMajor !== undefined) return target.javaMajor;
      return (await readLaunchVersion(folder, target)).javaVersion.majorVersion;
    }
    const version = target;
    const descriptor = await this.versions
      .gameMetadata(version, signal)
      .then(({ url }) => this.versions.resourceJson(url, signal))
      .catch((cause: unknown) => {
        signal?.throwIfAborted();
        throw new Error(
          `Could not read the Java requirement for Minecraft ${version}. Check your connection and retry.`,
          {
            cause,
          },
        );
      });
    const profile = Version.normalizeVersionJson(JSON.stringify(descriptor), folder.root);
    if (profile.id !== version || profile.inheritsFrom !== undefined) {
      throw new Error('Minecraft returned metadata for a different game version.');
    }
    const requiredMajor = Version.resolve(folder, [profile]).javaVersion.majorVersion;
    if (!Number.isSafeInteger(requiredMajor) || requiredMajor < 1) {
      throw new Error('The selected Minecraft version did not supply a usable Java requirement.');
    }
    return requiredMajor;
  }

  async probeReleaseJava(version: string, executable: string, signal?: AbortSignal) {
    const requiredMajor = await this.requiredJavaMajor(version, signal);
    return this.probe(executable, { requiredMajor, ...(signal && { signal }) });
  }

  async verifyJavaRuntime(policy: MinecraftJavaPolicy, requiredMajor: number, runtime?: string) {
    if (policy.kind === 'custom') return this.probe(policy.executable, { requiredMajor });
    if (!runtime) throw new LaunchFailure(launchIssues.installation);
    await checkLaunchResource(
      'One or more managed Java runtime files are missing or damaged. Verify and repair the instance.',
      () => checkManagedJava(this.resources, runtime),
    );
    return this.probe(managedJavaExecutable(this.resources, runtime), { requiredMajor }).catch(() => {
      throw new LaunchFailure({
        ...launchIssues.installation,
        summary: 'The managed Java runtime could not start. Verify and repair the instance.',
      });
    });
  }

  async checkJavaRuntime(
    version: string,
    policy: MinecraftJavaPolicy,
    installation?: MinecraftInstallation,
  ): Promise<MinecraftJavaStatus> {
    const requiredMajor = await this.requiredJavaMajor(installation ?? version);
    const requirement = { version, requiredMajor };
    const storedRuntime = installation?.javaRuntime;
    if (policy.kind === 'managed' && !storedRuntime) {
      return { ...requirement, state: 'needs-preparation', policy: 'managed' };
    }
    try {
      const { major, architecture } = await this.verifyJavaRuntime(policy, requiredMajor, storedRuntime);
      return { ...requirement, state: 'ready', policy: policy.kind, major, architecture };
    } catch (error) {
      return {
        ...requirement,
        state: 'invalid',
        policy: policy.kind,
        action: policy.kind === 'managed' ? 'repair' : 'settings',
        message: error instanceof Error ? error.message : 'The selected Java could not be checked.',
      };
    }
  }

  async start(
    gamePath: string,
    installation: MinecraftInstallation,
    minecraft: { loader: MinecraftSelection['loader']; settings?: MinecraftSettings },
    onSpawn?: (child: ChildProcess, accessToken: string, cleanup: Promise<void>) => void,
  ) {
    const { loader, settings } = minecraft;
    const policy = settings?.java ?? { kind: 'managed' };
    if (policy.kind === 'managed' && !installation.javaRuntime) throw new LaunchFailure(launchIssues.installation);
    const folder = new MinecraftFolder(this.resources);
    const version = await readLaunchVersion(folder, installation).catch(() => {
      throw new LaunchFailure({
        ...launchIssues.installation,
        summary: 'The Minecraft version or loader profile is missing or damaged. Verify and repair the instance.',
      });
    });
    const requiredMajor = installation.javaMajor ?? version.javaVersion.majorVersion;
    const java = await this.verifyJavaRuntime(policy, requiredMajor, installation.javaRuntime).catch(
      (error: unknown) => {
        if (policy.kind === 'managed') throw error;
        const summary =
          Number.isSafeInteger(requiredMajor) && requiredMajor > 0
            ? `This Minecraft release requires Java ${requiredMajor}. Select a compatible Java runtime in Settings.`
            : launchIssues.java.summary;
        throw new LaunchFailure({ ...launchIssues.java, summary });
      },
    );
    const options: LaunchOption = {
      version,
      useHashAssetsIndex: await checkLaunchAssets(folder, version),
      launcherName: 'REZICS',
      launcherBrand: 'REZICS',
      javaPath: java.executable,
      ...(settings?.maxMemoryMiB !== undefined && { maxMemory: settings.maxMemoryMiB }),
      gamePath,
      resourcePath: this.resources,
    };
    await checkLaunchClasspath(folder, version, options);
    if (loader === 'forge' || loader === 'neoforge') {
      await checkLaunchResource(
        'One or more generated Minecraft loader files are missing or damaged. Verify and repair the instance.',
        () => verifyGeneratedLoaderFiles(folder, installation),
      );
    }
    const credentials = await this.auth.launchCredentials(settings?.accountId).catch((error: unknown) => {
      throw new LaunchFailure(
        error instanceof AuthFailure ? { ...launchIssues.account, summary: error.message } : launchIssues.account,
      );
    });
    await mkdir(gamePath, { recursive: true }).catch(() => {
      throw new LaunchFailure({
        ...launchIssues.installation,
        summary: 'The Minecraft game folder could not be opened. Check its location and permissions.',
      });
    });
    const nativeRoot = await mkdtemp(join(this.resources, 'natives-')).catch(() => {
      throw new LaunchFailure({
        ...launchIssues.unknown,
        summary:
          'Launcher could not create a temporary Minecraft folder. Check available disk space and permissions, then retry.',
      });
    });
    const discardNatives = () => rm(nativeRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    try {
      await checkLaunchResource(
        'The Minecraft native libraries could not be unpacked. Verify and repair the instance.',
        () => extractMinecraftNatives(folder, version, nativeRoot),
      );
      const child = await launch({
        ...options,
        nativeRoot,
        accessToken: credentials.token,
        gameProfile: credentials.profile,
        extraExecOption: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: javaEnvironment() },
        prechecks: [],
        spawn(command, args, options) {
          const child = spawn(command, args ?? [], options ?? {});
          const cleanup = new Promise<void>((resolve) => child.once('close', () => resolve())).then(discardNatives);
          onSpawn?.(child, credentials.token, cleanup);
          return child;
        },
      });
      return { child, accessToken: credentials.token };
    } catch (error) {
      await discardNatives();
      if (error instanceof LaunchFailure) throw error;
      throw new LaunchFailure(launchIssues.unknown);
    }
  }
}
