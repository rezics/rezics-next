import type { LauncherApi } from '@rezics/launcher-contract';
import { extname, isAbsolute, resolve } from 'node:path';
import type { PluginAutomationHandlers } from '../automation-types';
import type { PickSavePath, PluginRpcHandlers } from '../rpc-types';
import { record, text } from '../rpc-values';

type FootprintsPort = Pick<LauncherApi, 'footprintStatus' | 'setFootprintRecording' | 'exportFootprints'>;

function recording(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Choose whether to record game footprints.');
  return value;
}

export const gameFootprintsCommands = {
  'footprint-status': {
    run: async (core) => ({ value: await core.footprintStatus() }),
  },
  'set-footprint-recording': {
    async run(core, argument) {
      const enabled = recording(record(argument).enabled);
      return { value: await core.setFootprintRecording(enabled), footprintRecordingChanged: true };
    },
  },
  'export-footprints': {
    async run(core, argument) {
      const path = text(record(argument).file, 32_767);
      if (!isAbsolute(path) || extname(path).toLowerCase() !== '.jsonl') {
        throw new Error('Choose an absolute .jsonl destination for the footprints export.');
      }
      const file = resolve(path);
      await core.exportFootprints(file, false);
      return { value: { file } };
    },
  },
} satisfies PluginAutomationHandlers<'game-footprints', FootprintsPort>;

export function gameFootprintsDesktop(
  core: FootprintsPort,
  savePath: PickSavePath,
): PluginRpcHandlers<'game-footprints'> {
  return {
    footprintStatus: () => core.footprintStatus(),
    setFootprintRecording: (enabled) => core.setFootprintRecording(recording(enabled)),
    async exportFootprints() {
      const destination = await savePath({
        title: 'Export game footprints',
        defaultPath: 'rezics-footprints.jsonl',
        filters: [{ name: 'REZICS Footprints', extensions: ['jsonl'] }],
      });
      if (!destination) return false;
      await core.exportFootprints(destination);
      return true;
    },
  };
}
