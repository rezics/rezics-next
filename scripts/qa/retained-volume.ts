import { postgresImage, run, volumeExists } from '../fixture/stack.ts';
import type { RetainedFileIntegrity } from '../fixture/manifest.ts';
import { parseVolumeInventory, volumeInventoryScript } from './volume-inventory.ts';

/** Inventory mounted custody read-only; copyVolume remains the sole volume copier. */
export function retainedVolumeInventory(volume: string, docker: NodeJS.ProcessEnv): Record<string, RetainedFileIntegrity> {
  if (!volumeExists(volume, docker)) throw new Error(`retained graph volume is missing: ${volume}`);
  const output = run('docker', ['run', '--rm', '--pull=never', '--read-only', '--network', 'none', '--user', '0:0',
    '--mount', `type=volume,source=${volume},target=/backup,readonly,volume-nocopy`,
    '--workdir', '/backup', '--entrypoint', 'sh', postgresImage(), '-ec',
    volumeInventoryScript], docker, 60_000);
  return parseVolumeInventory(output);
}
