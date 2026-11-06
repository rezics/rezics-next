import { type HistoryComposition } from '../contract/index.ts';

let installed: HistoryComposition | undefined;

/** Installed once by the process composition root before History is used. Replaces any earlier install. */
export function installHistoryComposition(composition: HistoryComposition): void {
  installed = composition;
}

/** The installed native composition. Nothing is substituted when it is absent. */
export function historyComposition(): HistoryComposition {
  if (!installed) throw new Error('History composition is not installed');
  return installed;
}
