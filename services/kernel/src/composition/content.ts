import {
  ensureContentApplication,
  startContentApplication as startNativeContentApplication,
  tryContentApplication,
  bindReadingPageCapabilities,
  createNativeReadingPageCapabilities,
} from '../content/adapters/index.ts';
import { createNativeAccessReadingPorts } from '../access/adapters/index.ts';
import type { ContentAmbient, ContentApplication } from '../content/contract/index.ts';

/** The ordinary server, worker and native preload install real Access reading operands. */
export function composeContentReading(): void {
  bindReadingPageCapabilities(createNativeReadingPageCapabilities(createNativeAccessReadingPorts()));
}

export function startContentApplication(ambient?: Partial<ContentAmbient>) {
  composeContentReading();
  return startNativeContentApplication(ambient);
}

export function composeContentApplication(ambient?: Partial<ContentAmbient>): ContentApplication {
  composeContentReading();
  return ensureContentApplication(ambient ?? {});
}

export function composedContentApplication(): ContentApplication {
  return tryContentApplication() ?? composeContentApplication();
}
