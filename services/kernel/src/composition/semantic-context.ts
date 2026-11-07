import { bindContextAccess, bindContextApplication, createContextApplication } from '../semantic/index.ts';
import { nativeContextAccess } from '../semantic/adapters/index.ts';
import type { ContextApplication } from '../semantic/index.ts';

let composed: ContextApplication | undefined;

/** Ordinary composition installs the native adapter for direct calls and closes the same port over its application. */
export function composeSemanticContext(): ContextApplication {
  if (composed) return composed;
  const access = nativeContextAccess();
  bindContextAccess(access);
  composed = bindContextApplication(createContextApplication(access));
  return composed;
}

export function composedSemanticContext(): ContextApplication {
  return composed ?? composeSemanticContext();
}
