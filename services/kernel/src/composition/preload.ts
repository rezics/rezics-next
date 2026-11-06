import { installNativeHistory } from './history.ts';

/** Test and command preload hooks use the same native History binding as server and worker. */
export function installNativeHistoryPreload(): void {
  installNativeHistory();
}
