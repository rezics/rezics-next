import { isAbsolute } from 'node:path';
import type { AutomationResult, PluginAutomationHandlers } from '../automation-types';
import type { Launcher } from '@rezics/launcher-core';
import {
  archivedMinecraftRevision,
  copyMinecraftWorlds,
  minecraftInstance,
  minecraftLoader,
  minecraftPreparationMode,
  minecraftSettings,
  optionalText,
  record,
  text,
} from '../rpc-values';
import { minecraftModCommands } from './minecraft-mod-automation';
import { minecraftPackCommands } from './minecraft-pack-automation';
import { minecraftUpgradeCommands } from './minecraft-upgrade-automation';
import { minecraftWorldCommands } from './minecraft-world-automation';

export const minecraftCommands = {
  ...minecraftModCommands,
  ...minecraftPackCommands,
  ...minecraftUpgradeCommands,
  ...minecraftWorldCommands,
  'minecraft-versions': {
    run: async (core) => ({ value: await core.listMinecraftVersions() }),
  },
  'minecraft-loaders': {
    async run(core, argument) {
      const fields = record(argument);
      const version = text(fields.version, 32);
      const loader = minecraftLoader(fields.loader);
      switch (loader) {
        case 'vanilla':
          return { value: [] };
        case 'fabric':
          return { value: await core.listFabricVersions(version) };
        case 'forge':
          return { value: await core.listForgeVersions(version) };
        case 'neoforge':
          return { value: await core.listNeoForgeVersions(version) };
      }
    },
  },
  'create-minecraft': {
    run: async (core, argument) => ({
      value: await core.createMinecraft(minecraftInstance(argument)),
      installedChanged: true,
    }),
  },
  'rename-minecraft': {
    async run(core, argument) {
      const { instanceId, name } = record(argument);
      return { value: await core.renameMinecraft(text(instanceId), text(name, 120)), installedChanged: true };
    },
  },
  'duplicate-minecraft': {
    async run(core, argument) {
      const { instanceId, name, copyWorlds } = record(argument);
      const value = await core.duplicateMinecraft(text(instanceId), text(name, 120), copyMinecraftWorlds(copyWorlds));
      return { value, installedChanged: true };
    },
  },
  'archive-minecraft': {
    async run(core, argument) {
      const instanceId = text(argument);
      await core.archiveMinecraft(instanceId);
      return { value: { status: 'archived', instanceId }, installedChanged: true, archivedInstanceIds: [instanceId] };
    },
  },
  'list-archived-minecraft': {
    run: async (core) => ({ value: await core.listArchivedMinecraft() }),
  },
  'restore-archived-minecraft': {
    run: async (core, argument) => ({
      value: await core.restoreArchivedMinecraft(text(argument)),
      installedChanged: true,
    }),
  },
  'delete-archived-minecraft': {
    async run(core, argument) {
      const { instanceId: id, revision, confirmInstanceId } = record(argument);
      const instanceId = text(id);
      if (confirmInstanceId !== instanceId)
        throw new Error('Confirm the exact archived instance ID before deleting it.');
      await core.deleteArchivedMinecraft(instanceId, archivedMinecraftRevision(revision));
      return { value: { status: 'deleted', instanceId }, installedChanged: true };
    },
  },
  'set-minecraft-settings': {
    async run(core, argument) {
      const fields = record(argument);
      const value = await core.setMinecraftSettings(text(fields.instanceId), minecraftSettings(fields));
      return { value, installedChanged: true };
    },
  },
  'set-minecraft-java': {
    async run(core, argument) {
      const { instanceId, executable: path } = record(argument);
      const executable = text(path, 32_767);
      if (!isAbsolute(executable)) throw new Error('Supply an absolute path to the Java executable.');
      const value = await core.setMinecraftJava(text(instanceId), executable);
      return { value, installedChanged: true };
    },
  },
  'check-minecraft-java': {
    async run(core, id) {
      const value = await core.checkMinecraftJava(text(id));
      return { value, partial: value.state === 'invalid' };
    },
  },
  'prepare-minecraft': {
    async run(core, argument) {
      const { instanceId, mode } = record(argument);
      return { value: await core.startMinecraftPreparation(text(instanceId), minecraftPreparationMode(mode)) };
    },
  },
  'minecraft-preparation': {
    run: async (core, id) => ({ value: await core.readMinecraftPreparation(text(id)) }),
  },
  'minecraft-preparations': {
    run: async (core) => ({ value: await core.readMinecraftPreparationActivity() }),
  },
  'cancel-minecraft-preparation': {
    async run(core, argument) {
      const { instanceId, attemptId } = record(argument);
      return { value: await core.cancelMinecraftPreparation(text(instanceId), text(attemptId, 64)) };
    },
  },
  'start-minecraft-sign-in': {
    async run(core, argument) {
      const { accountId } = record(argument);
      await core.beginMinecraftSignIn(optionalText(accountId, 120));
      return signInResult(core);
    },
  },
  'minecraft-sign-in-status': { run: signInResult },
  'cancel-minecraft-sign-in': {
    async run(core) {
      await core.cancelMinecraftSignIn();
      return signInResult(core);
    },
  },
  'minecraft-accounts': {
    run: async (core) => ({ value: await core.minecraftAccounts() }),
  },
  'select-minecraft-account': {
    async run(core, id) {
      await core.selectMinecraftAccount(text(id, 120));
      return { value: await core.minecraftAccounts() };
    },
  },
  'forget-minecraft-account': {
    async run(core, id) {
      await core.forgetMinecraftAccount(text(id, 120));
      return { value: await core.minecraftAccounts() };
    },
  },
} satisfies PluginAutomationHandlers<'minecraft'>;

async function signInResult(core: Launcher): Promise<AutomationResult> {
  const value = await core.readMinecraftSignIn();
  return { value, partial: value.state === 'failed' };
}
