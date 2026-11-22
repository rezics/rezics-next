import {
  minecraftInPlaceUpgradeMessages,
  sameMinecraftSelection,
  type MinecraftJavaPolicy,
} from '@rezics/launcher-contract';
import { parseMinecraftUpgradeSelection, type Launcher } from '@rezics/launcher-core';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { copyWorldIds, minecraftUpgradeMode, record, text, worldVersionConfirmation } from '../rpc-values';
import type { AutomationHandler } from '../automation-types';

function javaPolicy(value: unknown): MinecraftJavaPolicy {
  const { kind, executable: path } = record(value);
  if (kind === 'managed') return { kind };
  if (kind !== 'custom') throw new Error('Choose managed or custom Java.');
  const executable = text(path, 32_767);
  if (!isAbsolute(executable)) throw new Error('Supply an absolute path to the Java executable.');
  return { kind, executable };
}

async function reviewVersionChange(core: Launcher, fields: Record<string, unknown>) {
  const instanceId = text(fields.instanceId);
  const mode = minecraftUpgradeMode(fields.mode);
  const selection = parseMinecraftUpgradeSelection(fields.selection);
  if (mode === 'in-place' && fields.worldIds !== undefined) {
    throw new Error('Choose a separate instance to copy worlds.');
  }
  const source = (await core.listInstances()).find(({ id }) => id === instanceId)?.minecraft;
  if (!source) throw new Error('Select a Minecraft instance.');
  const from = parseMinecraftUpgradeSelection(source);
  if (sameMinecraftSelection(from, selection)) throw new Error('Choose a different Minecraft release or loader.');
  const java = javaPolicy(fields.java === undefined ? (source.settings?.java ?? { kind: 'managed' }) : fields.java);
  const base = { instanceId, from, selection, java };
  if (mode === 'in-place') {
    return {
      ...base,
      mode,
      inPlaceBlocker: await core.readMinecraftInPlaceUpgradeBlocker(instanceId, selection.version),
    } as const;
  }

  const ids =
    fields.worldIds === undefined ? (await core.listMinecraftWorlds(instanceId)).map(({ id }) => id) : fields.worldIds;
  const worldIds = copyWorldIds(ids, true);
  const worldVersionRisk = await core.previewMinecraftWorldCopy(instanceId, selection.version, worldIds);
  return { ...base, mode, worldIds, worldVersionRisk } as const;
}

function revisionOf(review: Awaited<ReturnType<typeof reviewVersionChange>>) {
  return createHash('sha256').update(JSON.stringify(review)).digest('hex');
}

export const minecraftUpgradeCommands = {
  'preview-minecraft-version-change': {
    async run(core, argument) {
      const review = await reviewVersionChange(core, record(argument));
      return { value: { ...review, revision: revisionOf(review) } };
    },
  },
  'start-minecraft-version-change': {
    async run(core, argument, signal) {
      const fields = record(argument);
      if (typeof fields.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(fields.revision)) {
        throw new Error('Preview the Minecraft version change before starting it.');
      }
      const review = await reviewVersionChange(core, fields);
      if (revisionOf(review) !== fields.revision) {
        throw new Error('The Minecraft version change or its choices changed. Preview it again.');
      }
      if (review.mode === 'in-place' && review.inPlaceBlocker) {
        throw new Error(minecraftInPlaceUpgradeMessages[review.inPlaceBlocker]);
      }
      const confirmation = worldVersionConfirmation(fields.worldVersionConfirmation);
      const risk = review.mode === 'copy' ? review.worldVersionRisk : null;
      if (
        risk &&
        (confirmation?.worldVersion !== risk.worldVersion || confirmation.targetVersion !== risk.targetVersion)
      ) {
        throw new Error(
          'A selected world was saved in a newer Minecraft release. Review the world copy and confirm it.',
        );
      }
      signal?.throwIfAborted();
      const value = await core.startMinecraftUpgrade(
        review.instanceId,
        review.selection,
        review.mode,
        review.mode === 'copy' ? review.worldIds : undefined,
        risk ?? undefined,
        review.java,
        review.from,
      );
      return { value };
    },
  },
} satisfies Record<string, AutomationHandler>;
