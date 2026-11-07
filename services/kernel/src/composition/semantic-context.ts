import { bindContextAccess } from '../semantic/context-access-port.ts';
import { bindContextApplication, createContextApplication } from '../semantic/context-application.ts';
import { nativeContextAccess } from '../semantic/adapters/index.ts';
import type { ContextApplication } from '../semantic/context-application.ts';

let composed: ContextApplication | undefined;

/** Ordinary createKernel/server/worker composition binds native Access to Context directory, lifecycle and provenance. */
export function composeSemanticContext(): ContextApplication {
  if (composed) return composed;
  const access = bindContextAccess(nativeContextAccess());
  composed = bindContextApplication(createContextApplication(access));
  return composed;
}

export function composedSemanticContext(): ContextApplication {
  return composed ?? composeSemanticContext();
}
