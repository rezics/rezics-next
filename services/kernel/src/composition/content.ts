import { createContentApplication } from '../content/application/index.ts';
import {
  bindContentApplication,
  createNativeContentAmbient,
  createNativeContentPorts,
} from '../content/adapters/index.ts';
import type { ContentAmbient, ContentApplication } from '../content/contract/index.ts';

let composed: ContentApplication | undefined;

/** Ordinary createKernel/server/worker composition binds the native Content adapters. */
export function composeContentApplication(ambient?: Partial<ContentAmbient>): ContentApplication {
  if (composed && ambient === undefined) return composed;
  const resolved = createNativeContentAmbient(ambient ?? {});
  composed = bindContentApplication(createContentApplication(createNativeContentPorts(resolved)));
  return composed;
}

export function composedContentApplication(): ContentApplication {
  return composed ?? composeContentApplication();
}
