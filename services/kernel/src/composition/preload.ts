import { installNativeHistory } from './history.ts';
import { composeAccessApplication } from './access.ts';

/** Test and command preloads use the same Access and History composition as server and worker. */
export function installNativeHistoryPreload(): void {
  composeAccessApplication();
  installNativeHistory();
}
