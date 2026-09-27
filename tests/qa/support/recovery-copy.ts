import { constants, cpSync } from 'node:fs';

/** Give each replay host an independent writable copy without duplicating all backup bytes. */
export function copyRecoveryTree(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE });
}
