import { createAccessApplication } from '../access/application/index.ts';
import { acknowledgeErasure } from '../access/erasure.ts';
import { bindAccessApplication, createNativeAccessPorts } from '../access/adapters/index.ts';
import type { AccessApplication } from '../access/contract/index.ts';

let composed: AccessApplication | undefined;

/** Ordinary createKernel/server/worker composition binds the native Access adapters. */
export function composeAccessApplication(): AccessApplication {
  if (composed) return composed;
  composed = bindAccessApplication(createAccessApplication(createNativeAccessPorts(acknowledgeErasure)));
  return composed;
}

export function composedAccessApplication(): AccessApplication {
  return composed ?? composeAccessApplication();
}
