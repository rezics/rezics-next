import { isAbsolute } from 'node:path';
import { managedModEnabled, manualModChange, modReviewRevision, record, text } from '../rpc-values';
import type { AutomationHandler } from '../automation-types';

function jarPath(value: unknown) {
  const path = text(value, 32_767);
  if (!isAbsolute(path)) throw new Error('Supply an absolute path to the mod JAR.');
  return path;
}

export const minecraftModCommands = {
  'minecraft-mod-folder': {
    run: async (core, id) => ({ value: await core.readMinecraftModFolder(text(id)) }),
  },
  'set-minecraft-mod-file': {
    async run(core, argument) {
      const fields = record(argument);
      const { name, enabled, revision } = manualModChange(fields);
      const instanceId = text(fields.instanceId);
      const value = await core.setMinecraftManualModEnabled(instanceId, name, enabled, revision);
      return { value, modFolderChanged: instanceId };
    },
  },
  'minecraft-mods': {
    run: async (core, id) => ({ value: await core.listInstalled(text(id)) }),
  },
  'search-minecraft-mods': {
    async run(core, argument) {
      const { instanceId, query } = record(argument);
      return { value: await core.searchMods(text(instanceId), text(query, 120, true)) };
    },
  },
  'minecraft-mod-versions': {
    async run(core, argument) {
      const { instanceId, projectId } = record(argument);
      return { value: await core.modVersions(text(instanceId), text(projectId)) };
    },
  },
  'preview-minecraft-mod-install': {
    async run(core, argument, signal) {
      const { instanceId, versionId } = record(argument);
      return { value: await core.previewModInstall(text(instanceId), text(versionId), signal) };
    },
  },
  'install-minecraft-mod': {
    async run(core, argument, signal) {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const versionId = text(fields.versionId);
      await core.installMod(
        instanceId,
        versionId,
        modReviewRevision(fields.revision, 'installation'),
        signal && { signal },
      );
      return { value: { status: 'installed', instanceId, versionId }, modFolderChanged: instanceId };
    },
  },
  'preview-minecraft-mod-state': {
    async run(core, argument) {
      const { instanceId, packageId, enabled } = record(argument);
      return { value: await core.previewModState(text(instanceId), text(packageId), managedModEnabled(enabled)) };
    },
  },
  'apply-minecraft-mod-state': {
    async run(core, argument) {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const packageId = text(fields.packageId);
      const enabled = managedModEnabled(fields.enabled);
      await core.applyModState(instanceId, packageId, enabled, modReviewRevision(fields.revision, 'change'));
      return { value: { instanceId, packageId, enabled }, modFolderChanged: instanceId };
    },
  },
  'import-minecraft-mod': {
    async run(core, argument) {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      await core.importMod(instanceId, jarPath(fields.file));
      return { value: { status: 'imported', instanceId }, modFolderChanged: instanceId };
    },
  },
  'repair-minecraft-mod': {
    async run(core, argument) {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const packageId = text(fields.packageId);
      await core.repairMod(instanceId, packageId, fields.file === undefined ? undefined : jarPath(fields.file));
      return { value: { status: 'repaired', instanceId, packageId }, modFolderChanged: instanceId };
    },
  },
  'remove-minecraft-mod': {
    async run(core, argument) {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const packageId = text(fields.packageId);
      await core.uninstallPackage(packageId, instanceId);
      return { value: { status: 'removed', instanceId, packageId }, modFolderChanged: instanceId };
    },
  },
} satisfies Record<string, AutomationHandler>;
