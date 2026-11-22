import type { LauncherApi, MinecraftWorldImportVersionRisk } from '@rezics/launcher-contract';
import { minecraftWorldImportName } from '@rezics/launcher-core';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { WorldImportSource } from '../../shared/desktop';
import { exactWorldId, record, text, worldVersionConfirmation } from '../rpc-values';
import type { AutomationHandler } from '../automation-types';

type WorldSource = { kind: WorldImportSource; path: string };
type WorldInspectionPort = Pick<LauncherApi, 'inspectMinecraftWorldFolder' | 'inspectMinecraftWorldArchive'>;
type WorldReview = {
  instanceId: string;
  source: WorldSource;
  name: string;
  digest: string;
  targetVersion: string;
  versionRisk?: MinecraftWorldImportVersionRisk;
};

export async function inspectWorld(
  core: WorldInspectionPort,
  source: WorldSource,
  instanceId: string,
  signal?: AbortSignal,
) {
  const { world, digest, versionRisk, targetVersion } =
    source.kind === 'folder'
      ? await core
          .inspectMinecraftWorldFolder(source.path, instanceId, signal)
          .then(({ folder, ...result }) => ({ world: folder, ...result }))
      : await core
          .inspectMinecraftWorldArchive(source.path, instanceId, signal)
          .then(({ archive, ...result }) => ({ world: archive, ...result }));
  if (targetVersion === undefined) throw new Error('Select a Minecraft instance.');
  return { world, digest, targetVersion, versionRisk };
}

function worldPath(value: unknown) {
  const path = text(value, 32_767);
  if (!isAbsolute(path)) throw new Error('Supply an absolute path to the world folder or ZIP.');
  return path;
}

function worldSource(value: unknown): WorldSource {
  const { kind, path } = record(value);
  if (kind !== 'zip' && kind !== 'folder') throw new Error('Choose a world folder or ZIP.');
  return { kind, path: worldPath(path) };
}

function worldRevision({ instanceId, source, name, digest, targetVersion, versionRisk }: WorldReview) {
  return createHash('sha256')
    .update(JSON.stringify([instanceId, source, name, digest, targetVersion, versionRisk]))
    .digest('hex');
}

export const minecraftWorldCommands = {
  'preview-minecraft-world': {
    async run(core, argument, signal) {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const source = worldSource(fields.source);
      const { world, digest, targetVersion, versionRisk } = await inspectWorld(core, source, instanceId, signal);
      const name = minecraftWorldImportName(fields.name === undefined ? world.name : text(fields.name, 120));
      const review = { instanceId, source, name, digest, targetVersion, ...(versionRisk && { versionRisk }) };
      return { value: { ...review, world, revision: worldRevision(review) } };
    },
  },
  'import-minecraft-world': {
    async run(core, argument, signal) {
      const fields = record(argument);
      if (typeof fields.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(fields.revision)) {
        throw new Error('Preview the Minecraft world import before continuing.');
      }
      const instanceId = text(fields.instanceId);
      const source = worldSource(fields.source);
      const name = minecraftWorldImportName(text(fields.name, 120));
      const digest = text(fields.digest, 64);
      const targetVersion = text(fields.targetVersion, 32);
      const versionRisk = worldVersionConfirmation(fields.versionRisk);
      const review = { instanceId, source, name, digest, targetVersion, ...(versionRisk && { versionRisk }) };
      if (worldRevision(review) !== fields.revision)
        throw new Error('The world import choices changed. Preview it again.');
      const confirmation = worldVersionConfirmation(fields.worldVersionConfirmation);
      if (
        versionRisk &&
        (confirmation?.worldVersion !== versionRisk.worldVersion ||
          confirmation.targetVersion !== versionRisk.targetVersion)
      ) {
        throw new Error(
          'This world was saved by a newer Minecraft release. Review the preview and confirm the import.',
        );
      }
      signal?.throwIfAborted();
      const importWorld = source.kind === 'folder' ? core.importMinecraftWorldFolder : core.importMinecraftWorldArchive;
      const value = await importWorld(instanceId, source.path, digest, name, versionRisk, targetVersion, signal);
      return { value, saveHistoryChanged: instanceId };
    },
  },
  'export-minecraft-world': {
    async run(core, argument, signal) {
      const { instanceId, worldId, path } = record(argument);
      signal?.throwIfAborted();
      return {
        value: {
          path: await core.exportMinecraftWorldArchive(
            text(instanceId),
            exactWorldId(worldId),
            worldPath(path),
            signal,
          ),
        },
      };
    },
  },
} satisfies Record<string, AutomationHandler>;
