import { sameMinecraftSelection, type MinecraftCustomJava, type ModrinthPackPreview } from '@rezics/launcher-contract';
import type { Launcher } from '@rezics/launcher-core';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { copyWorldIds, optionalText, record, text, worldVersionConfirmation } from '../rpc-values';
import type { AutomationHandler } from '../automation-types';

type PackSource = { kind: 'file'; file: string } | { kind: 'modrinth'; projectId: string; versionId: string };
type PackTarget =
  | { kind: 'new' }
  | { kind: 'existing'; instanceId: string }
  | { kind: 'copy-worlds'; instanceId: string; worldIds: string[] };
type InspectedPack = { source: string; digest: string; preview: ModrinthPackPreview };

function absoluteFile(value: unknown) {
  const path = text(value, 32_767);
  if (!isAbsolute(path)) throw new Error('Supply an absolute file path.');
  return path;
}

function sourceOf(value: unknown): PackSource {
  const { kind, file, projectId, versionId } = record(value);
  if (kind === 'file') return { kind, file: absoluteFile(file) };
  if (kind === 'modrinth') return { kind, projectId: text(projectId, 120), versionId: text(versionId, 120) };
  throw new Error('Choose a local archive or an exact Modrinth release.');
}

function targetOf(value: unknown): PackTarget {
  const { kind, instanceId, worldIds } = record(value);
  if (kind === 'new') return { kind };
  if (kind === 'existing') return { kind, instanceId: text(instanceId) };
  if (kind === 'copy-worlds') return { kind, instanceId: text(instanceId), worldIds: copyWorldIds(worldIds, false) };
  throw new Error('Choose a destination for the pack.');
}

function packRequest(fields: Record<string, unknown>) {
  const source = sourceOf(fields.source);
  const target = targetOf(fields.target);
  let java: MinecraftCustomJava | undefined;
  if (fields.javaExecutable !== undefined) {
    if (target.kind === 'existing') throw new Error('Updates use the instance’s configured Java.');
    java = { kind: 'custom', executable: absoluteFile(fields.javaExecutable) };
  }
  return { source, target, java };
}

async function withPack<T>(
  core: Launcher,
  source: PackSource,
  signal: AbortSignal | undefined,
  work: (pack: InspectedPack) => Promise<T>,
): Promise<T> {
  if (source.kind === 'file') {
    return work({ source: source.file, ...(await core.inspectModrinthPack(source.file, signal)) });
  }
  const staged = await core.stageOnlineModrinthPack(source.projectId, source.versionId, signal);
  try {
    return await work(staged);
  } finally {
    await staged.release().catch(() => {});
  }
}

function revisionFor(digest: string, request: ReturnType<typeof packRequest>) {
  return createHash('sha256')
    .update(JSON.stringify([digest, request]))
    .digest('hex');
}

export const minecraftPackCommands = {
  'search-minecraft-packs': {
    async run(core, argument) {
      const { query, cursor } = record(argument);
      return { value: await core.searchModrinthPacks(text(query, 120, true), optionalText(cursor, 256)) };
    },
  },
  'minecraft-pack-versions': {
    async run(core, argument) {
      const { projectId, cursor } = record(argument);
      return { value: await core.listModrinthPackVersions(text(projectId, 120), optionalText(cursor, 256)) };
    },
  },
  'preview-minecraft-pack': {
    async run(core, argument, signal) {
      const request = packRequest(record(argument));
      const { source, target, java } = request;
      return withPack(core, source, signal, async ({ digest, preview }) => {
        if (target.kind === 'existing') {
          const game = (await core.listInstances()).find(({ id }) => id === target.instanceId)?.minecraft;
          if (!game || !sameMinecraftSelection(game, preview.selection)) {
            throw new Error('Choose an instance with the exact Minecraft and loader versions from this pack.');
          }
        }
        const warning =
          target.kind === 'copy-worlds'
            ? await core.previewMinecraftWorldCopy(target.instanceId, preview.selection.version, target.worldIds)
            : undefined;
        return {
          value: {
            preview,
            digest,
            revision: revisionFor(digest, request),
            source,
            target,
            ...(warning && { worldVersionRisk: warning }),
            ...(java && { javaExecutable: java.executable }),
          },
        };
      });
    },
  },
  'install-minecraft-pack': {
    async run(core, argument, signal) {
      const fields = record(argument);
      const request = packRequest(fields);
      const revision = fields.revision;
      if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)) {
        throw new Error('Review this modpack before installing.');
      }
      const { source, target, java } = request;
      const confirmation = worldVersionConfirmation(fields.worldVersionConfirmation);
      return withPack(core, source, signal, async (pack) => {
        if (revisionFor(pack.digest, request) !== revision) {
          throw new Error('The archive or its installation choices changed. Preview the pack again.');
        }
        const control = signal && { signal };
        if (target.kind === 'copy-worlds') {
          const value = await core.migrateModrinthPack(
            pack.source,
            pack.digest,
            pack.preview,
            target.instanceId,
            target.worldIds,
            control,
            confirmation,
            java,
          );
          return { value, installedChanged: true };
        }
        const id = target.kind === 'existing' ? target.instanceId : undefined;
        const value = await core.importModrinthPack(pack.source, pack.digest, pack.preview, id, control, java);
        return id ? { value, modFolderChanged: id } : { value, installedChanged: true };
      });
    },
  },
  'minecraft-pack': {
    run: async (core, id) => ({ value: await core.currentModrinthPack(text(id)) }),
  },
  'repair-minecraft-pack': {
    async run(core, id, signal) {
      const instanceId = text(id);
      const repaired = await core.repairModrinthPack(instanceId, signal && { signal });
      return { value: { repaired }, modFolderChanged: instanceId };
    },
  },
  'export-minecraft-pack': {
    async run(core, argument) {
      const { instanceId, file } = record(argument);
      return { value: { path: await core.exportModrinthPack(text(instanceId), absoluteFile(file)) } };
    },
  },
} satisfies Record<string, AutomationHandler>;
